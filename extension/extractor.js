// GoMining Data Extractor - Content Script
// Extrait les données du DOM et intercepte les requêtes API

(function() {
    'use strict';

    const MAX_AGE_HOURS = 24; // Durée de vie max des données
    const MAX_HISTORY_DAYS = 30; // Garder seulement 30 jours de reward history
    const AUTOSYNC_DEBOUNCE_MS = 30000; // 30 seconds debounce for auto-sync
    const AUTOSYNC_FIRST_MS = 3000; // 3 seconds for first sync

    // === Auto-sync: debounced save to chrome.storage.local ===
    let _autoSyncTimer = null;
    let _firstSyncDone = false;
    function scheduleAutoSync() {
        if (_autoSyncTimer) return; // already scheduled
        // BUGFIX: previously this always used DEBOUNCE_MS (30s) so the first
        // sync was 10× slower than intended. Use the computed delay.
        const delay = _firstSyncDone ? AUTOSYNC_DEBOUNCE_MS : AUTOSYNC_FIRST_MS;
        _autoSyncTimer = setTimeout(() => {
            _autoSyncTimer = null;
            _firstSyncDone = true;
            try {
                const essentials = extractEssentials();
                // Only save if we have at least some meaningful data
                const hasWarsData = essentials.wars && (
                    essentials.wars.clan?.totalTh ||
                    essentials.wars.league?.totalTh ||
                    essentials.wars.recentBlocks?.length ||
                    essentials.wars.recentPersonal?.length ||
                    // New: any HAR-precise live field counts as "we have MW data"
                    essentials.wars.live?.league?.btcRewardFund ||
                    essentials.wars.live?.league?.totalPowerTh ||
                    essentials.wars.live?.user?.baseTh ||
                    essentials.wars.live?.clan?.totalBaseTh ||
                    essentials.wars.live?.round?.myClanRound
                );
                if (essentials.miner.power || essentials.income.prPerThGmt || essentials.rewardHistory?.length || hasWarsData) {
                    chrome.storage.local.set({ gominingAutoSync: essentials }, () => {
                        if (!chrome.runtime.lastError) {
                            log('Auto-sync: données sauvegardées pour le simulateur (hasWars=' + !!hasWarsData + ')');
                        }
                    });
                }
            } catch(e) {
                console.warn('[GoMining Extractor] Auto-sync error:', e);
            }
        }, delay);
    }

    const DATA = {
        apiCalls: [],
        miners: {},    // clé = endpoint, valeur = dernière réponse
        rewards: {},   // clé = endpoint, valeur = dernière réponse
        wars: {},      // Miner Wars: clan / league / blocks endpoints
        discount: {},
        prices: {},
        timestamp: null
    };

    // === Injecter l'intercepteur réseau dans la page ===
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('interceptor.js');
    (document.head || document.documentElement).appendChild(script);
    script.onload = () => script.remove();

    // === Écouter les requêtes interceptées ===
    window.addEventListener('message', (event) => {
        if (event.source !== window) return;
        if (event.data.type !== 'GOMINING_FETCH' && event.data.type !== 'GOMINING_XHR') return;

        const { url, body, status } = event.data;
        if (status !== 200) return;

        // Ignorer les requêtes non pertinentes
        if (url.includes('intercom') || url.includes('scevent') || url.includes('pixel')) return;

        let parsed = null;
        try {
            parsed = JSON.parse(body);
        } catch(e) {
            return; // pas du JSON
        }

        // Logger toutes les requêtes API
        const entry = {
            time: new Date().toISOString(),
            url: url.substring(0, 120),
            size: body.length,
            keys: parsed ? Object.keys(parsed).join(', ') : ''
        };
        DATA.apiCalls.unshift(entry);
        if (DATA.apiCalls.length > 50) DATA.apiCalls.pop();

        // Analyser les données intéressantes
        analyzeResponse(url, parsed);
        updatePanel();
        scheduleAutoSync();
    });

    // === Extraire la clé unique d'un endpoint (sans query params) ===
    function extractEndpointKey(url) {
        try {
            const u = new URL(url, window.location.origin);
            return u.pathname.split('/').slice(-2).join('/');
        } catch(e) {
            return url.substring(0, 80);
        }
    }

    // === Purger les données trop vieilles ===
    function purgeOldData() {
        const cutoff = new Date(Date.now() - MAX_AGE_HOURS * 3600 * 1000).toISOString();

        for (const key of Object.keys(DATA.miners)) {
            if (DATA.miners[key].time < cutoff) delete DATA.miners[key];
        }
        for (const key of Object.keys(DATA.rewards)) {
            if (DATA.rewards[key].time < cutoff) delete DATA.rewards[key];
        }

        // Purger apiCalls vieux
        DATA.apiCalls = DATA.apiCalls.filter(c => c.time > cutoff);

        for (const key of Object.keys(DATA.wars)) {
            if (DATA.wars[key].time < cutoff) delete DATA.wars[key];
        }

        log(`Purge: miners=${Object.keys(DATA.miners).length}, rewards=${Object.keys(DATA.rewards).length}, wars=${Object.keys(DATA.wars).length}, apiCalls=${DATA.apiCalls.length}`);
    }

    // Purge auto toutes les 30 min
    setInterval(purgeOldData, 30 * 60 * 1000);

    // === Analyser les réponses API ===
    function analyzeResponse(url, data) {
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
                data.data.array = Array.from(byDate.values())
                    .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
                log('Merge reward history: ' + existing.length + ' + ' + newDays.length + ' → ' + data.data.array.length + ' jours');
            }

            DATA.rewards[key] = {
                url: url,
                time: new Date().toISOString(),
                data: data
            };
            log('Données rewards: ' + key);
        }

        // === Miner Wars: precise endpoint matching from HAR capture ===
        // These are the exact GoMining MW API paths we now parse with
        // dedicated endpoint-specific parsers (no more generic field hunting):
        //   /api/nft-game/league/index                    — league catalog
        //   /api/nft-game/league/get-user-positions-data  — your rank
        //   /api/nft-game/clan-leaderboard/index-v2       — btcFund, totalPower, avg W/TH
        //   /api/nft-game/clan/get-by-id                  — clan + your profile
        //   /api/nft-game/round/get-state                 — live round + win chance
        //   /api/nft-game/rewards-by-user                 — clan reward history
        //   /api/nft-game/get-total-reward-by-user        — totals
        //   /api/nft-game/nft-game-bot/index              — your bot rules
        //   /api/nft-game/nft-game-bot-balance/get-my     — bot GMT balance
        //   /api/nft-game-round/find-current              — legacy current round
        //   /api/clan/get-by-user                         — legacy clan lookup
        //   /api/league/find-many                         — legacy league list
        //   /api/clan-rating/get-by-clan-id               — legacy rank
        //   /api/nft-game-ability/find-many               — legacy spell catalog
        // Plus loose fallbacks for keyword matches we may not yet recognize.
        const isMwEndpoint =
            /\/nft-game\/league\/(index|get-user-positions-data)/i.test(url) ||
            /\/nft-game\/clan-leaderboard\//i.test(url) ||
            /\/nft-game\/clan\/get-by-id/i.test(url) ||
            /\/nft-game\/round\/get-state/i.test(url) ||
            /\/nft-game\/rewards-by-user/i.test(url) ||
            /\/nft-game\/get-total-reward-by-user/i.test(url) ||
            /\/nft-game\/nft-game-bot\/index/i.test(url) ||
            /\/nft-game\/nft-game-bot-balance\/get-my/i.test(url) ||
            /\/nft-game-round\/find-current/i.test(url) ||
            /\/clan\/get-by-user/i.test(url) ||
            /\/league\/find-many/i.test(url) ||
            /\/clan-rating\/get-by-clan-id/i.test(url) ||
            /\/nft-game-ability\/find-many/i.test(url) ||
            /\/exchanges\/getPrice/i.test(url) ||
            /\/action\/get-maintenance-state/i.test(url);
        const isMwLooseMatch =
            url.match(/mining-?wars|miner-?wars|mining_?war|\/clan\/|\/round\/|\/league\/|pool-block|block-find|round-find|round-stat|spell|multiplier-block/i) ||
            str.match(/clantotalth|leaguepower|leaguetotalth|prizefund|reward_fund|basepps|boostedpps|round_id|clan_score|multiplier_block|spell_cost|btcfund|weightedenergyefficiencyperth/i);
        if (isMwEndpoint || isMwLooseMatch) {
            const key = extractEndpointKey(url);
            DATA.wars[key] = {
                url: url,
                time: new Date().toISOString(),
                data: data
            };
            log('Données wars: ' + key);
        }

        // Données de mineur/NFT — garder seulement la dernière par endpoint
        if (str.includes('miner') || str.includes('nft') || str.includes('th/s') || str.includes('power')) {
            const key = extractEndpointKey(url);
            DATA.miners[key] = {
                url: url,
                time: new Date().toISOString(),
                data: data
            };
            log('Données mineur: ' + key);
        }

        // Prix — capturer spécifiquement les prix GoMining internes
        if (str.includes('price') || str.includes('rate') || str.includes('usd')) {
            DATA.prices = { ...DATA.prices, source: url, raw: data };

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
        toggle.title = 'GoMining Extractor';
        document.body.appendChild(toggle);

        // Panel
        const panel = document.createElement('div');
        panel.id = 'gm-extractor-panel';
        panel.innerHTML = `
            <div class="gm-header">
                <span>GoMining Extractor</span>
                <button id="gm-close">×</button>
            </div>
            <div class="gm-body">
                <div class="gm-status" id="gm-status">
                    <span class="gm-dot"></span>
                    <span id="gm-status-text">En attente de données...</span>
                </div>

                <div class="gm-meta" id="gm-meta"></div>

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

    function updatePanel() {
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
        console.log('[GoMining Extractor]', msg);
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

    // === Extract essential data for simulator ===
    function extractEssentials() {
        const result = {
            timestamp: new Date().toISOString(),
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
                const totalPower = nfts.reduce((sum, n) => sum + (n.power || 0), 0);
                // Use weighted average for efficiency
                const totalWatts = nfts.reduce((sum, n) => sum + (n.power || 0) * (n.energyEfficiency || 15), 0);
                const avgEfficiency = totalPower > 0 ? totalWatts / totalPower : 15;
                const main = nfts.reduce((a, b) => (b.power || 0) > (a.power || 0) ? b : a, nfts[0]);
                result.miner = {
                    power: totalPower,
                    energyEfficiency: avgEfficiency,
                    level: main.level,
                    name: main.name,
                    minerCount: nfts.length
                };
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
                    const dateStr = day.createdAt?.substring(0, 10);
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
                    const sumMaintGmt = incomes.reduce((s, i) => s + (i.maintenanceForWithdrawInGmt || 0), 0);
                    const sumGmtIncome = incomes.reduce((s, i) => s + (i.gmtIncomeBasedOnBtcIncome || 0), 0);

                    // For totalDiscount, take the value from the largest NFT (they should all have the same discount)
                    const main = incomes.reduce((a, b) => (b.power || 0) > (a.power || 0) ? b : a, incomes[0]);

                    // Mark today's entry as `partial: true` — it's accumulating since
                    // 00:00 UTC and any consumer that uses `poolReward / power` for the
                    // PR display will get inflated values without this flag.
                    const todayUTC = new Date().toISOString().substring(0, 10);
                    result.rewardHistory.push({
                        date: dateStr,
                        partial: dateStr >= todayUTC,
                        valueBtc: day.valueV2 || day.value || 0,
                        power: sumPower,
                        c1: sumC1,
                        c2: sumC2,
                        poolReward: sumPoolReward,
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

        // === MINER WARS data ===
        // Best-effort: GoMining's MW endpoints are still being mapped, so we
        // recursively scan captured payloads for likely field names rather
        // than relying on a fixed schema.
        result.wars = extractWarsData();

        return result;
    }

    // ===== Miner Wars helpers =====
    // Recursively search an object/array for the first matching key (case-insensitive).
    function findField(obj, names, depth) {
        if (depth === undefined) depth = 0;
        if (depth > 6 || obj === null || obj === undefined) return null;
        if (typeof obj !== 'object') return null;
        const keys = Object.keys(obj);
        for (const k of keys) {
            if (names.indexOf(k.toLowerCase()) >= 0) return obj[k];
        }
        for (const k of keys) {
            const v = obj[k];
            if (v && typeof v === 'object') {
                const found = findField(v, names, depth + 1);
                if (found !== null && found !== undefined) return found;
            }
        }
        return null;
    }
    function findArray(obj, names, depth) {
        if (depth === undefined) depth = 0;
        if (depth > 6 || obj === null || obj === undefined) return null;
        if (typeof obj !== 'object') return null;
        const keys = Object.keys(obj);
        for (const k of keys) {
            if (names.indexOf(k.toLowerCase()) >= 0 && Array.isArray(obj[k])) return obj[k];
        }
        for (const k of keys) {
            const v = obj[k];
            if (v && typeof v === 'object') {
                const found = findArray(v, names, depth + 1);
                if (found) return found;
            }
        }
        return null;
    }
    // Provenance helper — wraps a raw value with its source so consumers know
    // which endpoint it came from and how confident we are in it.
    // Usage: tag(value, '/api/...', 'data.x.y', 'high')
    function tag(value, sourceEndpoint, sourcePath, confidence) {
        if (value === null || value === undefined) return null;
        return {
            value,
            sourceEndpoint: sourceEndpoint || null,
            sourcePath: sourcePath || null,
            capturedAt: Date.now(),
            confidence: confidence || 'medium',
        };
    }
    function extractWarsData() {
        const out = {
            clan: {},
            league: {},
            you: {},
            cycle: {},
            cycleSoFar: { clanBlocksWon:0, clanBtcWon:0, yourBtcWon:0, yourGmtWon:0, yourPersonalBlocks:0 },
            recentBlocks: [],
            recentPersonal: [],
            // ----- structured data parsed from confirmed GoMining endpoints -----
            allLeagues: [],          // array of { id, name, level, totalClansCount, multConfig:[{p,v}], promo, releg }
            roundMultConfig: null,   // array of { p:probability, v:multiplier } for YOUR league
            currentRound: null,      // { id, multiplier, active, startedAt, leagueId, yourScore, yourPower, allClansState }
            abilities: [],           // active spell catalog with exact prices/effects
            rank: {},                // { leagueId, clanRank, userRank }
            // ----- normalized live data (HAR-precise, with provenance) -----
            // Each field below is { value, sourceEndpoint, sourcePath, capturedAt, confidence }.
            // This is the shape the calculator should prefer over the legacy fields above.
            live: {
                user: {},      // userId, alias, baseTh, wPerTh, isClanOwner, joinDate, rank
                prices: {},    // btcUsd, gmtUsd
                league: {},    // leagueId, leagueName, level, totalClansCount, roundMultiplierConfig, btcRewardFund, totalPowerTh, averageWPerTh, ...
                clan: {},      // clanId, name, rank, usersCount, totalBaseTh, userClanShare, ...
                round: {},     // myClanRound { rank, winChance, power, basePoints, currentAddedScore, score, ... }
                rewards: {},   // totalDepositBtc, totalDepositGmtFund, clanRewardsItems, ...
                boosts: {},    // botRules, botBalanceGmt, abilityCatalog
                serviceState: {},
                sources: {},   // which endpoints we actually saw
            },
            capturedAt: Date.now(),
            sourceEndpoints: Object.keys(DATA.wars),
        };
        if (Object.keys(DATA.wars).length === 0) return out;

        // ===== PASS 1: parse confirmed GoMining MW endpoints precisely =====
        // We match by URL keywords because the endpoint key is just the last
        // two path segments (e.g. "league/find-many"). We don't rely on host.
        for (const r of Object.values(DATA.wars)) {
            const url = r.url || '';
            const d   = r.data;
            if (!d) continue;

            // ---- /api/league/find-many : full league catalog ----
            if (/\/league\/find-many/i.test(url) && d.data && Array.isArray(d.data.array)) {
                out.allLeagues = d.data.array.map(L => ({
                    id: L.id,
                    name: L.name,
                    level: L.level,
                    totalClansCount: L.totalClansCount,
                    promotionToLeagueId: L.promotionToLeagueId,
                    relegationToLeagueId: L.relegationToLeagueId,
                    isDynamicClansMovement: L.isDynamicClansMovement,
                    multConfig: Array.isArray(L.roundMultiplierConfig) ? L.roundMultiplierConfig : []
                }));
            }

            // ---- /api/clan/get-by-user-id (or get-by-user) : your clan ----
            if (/\/clan\/get-by-user/i.test(url) && d.data && typeof d.data === 'object') {
                const c = d.data;
                if (c.id !== undefined)        out.clan.id          = c.id;
                if (c.name)                    out.clan.name        = c.name;
                if (c.usersCount !== undefined) out.clan.memberCount = c.usersCount;
                if (c.nftsCount !== undefined) out.clan.nftsCount   = c.nftsCount;
                if (c.power !== undefined)     out.clan.totalTh     = c.power;
                if (c.leagueId !== undefined)  out.clan.leagueId    = c.leagueId;
                if (c.type)                    out.clan.type        = c.type;
                if (c.logo)                    out.clan.logo        = c.logo;
                if (c.isOwner !== undefined)   out.clan.isOwner     = c.isOwner;
                // Mirror leagueId onto league bucket so downstream lookups work
                if (c.leagueId !== undefined)  out.league.id        = out.league.id || c.leagueId;
            }

            // ---- /api/nft-game-round/find-current : live round state ----
            if (/\/nft-game-round\/find-current/i.test(url) && d.data && typeof d.data === 'object') {
                const R = d.data;
                out.currentRound = {
                    id:           R.id,
                    cycleId:      R.cycleId,
                    blockNumber:  R.blockNumber,
                    leagueId:     R.leagueId,
                    multiplier:   R.multiplier,
                    active:       R.active,
                    startedAt:    R.startedAt,
                    endedAt:      R.endedAt,
                    nftRate:      R.nftRate,
                    winnerClanId: R.winnerClanId,
                    winnerUserId: R.winnerUserId,
                    winnerNftId:  R.winnerNftId,
                    firstRoundStartedAt: R.firstRoundStartedAt,
                    isUserInCorrectLeague: R.isUserInCorrectLeague,
                    vipDiscount:  R.vipDiscount,
                    botBalanceValueNumeric: R.botBalanceValueNumeric,
                };
                // Probability table for THIS league (round-scoped — most authoritative)
                if (R.league && Array.isArray(R.league.roundMultiplierConfig)) {
                    out.roundMultConfig = R.league.roundMultiplierConfig.slice();
                } else if (Array.isArray(R.percents)) {
                    out.roundMultConfig = R.percents.slice();
                }
                // Your live state in this round
                if (R.userState && typeof R.userState === 'object') {
                    const u = R.userState;
                    out.you.userId            = u.userId;
                    out.you.clanId            = u.clanId;
                    out.you.score             = u.currentAddedScore;        // total score this round
                    out.you.activeBoostScore  = u.activeBoostScore;
                    out.you.userRoundPower    = u.userRoundPower;           // your TH eligible this round
                    out.you.usedAbilities     = u.usedAbilities || [];
                    out.you.stealerAbilities  = u.stealerAbilities || [];
                    out.currentRound.yourScore = u.currentAddedScore;
                    out.currentRound.yourPower = u.userRoundPower;
                }
                // Per-clan live scoreboard for the round
                if (Array.isArray(R.allClansState)) {
                    out.currentRound.allClansState = R.allClansState.map(c => ({
                        clanId: c.clanId,
                        currentAddedScore: c.currentAddedScore,
                        activeBoostScore: c.activeBoostScore,
                        clanPower: c.clanPower,
                        usedAbilities: c.usedAbilities || [],
                        clanPowerUpAbilityUsageCounter: c.clanPowerUpAbilityUsageCounter,
                    }));
                }
                // Per-user power participation in this round (basePoints, clan, power)
                if (Array.isArray(R.userRounds)) {
                    out.currentRound.userRounds = R.userRounds.map(u => ({
                        clanId: u.clanId,
                        userId: u.userId,
                        power: u.power,
                        basePoints: u.basePoints,
                    }));
                    // Compute clan totals from userRounds (sum power per clanId)
                    const clanTh = {};
                    for (const u of R.userRounds) {
                        if (u.clanId == null) continue;
                        clanTh[u.clanId] = (clanTh[u.clanId] || 0) + (u.power || 0);
                    }
                    out.currentRound.clanThByClanId = clanTh;
                    // Total league TH eligible this round (sum of all clans)
                    out.league.totalTh = Object.values(clanTh).reduce((a,b) => a+b, 0);
                    // Your clan total TH from this round (only powered participants count)
                    if (out.clan.id != null && clanTh[out.clan.id] != null) {
                        out.clan.activeTh = clanTh[out.clan.id];
                    }
                }
                // Active spell catalog for THIS round (most up-to-date prices)
                if (Array.isArray(R.nftGameAbilities)) {
                    out.abilities = R.nftGameAbilities.map(a => ({
                        id: a.id,
                        type: a.type,
                        subtype: a.subtype,
                        name: a.name,
                        description: a.description,
                        priceInGMT: a.priceInGMT,
                        data: a.data,
                        availableFrom: a.availableFrom,
                        availableTo: a.availableTo,
                    }));
                }
                // Mirror multiplier into league bucket
                if (R.multiplier !== undefined) out.league.currentMultiplier = R.multiplier;
            }

            // ---- /api/clan-rating/get-by-clan-id : clan & user rank ----
            if (/\/clan-rating\/get-by-clan-id/i.test(url) && d.data && typeof d.data === 'object') {
                const k = d.data;
                if (k.leagueId !== undefined) out.rank.leagueId  = k.leagueId;
                if (k.clanRank !== undefined) out.rank.clanRank  = k.clanRank;
                if (k.userRank !== undefined) out.rank.userRank  = k.userRank;
            }

            // ===== HAR-precise endpoints (preferred — populate out.live.*) =====

            // ---- /api/nft-game/league/index : league catalog (HAR) ----
            if (/\/nft-game\/league\/index/i.test(url) && d.data && Array.isArray(d.data.array)) {
                out.live.sources.leagueIndex = url;
                if (!out.allLeagues.length) {
                    out.allLeagues = d.data.array.map(L => ({
                        id: L.id,
                        name: L.name,
                        level: L.level,
                        totalClansCount: L.totalClansCount,
                        promotionToLeagueId: L.promotionToLeagueId,
                        relegationToLeagueId: L.relegationToLeagueId,
                        isDynamicClansMovement: L.isDynamicClansMovement,
                        multConfig: Array.isArray(L.roundMultiplierConfig) ? L.roundMultiplierConfig : []
                    }));
                }
                out.live.league.catalog = tag(out.allLeagues, url, 'data.array', 'high');
            }

            // ---- /api/nft-game/league/get-user-positions-data : ranks (HAR) ----
            if (/\/nft-game\/league\/get-user-positions-data/i.test(url) && d.data && typeof d.data === 'object') {
                out.live.sources.positions = url;
                const k = d.data;
                if (k.leagueId !== undefined) {
                    out.rank.leagueId = k.leagueId;
                    out.live.league.leagueId = tag(k.leagueId, url, 'data.leagueId', 'high');
                }
                if (k.clanRank !== undefined) {
                    out.rank.clanRank = k.clanRank;
                    out.live.clan.rank = tag(k.clanRank, url, 'data.clanRank', 'high');
                }
                if (k.userRank !== undefined) {
                    out.rank.userRank = k.userRank;
                    out.live.user.rank = tag(k.userRank, url, 'data.userRank', 'high');
                }
            }

            // ---- /api/nft-game/clan-leaderboard/index-v2 : league fund + total power + avg W/TH (HAR — CRITICAL) ----
            if (/\/nft-game\/clan-leaderboard\/index-v2/i.test(url) && d.data && typeof d.data === 'object') {
                out.live.sources.leaderboard = url;
                const L = d.data;
                if (L.btcFund !== undefined) {
                    out.league.prizeFundBtc = Number(L.btcFund);
                    out.live.league.btcRewardFund = tag(Number(L.btcFund), url, 'data.btcFund', 'high');
                }
                if (L.totalPower !== undefined) {
                    out.league.totalTh = L.totalPower;
                    out.live.league.totalPowerTh = tag(L.totalPower, url, 'data.totalPower', 'high');
                }
                if (L.weightedEnergyEfficiencyPerTh !== undefined) {
                    out.league.avgWth = L.weightedEnergyEfficiencyPerTh;
                    out.live.league.averageWPerTh = tag(L.weightedEnergyEfficiencyPerTh, url, 'data.weightedEnergyEfficiencyPerTh', 'high');
                }
                if (L.totalMinedBlocks !== undefined) out.live.league.totalMinedBlocks = tag(L.totalMinedBlocks, url, 'data.totalMinedBlocks', 'high');
                if (L.count !== undefined)            out.live.league.clanCount        = tag(L.count, url, 'data.count', 'high');
                if (L.status)                         out.live.league.status           = tag(L.status, url, 'data.status', 'high');
                if (L.me) {
                    if (L.me.id   !== undefined) out.live.clan.clanId = tag(L.me.id,   url, 'data.me.id',   'high');
                    if (L.me.name)               out.live.clan.name   = tag(L.me.name, url, 'data.me.name', 'high');
                    out.clan.id   = out.clan.id   || L.me.id;
                    out.clan.name = out.clan.name || L.me.name;
                }
                if (Array.isArray(L.clansPromoted))  out.live.league.clansPromoted  = tag(L.clansPromoted,  url, 'data.clansPromoted',  'high');
                if (Array.isArray(L.clansRemaining)) out.live.league.clansRemaining = tag(L.clansRemaining, url, 'data.clansRemaining', 'high');
                if (Array.isArray(L.clansRelegated)) out.live.league.clansRelegated = tag(L.clansRelegated, url, 'data.clansRelegated', 'high');
            }

            // ---- /api/nft-game/clan/get-by-id : clan + your profile (HAR — CRITICAL) ----
            if (/\/nft-game\/clan\/get-by-id/i.test(url) && d.data && typeof d.data === 'object') {
                out.live.sources.clanDetail = url;
                const C = d.data;
                if (C.id !== undefined)         out.live.clan.clanId       = out.live.clan.clanId   || tag(C.id,         url, 'data.id',         'high');
                if (C.name)                     out.live.clan.name         = out.live.clan.name     || tag(C.name,       url, 'data.name',       'high');
                if (C.leagueId !== undefined)   out.live.clan.leagueId     = tag(C.leagueId,     url, 'data.leagueId',   'high');
                if (C.isOwner !== undefined)    out.live.clan.isOwner      = tag(C.isOwner,      url, 'data.isOwner',    'high');
                if (C.usersCount !== undefined) out.live.clan.usersCount   = tag(C.usersCount,   url, 'data.usersCount', 'high');
                if (C.nftsCount !== undefined)  out.live.clan.nftsCount    = tag(C.nftsCount,    url, 'data.nftsCount',  'high');
                if (C.power !== undefined) {
                    out.live.clan.totalBaseTh = tag(C.power, url, 'data.power', 'high');
                    out.clan.totalTh = C.power;
                }
                if (C.weightedEffectiveness !== undefined) out.live.clan.weightedEffectiveness = tag(C.weightedEffectiveness, url, 'data.weightedEffectiveness', 'high');
                if (C.blocksMined !== undefined)           out.live.clan.blocksMined           = tag(C.blocksMined,           url, 'data.blocksMined',           'high');
                if (C.blocksShare !== undefined)           out.live.clan.blocksSharePct        = tag(C.blocksShare,           url, 'data.blocksShare',           'high');
                if (C.btcIncome !== undefined)             out.live.clan.btcIncome             = tag(C.btcIncome,             url, 'data.btcIncome',             'high');
                if (C.gmtIncome !== undefined)             out.live.clan.gmtIncome             = tag(C.gmtIncome,             url, 'data.gmtIncome',             'high');
                if (C.powerShare !== undefined)            out.live.clan.powerSharePct         = tag(C.powerShare,            url, 'data.powerShare',            'high');
                if (C.scoreShare !== undefined)            out.live.clan.scoreSharePct         = tag(C.scoreShare,            url, 'data.scoreShare',            'high');
                if (C.luck !== undefined)                  out.live.clan.luck                  = tag(C.luck,                  url, 'data.luck',                  'high');
                if (C.clanRank !== undefined && !out.live.clan.rank) {
                    out.live.clan.rank = tag(C.clanRank, url, 'data.clanRank', 'high');
                    out.rank.clanRank = out.rank.clanRank || C.clanRank;
                }
                // Your profile inside this clan — primary source for user.baseTh & user.wPerTh
                if (C.myProfile && typeof C.myProfile === 'object') {
                    const M = C.myProfile;
                    if (M.id !== undefined)      out.live.user.userId      = tag(M.id,      url, 'data.myProfile.id',      'high');
                    if (M.alias)                 out.live.user.alias       = tag(M.alias,   url, 'data.myProfile.alias',   'high');
                    if (M.power !== undefined)   out.live.user.baseTh      = tag(M.power,   url, 'data.myProfile.power',   'high');
                    if (M.ee !== undefined)      out.live.user.wPerTh      = tag(M.ee,      url, 'data.myProfile.ee',      'high');
                    if (M.isOwner !== undefined) out.live.user.isClanOwner = tag(M.isOwner, url, 'data.myProfile.isOwner', 'high');
                    if (M.joinDate)              out.live.user.joinDate    = tag(M.joinDate,url, 'data.myProfile.joinDate','high');
                    if (Array.isArray(M.usedNftGameAbilities)) {
                        out.live.boosts.usedAbilitiesByUser = tag(M.usedNftGameAbilities, url, 'data.myProfile.usedNftGameAbilities', 'high');
                    }
                    // userClanShare = your base TH / clan total base TH (the BTC distribution share)
                    if (M.power && C.power) {
                        out.live.clan.userClanShare = tag(M.power / C.power, url, 'data.myProfile.power / data.power', 'high');
                    }
                }
                if (Array.isArray(C.usersForClient)) {
                    out.live.clan.members = tag(C.usersForClient, url, 'data.usersForClient', 'high');
                }
            }

            // ---- /api/nft-game/round/get-state : live round score + win chance (HAR) ----
            if (/\/nft-game\/round\/get-state/i.test(url) && d.data && typeof d.data === 'object') {
                out.live.sources.roundState = url;
                const R = d.data;
                if (R.type)                 out.live.round.type      = tag(R.type,  url, 'data.type',  'high');
                if (R.count !== undefined)  out.live.round.clanCount = tag(R.count, url, 'data.count', 'high');
                if (R.me && typeof R.me === 'object') {
                    const me = R.me;
                    out.live.round.myClanRound = tag({
                        rank:              me.rank,
                        winChance:         me.chance,
                        power:             me.power,
                        basePoints:        me.basePoints,
                        currentAddedScore: me.currentAddedScore,
                        activeBoostScore:  me.activeBoostScore,
                        score:             me.score,
                        usedAbilities:     me.usedAbilities || [],
                        clanName:          me.clanName,
                    }, url, 'data.me', 'high');
                    // Mirror to legacy buckets
                    if (me.rank   !== undefined) out.rank.clanRank = out.rank.clanRank || me.rank;
                    if (me.chance !== undefined) out.live.round.winChance = tag(me.chance, url, 'data.me.chance', 'high');
                }
                if (Array.isArray(R.array)) {
                    out.live.round.clanRows = tag(R.array, url, 'data.array', 'high');
                }
            }

            // ---- /api/nft-game/rewards-by-user : reward history (HAR) ----
            if (/\/nft-game\/rewards-by-user/i.test(url) && d.data && Array.isArray(d.data.array)) {
                out.live.sources.rewardsByUser = url;
                const items = d.data.array;
                // Merge across multiple paginated captures (dedupe by roundId).
                const existing = (out.live.rewards.clanRewardsItems && out.live.rewards.clanRewardsItems.value) || [];
                const byKey = new Map();
                for (const it of existing) byKey.set(it.roundId ?? JSON.stringify(it), it);
                for (const it of items)    byKey.set(it.roundId ?? JSON.stringify(it), it);
                const merged = Array.from(byKey.values()).sort((a,b) =>
                    (b.createdAt || '').localeCompare(a.createdAt || ''));
                out.live.rewards.clanRewardsItems = tag(merged, url, 'data.array', 'high');
                out.live.rewards.clanRewardsCount = tag(d.data.count, url, 'data.count', 'high');

                // Compute current-cycle clan BTC total (sum non-null btcValue for the most recent cycleId)
                if (merged.length) {
                    const latestCycle = merged
                        .map(r => r.cycleId)
                        .filter(c => c !== undefined && c !== null)
                        .sort((a,b) => b - a)[0];
                    if (latestCycle !== undefined) {
                        const cycleRows = merged.filter(r => r.cycleId === latestCycle);
                        const cycleBtc  = cycleRows.reduce((s,r) => s + (Number(r.btcValue) || 0), 0);
                        out.live.rewards.currentCycleId           = tag(latestCycle, url, 'data.array[].cycleId (max)',          'high');
                        out.live.rewards.currentCycleClanRounds   = tag(cycleRows.length, url, 'data.array[].cycleId==max count', 'high');
                        out.live.rewards.currentCycleClanBtcTotal = tag(cycleBtc, url, 'sum(data.array[].btcValue) where cycleId==max', 'medium');
                    }
                }
            }

            // ---- /api/nft-game/get-total-reward-by-user : totals (HAR) ----
            if (/\/nft-game\/get-total-reward-by-user/i.test(url) && d.data && typeof d.data === 'object') {
                out.live.sources.totalRewards = url;
                const T = d.data;
                if (T.depositBtc !== undefined)            out.live.rewards.totalDepositBtc           = tag(T.depositBtc,           url, 'data.depositBtc',           'high');
                if (T.depositGmtFund !== undefined)        out.live.rewards.totalDepositGmtFund       = tag(T.depositGmtFund,       url, 'data.depositGmtFund',       'medium');
                if (T.depositGmtFundOwner !== undefined)   out.live.rewards.totalDepositGmtFundOwner  = tag(T.depositGmtFundOwner,  url, 'data.depositGmtFundOwner',  'medium');
            }

            // ---- /api/nft-game/nft-game-bot/index : bot rules (HAR) ----
            if (/\/nft-game\/nft-game-bot\/index/i.test(url) && d.data && Array.isArray(d.data.array)) {
                out.live.sources.botConfig = url;
                out.live.boosts.botRules = tag(d.data.array, url, 'data.array', 'high');
            }

            // ---- /api/nft-game/nft-game-bot-balance/get-my : bot GMT balance (HAR) ----
            if (/\/nft-game\/nft-game-bot-balance\/get-my/i.test(url) && d.data && d.data.valueNumeric !== undefined) {
                out.live.sources.botBalance = url;
                const raw = d.data.valueNumeric;
                const gmt = Number(raw) / 1e18;
                out.live.boosts.botBalanceRaw = tag(raw, url, 'data.valueNumeric', 'high');
                out.live.boosts.botBalanceGmt = tag(gmt, url, 'Number(data.valueNumeric)/1e18', 'high');
            }

            // ---- /api/exchanges/getPrice : BTC price (HAR) ----
            if (/\/exchanges\/getPrice/i.test(url) && d.data !== undefined) {
                out.live.sources.prices = url;
                // The HAR shows the response is { data: <number> } when symbol=BTC.
                if (typeof d.data === 'number') {
                    if (/symbol=BTC/i.test(url) || !out.live.prices.btcUsd) {
                        out.live.prices.btcUsd = tag(d.data, url, 'data', 'high');
                    }
                }
            }

            // ---- /api/action/get-maintenance-state : service-button click state (HAR) ----
            if (/\/action\/get-maintenance-state/i.test(url) && d.data && typeof d.data === 'object') {
                out.live.sources.maintenanceState = url;
                const S = d.data;
                if (S.userId !== undefined)               out.live.user.userId                 = out.live.user.userId || tag(S.userId, url, 'data.userId', 'high');
                if (S.name)                               out.live.serviceState.name           = tag(S.name,             url, 'data.name',                'high');
                if (S.value !== undefined)                out.live.serviceState.value          = tag(S.value,            url, 'data.value',               'high');
                if (S.lastUpdatedAt)                      out.live.serviceState.lastUpdatedAt  = tag(S.lastUpdatedAt,    url, 'data.lastUpdatedAt',       'high');
                if (S.updateAvailableFrom)                out.live.serviceState.updateAvailableFrom = tag(S.updateAvailableFrom, url, 'data.updateAvailableFrom', 'high');
            }

            // ---- /api/nft-game-ability/find-many : full spell catalog ----
            if (/\/nft-game-ability\/find-many/i.test(url) && d.data && Array.isArray(d.data.array)) {
                // Filter to currently-active abilities (availableTo in the future)
                const now = Date.now();
                const active = d.data.array.filter(a => {
                    if (!a.enabled) return false;
                    const to = a.availableTo ? Date.parse(a.availableTo) : Infinity;
                    const from = a.availableFrom ? Date.parse(a.availableFrom) : 0;
                    return to > now && from <= now;
                });
                // Only overwrite abilities[] from this endpoint if currentRound didn't supply them
                if (!out.abilities.length) {
                    out.abilities = active.map(a => ({
                        id: a.id,
                        type: a.type,
                        subtype: a.subtype,
                        name: a.name,
                        description: a.description,
                        priceInGMT: a.priceInGMT,
                        data: a.data,
                        availableFrom: a.availableFrom,
                        availableTo: a.availableTo,
                    }));
                }
            }
        }

        // After pass 1: if we know the user's leagueId but didn't grab a
        // round-scoped multConfig, pull it from allLeagues[].
        // Resolve our leagueId from any source (positions endpoint > clan detail > legacy clan).
        const myLeagueId =
            (out.live.league.leagueId && out.live.league.leagueId.value) ||
            (out.live.clan.leagueId   && out.live.clan.leagueId.value) ||
            out.clan.leagueId ||
            (out.rank && out.rank.leagueId);

        if (!out.roundMultConfig && myLeagueId != null && out.allLeagues.length) {
            const myLeague = out.allLeagues.find(L => L.id === myLeagueId);
            if (myLeague) {
                out.roundMultConfig = myLeague.multConfig.slice();
                // Also mirror league name/level into out.league for the dashboard
                out.league.name = out.league.name || myLeague.name;
                out.league.level = out.league.level || myLeague.level;
                out.league.totalClansCount = out.league.totalClansCount || myLeague.totalClansCount;
            }
        }
        // Mirror multiplier table into the normalized live shape for the calculator.
        if (myLeagueId != null && out.allLeagues.length) {
            const myLeague = out.allLeagues.find(L => L.id === myLeagueId);
            if (myLeague) {
                if (!out.live.league.leagueId)               out.live.league.leagueId               = tag(myLeagueId, out.live.sources.leagueIndex || out.live.sources.positions, 'matched-league', 'high');
                if (myLeague.name)                           out.live.league.leagueName             = out.live.league.leagueName     || tag(myLeague.name,                   out.live.sources.leagueIndex, 'data.array[id=leagueId].name',                   'high');
                if (myLeague.level !== undefined)            out.live.league.level                  = out.live.league.level          || tag(myLeague.level,                  out.live.sources.leagueIndex, 'data.array[id=leagueId].level',                  'high');
                if (myLeague.totalClansCount !== undefined)  out.live.league.totalClansCount        = out.live.league.totalClansCount|| tag(myLeague.totalClansCount,        out.live.sources.leagueIndex, 'data.array[id=leagueId].totalClansCount',        'high');
                if (myLeague.isDynamicClansMovement !== undefined) out.live.league.isDynamicClansMovement = tag(myLeague.isDynamicClansMovement, out.live.sources.leagueIndex, 'data.array[id=leagueId].isDynamicClansMovement', 'high');
                if (myLeague.promotionToLeagueId !== undefined)    out.live.league.promotionToLeagueId    = tag(myLeague.promotionToLeagueId,    out.live.sources.leagueIndex, 'data.array[id=leagueId].promotionToLeagueId',    'high');
                if (myLeague.relegationToLeagueId !== undefined)   out.live.league.relegationToLeagueId   = tag(myLeague.relegationToLeagueId,   out.live.sources.leagueIndex, 'data.array[id=leagueId].relegationToLeagueId',   'high');
                if (Array.isArray(myLeague.multConfig) && myLeague.multConfig.length) {
                    out.live.league.roundMultiplierConfig = tag(myLeague.multConfig.slice(), out.live.sources.leagueIndex, 'data.array[id=leagueId].roundMultiplierConfig', 'high');
                    out.live.league.maxMultiplier = tag(
                        myLeague.multConfig.reduce((m,x) => Math.max(m, x.v || 0), 0),
                        out.live.sources.leagueIndex, 'max(data.array[id=leagueId].roundMultiplierConfig.v)', 'high');
                }
            }
        }
        // Fallback: if round-state didn't populate live.round but legacy did, mirror it.
        if (!out.live.round.myClanRound && out.currentRound && out.currentRound.yourScore !== undefined) {
            out.live.round.myClanRound = tag({
                rank:              null,
                winChance:         null,
                power:             out.currentRound.yourPower,
                currentAddedScore: out.currentRound.yourScore,
            }, out.live.sources.roundState || '/api/nft-game-round/find-current', 'data.userState (legacy fallback)', 'medium');
        }

        // Prices: GMT comes from the main extractor's DATA.prices fallback (not in
        // this HAR). If we have it, surface it normalized too.
        if (DATA.prices && DATA.prices.gmtPriceInternal) {
            out.live.prices.gmtUsd = tag(DATA.prices.gmtPriceInternal,
                DATA.prices.source || 'getTokenPrice/home-page',
                'derived from solo-mining capture', 'medium');
        }
        if (DATA.prices && DATA.prices.btcPriceInternal && !out.live.prices.btcUsd) {
            out.live.prices.btcUsd = tag(DATA.prices.btcPriceInternal,
                DATA.prices.source || 'home-page',
                'derived from solo-mining capture', 'medium');
        }

        // ===== PASS 2: legacy best-effort field hunting (kept for resilience) =====
        // If precise parsing missed something, fall back to recursive key search.
        for (const r of Object.values(DATA.wars)) {
            const d = r.data;
            if (!d) continue;

            // ---- Clan ----
            out.clan.id          = out.clan.id          || findField(d, ['clanid','clan_id']);
            out.clan.name        = out.clan.name        || findField(d, ['clanname','clan_name']);
            out.clan.totalTh     = out.clan.totalTh     || findField(d, ['clantotalth','clan_total_th','clanpower','totalpower','totaltth','totalhashrate','clanhashrate']);
            out.clan.memberCount = out.clan.memberCount || findField(d, ['membercount','members','membersnumber','clansize']);
            out.clan.score       = out.clan.score       || findField(d, ['clanscore','clan_score','currentscore']);
            out.clan.rank        = out.clan.rank        || findField(d, ['clanrank','rank','position']);

            // ---- League ----
            out.league.id        = out.league.id        || findField(d, ['leagueid','league_id','leaguename','leaguetier','leaguelevel']);
            out.league.totalTh   = out.league.totalTh   || findField(d, ['leaguetotalth','league_total_th','leaguepower','leaguehashrate']);
            out.league.avgWth    = out.league.avgWth    || findField(d, ['leagueaveragewth','averagewth','avg_w_per_th','leagueavgw']);
            out.league.prizeFundBtc = out.league.prizeFundBtc || findField(d, ['prizefundbtc','rewardfundbtc','prizefund','prize_fund','rewardfund','reward_fund','poolreward','poolprize']);
            out.league.prizeFundGmt = out.league.prizeFundGmt || findField(d, ['prizefundgmt','rewardfundgmt','gmtfund','gmt_fund']);
            out.league.maxMult   = out.league.maxMult   || findField(d, ['maxmultiplier','max_multiplier','multipliercap']);

            // ---- You ----
            out.you.basePps      = out.you.basePps      || findField(d, ['basepps','base_pps','baseppspoint']);
            out.you.boostedPps   = out.you.boostedPps   || findField(d, ['boostedpps','boosted_pps','currentpps']);
            out.you.score        = out.you.score        || findField(d, ['userscore','my_score','score','roundscore','playerscore']);

            // ---- Cycle / round timing ----
            out.cycle.startAt    = out.cycle.startAt    || findField(d, ['cyclestart','cycle_start','roundstart','round_start','weekstart','startedat','started_at']);
            out.cycle.endAt      = out.cycle.endAt      || findField(d, ['cycleend','cycle_end','roundend','round_end','weekend','endsat','ends_at','finishesat']);
            out.cycle.roundId    = out.cycle.roundId    || findField(d, ['roundid','round_id','cycleid','cycle_id']);

            // ---- Cumulative this cycle ----
            out.cycleSoFar.clanBlocksWon = Math.max(out.cycleSoFar.clanBlocksWon,
                +findField(d, ['clanblockswon','clan_blocks_won','blockswon','blocks_won','totalblocks']) || 0);
            out.cycleSoFar.clanBtcWon = Math.max(out.cycleSoFar.clanBtcWon,
                +findField(d, ['clanbtcwon','clan_btc_won','accumulatedbtc','btcaccumulated','btc_so_far','rewardsoFarBtc']) || 0);
            out.cycleSoFar.yourBtcWon = Math.max(out.cycleSoFar.yourBtcWon,
                +findField(d, ['yourbtcwon','user_btc_won','myrewardbtc','my_btc_so_far']) || 0);
            out.cycleSoFar.yourGmtWon = Math.max(out.cycleSoFar.yourGmtWon,
                +findField(d, ['yourgmtwon','user_gmt_won','myrewardgmt','my_gmt_so_far','personalgmt']) || 0);

            // ---- Recent blocks history ----
            const allBlocks = findArray(d, ['blocks','recentblocks','recent_blocks','blockhistory','wins','rounds','blockwins']);
            if (Array.isArray(allBlocks)) {
                allBlocks.forEach(b => {
                    if (!b || typeof b !== 'object') return;
                    const ts   = findField(b, ['createdat','timestamp','time','date','foundat']);
                    const mult = findField(b, ['multiplier','mult','reward_multiplier','blockmultiplier']);
                    const btc  = findField(b, ['btc','btcamount','btcreward','btc_amount','rewardbtc']);
                    const gmt  = findField(b, ['gmt','gmtamount','gmtreward','gmt_amount','rewardgmt']);
                    const isPersonal = findField(b, ['personal','ispersonal','is_personal','personalwin']);
                    const entry = { ts, mult, btc, gmt };
                    if (isPersonal || (gmt && !btc))      out.recentPersonal.push(entry);
                    else if (btc !== null && btc !== undefined) out.recentBlocks.push(entry);
                });
            }
        }
        return out;
    }

    // === Init ===
    createPanel();
    log('Extension GoMining Extractor démarrée');

    // Auto-scan après 3 secondes
    setTimeout(() => {
        const domData = scanDOM();
        DATA.dom = domData;
        updateDomDisplay(domData);
        log('Auto-scan initial');
    }, 3000);

})();
