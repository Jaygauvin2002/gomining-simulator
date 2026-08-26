// GoMining Data Extractor - Content Script
// Extrait les données du DOM et intercepte les requêtes API

(function() {
    'use strict';

    const MAX_AGE_HOURS = 24; // Durée de vie max des données
    const MAX_HISTORY_DAYS = 30; // Fenêtre envoyée au simulateur
    // Plafond de ce qu'on CONSERVE en local. 2,5 Mo laisse largement la place
    // au reste (nft/get-my ~45 Ko, portefeuille, prix) sous le quota de 10 Mo
    // de chrome.storage.local, tout en gardant des mois d'historique réel :
    // les jours ne pèsent lourd que lorsqu'ils contiennent des revenus.
    const HISTORY_BYTE_BUDGET = 2_500_000;
    const AUTOSYNC_DEBOUNCE_MS = 30000; // 30 seconds debounce for auto-sync
    const AUTOSYNC_FIRST_MS = 3000; // 3 seconds for first sync

    // === Farm-power sanity bounds ===
    // The global-scan and DOM layers pick the LARGEST plausible power value
    // they can find. Without a bound they happily grab GoMining's NETWORK-WIDE
    // hashrate (millions of TH) that also appears on the page/in responses,
    // instead of the user's farm (~hundreds of TH). We anchor every override
    // to the reliable per-NFT base sum (Σ n.power from /nft/get-my):
    //   - a real farm total exceeds the base sum only modestly (boosts),
    //   - a value 3× larger is not this farm — it's a network figure leaking in.
    const MAX_POWER_RATIO = 3;        // farm total ≤ 3× base Σ(power)
    const ABS_MAX_FARM_TH = 100000;   // hard ceiling when no base sum is known
    function isPlausibleFarmPower(v, anchor) {
        if (!(v > 0) || v >= 1e7) return false;
        if (anchor > 0) return v <= anchor * MAX_POWER_RATIO;
        return v < ABS_MAX_FARM_TH; // no NFT base captured → reject network-scale values
    }

    // === Auto-sync: debounced save to chrome.storage.local ===
    let _autoSyncTimer = null;
    let _firstSyncDone = false;
    function scheduleAutoSync() {
        if (_autoSyncTimer) return; // already scheduled
        const delay = _firstSyncDone ? AUTOSYNC_DEBOUNCE_MS : AUTOSYNC_FIRST_MS;
        _autoSyncTimer = setTimeout(() => {
            _autoSyncTimer = null;
            _firstSyncDone = true;
            try {
                const essentials = extractEssentials();
                // Only save if we have at least some meaningful data
                if (essentials.miner.power || essentials.income.prPerThGmt || essentials.rewardHistory?.length) {
                    chrome.storage.local.set({ gominingAutoSync: essentials }, () => {
                        if (!chrome.runtime.lastError) {
                            log('Auto-sync: données sauvegardées pour le simulateur');
                        }
                    });
                }
            } catch(e) {
                console.warn('[GMSim Sync] Auto-sync error:', e);
            }
        }, delay);
    }

    const DATA = {
        apiCalls: [],
        miners: {},    // clé = endpoint, valeur = dernière réponse
        rewards: {},   // clé = endpoint, valeur = dernière réponse
        discount: {},
        prices: {},
        timestamp: null
    };

    // === Injecter l'intercepteur réseau dans la page ===
    // (Already injected at document_start by inject-early.js. The
    // interceptor itself guards against double-init. We re-inject as
    // a fallback in case inject-early didn't run for some reason.)
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('interceptor.js');
    (document.head || document.documentElement).appendChild(script);
    script.onload = () => script.remove();

    // === Socket.IO frame parser ===
    // Socket.IO over WebSocket prefixes every text frame with a small numeric
    // packet code:
    //   0{...}    Engine.IO open handshake
    //   2 / 3     ping / pong (no body)
    //   40        connect
    //   42[evt,data]   message → an event with name + payload
    //   43...     ack (we don't use)
    // We only care about "42" event frames. Returns { event, data } or null.
    function parseSocketIoFrame(body) {
        if (typeof body !== 'string') return null;
        if (!body.startsWith('42')) return null;
        // strip leading "42" then any optional namespace + ack id like "42/nft,123"
        let payload = body.slice(2);
        const bracket = payload.indexOf('[');
        if (bracket < 0) return null;
        payload = payload.slice(bracket);
        try {
            const arr = JSON.parse(payload);
            if (!Array.isArray(arr) || arr.length === 0) return null;
            return { event: String(arr[0]), data: arr.length > 1 ? arr[1] : null };
        } catch (e) { return null; }
    }

    // === Process one intercepted message (fetch / XHR / WS / SSE) ===
    function handleInterceptedMessage(data) {
        if (!data) return;
        const { type, url, body, status } = data;
        if (type === 'GOMINING_FETCH' || type === 'GOMINING_XHR') {
            if (status !== 200) return;
        }
        if (url && (url.includes('intercom') || url.includes('scevent') || url.includes('pixel'))) return;

        let parsed = null;
        let wsEvent = null;   // event name for WS frames, null otherwise

        if (type === 'GOMINING_WS') {
            // Socket.IO frames are NOT plain JSON. Parse as event frame first.
            const frame = parseSocketIoFrame(body);
            if (!frame) return;            // ping/pong/handshake — drop quietly
            wsEvent = frame.event;
            parsed = frame.data;
        } else {
            try {
                parsed = JSON.parse(body);
            } catch (e) {
                return; // not JSON
            }
        }

        // Log entry — same shape regardless of channel, but tag the type
        const channel = type === 'GOMINING_FETCH' ? 'fetch'
                      : type === 'GOMINING_XHR'   ? 'xhr'
                      : type === 'GOMINING_WS'    ? 'ws'
                      : type === 'GOMINING_SSE'   ? 'sse' : '?';
        const entry = {
            time: new Date().toISOString(),
            url: ('[' + channel + (wsEvent ? ':'+wsEvent : '') + '] ' + (url || '').split('?')[0]).substring(0, 120),
            size: body ? body.length : 0,
            keys: parsed && typeof parsed === 'object' ? Object.keys(parsed).join(', ') : ''
        };
        // Ne journaliser que les endpoints de la liste blanche. Sinon ce
        // compteur serait un relevé du trafic réseau de la page — quelque
        // chose qu'il faudrait déclarer comme « activité de l'utilisateur »
        // au Chrome Web Store, pour un simple indicateur d'interface.
        if (isStorableUrl(url) || type === 'GOMINING_WS' || type === 'GOMINING_SSE') {
            DATA.apiCalls.unshift(entry);
            if (DATA.apiCalls.length > 50) DATA.apiCalls.pop();
        }

        // Storage strategy:
        //   fetch / XHR  → keyed by endpoint pathname (last response wins)
        //   WS / SSE     → store under DATA.wars (NEVER DATA.miners).
        //
        // CRITICAL: WS frames from nft.ws.gomining.com contain `clanPower`
        // (e.g. 1500) and `currentAddedScore` (millions). If we put them in
        // DATA.miners the global power scanner could mis-pick them as the
        // user's farm total. So WS goes ONLY to DATA.wars, which the solo
        // path never reads.
        if (type === 'GOMINING_WS') {
            // Key by event name → only the LATEST snapshot is kept per event.
            // For allUsersStateV2 (1Hz updates) this means we always have the
            // freshest scoreboard but don't accumulate megabytes of history.
            const wsKey = 'ws:' + (wsEvent || 'unknown');
            DATA.wars[wsKey] = {
                url: url,
                event: wsEvent,
                time: new Date().toISOString(),
                data: parsed
            };
        } else if (type === 'GOMINING_SSE') {
            // SSE is also non-solo. Keep in DATA.wars for safety.
            const sseKey = 'sse:' + (url || 'unknown').substring(0, 80) + ':' + Date.now();
            DATA.wars[sseKey] = { url: url, time: new Date().toISOString(), data: parsed };
            // Cap at 30 SSE frames
            const sseKeys = Object.keys(DATA.wars).filter(k => k.startsWith('sse:'));
            if (sseKeys.length > 30) { delete DATA.wars[sseKeys.sort()[0]]; }
        }

        // Analyze + persist + bubble up to simulator
        // analyzeResponse uses URL-based routing (solo allowlist + MW blocklist),
        // so WS frames will NOT pollute DATA.miners even though they pass through.
        analyzeResponse(url || '', parsed);
        updatePanel();
        scheduleAutoSync();
    }

    // === Écouter les requêtes interceptées (fetch / XHR / WS / SSE) ===
    window.addEventListener('message', (event) => {
        if (event.source !== window) return;
        const t = event.data && event.data.type;
        if (t !== 'GOMINING_FETCH' && t !== 'GOMINING_XHR' &&
            t !== 'GOMINING_WS' && t !== 'GOMINING_SSE') return;
        handleInterceptedMessage(event.data);
    });

    // === Drain the early buffer set up by inject-early.js ===
    // Messages received between document_start and document_idle are
    // queued there. Process them all now so we don't lose the page's
    // initial fetches.
    try {
        if (Array.isArray(window.__gmMsgBuffer)) {
            const buffered = window.__gmMsgBuffer.slice();
            window.__gmMsgBuffer = null; // signal: stop buffering
            for (const data of buffered) handleInterceptedMessage(data);
        }
    } catch (_) {}

    // === Extraire la clé unique d'un endpoint (sans query params) ===
    function extractEndpointKey(url) {
        try {
            const u = new URL(url, window.location.origin);
            return u.pathname.split('/').slice(-2).join('/');
        } catch(e) {
            return url.substring(0, 80);
        }
    }

    // === Liste blanche des endpoints réellement consommés ===
    // Tout ce qui n'est pas ici n'est jamais stocké. Motivation : le filtrage
    // par mots-clés d'avant capturait /auth/isAuth-v2 (parce que sa réponse
    // contient "rewardProtection", "bonusMinerActiveUntil" et "nftPrimaryPfpId"),
    // ce qui mettait en cache l'e-mail, le téléphone, le statut KYC, l'IP et un
    // JWT actif — puis les recopiait dans le localStorage de gmsim.ca.
    // Chaque entrée ci-dessous correspond à une lecture réelle dans
    // extractEssentials() ou dans le bloc prix.
    const SOLO_ALLOWLIST = /\/nft\/(get-my|get-power-upgrade-info|get-upgrade-rate|my-computing-power-chart|get-info)\b|\/nft-income\/find-aggregated-by-date|\/nft-income-aggregation\/get-last|\/wallet\/find-by-user|\/wallet\/transaction-history|\/bonus-miner\/client\/find-one|\/get-my-nft-discount|\/user\/get-total-income-values|\/home-page\/get-info|\/ve-gomining-lock\/(find-by-user|statistics)|getTokenPrice/i;

    // Refus explicite, évalué avant la liste blanche. Ceinture et bretelles :
    // si un endpoint sensible venait un jour à ressembler à un endpoint solo,
    // il resterait bloqué.
    const HARD_DENYLIST = /\/auth\/|\/oauth|\/kyc|\/profile|\/i18n\/|\/assets\/|\.json(\?|$)|config\.ton\.org|intercom|\/banner-configuration\/|\/academy\/|\/achievement-template\/|\/loan-api\/|\/notification\/|\/ab-tests\/|\/nft-collection\/index/i;

    // Mode exploration. Le manifest du dépôt porte « (DEV) » dans son nom et
    // build-zip.sh le retire pour le paquet publié — donc ceci est vrai sur la
    // copie chargée non empaquetée, et faux chez les utilisateurs, sans qu'il y
    // ait un second interrupteur à penser à remettre.
    //
    // Sert à inspecter un endpoint avant de décider s'il mérite d'être capté en
    // production : on le liste ici, on capture, on regarde le payload, et on
    // choisit ensuite en connaissance de cause plutôt qu'à l'intuition.
    const IS_DEV = (function () {
        try { return /\(DEV\)/.test(chrome.runtime.getManifest().name); }
        catch (e) { return false; }
    })();

    // NOTE 2026-08-26 : `bonus-miner/client/find-one` vient d'être ajouté à la
    // liste blanche. Le Bonus miner (#531186 chez Jérémie, 0,40 TH) est un vrai
    // mineur qui produit de vraies récompenses, mais il n'apparaît PAS dans
    // /nft/get-my — il a son propre hôte. C'est très probablement l'origine de
    // l'écart de 2,16 TH de mai (333,27 sommés contre 335,43 affichés) qui avait
    // motivé le scan global et le scraping du DOM. On avait bâti des heuristiques
    // pour deviner un nombre qu'une API voisine donnait proprement.
    // Sa puissance reste à sommer : voir le TODO dans extractEssentials.

    // En cours d'examen : reconstruire le capital investi. `nft/get-my` ne donne
    // que le prix d'achat initial du NFT ; tout ce qui a été dépensé en upgrades
    // de puissance n'y figure pas (chez Jérémie : ~725 $ d'achats pour ~4 150 $
    // réellement investis). L'historique de transactions est le seul endroit où
    // cette dépense pourrait apparaître.
    // Aucune sonde active. `wallet/transaction-history` est passé en production
    // le 2026-08-26 après examen d'une capture réelle : c'est la seule source du
    // capital externe, et sa taxonomie `fromType` est ce qui permet de distinguer
    // l'argent venu de l'extérieur des mouvements internes.
    const DEV_PROBE = /$^/;

    function isStorableUrl(url) {
        if (IS_DEV && DEV_PROBE.test(url || '')) return true;
        const u = url || '';
        if (HARD_DENYLIST.test(u)) return false;
        return SOLO_ALLOWLIST.test(u);
    }

    // === Purger les données trop vieilles ===
    function purgeOldData() {
        const cutoff = new Date(Date.now() - MAX_AGE_HOURS * 3600 * 1000).toISOString();

        // Drop any MW-namespace URLs that previously leaked into miner/reward
        // pools (before the strict allowlist was added). Identifies them by
        // URL substring — not by content — so we don't trip on field names.
        const isMwLeaked = (entry) => /\/nft-game\/|\/clan-leaderboard\/|\/clan\/get-by(-id|-user)|\/round\/(get-state|get-last|find-by-cycleId)|\/rewards-by-user|\/get-total-reward-by-user|\/league\/(index|get-user-positions-data)|\/nft-game-bot|\/nft-game-token|\/nft-game-ability|\/nft-game-income|\/nft-game-user-profile|\/clan-rating|\/clan-message|\/league\/find-many|\/nft-game-round|wss?:\/\/(?:[a-z0-9-]+\.)*gomining\.com/i.test(entry.url || '');

        let leaked = 0, offlist = 0;
        for (const key of Object.keys(DATA.miners)) {
            if (isMwLeaked(DATA.miners[key])) { delete DATA.miners[key]; leaked++; continue; }
            // Évince ce qu'une version antérieure avait mis en cache hors liste
            // blanche — notamment /auth/isAuth-v2 et ses données personnelles.
            if (!isStorableUrl(DATA.miners[key].url)) { delete DATA.miners[key]; offlist++; continue; }
            if (DATA.miners[key].time < cutoff) delete DATA.miners[key];
        }
        for (const key of Object.keys(DATA.rewards)) {
            if (isMwLeaked(DATA.rewards[key])) { delete DATA.rewards[key]; leaked++; continue; }
            if (!isStorableUrl(DATA.rewards[key].url)) { delete DATA.rewards[key]; offlist++; continue; }
            if (DATA.rewards[key].time < cutoff) delete DATA.rewards[key];
        }
        if (leaked) log('Purge MW-leaked from solo pools: ' + leaked);
        if (offlist) log('Purge hors liste blanche (données héritées): ' + offlist);

        // DATA.prices.raw pouvait retenir n'importe quelle réponse contenant
        // "price"/"rate"/"usd" — dont le bundle i18n. On ne garde que les
        // valeurs dérivées si la source n'est plus admissible.
        if (DATA.prices && DATA.prices.source && !isStorableUrl(DATA.prices.source)) {
            delete DATA.prices.raw;
            delete DATA.prices.source;
        }

        // Purger apiCalls vieux
        DATA.apiCalls = DATA.apiCalls.filter(c => c.time > cutoff);

        log(`Purge: miners=${Object.keys(DATA.miners).length}, rewards=${Object.keys(DATA.rewards).length}, apiCalls=${DATA.apiCalls.length}`);
    }

    // Purge auto toutes les 30 min
    setInterval(purgeOldData, 30 * 60 * 1000);
    // Run once at startup to flush MW-leaked entries from any prior session.
    setTimeout(purgeOldData, 500);

    // Réduit une transaction à ce qui sert au calcul du capital.
    // `hasDepositTx` / `hasWithdrawOrder` remplacent les identifiants eux-mêmes :
    // on a besoin de savoir qu'un mouvement a franchi la chaîne, pas de conserver
    // sa référence on-chain.
    //
    // ATTENTION : ne pas se fier à `withdrawNetwork` pour repérer une sortie
    // externe — ce champ nomme le réseau de l'actif, pas une destination. Il est
    // rempli sur des `asset-conversion` purement internes. Les vrais marqueurs
    // sont withdrawOrderId / withdrawOrderBlockchainTxId.
    function slimTransaction(t) {
        if (!t || typeof t !== 'object') return t;
        return {
            id: t.id,
            createdAt: t.createdAt,
            type: t.type,
            fromType: t.fromType,
            valueNumeric: t.valueNumeric,
            walletType: t.walletType,
            hasDepositTx: !!(t.depositTxId || t.depositNetwork),
            hasWithdrawOrder: !!(t.withdrawOrderId || t.withdrawOrderBlockchainTxId),
        };
    }

    // Fusionne un tableau paginé dans celui déjà stocké, dédoublonné par clé et
    // borné par octets. L'API renvoie une page à la fois : sans ça, chaque page
    // chargée écrase la précédente et défiler ne sert à rien.
    //
    // La fusion de l'historique des récompenses, plus haut, fait la même chose à
    // la main. Elle n'est pas migrée ici volontairement : elle fonctionne, elle
    // porte des mois de données réelles, et la réécrire pour l'élégance ferait
    // courir un risque sans bénéfice pour l'utilisateur.
    function mergePagedArray(prevArray, nextArray, keyOf, budgetBytes) {
        const byKey = new Map();
        for (const item of prevArray || []) {
            const k = keyOf(item);
            if (k != null) byKey.set(String(k), item);
        }
        let added = 0;
        for (const item of nextArray || []) {
            const k = keyOf(item);
            if (k == null) continue;
            if (!byKey.has(String(k))) added++;
            byKey.set(String(k), item);
        }
        // Plus récents d'abord, puis on remplit jusqu'au budget. Trier sur
        // createdAt quand il existe, sinon sur la clé (les ids sont croissants).
        const sortKey = (x) => x.createdAt || String(keyOf(x) ?? '');
        const desc = Array.from(byKey.values()).sort((a, b) => String(sortKey(b)).localeCompare(String(sortKey(a))));
        const kept = [];
        let budget = budgetBytes;
        for (const item of desc) {
            const cost = JSON.stringify(item).length;
            if (kept.length && cost > budget) break;
            kept.push(item);
            budget -= cost;
        }
        kept.sort((a, b) => String(sortKey(a)).localeCompare(String(sortKey(b))));
        return { merged: kept, added: added, dropped: desc.length - kept.length };
    }

    // Lit le Bonus miner dans les réponses captées. Repéré par URL plutôt que
    // par clé de stockage : extractEndpointKey ne garde que les deux derniers
    // segments, donc il est rangé sous « client/find-one » — un nom qui ne dit
    // rien de son origine et qu'un autre service pourrait un jour réutiliser.
    function findBonusMiner() {
        for (const pool of [DATA.miners, DATA.rewards]) {
            for (const entry of Object.values(pool || {})) {
                if (!/bonus-miner/i.test(entry?.url || '')) continue;
                const m = entry?.data?.data?.miner;
                if (!m) continue;
                const power = Number(m.power);
                if (!isFinite(power) || power <= 0) continue;
                return { power: power, efficiency: Number(m.energy_efficiency) || null };
            }
        }
        return null;
    }

    // === Capital externe, depuis le relevé de transactions ===================
    //
    // Le seul dénominateur légitime d'un ROI : ce qui a franchi la frontière du
    // compte. Tout le reste — conversions, achats de mineurs, upgrades, lock —
    // change la composition de l'actif, pas le capital. Compter un achat comme
    // un investissement double-compte les gains réinvestis : ils ont déjà été
    // comptés le jour où ils ont été minés.
    //
    // Les taux viennent des conversions de l'utilisateur lui-même, appariées par
    // horodatage. Aucune source de prix externe, donc aucune dépendance et aucun
    // historique à deviner : s'il a converti du SOL en GMT, on connaît son taux.
    const EXTERNAL_IN = /^(fireblocks-deposit|payment)$/i;
    const TH_SPEND    = /^(marketplace-withdraw|nft-upgrade-power)$/i;

    function computeCapital() {
        let entry = null;
        for (const pool of [DATA.rewards, DATA.miners]) {
            for (const e of Object.values(pool || {})) {
                if (/\/wallet\/transaction-history/i.test(e?.url || '')) { entry = e; break; }
            }
            if (entry) break;
        }
        const txs = entry?.data?.data?.array;
        if (!Array.isArray(txs) || txs.length === 0) return null;

        const cur = (t) => String(t.walletType || '').replace('VIRTUAL_', '');
        const amt = (t) => {
            const n = Number(t.valueNumeric);
            return isFinite(n) ? n / 1e18 : 0;
        };

        // --- taux X → GMT, appariés à la minute ---
        const conv = txs.filter(t => t.fromType === 'asset-conversion')
                        .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
        const given = {}, got = {};
        const used = new Set();
        for (let i = 0; i < conv.length; i++) {
            const a = conv[i];
            if (used.has(i) || a.type !== 'withdraw') continue;
            for (let j = 0; j < conv.length; j++) {
                const b = conv[j];
                if (used.has(j) || j === i || b.type !== 'deposit') continue;
                if (String(a.createdAt).slice(0, 16) !== String(b.createdAt).slice(0, 16)) continue;
                used.add(i); used.add(j);
                if (cur(b) === 'GMT' && cur(a) !== 'GMT' && amt(a) > 0) {
                    given[cur(a)] = (given[cur(a)] || 0) + amt(a);
                    got[cur(a)]   = (got[cur(a)]   || 0) + amt(b);
                }
                break;
            }
        }
        const rates = {};
        for (const c of Object.keys(given)) if (given[c] > 0) rates[c] = got[c] / given[c];

        // --- entrées externes ---
        const deposits = {};
        let externalWithdrawals = 0;
        const spentGmt = {};
        for (const t of txs) {
            const c = cur(t);
            if (t.type === 'deposit' && EXTERNAL_IN.test(t.fromType || '')) {
                deposits[c] = (deposits[c] || 0) + amt(t);
            }
            if (t.type === 'withdraw' && t.hasWithdrawOrder) externalWithdrawals += amt(t);
            if (t.type === 'withdraw' && TH_SPEND.test(t.fromType || '') && c === 'GMT') {
                spentGmt[t.fromType] = (spentGmt[t.fromType] || 0) + amt(t);
            }
        }

        let gmtEquivalent = 0;
        const unvalued = {};
        for (const [c, v] of Object.entries(deposits)) {
            if (c === 'GMT') gmtEquivalent += v;
            else if (rates[c]) gmtEquivalent += v * rates[c];
            else unvalued[c] = v;   // jamais converti par l'utilisateur → pas de taux honnête
        }

        return {
            source: 'transaction-history',
            txCount: txs.length,
            deposits: deposits,
            rates: rates,
            unvalued: unvalued,
            gmtEquivalent: gmtEquivalent > 0 ? gmtEquivalent : null,
            externalWithdrawals: externalWithdrawals,
            spentOnThGmt: Object.values(spentGmt).reduce((a, b) => a + b, 0),
            spentBreakdownGmt: spentGmt,
        };
    }

    // === Analyser les réponses API ===
    function analyzeResponse(url, data) {
        // Rien n'est stocké hors de la liste blanche — voir isStorableUrl().
        if (!isStorableUrl(url)) return;

        // Chercher des patterns de données mining
        const str = JSON.stringify(data).toLowerCase();

        // Données de rewards/income — garder seulement la dernière par endpoint
        if (str.includes('reward') || str.includes('income') || str.includes('computing_power') ||
            str.includes('hashrate') || str.includes('electricity') || str.includes('service')) {
            const key = extractEndpointKey(url);

            // Pour find-aggregated-by-date, merger les jours au lieu d'écraser
            // (le dashboard GoMining retourne ~6 jours, la page rewards ~20 jours)
            if (url.includes('/nft-income/find-aggregated-by-date') &&
                data?.data?.array &&
                DATA.rewards[key]?.data?.data?.array) {
                const existing = DATA.rewards[key].data.data.array;
                const newDays = data.data.array;
                const byDate = new Map();
                for (const d of existing) {
                    const dt = d.createdAt?.substring(0, 10);
                    if (dt) byDate.set(dt, d);
                }
                for (const d of newDays) {
                    const dt = d.createdAt?.substring(0, 10);
                    if (dt) byDate.set(dt, d); // nouvelles données ont priorité
                }
                data = JSON.parse(JSON.stringify(data));

                // Borner ce qui est STOCKÉ, pas seulement ce qui est synchronisé.
                // La fusion dédoublonne par date et ne jetait jamais rien : à
                // ~100 Ko par jour de détail par NFT, la clé grossissait sans fin
                // jusqu'à saturer le quota de chrome.storage.local (10 Mo, on ne
                // demande pas unlimitedStorage) — et un set() qui échoue arrête la
                // synchro en silence.
                //
                // On borne par TAILLE et non par âge, en gardant les jours les plus
                // récents. Une coupe par date paraissait plus simple mais détruisait
                // de vraies données : un utilisateur passé par Miner Wars a un trou
                // dans son historique solo, si bien que ses seuls jours réels
                // pouvaient tous être antérieurs au seuil. Et la synchro cloud
                // prévue vise justement à dépasser la fenêtre de 30 jours — inutile
                // de détruire d'avance ce qu'elle voudra lire.
                const sortedDesc = Array.from(byDate.values())
                    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
                const kept = [];
                let budget = HISTORY_BYTE_BUDGET;
                for (const day of sortedDesc) {
                    const cost = JSON.stringify(day).length;
                    // Toujours garder le jour le plus récent, même s'il dépasse à lui
                    // seul le budget : sans lui il n'y a plus de synchro du tout.
                    if (kept.length && cost > budget) break;
                    kept.push(day);
                    budget -= cost;
                }
                const dropped = sortedDesc.length - kept.length;
                data.data.array = kept
                    .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
                log('Merge reward history: ' + existing.length + ' + ' + newDays.length +
                    ' → ' + data.data.array.length + ' jours' +
                    (dropped ? ' (' + dropped + ' plus anciens écartés, budget atteint)' : ''));
            }

            // Historique de transactions : accumuler les pages au lieu de les
            // écraser. C'est le seul moyen de reconstituer le capital externe —
            // l'API en renvoie ~9 par page et il peut y en avoir des dizaines.
            if (/\/wallet\/transaction-history/i.test(url) && Array.isArray(data?.data?.array)) {
                // N'garder que les six champs qui servent, plus deux booléens de
                // provenance. Le payload d'origine porte 21 champs par ligne,
                // dont une quinzaine de nulls et des drapeaux de conformité
                // (travelRule*) qui ne nous regardent pas. Sur des dizaines de
                // transactions ça compte, et moins de données financières
                // conservées est bon en soi.
                data = JSON.parse(JSON.stringify(data));
                data.data.array = data.data.array.map(slimTransaction);
                const prev = DATA.rewards[key]?.data?.data?.array;
                if (Array.isArray(prev)) {
                    const r = mergePagedArray(prev, data.data.array, (x) => x.id, HISTORY_BYTE_BUDGET);
                    data.data.array = r.merged;
                    log('Merge transactions: +' + r.added + ' nouvelles → ' + r.merged.length +
                        ' au total' + (r.dropped ? ' (' + r.dropped + ' écartées, budget atteint)' : ''));
                }
            }

            DATA.rewards[key] = {
                url: url,
                time: new Date().toISOString(),
                data: data
            };
            log('Données rewards: ' + key);
        }

        // Données de mineur/NFT — STRICT allowlist for SOLO mining endpoints.
        // PRIOR BUG: matching on `str.includes('power')` slurped Miner Wars
        // endpoints (clan-leaderboard returns totalPower:63042, clan/get-by-id
        // returns power:210, etc). The global power scanner then picked those
        // as the "user farm total" and overwrote miner.power with 63042.
        // Fix: only accept URLs that look like SOLO mining endpoints, AND
        // explicitly REJECT any URL with /nft-game/ (Miner Wars namespace) or
        // /clan-leaderboard/ etc.
        const isMwUrl = /\/nft-game\/|\/clan-leaderboard\/|\/clan\/get-by(-id|-user)|\/round\/(get-state|get-last|find-by-cycleId)|\/rewards-by-user|\/get-total-reward-by-user|\/league\/(index|get-user-positions-data)|\/nft-game-bot|\/nft-game-token|\/nft-game-ability|\/nft-game-income|\/nft-game-user-profile|\/clan-rating|\/clan-message|\/league\/find-many|\/nft-game-round|wss?:\/\/(?:[a-z0-9-]+\.)*gomining\.com/i.test(url);
        // `/nft-income` est volontairement absent : extractEssentials ne lit
        // l'historique que depuis DATA.rewards, et le payload pèse ~56 Ko par
        // jour — le dupliquer ici coûtait 1,1 Mo que personne ne lisait.
        // `/nft-collection` retiré aussi : 406 Ko jamais lus, et ses champs de
        // puissance faussaient la détection de la ferme.
        const isSoloMinerUrl = /\/nft\/(get-my|get-power-upgrade-info|get-upgrade-rate|my-computing-power-chart|get-info)|\/wallet\/find-by-user|\/ve-gomining-lock|\/home-page\/get-info/i.test(url);
        if (isSoloMinerUrl && !isMwUrl) {
            const key = extractEndpointKey(url);
            DATA.miners[key] = {
                url: url,
                time: new Date().toISOString(),
                data: data
            };
            log('Données mineur (solo): ' + key);
        } else if (!isMwUrl && !/\/nft-income/i.test(url) &&
                   (str.includes('th/s') || (str.includes('miner') && str.includes('nft')))) {
            // Loose fallback for solo data we haven't catalogued yet — but still
            // exclude MW URLs and require BOTH miner+nft keywords (not just 'power').
            // `/nft-income` is excluded explicitly: its payload contains both
            // "miner" and "nft", so it satisfied this fallback and got duplicated
            // into DATA.miners at ~56 KB per day of history, for nothing —
            // extractEssentials only ever reads it from DATA.rewards.
            const key = extractEndpointKey(url);
            DATA.miners[key] = {
                url: url,
                time: new Date().toISOString(),
                data: data
            };
            log('Données mineur (loose): ' + key);
        }

        // Prix — capturer spécifiquement les prix GoMining internes
        if (str.includes('price') || str.includes('rate') || str.includes('usd')) {
            // `raw` ne garde que les deux sources qui portent réellement un prix.
            // Avant, n'importe quelle réponse contenant « usd » l'écrasait — on y
            // trouvait le payload de wallet/find-by-user, recopié pour rien.
            const isPriceSource = /getTokenPrice|home-page\/get-info/i.test(url);
            DATA.prices = isPriceSource
                ? { ...DATA.prices, source: url, raw: data }
                : { ...DATA.prices };

            // Prix GMT interne GoMining (endpoint getTokenPrice)
            if (url.includes('getTokenPrice') && data?.data?.price) {
                DATA.prices.gmtPriceInternal = parseFloat(data.data.price);
                log('Prix GMT interne: $' + DATA.prices.gmtPriceInternal);
            }
            // Prix depuis home-page
            if (url.includes('home-page/get-info-v2') && data?.data) {
                if (data.data.currentGmtPrice) DATA.prices.gmtPriceInternal = data.data.currentGmtPrice;
                if (data.data.currentBtcPrice) DATA.prices.btcPriceInternal = data.data.currentBtcPrice;
                log('Prix home-page: GMT=$' + data.data.currentGmtPrice + ' BTC=$' + data.data.currentBtcPrice);
            }
            log('Données prix trouvées: ' + url);
        }
    }

    // === Scanner le DOM pour extraire des données ===
    function scanDOM() {
        const extracted = {
            timestamp: new Date().toISOString(),
            page: window.location.pathname,
            texts: {}
        };

        // Chercher tous les textes qui contiennent des données numériques intéressantes
        const patterns = {
            'TH/s': /(\d+\.?\d*)\s*TH\/s/gi,
            'W/TH': /(\d+\.?\d*)\s*W\/TH/gi,
            'sat': /(\d+)\s*sat/gi,
            'GOMINING': /(\d+\.?\d*)\s*GOMINING/gi,
            'BTC': /(\d+\.?\d*)\s*BTC/gi,
            'discount': /(\d+\.?\d*)%/gi,
            'kWh': /(\d+\.?\d*)\s*\$?\/kWh/gi
        };

        const body = document.body.innerText;
        for (const [key, regex] of Object.entries(patterns)) {
            const matches = [];
            let match;
            while ((match = regex.exec(body)) !== null) {
                matches.push(match[0]);
            }
            if (matches.length > 0) {
                extracted.texts[key] = [...new Set(matches)]; // unique
            }
        }

        // Chercher spécifiquement le tableau de rewards
        const rows = document.querySelectorAll('table tr, [class*="reward"], [class*="income"]');
        if (rows.length > 0) {
            extracted.rewardRows = rows.length;
        }

        // Chercher les éléments avec des données spécifiques
        const allElements = document.querySelectorAll('[class*="card"], [class*="stat"], [class*="value"], [class*="amount"]');
        const values = [];
        allElements.forEach(el => {
            const text = el.innerText.trim();
            if (text && text.length < 100 && /\d/.test(text)) {
                values.push(text);
            }
        });
        extracted.cardValues = [...new Set(values)].slice(0, 30);

        return extracted;
    }

    // === Interface Panel ===
    function createPanel() {
        // Toggle button
        const toggle = document.createElement('button');
        toggle.id = 'gm-extractor-toggle';
        toggle.innerHTML = '<img src="' + chrome.runtime.getURL('icon-128.png') + '" style="width:30px;height:30px;border-radius:6px;">';
        // Afficher le nom du manifest : en local il porte le suffixe (DEV), donc
        // on voit immédiatement laquelle des deux extensions injecte la page.
        const EXT_NAME = (function () {
            try { return chrome.runtime.getManifest().name.replace('— Miner Sync', 'Sync'); }
            catch (e) { return 'GMSim Sync'; }
        })();
        toggle.title = EXT_NAME;
        document.body.appendChild(toggle);

        // Panel
        const panel = document.createElement('div');
        panel.id = 'gm-extractor-panel';
        panel.innerHTML = `
            <div class="gm-header">
                <span>${EXT_NAME}</span>
                <button id="gm-close">×</button>
            </div>
            <div class="gm-body">
                <div class="gm-status" id="gm-status">
                    <span class="gm-dot"></span>
                    <span id="gm-status-text">En attente de données...</span>
                </div>

                <div class="gm-meta" id="gm-meta"></div>
                <a class="gm-nudge" id="gm-nudge" href="https://gmsim.ca/" target="_blank" rel="noopener" hidden></a>

                <div class="gm-footer">
                    <span id="gm-req-count" style="display:none">0</span>
                    <span id="gm-data-size" style="display:none">0</span>
                    <span id="gm-page" style="display:none">${window.location.pathname}</span>
                    <button class="gm-link" id="gm-purge">Purger</button>
                    <button class="gm-link" id="gm-export">Exporter JSON</button>
                </div>
            </div>
            <div id="gm-dom-data" style="display:none"></div>
            <div class="gm-log" id="gm-log" style="display:none"></div>
        `;
        document.body.appendChild(panel);

        // Events
        document.getElementById('gm-close').addEventListener('click', () => {
            panel.style.display = 'none';
            toggle.style.display = 'block';
        });

        toggle.addEventListener('click', () => {
            panel.style.display = 'block';
            toggle.style.display = 'none';
        });

        document.getElementById('gm-export').addEventListener('click', () => {
            DATA.timestamp = new Date().toISOString();
            DATA.dom = scanDOM();
            const blob = new Blob([JSON.stringify(DATA, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `gomining-data-${new Date().toISOString().slice(0, 10)}.json`;
            a.click();
            URL.revokeObjectURL(url);
        });

        document.getElementById('gm-purge').addEventListener('click', () => {
            DATA.miners = {};
            DATA.rewards = {};
            DATA.apiCalls = [];
            DATA.prices = {};
            DATA.discount = {};
            DATA.dom = null;
            updatePanel();
        });
    }

    function updateDomDisplay(domData) {
        const el = document.getElementById('gm-dom-data');
        if (!domData) return;

        let html = '';
        if (domData.texts) {
            for (const [key, values] of Object.entries(domData.texts)) {
                html += `<div class="gm-row">
                    <span class="gm-label">${key}</span>
                    <span class="gm-value">${values.slice(0, 5).join(', ')}</span>
                </div>`;
            }
        }
        if (domData.cardValues && domData.cardValues.length > 0) {
            html += `<div style="margin-top:8px;font-size:11px;color:#666;">
                Card values: ${domData.cardValues.slice(0, 15).join(' | ')}
            </div>`;
        }
        el.innerHTML = html || 'Aucune donnée trouvée';
    }

    // Rappel de retour — n'apparaît que si le simulateur n'a pas été ouvert
    // depuis un moment ET que le marché a bougé assez pour que ça change
    // quelque chose. Strictement factuel : c'est un constat sur les données de
    // l'utilisateur, pas une promotion. Silencieux le reste du temps.
    const NUDGE_MIN_DAYS = 3;
    const NUDGE_MIN_MOVE = 5;   // % de variation du BTC

    function updateNudge() {
        const el = document.getElementById('gm-nudge');
        if (!el) return;
        try {
            chrome.storage.local.get('gmsLastVisit', function (res) {
                if (chrome.runtime.lastError) return;
                const snap = res && res.gmsLastVisit;
                const now = DATA.prices && DATA.prices.btcPriceInternal;
                if (!snap || !snap.t || !snap.btc || !now) { el.hidden = true; return; }

                const days = Math.floor((Date.now() - new Date(snap.t).getTime()) / 86400000);
                const move = ((now - snap.btc) / snap.btc) * 100;
                if (days < NUDGE_MIN_DAYS || Math.abs(move) < NUDGE_MIN_MOVE) {
                    el.hidden = true;
                    return;
                }

                const sign = move >= 0 ? '+' : '';
                el.textContent = 'Bitcoin ' + sign + move.toFixed(1) + '% depuis ta dernière visite ('
                               + days + 'j) · revoir ta stratégie →';
                el.className = 'gm-nudge ' + (move >= 0 ? 'up' : 'down');
                el.hidden = false;
            });
        } catch (e) { /* jamais bloquer le panneau */ }
    }

    function updatePanel() {
        updateNudge();
        // Status indicator
        const statusText = document.getElementById('gm-status-text');
        const statusDot = document.querySelector('.gm-dot');
        const hasData = Object.keys(DATA.miners).length > 0 || Object.keys(DATA.rewards).length > 0;
        if (statusText && statusDot) {
            if (hasData) {
                statusText.textContent = 'Sync auto actif · ' + DATA.apiCalls.length + ' requêtes';
                statusDot.classList.add('active');
            } else {
                statusText.textContent = 'En attente de données...';
                statusDot.classList.remove('active');
            }
        }

        // Meta: show summary of captured data
        const metaEl = document.getElementById('gm-meta');
        if (metaEl) {
            const essentials = hasData ? extractEssentials() : null;
            if (essentials) {
                const items = [];
                if (essentials.miner?.power) items.push(essentials.miner.power + ' TH');
                if (essentials.prices?.gmtPrice) items.push('GMT $' + essentials.prices.gmtPrice.toFixed(4));
                if (essentials.prices?.btcPrice) items.push('BTC $' + Math.round(essentials.prices.btcPrice).toLocaleString());
                if (essentials.rewardHistory?.length) items.push(essentials.rewardHistory.length + 'j hist.');
                metaEl.textContent = items.join(' · ');
                metaEl.style.display = items.length ? 'block' : 'none';
            } else {
                metaEl.style.display = 'none';
            }
        }
    }

    const logMessages = [];
    function log(msg) {
        logMessages.push(`[${new Date().toLocaleTimeString()}] ${msg}`);
        console.log('[GMSim Sync]', msg);
    }

    // === Observer les changements de page (SPA Angular) ===
    let lastUrl = location.href;
    const observer = new MutationObserver(() => {
        if (location.href !== lastUrl) {
            lastUrl = location.href;
            const pageEl = document.getElementById('gm-page');
            if (pageEl) pageEl.textContent = window.location.pathname;
            log('Navigation: ' + window.location.pathname);
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // === Scrape the visible farm power from the GoMining DOM ===
    // The /nft/get-my API returns each NFT's "base" power, but GoMining's
    // Mining-farm widget displays a total that can include bonuses or
    // adjustments not reflected in that field (we observed 333.27 from
    // the API summing while the UI displayed 335.43 across the same
    // 3 miners). Reading the DOM gives us the value the user actually
    // sees, which is what the simulator should use for projections.
    //
    // Strategy:
    //   1) Try to find a text node like "POWER" / "Power" / "power" /
    //      "Total power" / "Farm power" / "Hashrate" (any case), then
    //      walk up to its card and capture every "X TH" inside.
    //   2) If no labelled match found, fall back to scanning the whole
    //      page for the LARGEST plausible "X TH" value > 50 — on a farm
    //      page that's almost certainly the farm total. We keep this as
    //      a fallback so users on a non-overview view still get a value.
    //
    // The function logs which strategy fired so the user can verify in
    // DevTools when the value seems wrong.
    function scanFarmPowerFromDom() {
        try {
            const POWER_LABELS = /^(?:total\s+)?(?:farm\s+)?(?:power|hashrate)\s*[:.]?\s*$/i;
            const TH_PATTERN = /(\d+(?:[.,]\d+)?)\s*TH\b(?!\/s|H)/g;
            const labelledCandidates = [];

            // Strategy 1 — labelled
            const walker = document.createTreeWalker(
                document.body, NodeFilter.SHOW_TEXT, null
            );
            let node;
            while (node = walker.nextNode()) {
                const t = (node.nodeValue || '').replace(/ /g, ' ').trim();
                if (!t || !POWER_LABELS.test(t)) continue;
                let cur = node.parentElement;
                for (let depth = 0; depth < 6 && cur; depth++, cur = cur.parentElement) {
                    const text = (cur.textContent || '').replace(/ /g, ' ');
                    TH_PATTERN.lastIndex = 0;
                    const matches = [...text.matchAll(TH_PATTERN)];
                    if (matches.length) {
                        for (const m of matches) {
                            const v = parseFloat(m[1].replace(',', '.'));
                            if (v > 0.01 && v < 1e7) labelledCandidates.push(v);
                        }
                        break;
                    }
                }
            }
            if (labelledCandidates.length) {
                const best = Math.max(...labelledCandidates);
                try { console.log('[GMSim Sync] DOM power (labelled):', best, 'from', labelledCandidates); } catch {}
                return best;
            }

            // Strategy 2 — biggest plausible "X TH" on the page
            const fallbackCandidates = [];
            const bodyText = (document.body?.textContent || '').replace(/ /g, ' ');
            TH_PATTERN.lastIndex = 0;
            const allMatches = [...bodyText.matchAll(TH_PATTERN)];
            for (const m of allMatches) {
                const v = parseFloat(m[1].replace(',', '.'));
                if (v > 50 && v < 1e7) fallbackCandidates.push(v);
            }
            if (fallbackCandidates.length) {
                const best = Math.max(...fallbackCandidates);
                try { console.log('[GMSim Sync] DOM power (fallback / largest TH):', best, 'from', fallbackCandidates); } catch {}
                return best;
            }

            try { console.log('[GMSim Sync] No DOM power match on this page'); } catch {}
            return null;
        } catch (e) {
            try { console.log('[GMSim Sync] DOM scrape error:', e); } catch {}
            return null;
        }
    }

    // === Extract essential data for simulator ===
    function extractEssentials() {
        const result = {
            timestamp: new Date().toISOString(),
            // Report the extension version so the simulator can prompt the user
            // to reload an outdated extension (unpacked installs don't auto-update).
            extVersion: (() => { try { return chrome.runtime.getManifest().version; } catch (_) { return null; } })(),
            miner: {},
            wallet: {},
            discount: {},
            prices: {},
            income: {}
        };

        // Find miner data (DATA.miners est maintenant un objet clé=endpoint)
        for (const m of Object.values(DATA.miners)) {
            if (m.url?.includes('/nft/get-my') && m.data?.data?.array?.length > 0) {
                const nfts = m.data.data.array;

                // === Multi-field power summing ===
                // GoMining's UI displays a higher total than naive Σ(n.power)
                // (we observed 335.43 displayed vs 333.27 from n.power across
                // the same 3 miners). The displayed value likely comes from
                // a different field on each NFT — boostedPower / computingPower
                // / actualPower / totalPower depending on API generation.
                // Strategy: sum each candidate field independently and keep
                // the LARGEST sum. The largest sum is the displayed total
                // because boost/computing fields ≥ base power. Falls back
                // to plain `n.power` when only that field exists (unchanged
                // behavior on older API responses).
                const POWER_FIELDS = [
                    'computingPower',     // newer "displayed" power
                    'boostedPower',       // includes streak/VIP/mode bonuses
                    'actualPower',
                    'totalPower',
                    'displayedPower',
                    'farmPower',
                    'effectivePower',
                    'power',              // legacy base field
                ];
                const sums = {};
                for (const f of POWER_FIELDS) {
                    const s = nfts.reduce((acc, n) => acc + (typeof n[f] === 'number' ? n[f] : 0), 0);
                    if (s > 0) sums[f] = s;
                }
                let totalPower = 0;
                let powerField = 'none';
                for (const [f, v] of Object.entries(sums)) {
                    if (v > totalPower) { totalPower = v; powerField = f; }
                }
                if (totalPower === 0) {
                    // Last-ditch: literal n.power || 0 (matches legacy behavior
                    // when no recognised field is present on any NFT).
                    totalPower = nfts.reduce((acc, n) => acc + (n.power || 0), 0);
                    powerField = 'power-fallback';
                }

                // Sanity bound: if the chosen field sums to something absurd
                // relative to the base `power` sum (e.g. a network figure stored
                // on the NFT payload), revert to the trustworthy base sum.
                const baseSum = sums.power || 0;
                if (baseSum > 0 && totalPower > baseSum * MAX_POWER_RATIO) {
                    try { console.log('[GMSim Sync] Rejecting implausible field sum', totalPower, 'via', powerField, '→ base', baseSum); } catch {}
                    totalPower = baseSum;
                    powerField = 'power (bounded)';
                }

                // Use weighted average for efficiency (always from `power` since
                // efficiency is paired with raw power in the API)
                const basePower = nfts.reduce((acc, n) => acc + (n.power || 0), 0);
                const totalWatts = nfts.reduce((acc, n) => acc + (n.power || 0) * (n.energyEfficiency || 15), 0);
                const avgEfficiency = basePower > 0 ? totalWatts / basePower : 15;
                const main = nfts.reduce((a, b) => (b.power || 0) > (a.power || 0) ? b : a, nfts[0]);

                result.miner = {
                    power: totalPower,
                    energyEfficiency: avgEfficiency,
                    level: main.level,
                    name: main.name,
                    minerCount: nfts.length,
                    apiPower: basePower,        // legacy n.power sum (for diagnostics)
                    apiPowerField: powerField,  // which field the chosen sum came from
                    powerSource: 'api',
                    fieldSums: sums              // all field sums (visible in JSON export for debug)
                };
                try { console.log('[GMSim Sync] Power per field:', sums, '→ chosen:', totalPower, 'via', powerField); } catch {}

                // Le Bonus miner est un vrai mineur, avec sa propre puissance et
                // ses propres récompenses, servi par api.bonus-miner.gomining.com
                // et ABSENT de /nft/get-my. Sans lui la ferme est sous-comptée :
                // chez Jérémie 696,4212 sommés contre 696,82 affichés par
                // GoMining, et 696,4212 + 0,3972 = 696,8184 — l'écart restant
                // (0,0016) est l'arrondi de l'affichage.
                //
                // C'est très probablement ce mineur que le scan global et le
                // scraping du DOM tentaient de deviner depuis mai. Les noms de
                // champs sont en snake_case : autre service, autre convention.
                const bonus = findBonusMiner();
                if (bonus && bonus.power > 0) {
                    const withBonus = result.miner.power + bonus.power;
                    // L'efficacité de la ferme est pondérée par la puissance.
                    const watts = result.miner.power * result.miner.energyEfficiency
                                + bonus.power * (bonus.efficiency || result.miner.energyEfficiency);
                    result.miner.power = withBonus;
                    result.miner.energyEfficiency = withBonus > 0 ? watts / withBonus : result.miner.energyEfficiency;
                    result.miner.apiPower = (result.miner.apiPower || 0) + bonus.power;
                    result.miner.minerCount = (result.miner.minerCount || 0) + 1;
                    result.miner.bonusMinerPower = bonus.power;
                    result.miner.powerSource = 'api+bonus';
                    try { console.log('[GMSim Sync] Bonus miner: +' + bonus.power + ' TH → ' + withBonus); } catch {}
                }
            }
            if (m.url?.includes('/wallet/find-by-user') && m.data?.data?.array) {
                const gmtW = m.data.data.array.find(w => w.type === 'VIRTUAL_GMT');
                if (gmtW) {
                    result.wallet.gmtBalance = parseFloat(gmtW.gmtValueAtSyncDate) || 0;
                    result.wallet.gmtLocked = Math.round(parseFloat(gmtW.lockedGmtInWei || '0') / 1e18);
                }
                // BTC wallet: no reliable balance field (no btcValueAtSyncDate equivalent)
                // valueNumericAtSyncDate is an internal counter, not the balance
            }
        }

        // Find discount data (DATA.rewards est maintenant un objet clé=endpoint)
        for (const r of Object.values(DATA.rewards)) {
            if (r.url?.includes('/get-my-nft-discount') && r.data?.data) {
                const d = r.data.data;
                result.discount = {
                    streak: d.dailyMaintenanceDiscount || 0,
                    vip: d.levelDiscount || 0,
                    miningMode: d.rewardDistributionDiscount || 0,
                    token: d.discountByMaintenanceInGmt || 0,
                    availableDays: d.discountAvailableDays || 0
                };
            }
            if (r.url?.includes('/home-page/get-info-v2') && r.data?.data) {
                result.prices.gmtPrice = r.data.data.currentGmtPrice;
                result.prices.btcPrice = r.data.data.currentBtcPrice;
            }
            if (r.url?.includes('/nft-income-aggregation/get-last') && r.data?.data) {
                // totalIncomePerThToday is partial-day (resets at UTC midnight),
                // so it keeps "dropping" as UTC days roll over. Stash it as a last-resort
                // fallback only — the primary PR source is rewardHistory (last complete day).
                result.income._partialDayPr = r.data.data.totalIncomePerThToday;
                result.income.c1PerThPerWt = r.data.data.c1ValuePerThPerWtToday;
                result.income.c2PerTh = r.data.data.c2ValuePerThToday;
                // Capturer le prix GMT depuis les stats si disponible
                if (r.data.data.gmtPrice) {
                    result.prices.gmtPrice = result.prices.gmtPrice || r.data.data.gmtPrice;
                }
                if (r.data.data.btcPrice) {
                    result.prices.btcPrice = result.prices.btcPrice || r.data.data.btcPrice;
                }
            }
        }

        // Also check miners for home-page data
        for (const m of Object.values(DATA.miners)) {
            if (m.url?.includes('/home-page/get-info-v2') && m.data?.data) {
                result.prices.gmtPrice = result.prices.gmtPrice || m.data.data.currentGmtPrice;
                result.prices.btcPrice = result.prices.btcPrice || m.data.data.currentBtcPrice;
            }
        }

        // Upgrade cost per TH — DISABLED.
        // Previous heuristic picked the first numeric field 0-1000 from
        // /nft/get-power-upgrade-info and was returning wrong values (~$7.79
        // when the real upgrade rate is $12.34). Until we can identify the
        // correct field with a captured raw payload, we don't propagate a
        // cost — the simulator falls back to its hardcoded $12.34 default.
        // For debugging when GoMining ships a new upgrade flow, log raw keys:
        result.upgrade = {};
        for (const m of Object.values(DATA.miners)) {
            if (m.url?.includes('/nft/get-power-upgrade-info') || m.url?.includes('/nft/get-upgrade-rate')) {
                const d = m.data?.data || m.data;
                if (d) log('Upgrade endpoint keys (debug): ' + Object.keys(d).join(','));
            }
        }

        // veGMT staking data
        result.staking = {};
        for (const r of Object.values(DATA.rewards)) {
            // Lock details (votes, GMT locked, days to expire)
            if (r.url?.includes('/ve-gomining-lock/find-by-user') && r.data?.data?.array?.[0]) {
                const lock = r.data.data.array[0];
                result.staking.votes = lock.votes || 0;
                result.staking.gmtLocked = Math.round(parseFloat(lock.amountNumeric || '0') / 1e18);
                result.staking.daysToExpire = lock.daysToExpire || 0;
                result.staking.gmtRewardCumulative = lock.gmtReward || 0;
            }
            // Statistics (yearly income per vote)
            if (r.url?.includes('/ve-gomining-lock/statistics') && r.data?.data?.array) {
                // Find VIRTUAL_GMT stats
                const vgmt = r.data.data.array.find(s => s.network === 'VIRTUAL_GMT');
                if (vgmt) {
                    result.staking.yearlyIncomePerVote = vgmt.yearlyIncomePerVote || 0;
                }
            }
        }
        // Also check miners for these endpoints
        for (const m of Object.values(DATA.miners)) {
            if (m.url?.includes('/ve-gomining-lock/find-by-user') && m.data?.data?.array?.[0]) {
                const lock = m.data.data.array[0];
                result.staking.votes = result.staking.votes || lock.votes || 0;
                result.staking.gmtLocked = result.staking.gmtLocked || Math.round(parseFloat(lock.amountNumeric || '0') / 1e18);
                result.staking.gmtRewardCumulative = result.staking.gmtRewardCumulative || lock.gmtReward || 0;
            }
            if (m.url?.includes('/ve-gomining-lock/statistics') && m.data?.data?.array) {
                const vgmt = m.data.data.array.find(s => s.network === 'VIRTUAL_GMT');
                if (vgmt && !result.staking.yearlyIncomePerVote) {
                    result.staking.yearlyIncomePerVote = vgmt.yearlyIncomePerVote || 0;
                }
            }
        }
        // Calculate weekly GMT reward if we have the data
        if (result.staking.votes && result.staking.yearlyIncomePerVote) {
            result.staking.weeklyGmtReward = result.staking.votes * result.staking.yearlyIncomePerVote / 52;
        }

        // Fallback: utiliser les prix internes captés par DATA.prices (getTokenPrice, etc.)
        if (!result.prices.gmtPrice && DATA.prices.gmtPriceInternal) {
            result.prices.gmtPrice = DATA.prices.gmtPriceInternal;
        }
        if (!result.prices.btcPrice && DATA.prices.btcPriceInternal) {
            result.prices.btcPrice = DATA.prices.btcPriceInternal;
        }

        // Fallback ultime: CALCULER le prix GMT depuis la formule C2
        // C2 = (0.0089 / gmtPrice) * (1 - totalDiscount)
        // Donc: gmtPrice = 0.0089 * (1 - totalDiscount) / c2PerTh
        if (!result.prices.gmtPrice && result.income.c2PerTh && result.discount.streak !== undefined) {
            const totalDiscount = (result.discount.streak || 0) + (result.discount.vip || 0) +
                                  (result.discount.miningMode || 0) + (result.discount.token || 0);
            const discountMult = 1 - totalDiscount;
            if (result.income.c2PerTh > 0) {
                result.prices.gmtPrice = 0.0089 * discountMult / result.income.c2PerTh;
                result.prices.gmtPriceSource = 'derived-from-c2';
            }
        }

        // Extract reward history — limité aux MAX_HISTORY_DAYS derniers jours
        result.rewardHistory = [];
        const cutoffDate = new Date(Date.now() - MAX_HISTORY_DAYS * 24 * 3600 * 1000).toISOString().substring(0, 10);

        for (const r of Object.values(DATA.rewards)) {
            if (r.url?.includes('/nft-income/find-aggregated-by-date') && r.data?.data?.array) {
                for (const day of r.data.data.array) {
                    // GoMining écrit l'enregistrement le LENDEMAIN du jour miné :
                    // `createdAt` est la date d'écriture, `calculatedAt` (à
                    // 23:59:59.999) est le jour réellement miné. Vérifié sur 20
                    // jours consécutifs : l'écart est systématiquement de J-1.
                    //
                    // Se fier à createdAt avait deux effets, tous deux constatés :
                    // le calendrier décalait chaque gain d'un jour, et le jour
                    // daté d'aujourd'hui — qui est en fait la journée COMPLÈTE de
                    // la veille — était marqué « partiel » puis écarté. Le site
                    // remontait alors au dernier jour « complet » vieux de 36
                    // jours et retombait sur son PR par défaut de 47 sat/TH au
                    // lieu des 50 réels, sous-estimant le gain net de 38 %.
                    const calcDay = day.incomeStatistic?.calculatedAt?.substring(0, 10);
                    let dateStr = calcDay;
                    if (!dateStr && day.createdAt) {
                        // Repli : reculer d'un jour, puisque le décalage est la règle.
                        const t = Date.parse(day.createdAt.substring(0, 10) + 'T00:00:00Z');
                        if (isFinite(t)) dateStr = new Date(t - 86400000).toISOString().substring(0, 10);
                    }
                    if (!dateStr || dateStr < cutoffDate) continue; // Skip old data

                    // Aggregate ALL miner NFTs for this day (exclude nft 21521713 which is staking-related).
                    // Previously we only picked the FIRST NFT, which broke for users with multiple miners
                    // (gave per-NFT power instead of total → 10 TH instead of 197 TH for example).
                    const incomes = (day.incomeListV2 || []).filter(i => i.nftId !== 21521713);
                    if (incomes.length === 0) continue;

                    const sumPower = incomes.reduce((s, i) => s + (i.power || 0), 0);
                    const sumC1 = incomes.reduce((s, i) => s + (i.c1Value || 0), 0);
                    const sumC2 = incomes.reduce((s, i) => s + (i.c2Value || 0), 0);
                    const sumPoolReward = incomes.reduce((s, i) => s + (i.metaData?.poolReward || 0), 0);
                    // Deux termes que le simulateur ignorait, tous deux dans metaData.
                    // GBP (« GoBTC Pay bonus ») s'ajoute au PR : +0,031 %, négligeable
                    // mais présent dans la formule affichée par GoMining.
                    // La commission de réinvestissement, elle, pèse 2,25 % : c'est ce
                    // que GoMining prélève en convertissant les gains BTC en GMT. Sans
                    // elle, tout utilisateur qui réinvestit en GMT voit son gain
                    // surestimé d'autant.
                    const sumGoBtcPayBonus = incomes.reduce((s, i) => s + (i.metaData?.goBtcPayBonus || 0), 0);
                    const sumReinvestCommission = incomes.reduce((s, i) => s + (i.metaData?.reinvestmentCommissionBtc || 0), 0);
                    const sumMaintGmt = incomes.reduce((s, i) => s + (i.maintenanceForWithdrawInGmt || 0), 0);
                    const sumGmtIncome = incomes.reduce((s, i) => s + (i.gmtIncomeBasedOnBtcIncome || 0), 0);

                    // For totalDiscount, take the value from the largest NFT (they should all have the same discount)
                    const main = incomes.reduce((a, b) => (b.power || 0) > (a.power || 0) ? b : a, incomes[0]);

                    // `partial` se juge sur le jour MINÉ, pas sur la date d'écriture.
                    // Un jour dont les récompenses sont encore en cours d'accumulation
                    // donnerait un poolReward/power sous-évalué à tout consommateur
                    // qui l'utilise pour le PR.
                    const todayUTC = new Date().toISOString().substring(0, 10);
                    result.rewardHistory.push({
                        date: dateStr,
                        partial: dateStr >= todayUTC,
                        valueBtc: day.valueV2 || day.value || 0,
                        power: sumPower,
                        c1: sumC1,
                        c2: sumC2,
                        poolReward: sumPoolReward,
                        goBtcPayBonus: sumGoBtcPayBonus,
                        reinvestCommissionBtc: sumReinvestCommission,
                        totalDiscount: main.totalDiscount,
                        gmtPrice: day.incomeStatistic?.gmtPrice,
                        btcPrice: day.incomeStatistic?.btcCourseInUsd,
                        maintenanceGmt: sumMaintGmt,
                        gmtIncome: sumGmtIncome,
                        reinvestment: main.reinvestment,
                        reinvestInTH: !!main.reinvestmentInPowerNftId,
                        toWalletType: main.toWalletType
                    });
                }
            }
        }
        // Deduplicate by date
        const seen = new Set();
        result.rewardHistory = result.rewardHistory.filter(r => {
            if (seen.has(r.date)) return false;
            seen.add(r.date);
            return true;
        }).sort((a, b) => a.date.localeCompare(b.date));

        // Fallback prix et PR depuis le reward history (le jour le plus récent)
        if (result.rewardHistory.length > 0) {
            const todayUTC = new Date().toISOString().substring(0, 10);

            // Find the most recent COMPLETE day (strictly before today UTC, AND with valid poolReward/power).
            // This avoids using today's partial data which makes PR drift / drop randomly.
            let completeDay = null;
            for (let i = result.rewardHistory.length - 1; i >= 0; i--) {
                const d = result.rewardHistory[i];
                if (d.date >= todayUTC) continue;           // skip today (partial)
                if (!d.poolReward || !d.power) continue;    // skip days with missing data
                completeDay = d;
                break;
            }
            // Fall back to most recent day (even if today) for prices if no complete day found
            const latest = completeDay || result.rewardHistory[result.rewardHistory.length - 1];

            if (!result.prices.gmtPrice && latest.gmtPrice) {
                result.prices.gmtPrice = latest.gmtPrice;
                result.prices.gmtPriceSource = 'reward-history';
            }
            if (!result.prices.btcPrice && latest.btcPrice) {
                result.prices.btcPrice = latest.btcPrice;
                result.prices.btcPriceSource = 'reward-history';
            }

            // Termes complémentaires du dernier jour complet, en unités réutilisables :
            // le bonus en sat/TH, et la commission en fraction du gain net.
            if (completeDay && completeDay.power > 0) {
                if (completeDay.goBtcPayBonus) {
                    result.income.gbpSatPerTh = completeDay.goBtcPayBonus / completeDay.power * 1e8;
                }
                const netBtc = (completeDay.poolReward || 0) + (completeDay.goBtcPayBonus || 0)
                             - (completeDay.c1 || 0) - (completeDay.c2 || 0);
                if (netBtc > 0 && completeDay.reinvestCommissionBtc) {
                    result.income.reinvestCommissionRate = completeDay.reinvestCommissionBtc / netBtc;
                }
            }

            // PRIMARY PR source: the last COMPLETE day's poolReward / power, converted BTC→GMT
            if (completeDay && completeDay.poolReward && completeDay.power) {
                const prBtcPerTH = completeDay.poolReward / completeDay.power;
                const gp = result.prices.gmtPrice;
                const bp = result.prices.btcPrice;
                if (gp && bp) {
                    result.income.prPerThGmt = prBtcPerTH * bp / gp;
                    result.income.prPerThSource = 'reward-history:' + completeDay.date;
                }
            }
        }

        // Last-resort fallback: use partial-day value only if nothing else worked
        if (!result.income.prPerThGmt && result.income._partialDayPr) {
            result.income.prPerThGmt = result.income._partialDayPr;
            result.income.prPerThSource = 'partial-day-fallback';
        }
        delete result.income._partialDayPr;

        // === Belt-and-suspenders: scan every captured response for a
        //     top-level "totalPower" / "farmPower" / "computingPower" /
        //     "totalHashrate" field. If one exists with a value larger
        //     than what we summed per-NFT, prefer it — the user-facing
        //     UI almost always pulls from such a dedicated total endpoint
        //     when it exists.
        const anchor = result.miner.apiPower || 0; // base Σ(n.power)

        // Σ(n.power) issu de /nft/get-my fait FOI quand il existe.
        //
        // Ces deux couches d'écrasement avaient été ajoutées pour combler un
        // écart de 0,6 % (333,27 sommés contre 335,43 affichés). Elles ont
        // depuis produit trois pannes bien pires que le défaut qu'elles
        // corrigeaient : une ferme annoncée à 2 000 000 TH, une autre rabattue
        // à 10 000 par la validation du site, et — confirmé par Jérémie le
        // 2026-08-26 — 998,63 TH affichés pour une ferme réelle de 696,42, soit
        // 43 % d'erreur sur laquelle reposaient gain quotidien, profit et sat/TH.
        //
        // Le garde-fou ne pouvait rien y faire : il tolère jusqu'à 3× la base,
        // et 998 < 3 × 696. Aucun réglage de seuil ne distingue une valeur
        // fausse d'une valeur haute — seule la source le peut.
        //
        // Les couches restent donc en place UNIQUEMENT pour les utilisateurs
        // dont /nft/get-my n'a pas été capté : sans elles, ils n'auraient aucune
        // puissance du tout. Dès que l'API a parlé, on l'écoute.
        if (!anchor) {
            const globalPower = findFarmTotalAcrossResponses(result.miner.power || 0);
            if (globalPower != null && globalPower > (result.miner.power || 0)
                && isPlausibleFarmPower(globalPower, anchor)) {
                result.miner.power = globalPower;
                result.miner.powerSource = 'global-scan (aucun /nft/get-my capté)';
            }

            const domPower = scanFarmPowerFromDom();
            if (domPower != null && domPower > 0
                && isPlausibleFarmPower(domPower, anchor)) {
                result.miner.power = domPower;
                result.miner.powerSource = 'dom (aucun /nft/get-my capté)';
            }
        }

        // Capital externe — null si le relevé n'a pas été capté, jamais un zéro
        // trompeur : le site doit pouvoir faire la différence entre « aucun
        // dépôt » et « je n'en sais rien ».
        result.capital = computeCapital();

        return result;
    }

    // === Scan every captured response (DATA.miners + DATA.rewards) for
    //     a top-level field whose name suggests "total power / hashrate".
    //     Returns the largest plausible value > minSum, or null.
    //
    //     SAFETY: cap candidates at 5× minSum. The user's farm total is at
    //     most a small multiple of the sum of their NFTs. Any value bigger
    //     than that is almost certainly a LEAGUE or CLAN total leaking from
    //     MW endpoints — REJECT it. ===
    function findFarmTotalAcrossResponses(minSum) {
        const POWER_FIELDS = /^(?:total[_\s]?power|farm[_\s]?power|total[_\s]?hashrate|computing[_\s]?power|displayed[_\s]?power|farm[_\s]?total|total[_\s]?th|total[_\s]?hash|hashrate|hashpower)$/i;
        const candidates = [];
        // Hard ceiling: never trust a global-scan value bigger than 5× minSum
        // (or 5000 TH if minSum is unset). Realistic mega-farms are <2000 TH.
        const ceiling = Math.max(5000, (minSum || 0) * 5);

        function scan(obj, depth = 0) {
            if (!obj || depth > 8) return;
            if (Array.isArray(obj)) {
                for (const o of obj) scan(o, depth + 1);
                return;
            }
            if (typeof obj !== 'object') return;
            for (const [k, v] of Object.entries(obj)) {
                if (typeof v === 'number' && v > 50 && v < ceiling
                    && POWER_FIELDS.test(k.replace(/[_\s]/g, ''))) {
                    candidates.push({ field: k, value: v });
                }
                if (v && typeof v === 'object') scan(v, depth + 1);
            }
        }

        // Only scan SOLO miner sources. DATA.miners is now strictly solo
        // (see analyzeResponse allowlist). DATA.rewards is solo income.
        for (const m of Object.values(DATA.miners)) if (m.data) scan(m.data);
        for (const r of Object.values(DATA.rewards)) if (r.data) scan(r.data);

        if (!candidates.length) return null;
        // Prefer the largest plausible — that's typically the farm total
        const best = candidates.reduce((a, b) => b.value > a.value ? b : a);
        try { console.log('[GMSim Sync] Global scan candidates:', candidates, '→ chosen:', best, '(ceiling:', ceiling, ')'); } catch {}
        return best.value;
    }

    // === Init ===
    createPanel();
    log('GMSim Sync démarré');

    // Auto-scan après 3 secondes
    setTimeout(() => {
        const domData = scanDOM();
        DATA.dom = domData;
        updateDomDisplay(domData);
        log('Auto-scan initial');
    }, 3000);

})();
