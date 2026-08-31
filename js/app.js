        // ===== STATE =====
        let state = {
            btcPrice: 0,
            gmtPrice: 0,
            difficulty: 0,
            networkHashrate: 0, // in GH/s
            customBtcPrices: [],
            lastCalc: null,
            currency: 'usd', // 'usd', 'btc', 'gmt'
            walletMode: 'btc', // 'btc', 'gmt', 'cash' — toggle on the unified Wallet KPI card
            rewardHistory: [], // loaded from localStorage on init
            costPerTH: 0, // upgrade cost per TH from /nft/get-power-upgrade-info (extension sync)
            feeMode: 'gmt', // 'gmt' = pay fees in GMT (token discount applies) | 'btc' = pay in BTC (no token discount)
            discountFromApi: false, // true when extension synced the real discount; blocks the local prepaid-days heuristic from overwriting it
            apiPrepaidDays: null    // /get-my-nft-discount → discountAvailableDays. Authoritative: includes locked GMT, uses GoMining's own price + fee formula.
        };
        // Expose `state` on window so the redesign hero scripts (declared
        // in a separate <script> block at the end of body) can read
        // rewardHistory / btcPrice / gmtPrice for real data charts.
        // Same object reference, so live mutations stay in sync.
        window.state = state;

        const FEE_MODE_KEY = 'gomining_fee_mode';

        function setFeeMode(mode) {
            state.feeMode = mode;
            try { localStorage.setItem(FEE_MODE_KEY, mode); } catch(e) {}
            document.querySelectorAll('.fee-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll(`.fee-btn[data-fee="${mode}"]`).forEach(b => b.classList.add('active'));
            // Recalculate everything: token discount changes, total discount changes, all results change
            calcTotalDiscount();
            if (typeof calculate === 'function') calculate();
        }

        function loadFeeMode() {
            try {
                const m = localStorage.getItem(FEE_MODE_KEY);
                if (m === 'btc' || m === 'gmt') state.feeMode = m;
            } catch(e) {}
            document.querySelectorAll('.fee-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll(`.fee-btn[data-fee="${state.feeMode}"]`).forEach(b => b.classList.add('active'));
        }

        function setCurrency(cur) {
            state.currency = cur;
            document.querySelectorAll('.cur-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll(`.cur-btn[data-cur="${cur}"]`).forEach(b => b.classList.add('active'));
            if (state.lastCalc) {
                calculate();
            }
        }

        function formatVal(btcAmount, btcPrice, gmtAmount) {
            if (state.currency === 'btc') {
                return btcAmount.toFixed(8) + ' BTC';
            } else if (state.currency === 'gmt') {
                const gmt = gmtAmount !== undefined ? gmtAmount : (btcAmount * btcPrice) / state.gmtPrice;
                return formatNumber(gmt) + ' GMT';
            } else {
                return formatUSD(btcAmount * btcPrice);
            }
        }

        // Profit display: BTC = brut (fees payés en GMT séparément), USD/GMT = net
        function formatProfit(netBtc, btcPrice, netGmt, grossBtc) {
            if (state.currency === 'btc') {
                return (grossBtc !== undefined ? grossBtc : netBtc).toFixed(8) + ' BTC';
            } else if (state.currency === 'gmt') {
                return formatNumber(netGmt) + ' GMT';
            } else {
                return formatUSD(netBtc * btcPrice);
            }
        }

        const SERVICE_COST_PER_TH = 0.0089; // $/TH/day
        const ELEC_COST_DEFAULT = 0.05; // $/kWh

        // Power levels from GoMining API (get-power-upgrade-info)
        const POWER_LEVELS = [0, 1, 2, 4, 8, 16, 32, 48, 64, 96, 128, 192, 256, 384, 512, 768, 1024, 1536, 2560, 3584, 5000];

        // Current upgrade price: $12.34/TH direct (confirmed from app screenshot)
        // Reinvest rate: ~$11/TH (from reward → TH conversion, with 5% bonus = ~$10.48 effective)
        const UPGRADE_PRICE_DIRECT = 12.34;

        // Marketplace TH prices from API (for buying new miners)
        const MARKETPLACE_PRICES = [
            { power: 1, pricePerTh: 25.82 },
            { power: 4, pricePerTh: 22.54 },
            { power: 8, pricePerTh: 22.92 },
            { power: 16, pricePerTh: 23.31 },
            { power: 32, pricePerTh: 21.93 },
            { power: 64, pricePerTh: 21.40 },
            { power: 128, pricePerTh: 20.98 }
        ];

        function getCurrentLevel(power) {
            for (let i = POWER_LEVELS.length - 1; i >= 0; i--) {
                if (power >= POWER_LEVELS[i]) return i;
            }
            return 0;
        }

        function getNextLevelTH(currentPower) {
            const level = getCurrentLevel(currentPower);
            if (level >= POWER_LEVELS.length - 1) return null;
            return POWER_LEVELS[level + 1];
        }

        // Paliers discount maintenance GMT (jours prépayés → %)
        // Interpolation linéaire entre les paliers
        // Paliers réels GoMining (confirmés par screenshots)
        // Pattern: <18j = 0%, puis ~1% par 18 jours, cap 20% à 360j
        // Confirmé: 115j=6%, 162j=8%, 180j=9%, 198j=10%, 360j=20%
        function getMaintenanceDiscount(prepaidDays) {
            if (prepaidDays < 18) return 0;
            if (prepaidDays >= 360) return 20;
            // Linéaire de 18j(0%) à 360j(20%), arrondi entier (GoMining n'a que des % entiers)
            return Math.round((prepaidDays - 18) / (360 - 18) * 20);
        }

        function calcTotalDiscount() {
            const maint = parseFloat(document.getElementById('discount-maintenance').value) || 0;
            const vip = parseFloat(document.getElementById('discount-vip').value) || 0;
            const streak = parseFloat(document.getElementById('discount-streak').value) || 0;
            const solo = parseFloat(document.getElementById('discount-solo').value) || 0;
            // Token (maintenance) discount only applies when paying fees in GMT.
            // If user pays in BTC, they lose the token discount but keep VIP/streak/mining-mode.
            const effectiveMaint = state.feeMode === 'btc' ? 0 : maint;
            const total = effectiveMaint + vip + streak + solo;
            document.getElementById('discount').value = total.toFixed(2);
            const dd = document.getElementById('discount-display');
            if (dd) dd.textContent = total.toFixed(2) + '%';

            // Show the fee mode impact hint
            const hint = document.getElementById('discount-fee-mode-hint');
            if (hint) {
                if (state.feeMode === 'btc') {
                    if (maint > 0) {
                        hint.innerHTML = `⚠ <strong>Fee mode: BTC</strong> — Token discount of <strong>${maint.toFixed(2)}%</strong> removed. Remaining: ${total.toFixed(2)}% (VIP ${vip.toFixed(1)}% + Streak ${streak.toFixed(1)}% + Mining mode ${solo.toFixed(2)}%)`;
                    } else {
                        hint.innerHTML = `⚠ <strong>Fee mode: BTC</strong> — Pay fees in BTC. Token discount doesn't apply (none configured). VIP/Streak/Mining-mode still apply: ${total.toFixed(2)}%`;
                    }
                    hint.style.display = 'block';
                    hint.style.borderLeftColor = 'var(--accent)';
                    hint.style.background = 'rgba(247,147,26,0.06)';
                } else {
                    hint.innerHTML = `✓ <strong>Fee mode: GMT</strong> — All discounts apply. Token ${maint.toFixed(2)}% + VIP ${vip.toFixed(1)}% + Streak ${streak.toFixed(1)}% + Mining mode ${solo.toFixed(2)}% = ${total.toFixed(2)}%`;
                    hint.style.display = 'block';
                    hint.style.borderLeftColor = 'var(--purple)';
                    hint.style.background = 'rgba(188,140,255,0.06)';
                }
            }
            return total;
        }

        // Calculer les jours prépayés et le discount maintenance auto
        function updatePrepaidDiscount() {
            // If the extension synced the real discount from the API, trust it.
            // The local prepaid-days heuristic disagrees with GoMining's actual
            // logic (which factors in collection / VIP / Bonus miner credits beyond
            // a simple GMT-balance/days calculation), so don't overwrite a real value.
            if (state.discountFromApi) return;
            const gmtWallet = parseFloat(document.getElementById('gmt-prepaid').value) || 0;
            const gmtLocked = parseFloat(document.getElementById('gmt-locked').value) || 0;
            const totalGmt = gmtWallet + gmtLocked;
            const hashrate = parseFloat(document.getElementById('hashrate').value) || 1;
            const efficiency = parseFloat(document.getElementById('efficiency').value) || 15;
            const elecCost = parseFloat(document.getElementById('elec-cost').value) || 0.05;
            const gp = state.gmtPrice;
            if (!gp) return;

            // GoMining calcule les jours prépayés en utilisant les frais APRÈS
            // streak + VIP + mining mode discounts, mais AVANT token discount.
            // C'est parce que le token discount dépend des jours (circulaire sinon).
            const vip = parseFloat(document.getElementById('discount-vip').value) || 0;
            const streak = parseFloat(document.getElementById('discount-streak').value) || 0;
            const solo = parseFloat(document.getElementById('discount-solo').value) || 0;
            const nonTokenDiscount = (vip + streak + solo) / 100;

            const c1PerDay = (elecCost * 24 * efficiency / gp / 1000) * hashrate;
            const c2PerDay = (SERVICE_COST_PER_TH / gp) * hashrate;
            const dailyFeesGmt = (c1PerDay + c2PerDay) * (1 - nonTokenDiscount);

            if (dailyFeesGmt > 0) {
                const prepaidDays = Math.floor(totalGmt / dailyFeesGmt);
                const maintDiscount = getMaintenanceDiscount(prepaidDays);
                document.getElementById('discount-maintenance').value = maintDiscount.toFixed(1);
                calcTotalDiscount();
            }
        }

        // ===== ARBITRAGE SAISIE MANUELLE / EXTENSION =====
        //
        // Les deux sources doivent coexister sans que l'une écrase l'autre en
        // silence. Avant, l'extension gagnait toujours : elle réécrivait le
        // champ à chaque synchro, donc une valeur tapée à la main disparaissait
        // sans un mot. Maintenant qu'on peut utiliser le simulateur sans compte
        // ni extension, ça devient inacceptable dans les deux sens.
        //
        // Règle : un champ que l'utilisateur a modifié À LA MAIN est « épinglé »
        // et la synchro ne le touche plus. Mais elle ne se tait pas non plus —
        // elle signale qu'elle a une valeur différente et propose de basculer.
        // Le conflit est montré, jamais tranché à l'insu de la personne.
        //
        // Une écriture programmatique de .value ne déclenche PAS d'événement
        // 'input', donc l'écouteur ne voit que les frappes humaines. C'est ce
        // qui rend la distinction fiable sans drapeau à poser partout.
        const PIN_KEY = 'gms_pinned_fields';
        const ARBITRATED = ['hashrate', 'efficiency', 'elec-cost', 'sat-per-th'];
        let pinnedFields = new Set();
        try {
            const raw = JSON.parse(localStorage.getItem(PIN_KEY));
            if (Array.isArray(raw)) pinnedFields = new Set(raw.filter(x => ARBITRATED.includes(x)));
        } catch (e) {}
        // Ce que la synchro AURAIT écrit dans un champ épinglé, pour pouvoir
        // l'offrir au lieu de le perdre.
        const syncPending = {};

        function savePins() {
            try { localStorage.setItem(PIN_KEY, JSON.stringify([...pinnedFields])); } catch (e) {}
        }

        // Écriture par une source automatique : extension, mempool, API GoMining.
        // Retourne true si le champ a été écrit.
        function syncField(id, value) {
            const el = document.getElementById(id);
            if (!el || value === undefined || value === null || value === '') return false;
            if (pinnedFields.has(id)) {
                const same = Math.abs((parseFloat(el.value) || 0) - (parseFloat(value) || 0)) < 1e-9;
                if (same) { delete syncPending[id]; }
                else { syncPending[id] = value; }
                renderPinNotice();
                return false;
            }
            el.value = value;
            delete syncPending[id];
            renderPinNotice();
            return true;
        }

        function pinField(id) {
            if (!ARBITRATED.includes(id) || pinnedFields.has(id)) return;
            pinnedFields.add(id);
            savePins();
            renderPinNotice();
        }

        // Rendre la main à la synchro sur tous les champs.
        function unpinAll() {
            pinnedFields.clear();
            savePins();
            for (const [id, v] of Object.entries(syncPending)) {
                const el = document.getElementById(id);
                if (el) el.value = v;
                delete syncPending[id];
            }
            renderPinNotice();
            try { saveSettings(); calculate(); } catch (e) {}
        }

        let pinNoticeDismissed = false;
        function keepMine() { pinNoticeDismissed = true; renderPinNotice(); }

        const FIELD_LABELS = {
            'hashrate': () => t('dh_hashrate', 'hashrate'),
            'efficiency': () => t('lbl_efficiency', 'efficiency'),
            'elec-cost': () => t('lbl_elec', 'electricity'),
            'sat-per-th': () => t('dh_pool_reward', 'Pool Reward'),
        };

        function renderPinNotice() {
            const el = document.getElementById('pin-notice');
            if (!el) return;
            const ids = Object.keys(syncPending);
            if (!ids.length || pinNoticeDismissed) { el.hidden = true; return; }
            el.hidden = false;
            el.className = 'price-origin price-origin--warn';
            const list = ids.map(id => {
                const cur = document.getElementById(id)?.value;
                return `${(FIELD_LABELS[id] || (() => id))()} ${cur} → ${syncPending[id]}`;
            }).join(' · ');
            el.innerHTML = `${t('pin_conflict', 'Your extension reports different values than the ones you typed:')} `
                + `<strong>${list}</strong> `
                + `<button type="button" class="pin-btn" onclick="unpinAll()">${t('pin_use_ext', 'Use extension data')}</button> `
                + `<button type="button" class="pin-btn pin-btn--ghost" onclick="keepMine()">${t('pin_keep_mine', 'Keep mine')}</button>`;
        }

        // Auto-update discount quand les champs changent
        document.addEventListener('input', function(e) {
            // Une frappe humaine épingle le champ : la synchro ne l'écrasera plus.
            if (ARBITRATED.includes(e.target.id)) pinField(e.target.id);
            const discountFields = ['discount-maintenance', 'discount-vip', 'discount-streak', 'discount-solo'];
            if (discountFields.includes(e.target.id)) {
                calcTotalDiscount();
            }
            if (['gmt-prepaid', 'gmt-locked', 'hashrate', 'efficiency', 'elec-cost'].includes(e.target.id)) {
                updatePrepaidDiscount();
            }
        });
        const BLOCK_REWARD = 3.125;
        const BLOCKS_PER_DAY = 144;

        // ===== FETCH LIVE DATA =====
        async function fetchLiveData() {
            const btn = document.querySelector('.refresh-btn');
            btn.classList.add('loading');
            btn.innerHTML = '<span class="spinner"></span> ' + t('loading');

            try {
                // Fetch each independently so one failure doesn't break all
                let prices = {}, rewardData = null, hashData = null;
                let binanceBtc = null;

                // Binance public API — real-time spot price, ~1-2s lag.
                // Try it first; CoinGecko (slower, 1-2 min lag) is the fallback.
                try {
                    const binResp = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT');
                    if (binResp.ok) {
                        const j = await binResp.json();
                        binanceBtc = parseFloat(j.price);
                    }
                } catch(e) { console.warn('Binance BTC fetch failed:', e); }

                try {
                    const priceResp = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,gmt-token&vs_currencies=usd&include_24hr_change=true');
                    prices = await priceResp.json();
                } catch(e) { console.warn('CoinGecko fetch failed:', e); }

                try {
                    const rewardResp = await fetch('https://mempool.space/api/v1/mining/reward-stats/144');
                    rewardData = await rewardResp.json();
                } catch(e) { console.warn('Mempool reward-stats fetch failed:', e); }

                try {
                    const hashResp = await fetch('https://mempool.space/api/v1/mining/hashrate/1w');
                    hashData = await hashResp.json();
                } catch(e) { console.warn('Mempool hashrate fetch failed:', e); }

                // Prix de repli, en DERNIER recours seulement. Ils étaient
                // maintenus à la main — « updated 2026-05-07 » — et servis en
                // silence : si les quatre API échouaient, l'app rendait un
                // dashboard complet, profit, ROI et projections comprises, sur
                // un prix inventé, sans que rien ne le dise. Même faute que le
                // prix du TH figé à 12,34 $ pendant des mois.
                //
                // On garde le repli — un simulateur inutilisable ne vaut pas
                // mieux — mais on TRACE l'origine de chaque prix et on le dit
                // à l'écran. Un chiffre inventé ne doit jamais ressembler à
                // une mesure.
                const FALLBACK_BTC = 80000;
                const FALLBACK_GMT = 0.30;

                // Dernier prix connu, persisté entre les sessions. Sans ça,
                // « en cache » n'existait pas : un rechargement hors-ligne
                // tombait directement sur le prix inventé.
                let cached = null;
                try { cached = JSON.parse(localStorage.getItem(PRICE_CACHE_KEY)); } catch (e) {}
                const cacheAgeMs = cached?.t ? Date.now() - cached.t : null;

                const pick = (live, liveName, cachedVal, fallback) => {
                    if (live) return { value: live, source: liveName };
                    if (cachedVal) return { value: cachedVal, source: 'cached' };
                    return { value: fallback, source: 'fallback' };
                };
                const btcPick = binanceBtc
                    ? { value: binanceBtc, source: 'binance' }
                    : pick(prices.bitcoin?.usd, 'coingecko',
                           state.btcPrice || cached?.btc, FALLBACK_BTC);
                const gmtPick = pick(prices['gmt-token']?.usd, 'coingecko',
                                     state.gmtPrice || cached?.gmt, FALLBACK_GMT);

                state.btcPrice = btcPick.value;
                state.gmtPrice = gmtPick.value;
                state.priceOrigin = {
                    btc: btcPick.source, gmt: gmtPick.source,
                    // L'âge ne veut dire quelque chose que pour un prix en cache.
                    ageMs: (btcPick.source === 'cached' || gmtPick.source === 'cached') ? cacheAgeMs : null,
                    mempool: !!(hashData && rewardData),
                };
                // Ne mémoriser QUE des prix réellement obtenus : mettre un prix
                // de repli en cache le transformerait en « dernier prix connu »
                // à la visite suivante, et le mensonge deviendrait permanent.
                if (btcPick.source !== 'fallback' && btcPick.source !== 'cached'
                    && gmtPick.source !== 'fallback') {
                    try {
                        localStorage.setItem(PRICE_CACHE_KEY, JSON.stringify({
                            btc: state.btcPrice, gmt: state.gmtPrice, t: Date.now()
                        }));
                    } catch (e) {}
                }
                // apiGmtPrice is kept separately for sat/TH conversion only

                // Network hashrate from mempool.space (in H/s)
                // Calculate sat/TH from mempool data if available
                if (hashData && rewardData) {
                    state.networkHashrate = hashData.currentHashrate || 0;
                    const hashrateTH = state.networkHashrate / 1e12;
                    const numBlocks = rewardData.endBlock - rewardData.startBlock + 1;
                    const avgRewardPerBlock = parseInt(rewardData.totalReward) / numBlocks;
                    const dailyRewardSat = avgRewardPerBlock * 144;
                    if (hashrateTH > 0) {
                        const mempoolSatPerTH = Math.round(dailyRewardSat / hashrateTH);
                        // Ne pas écraser le sat/TH de l'API GoMining (plus précis)
                        if (!state.apiSatPerTH) {
                            state.satPerTH = mempoolSatPerTH;
                            syncField('sat-per-th', state.satPerTH);
                        }
                        state.mempoolSatPerTH = mempoolSatPerTH; // garder pour référence
                    }
                }

                // Display
                if (state.btcPrice) document.getElementById('btc-price').textContent = formatUSD(state.btcPrice);
                if (state.gmtPrice) {
                    document.getElementById('gmt-price').textContent = '$' + state.gmtPrice.toFixed(4);
                }
                renderPriceOrigin();
                if (typeof updateStrategyPriceHints === 'function') updateStrategyPriceHints();
                if (state.networkHashrate) {
                    const ehps = state.networkHashrate / 1e18;
                    document.getElementById('net-difficulty').textContent = ehps.toFixed(1) + ' EH/s';
                }
                if (state.satPerTH) {
                    document.getElementById('net-hashrate').textContent = state.satPerTH + ' PR';
                }

                const now = new Date();
                document.getElementById('last-update').textContent =
                    t('last_update') + ': ' + now.toLocaleTimeString(currentLang === 'fr' ? 'fr-FR' : 'en-US');

                // Auto-calculate after data loads
                updatePrepaidDiscount();
                // Force API sat/TH if available (prevents mempool from overriding)
                if (state.apiSatPerTH) {
                    syncField('sat-per-th', state.apiSatPerTH);
                    state.satPerTH = state.apiSatPerTH;
                }
                calculate();
                checkPriceAlerts();
                updateEmptyState();

            } catch (e) {
                console.error('Erreur fetch:', e);
            }

            btn.classList.remove('loading');
            btn.innerHTML = '&#x21bb; ' + t('refresh_data');
        }

        // ===== CORE CALCULATIONS =====
        // Formules exactes GoMining (par TH/jour) :
        // PR (pool reward) = sat/TH en satoshis (input utilisateur)
        // C1 (électricité) = kWh * 24 * W/TH / GMT_price / 1000 * (1 - discount)
        // C2 (service)     = 0.0089 / GMT_price * (1 - discount)
        // Reward/TH        = PR_gmt - C1 - C2
        // gbpSat / commissionRate sont facultatifs et valent 0 par défaut : tous les
        // appels existants gardent exactement leur comportement.
        //
        // Ils viennent de la formule que GoMining affiche lui-même :
        //   net sat = PR + GBP − C1 − C2
        //   GMT crédité = (net BTC − commission de réinvestissement) × BTC / GMT
        // Vérifié au centième de pourcent sur une journée réelle : 690,32 TH,
        // 50,0509 PR, 15 W/TH, $0,05/kWh, 5,69 % → 28,7417 GMT, exactement ce que
        // GoMining a crédité. Le GBP pèse +0,031 %, la commission −2,25 % — c'est
        // elle qui faisait surestimer le gain de tout utilisateur réinvestissant
        // en GMT.
        function calcDailyReward(hashrateTH, efficiencyWTH, elecCostKwh, discountPct, btcPrice, satPerTH,
                                 gbpSatPerTh, reinvestCommissionRate) {
            if (!btcPrice || !state.gmtPrice) return null;
            const gmtPrice = state.gmtPrice;
            const discountMult = 1 - discountPct / 100;
            // Ces deux termes décrivent le COMPTE, pas l'appel : on les lit dans
            // `state`, alimenté par la synchro. Les paramètres ne servent que
            // d'override explicite (tests, projections hypothétiques). Sans ça il
            // faudrait les passer à trente sites d'appel, dont on oublierait
            // forcément un.
            const gbpSat = (gbpSatPerTh !== undefined && gbpSatPerTh !== null)
                ? gbpSatPerTh : (state.gbpSatPerTh || 0);
            const commission = (reinvestCommissionRate !== undefined && reinvestCommissionRate !== null)
                ? reinvestCommissionRate : (state.reinvestCommissionRate || 0);

            // PR per TH in GMT — GBP s'ajoute au pool reward, avant les coûts
            const prBtcPerTH = (satPerTH + gbpSat) * 1e-8;
            const prGmtPerTH = prBtcPerTH * btcPrice / gmtPrice;

            // C1: electricity per TH in GMT (after discount)
            const c1GmtPerTH = (elecCostKwh * 24 * efficiencyWTH / gmtPrice / 1000) * discountMult;

            // C2: service per TH in GMT (after discount)
            const c2GmtPerTH = (SERVICE_COST_PER_TH / gmtPrice) * discountMult;

            const feesGmtPerTH = c1GmtPerTH + c2GmtPerTH;
            const netGmtPerTH = prGmtPerTH - feesGmtPerTH;

            // Totals
            const totalPrGmt = prGmtPerTH * hashrateTH;
            const totalFeesGmt = feesGmtPerTH * hashrateTH;
            const totalNetGmt = netGmtPerTH * hashrateTH;

            // Convert to BTC and USD for display
            const grossBtc = totalPrGmt * gmtPrice / btcPrice;
            const feesBtc = totalFeesGmt * gmtPrice / btcPrice;
            const netBtc = totalNetGmt * gmtPrice / btcPrice;

            // La commission de réinvestissement ne s'applique QU'À la conversion
            // en GMT. Le gain en BTC, lui, est intact — quelqu'un qui encaisse en
            // BTC ne la paie jamais. L'appliquer partout ferait diverger le sat/TH
            // de ce que GoMining affiche (17,8844), alors que c'est le montant en
            // GMT qui est réduit (28,7417 au lieu de 29,4033).
            const netGmtCredited = totalNetGmt * (1 - commission);

            // Protection de déficit. GoMining évalue la ferme UNE FOIS PAR JOUR,
            // au moment du paiement, et la ferme si elle est négative — tous
            // frais arrêtés. Le résultat réel d'une journée est donc max(0, net),
            // et une ferme au-delà de son seuil ne perd rien : elle ne gagne rien.
            //
            // On EXPOSE les deux plutôt que de borner en place. Les champs net*
            // gardent leur signe, dont dépendent la recherche du prix BTC de
            // seuil et le calcul du seuil d'efficacité — les borner casserait
            // les deux. Les champs *Paid disent ce qui est réellement crédité,
            // et `paused` dit dans quel régime on est. Chaque affichage choisit :
            // le montant payé est la vérité, le montant théorique dit de combien
            // on est sous l'eau, donc quelle remontée du BTC remet en route.
            const paused = totalNetGmt <= 0;

            return {
                grossBtc,
                grossUsd: totalPrGmt * gmtPrice,
                grossGmt: totalPrGmt,
                feesBtc,
                feesUsd: totalFeesGmt * gmtPrice,
                feesGmt: totalFeesGmt,
                netBtc,
                netUsd: totalNetGmt * gmtPrice,
                netGmt: netGmtCredited,
                netGmtBeforeCommission: totalNetGmt,
                paused,
                netBtcPaid: paused ? 0 : netBtc,
                netUsdPaid: paused ? 0 : totalNetGmt * gmtPrice,
                netGmtPaid: paused ? 0 : netGmtCredited,
                grossBtcPaid: paused ? 0 : grossBtc,
                // Per TH details (sats)
                prSat: satPerTH,
                c1Sat: Math.round(c1GmtPerTH * gmtPrice / btcPrice * 1e8),
                c2Sat: Math.round(c2GmtPerTH * gmtPrice / btcPrice * 1e8),
                rewardSat: Math.round(netGmtPerTH * gmtPrice / btcPrice * 1e8)
            };
        }

        // ===== MINING CALCULATOR =====
        function calculate() {
            const hashrate = parseFloat(document.getElementById('hashrate').value);
            const efficiency = parseFloat(document.getElementById('efficiency').value);
            const elecCost = parseFloat(document.getElementById('elec-cost').value);
            const discount = parseFloat(document.getElementById('discount').value);
            const satPerTH = parseFloat(document.getElementById('sat-per-th').value);
            if (!state.btcPrice || !state.gmtPrice) {
                alert(t('alert_load_data'));
                return;
            }

            const r = calcDailyReward(hashrate, efficiency, elecCost, discount, state.btcPrice, satPerTH);
            if (!r) return;

            state.lastCalc = { hashrate, efficiency, elecCost, discount, satPerTH };

            // Display
            document.getElementById('mining-results').style.display = 'block';
            // Collapse form and show summary
            const colEl = document.getElementById('params-collapsible');
            if (colEl && !colEl.classList.contains('collapsed')) colEl.classList.add('collapsed');
            const sumEl = document.getElementById('params-summary');
            if (sumEl) sumEl.textContent = `${hashrate} TH | ${efficiency} W/TH | ${discount}%`;
            const bp = state.btcPrice;

            document.getElementById('res-gross-btc').textContent = formatVal(r.grossBtc, bp, r.grossGmt);
            document.getElementById('res-gross-usd').textContent = `${r.prSat} sat/TH — ${r.prSat * hashrate} sat total`;

            document.getElementById('res-fees-btc').textContent = '-' + formatVal(r.feesBtc, bp, r.feesGmt);
            document.getElementById('res-fees-usd').textContent = `C1: ${r.c1Sat} sat + C2: ${r.c2Sat} sat /TH`;

            // Ce qui est RÉELLEMENT crédité : zéro quand la protection de déficit
            // met la ferme en pause. Le montant théorique reste affiché juste en
            // dessous — il dit de combien la ferme est sous l'eau, et c'est
            // l'information qui permet de savoir quelle remontée du BTC la
            // remettrait en route. La jeter appauvrirait l'écran.
            const netEl = document.getElementById('res-net-btc');
            netEl.textContent = formatProfit(r.netBtcPaid, bp, r.netGmtPaid, r.grossBtcPaid);
            netEl.className = 'big ' + (r.paused ? 'negative' : 'positive');
            document.getElementById('res-net-usd').textContent = r.paused
                ? `${t('paused_farm', 'Farm paused — GoMining stops all fees')} · ${t('paused_would_be', 'would be')} ${formatUSD(r.netUsd)}/${t('eff_day', 'day')}`
                : `${r.rewardSat} sat/TH/jour (net)`;

            document.getElementById('res-month-btc').textContent = formatProfit(r.netBtcPaid * 30, bp, r.netGmtPaid * 30, r.grossBtcPaid * 30);
            document.getElementById('res-month-usd').textContent = r.paused ? t('paused_short', 'paused') : '';

            document.getElementById('res-year-btc').textContent = formatProfit(r.netBtcPaid * 365, bp, r.netGmtPaid * 365, r.grossBtcPaid * 365);
            document.getElementById('res-year-usd').textContent = r.paused ? t('paused_short', 'paused') : '';

            // === INFO MINEUR ===
            const currentLevel = getCurrentLevel(hashrate);
            const nextLevelTH = getNextLevelTH(hashrate);
            const thToNextLevel = nextLevelTH ? nextLevelTH - hashrate : null;
            const costToNextLevel = thToNextLevel ? thToNextLevel * UPGRADE_PRICE_DIRECT : null;

            // === ZONE DE DANGER ===
            // Trouver le prix BTC breakeven (où net = 0)
            // Formule: PR en BTC * btcPrice = fees en USD
            // fees_usd = ((kWh*24*WTH/1000) + SERVICE) * (1-discount/100) * hashrate
            // gross_usd = satPerTH * 1e-8 * btcPrice * hashrate
            // breakeven: gross_usd = fees_usd (quand les frais en USD = revenu en USD)
            // Mais les frais sont en GMT (divisés par gmtPrice), pas en BTC...
            // On fait une recherche binaire simple
            function findBreakevenBtc() {
                let lo = 1000, hi = 500000;
                for (let i = 0; i < 50; i++) {
                    const mid = (lo + hi) / 2;
                    const test = calcDailyReward(hashrate, efficiency, elecCost, discount, mid, satPerTH);
                    if (!test) return null;
                    if (test.netBtc > 0) hi = mid;
                    else lo = mid;
                }
                return Math.round((lo + hi) / 2);
            }

            const breakevenBtc = findBreakevenBtc();
            const distanceBtc = breakevenBtc ? ((bp - breakevenBtc) / bp * 100).toFixed(1) : null;
            const isClose = distanceBtc && distanceBtc < 20;

            const dangerEl = document.getElementById('danger-zone');
            dangerEl.style.display = 'block';
            dangerEl.innerHTML = `
                <div class="danger-zone-box">
                    <h3>${t('danger_title')}</h3>
                    <div class="danger-levels">
                        <div class="danger-level">
                            <div class="label">${t('danger_current_btc')}</div>
                            <div class="price" style="color:var(--green)">${formatUSD(bp)}</div>
                        </div>
                        <div class="danger-level">
                            <div class="label">${t('danger_breakeven')}</div>
                            <div class="price" style="color:var(--red)">${breakevenBtc ? formatUSD(breakevenBtc) : 'N/A'}</div>
                            <div class="distance" style="color:${isClose ? 'var(--red)' : 'var(--green)'}">
                                ${distanceBtc ? `${distanceBtc}% ${t('danger_margin')}` : ''}
                            </div>
                        </div>
                        <div class="danger-level">
                            <div class="label">${t('danger_safety')}</div>
                            <div class="price" style="color:${isClose ? 'var(--red)' : 'var(--green)'}">
                                ${breakevenBtc ? formatUSD(bp - breakevenBtc) : 'N/A'}
                            </div>
                            <div class="distance" style="color:var(--text-dim)">
                                ${t('danger_btc_can_drop')}
                            </div>
                        </div>
                    </div>
                </div>
                <div style="margin-top:15px;background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:18px;">
                    <h3 style="color:var(--accent2);margin-bottom:12px;font-size:1em;">${t('miner_info')}</h3>
                    <div class="danger-levels">
                        <div class="danger-level">
                            <div class="label">${t('miner_current_level')}</div>
                            <div class="price" style="color:var(--accent2)">Level ${currentLevel}</div>
                            <div class="distance" style="color:var(--text-dim)">${hashrate} TH / ${POWER_LEVELS[currentLevel]} TH (base)</div>
                        </div>
                        <div class="danger-level">
                            <div class="label">${t('miner_next_level')}</div>
                            <div class="price" style="color:var(--accent2)">${nextLevelTH ? nextLevelTH + ' TH' : 'MAX'}</div>
                            <div class="distance" style="color:var(--text-dim)">${thToNextLevel ? '+' + thToNextLevel + ' TH ' + t('miner_needed') : ''}</div>
                        </div>
                        <div class="danger-level">
                            <div class="label">${t('miner_upgrade_cost')}</div>
                            <div class="price" style="color:var(--purple)">${costToNextLevel ? formatUSD(costToNextLevel) : 'N/A'}</div>
                            <div class="distance" style="color:var(--text-dim)">$${UPGRADE_PRICE_DIRECT}/TH × ${thToNextLevel || 0} TH</div>
                        </div>
                    </div>
                </div>
            `;

            // Auto-update scenarios
            updateScenarios();

            // Update live dashboard
            updateDashboard(r, hashrate, efficiency);

            // Update TH objective
            updateThObjective(hashrate);

            // Start live ticker
            startTicker(r.netUsd);
            updateEmptyState();
            validateInputs();

            // Update TH objective with curve
            updateThObjectiveWithCurve(hashrate);
        }

        // ===== BTC SCENARIOS =====
        function getScenarioPrices() {
            const prices = new Set();

            // Tranches de 10k entre 50k et 150k
            for (let p = 50000; p <= 150000; p += 10000) prices.add(p);

            // Prix actuel + tranches de 5k impaires (pas multiples de 10k) autour
            if (state.btcPrice) {
                prices.add(Math.round(state.btcPrice));
                // Trouver le 5k impair en dessous et au dessus (65k, 75k, 85k, etc.)
                const lower = Math.floor(state.btcPrice / 10000) * 10000 + 5000;
                const upper = lower + 10000;
                if (lower < state.btcPrice) prices.add(lower);
                if (upper > state.btcPrice) prices.add(upper);
            }

            // Prix custom
            state.customBtcPrices.forEach(p => prices.add(p));

            return [...prices].filter(p => p > 0).sort((a, b) => a - b);
        }

        function addCustomBtc() {
            const val = parseInt(document.getElementById('custom-btc').value);
            if (val && val > 0) {
                if (!state.customBtcPrices.includes(val)) state.customBtcPrices.push(val);
                if (typeof persistScenarioPrices === 'function') persistScenarioPrices();
                document.getElementById('custom-btc').value = '';
                updateScenarios();
            }
        }

        function updateScenarios() {
            const c = state.lastCalc;
            if (!c) return;

            // === Hero stats: current / bear (-$20k) / bull (+$20k) ===
            const cur = state.btcPrice || 0;
            const heroPrices = [
                { id: 'current', price: cur },
                { id: 'bear',    price: Math.max(0, cur - 20000) },
                { id: 'bull',    price: cur + 20000 },
            ];
            const currentDailyNet = calcDailyReward(c.hashrate, c.efficiency, c.elecCost, c.discount, state.btcPrice, c.satPerTH);
            heroPrices.forEach(({ id, price }) => {
                const priceEl = document.getElementById('scn-' + id + '-price');
                const netEl   = document.getElementById('scn-' + id + '-net');
                const metaEl  = document.getElementById('scn-' + id + '-meta');
                if (!priceEl || !price) return;
                priceEl.textContent = formatUSD(price);
                const r = calcDailyReward(c.hashrate, c.efficiency, c.elecCost, c.discount, price, c.satPerTH);
                if (!r) return;
                // Un scénario de chute annonçait « −4 $/jour, −1 460 $/an ». Faux :
                // la ferme serait simplement en pause à zéro. On montre le montant
                // payé, et le théorique à côté pour dire l'ampleur du déficit.
                netEl.textContent = formatUSD(r.netUsdPaid) + '/day';
                netEl.className = 'scn-hero-net ' + (r.paused ? 'neg' : 'pos');
                let deltaTxt = '';
                if (id !== 'current' && currentDailyNet && currentDailyNet.netUsdPaid) {
                    const pct = ((r.netUsdPaid - currentDailyNet.netUsdPaid) / Math.abs(currentDailyNet.netUsdPaid)) * 100;
                    const sign = pct >= 0 ? '+' : '';
                    deltaTxt = ` · ${sign}${pct.toFixed(0)}% vs now`;
                }
                metaEl.textContent = r.paused
                    ? `${t('paused_short', 'paused')} · ${t('paused_would_be', 'would be')} ${formatUSD(r.netUsd)}/${t('eff_day', 'day')}`
                    : formatUSD(r.netUsdPaid * 365) + '/year' + deltaTxt;
            });

            // === Render scenario cards ===
            const prices = getScenarioPrices();
            const grid = document.getElementById('scenario-cards');
            if (grid) {
                grid.innerHTML = '';
                prices.forEach(btcP => {
                    const r = calcDailyReward(c.hashrate, c.efficiency, c.elecCost, c.discount, btcP, c.satPerTH);
                    if (!r) return;
                    const isCurrent = Math.abs(btcP - state.btcPrice) < 1000;
                    const isCustom = state.customBtcPrices.includes(btcP);
                    const cls = ['scn-card'];
                    if (isCurrent) cls.push('scn-card--current');
                    if (isCustom) cls.push('scn-card--custom');
                    const netClass = r.paused ? 'neg' : 'pos';
                    const card = document.createElement('div');
                    card.className = cls.join(' ');
                    card.innerHTML = `
                        ${isCurrent ? '<span class="scn-card-pill">' + (t('scn_now') || 'Now') + '</span>' : ''}
                        ${isCustom && !isCurrent ? '<button class="scn-card-x" title="Remove" onclick="removeScenarioChip(' + btcP + ')">×</button>' : ''}
                        <div class="scn-card-price">${formatUSD(btcP)}</div>
                        <div class="scn-card-net ${netClass}">${formatUSD(r.netUsdPaid)}<span class="scn-card-net-unit">/day</span></div>
                        ${r.paused ? '<div class="scn-card-paused">' + t('paused_short', 'paused') + ' · ' + t('paused_would_be', 'would be') + ' ' + formatUSD(r.netUsd) + '</div>' : ''}
                        <div class="scn-card-stats">
                            <div><span>Net/mo</span><strong class="${netClass}">${formatUSD(r.netUsdPaid * 30)}</strong></div>
                            <div><span>Net/yr</span><strong class="${netClass}">${formatUSD(r.netUsdPaid * 365)}</strong></div>
                            <div><span>Gross/d</span><strong>${r.paused ? formatUSD(0) : formatUSD(r.grossUsd)}</strong></div>
                            <div><span>Fees/d</span><strong class="neg">${r.paused ? formatUSD(0) : '-' + formatUSD(r.feesUsd)}</strong></div>
                        </div>
                    `;
                    grid.appendChild(card);
                });
            }

            // Legacy hidden table — kept populated for any code that still reads it
            const tbody = document.getElementById('scenario-body');
            if (tbody) {
                tbody.innerHTML = '';
                prices.forEach(btcP => {
                    const r = calcDailyReward(c.hashrate, c.efficiency, c.elecCost, c.discount, btcP, c.satPerTH);
                    if (!r) return;
                    const tr = document.createElement('tr');
                    tr.innerHTML = `<td>${formatUSD(btcP)}</td><td>${formatVal(r.grossBtc, btcP, r.grossGmt)}</td><td>-${formatVal(r.feesBtc, btcP, r.feesGmt)}</td><td>${formatProfit(r.netBtc, btcP, r.netGmt, r.grossBtc)}</td><td>${formatProfit(r.netBtc * 30, btcP, r.netGmt * 30, r.grossBtc * 30)}</td><td>${formatProfit(r.netBtc * 365, btcP, r.netGmt * 365, r.grossBtc * 365)}</td>`;
                    tbody.appendChild(tr);
                });
            }

            // === Chart + side-by-side compare ===
            drawScenarioChart();
            updateCompareScenarios();
        }

        // === Quick-pick chip handlers ===
        // Persisted across sessions so the user doesn't lose their picks on reload.
        // Also accepts ?scn=30000,75000,100000 in the URL for sharing scenarios.
        const SCN_PRICES_KEY = 'gms_scn_custom_prices';
        try {
            const saved = JSON.parse(localStorage.getItem(SCN_PRICES_KEY) || '[]');
            if (Array.isArray(saved)) state.customBtcPrices = saved.filter(n => typeof n === 'number' && n > 0);
            const scnParam = new URLSearchParams(location.search).get('scn');
            if (scnParam) {
                const incoming = scnParam.split(',').map(Number).filter(n => n > 0 && n < 10_000_000);
                incoming.forEach(p => { if (!state.customBtcPrices.includes(p)) state.customBtcPrices.push(p); });
            }
        } catch(_) {}
        window.shareScenarioUrl = function () {
            const prices = (state.customBtcPrices || []).filter(n => n > 0);
            const url = location.origin + location.pathname + '#scenarios' +
                        (prices.length ? '?scn=' + prices.join(',') : '');
            (navigator.clipboard?.writeText
                ? navigator.clipboard.writeText(url)
                : Promise.reject()
            ).then(
                () => typeof toast === 'function' && toast('Link copied to clipboard', 'success', 2200),
                () => prompt('Copy this URL:', url)
            );
        };
        function persistScenarioPrices() {
            try { localStorage.setItem(SCN_PRICES_KEY, JSON.stringify(state.customBtcPrices)); } catch(_) {}
        }
        window.addScenarioChip = function (btcP) {
            if (!state.customBtcPrices.includes(btcP)) state.customBtcPrices.push(btcP);
            persistScenarioPrices();
            updateScenarios();
        };
        window.removeScenarioChip = function (btcP) {
            state.customBtcPrices = state.customBtcPrices.filter(p => p !== btcP);
            persistScenarioPrices();
            updateScenarios();
        };

        // === Profit-curve chart ===
        // Geometry is cached on `_scnChart` so the hover handler can
        // convert mouse X → BTC price without recomputing.
        const _scnChart = { ready: false };
        function drawScenarioChart(hoverBtc) {
            const canvas = document.getElementById('scenario-chart');
            const c = state.lastCalc;
            if (!canvas || !c) return;
            const ctx = canvas.getContext('2d');
            const dpr = window.devicePixelRatio || 1;
            const w = canvas.clientWidth;
            const h = canvas.clientHeight;
            canvas.width  = w * dpr;
            canvas.height = h * dpr;
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.scale(dpr, dpr);
            ctx.clearRect(0, 0, w, h);

            // Sample 200 BTC prices from $10k → $250k and compute net USD
            const minBtc = 10000, maxBtc = 250000, samples = 200;
            const points = [];
            for (let i = 0; i <= samples; i++) {
                const btcP = minBtc + (maxBtc - minBtc) * i / samples;
                const r = calcDailyReward(c.hashrate, c.efficiency, c.elecCost, c.discount, btcP, c.satPerTH);
                if (r) points.push({ btc: btcP, net: r.netUsd });
            }
            if (points.length < 2) return;

            const minNet = Math.min(0, ...points.map(p => p.net));
            const maxNet = Math.max(0, ...points.map(p => p.net));
            const pad = { top: 18, right: 18, bottom: 30, left: 60 };
            const cw = w - pad.left - pad.right;
            const ch = h - pad.top - pad.bottom;
            const xScale = b => pad.left + ((b - minBtc) / (maxBtc - minBtc)) * cw;
            const yScale = n => pad.top + ch - ((n - minNet) / (maxNet - minNet)) * ch;
            const yZero  = yScale(0);

            // Cache for hover handler
            _scnChart.ready = true;
            _scnChart.minBtc = minBtc;
            _scnChart.maxBtc = maxBtc;
            _scnChart.pad = pad;
            _scnChart.cw = cw;
            _scnChart.h = h;
            _scnChart.w = w;

            // Grid
            ctx.strokeStyle = 'rgba(255,255,255,0.05)'; ctx.lineWidth = 1;
            for (let i = 0; i <= 4; i++) {
                const y = pad.top + (ch / 4) * i;
                ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(w - pad.right, y); ctx.stroke();
            }

            // Y axis labels (USD)
            ctx.fillStyle = 'rgba(255,255,255,0.45)'; ctx.font = '10px ui-monospace, Menlo, monospace';
            for (let i = 0; i <= 4; i++) {
                const v = maxNet - ((maxNet - minNet) / 4) * i;
                const y = pad.top + (ch / 4) * i;
                ctx.fillText('$' + Math.round(v).toLocaleString(), 4, y + 3);
            }

            // X axis labels (BTC)
            const ticks = [25000, 50000, 75000, 100000, 150000, 200000, 250000];
            ticks.forEach(b => {
                if (b < minBtc || b > maxBtc) return;
                const x = xScale(b);
                ctx.fillStyle = 'rgba(255,255,255,0.45)';
                ctx.fillText('$' + (b / 1000) + 'k', x - 14, h - 8);
            });

            // Zero line
            if (minNet < 0) {
                ctx.strokeStyle = 'rgba(248,81,73,0.4)'; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
                ctx.beginPath(); ctx.moveTo(pad.left, yZero); ctx.lineTo(w - pad.right, yZero); ctx.stroke();
                ctx.setLineDash([]);
            }

            // Area fill under curve (positive part)
            const grad = ctx.createLinearGradient(0, pad.top, 0, pad.top + ch);
            grad.addColorStop(0, 'rgba(247,147,26,0.30)');
            grad.addColorStop(1, 'rgba(247,147,26,0.02)');
            ctx.fillStyle = grad;
            ctx.beginPath();
            ctx.moveTo(xScale(points[0].btc), yZero);
            points.forEach(p => ctx.lineTo(xScale(p.btc), yScale(p.net)));
            ctx.lineTo(xScale(points[points.length - 1].btc), yZero);
            ctx.closePath();
            ctx.fill();

            // Curve line
            ctx.strokeStyle = '#f7931a'; ctx.lineWidth = 2;
            ctx.beginPath();
            points.forEach((p, i) => {
                const x = xScale(p.btc), y = yScale(p.net);
                if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
            });
            ctx.stroke();

            // Breakeven marker (where net = 0)
            for (let i = 1; i < points.length; i++) {
                const a = points[i - 1], b = points[i];
                if ((a.net <= 0 && b.net >= 0) || (a.net >= 0 && b.net <= 0)) {
                    const t = a.net === b.net ? 0 : -a.net / (b.net - a.net);
                    const beBtc = a.btc + (b.btc - a.btc) * t;
                    const x = xScale(beBtc), y = yZero;
                    ctx.fillStyle = '#f85149';
                    ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill();
                    ctx.strokeStyle = 'rgba(248,81,73,0.5)'; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
                    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, h - pad.bottom); ctx.stroke();
                    ctx.setLineDash([]);
                    ctx.fillStyle = '#f85149'; ctx.font = '11px ui-monospace, Menlo, monospace';
                    const lbl = '$' + Math.round(beBtc).toLocaleString();
                    ctx.fillText(lbl, x - 30, h - pad.bottom + 22);
                    break;
                }
            }

            // Current price marker
            if (state.btcPrice && state.btcPrice >= minBtc && state.btcPrice <= maxBtc) {
                const x = xScale(state.btcPrice);
                ctx.strokeStyle = 'rgba(247,147,26,0.8)'; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
                ctx.beginPath(); ctx.moveTo(x, pad.top); ctx.lineTo(x, h - pad.bottom); ctx.stroke();
                ctx.setLineDash([]);
                const r = calcDailyReward(c.hashrate, c.efficiency, c.elecCost, c.discount, state.btcPrice, c.satPerTH);
                if (r) {
                    const y = yScale(r.netUsd);
                    ctx.fillStyle = '#f7931a';
                    ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.fill();
                    ctx.fillStyle = '#000';
                    ctx.beginPath(); ctx.arc(x, y, 2, 0, Math.PI * 2); ctx.fill();
                }
            }

            // Custom price markers
            (state.customBtcPrices || []).forEach(btcP => {
                if (btcP < minBtc || btcP > maxBtc) return;
                const r = calcDailyReward(c.hashrate, c.efficiency, c.elecCost, c.discount, btcP, c.satPerTH);
                if (!r) return;
                const x = xScale(btcP), y = yScale(r.netUsd);
                ctx.fillStyle = '#a371f7';
                ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill();
                ctx.fillStyle = 'rgba(255,255,255,0.7)'; ctx.font = '10px ui-monospace, Menlo, monospace';
                ctx.fillText('$' + (btcP / 1000) + 'k', x - 12, y - 9);
            });

            // Hover marker (drawn last so it sits on top of everything)
            if (hoverBtc != null && hoverBtc >= minBtc && hoverBtc <= maxBtc) {
                const r = calcDailyReward(c.hashrate, c.efficiency, c.elecCost, c.discount, hoverBtc, c.satPerTH);
                if (r) {
                    const x = xScale(hoverBtc), y = yScale(r.netUsd);
                    ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
                    ctx.beginPath(); ctx.moveTo(x, pad.top); ctx.lineTo(x, h - pad.bottom); ctx.stroke();
                    ctx.setLineDash([]);
                    ctx.fillStyle = '#fff';
                    ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill();
                    ctx.fillStyle = '#0d1117';
                    ctx.beginPath(); ctx.arc(x, y, 2, 0, Math.PI * 2); ctx.fill();
                }
            }
        }

        // Wire mouse hover on the canvas (one-time setup, idempotent)
        (function wireScenarioChartHover() {
            const wrap = document.getElementById('scenario-chart-wrap');
            const canvas = document.getElementById('scenario-chart');
            const tip = document.getElementById('scenario-chart-tooltip');
            if (!wrap || !canvas || !tip) return;
            if (canvas.dataset.hoverWired === '1') return;
            canvas.dataset.hoverWired = '1';

            canvas.addEventListener('mousemove', (e) => {
                if (!_scnChart.ready) return;
                const c = state.lastCalc;
                if (!c) return;
                const rect = canvas.getBoundingClientRect();
                const x = e.clientX - rect.left;
                if (x < _scnChart.pad.left || x > _scnChart.w - _scnChart.pad.right) {
                    tip.style.display = 'none';
                    drawScenarioChart();
                    return;
                }
                const t = (x - _scnChart.pad.left) / _scnChart.cw;
                const btcP = _scnChart.minBtc + (_scnChart.maxBtc - _scnChart.minBtc) * t;
                const rew = calcDailyReward(c.hashrate, c.efficiency, c.elecCost, c.discount, btcP, c.satPerTH);
                if (!rew) return;
                drawScenarioChart(btcP);
                const netCls = rew.netUsd >= 0 ? 'pos' : 'neg';
                tip.innerHTML = `
                    <div class="scn-tip-price">${formatUSD(btcP)}</div>
                    <div class="scn-tip-row"><span>Net/day</span><strong class="${netCls}">${formatUSD(rew.netUsd)}</strong></div>
                    <div class="scn-tip-row"><span>Net/month</span><strong class="${netCls}">${formatUSD(rew.netUsd * 30)}</strong></div>
                    <div class="scn-tip-row"><span>Net/year</span><strong class="${netCls}">${formatUSD(rew.netUsd * 365)}</strong></div>
                    <div class="scn-tip-row"><span>Gross/day</span><strong>${formatUSD(rew.grossUsd)}</strong></div>
                    <div class="scn-tip-row"><span>Fees/day</span><strong class="neg">-${formatUSD(rew.feesUsd)}</strong></div>
                `;
                tip.style.display = 'block';
                // Position the tooltip near the cursor, clamped inside the wrap
                const wrapRect = wrap.getBoundingClientRect();
                const tipW = tip.offsetWidth;
                let left = x + 14;
                if (left + tipW > wrapRect.width - 6) left = x - tipW - 14;
                tip.style.left = left + 'px';
                tip.style.top  = (e.clientY - rect.top - 10) + 'px';
            });
            canvas.addEventListener('mouseleave', () => {
                tip.style.display = 'none';
                drawScenarioChart();
            });
        })();

        // === Side-by-side compare ===
        function updateCompareScenarios() {
            const c = state.lastCalc;
            const a = parseFloat(document.getElementById('scn-compare-a')?.value);
            const b = parseFloat(document.getElementById('scn-compare-b')?.value);
            const target = document.getElementById('scn-compare-cards');
            if (!c || !target || !a || !b) return;
            const rA = calcDailyReward(c.hashrate, c.efficiency, c.elecCost, c.discount, a, c.satPerTH);
            const rB = calcDailyReward(c.hashrate, c.efficiency, c.elecCost, c.discount, b, c.satPerTH);
            if (!rA || !rB) return;
            const renderCard = (label, btcP, r, accent) => `
                <div class="scn-cmp-card" style="--scn-cmp-accent:${accent}">
                    <div class="scn-cmp-label">${label}</div>
                    <div class="scn-cmp-price">${formatUSD(btcP)}</div>
                    <div class="scn-cmp-net ${r.netUsd >= 0 ? 'pos' : 'neg'}">${formatUSD(r.netUsd)}<span>/day</span></div>
                    <div class="scn-cmp-rows">
                        <div><span>Net/month</span><strong class="${r.netUsd >= 0 ? 'pos' : 'neg'}">${formatUSD(r.netUsd * 30)}</strong></div>
                        <div><span>Net/year</span><strong class="${r.netUsd >= 0 ? 'pos' : 'neg'}">${formatUSD(r.netUsd * 365)}</strong></div>
                        <div><span>Gross/day</span><strong>${formatUSD(r.grossUsd)}</strong></div>
                        <div><span>Fees/day</span><strong class="neg">-${formatUSD(r.feesUsd)}</strong></div>
                        <div><span>Margin</span><strong>${r.grossUsd > 0 ? ((r.netUsd / r.grossUsd) * 100).toFixed(1) + '%' : '—'}</strong></div>
                    </div>
                </div>`;
            const diffYear = (rB.netUsd - rA.netUsd) * 365;
            const diffPct  = rA.netUsd ? ((rB.netUsd - rA.netUsd) / Math.abs(rA.netUsd)) * 100 : 0;
            const diffSign = diffYear >= 0 ? '+' : '';
            target.innerHTML = `
                ${renderCard('Scenario A', a, rA, 'var(--accent2)')}
                <div class="scn-cmp-diff">
                    <div class="scn-cmp-diff-label">B vs A / year</div>
                    <div class="scn-cmp-diff-value ${diffYear >= 0 ? 'pos' : 'neg'}">${diffSign}${formatUSD(diffYear)}</div>
                    <div class="scn-cmp-diff-pct ${diffYear >= 0 ? 'pos' : 'neg'}">${diffSign}${diffPct.toFixed(1)}%</div>
                </div>
                ${renderCard('Scenario B', b, rB, 'var(--accent)')}
            `;
        }

        // ===== STRATEGY MAP ENGINE =====

        // Calcule le discount dynamique basé sur le TH actuel et le GMT prépayé
        function getDynamicDiscount(th, gmtPrepaid, efficiency, elecCost) {
            const gp = state.gmtPrice;
            if (!gp) return parseFloat(document.getElementById('discount').value) || 0;

            const gmtLocked = parseFloat(document.getElementById('gmt-locked').value) || 0;
            const totalGmt = gmtPrepaid + gmtLocked;

            // Non-token discounts (streak + VIP + mining mode)
            const vip = parseFloat(document.getElementById('discount-vip').value) || 0;
            const streak = parseFloat(document.getElementById('discount-streak').value) || 0;
            const solo = parseFloat(document.getElementById('discount-solo').value) || 0;
            const nonTokenDiscount = (vip + streak + solo) / 100;

            // Fees after non-token discounts but BEFORE token discount
            const c1PerDay = (elecCost * 24 * efficiency / gp / 1000) * th;
            const c2PerDay = (SERVICE_COST_PER_TH / gp) * th;
            const dailyFees = (c1PerDay + c2PerDay) * (1 - nonTokenDiscount);

            const prepaidDays = dailyFees > 0 ? Math.floor(totalGmt / dailyFees) : 0;
            const maintDiscount = getMaintenanceDiscount(prepaidDays);

            return maintDiscount + vip + streak + solo;
        }

        function simulateStrategy(strategy, c, days, currentBtcPrice, costPerTH, bonusPct) {
            const r = calcDailyReward(c.hashrate, c.efficiency, c.elecCost, c.discount, currentBtcPrice, c.satPerTH);
            if (!r) return null;

            const gmtPrepaid = parseFloat(document.getElementById('gmt-prepaid').value) || 0;

            if (strategy === 'btc') {
                return { btc: r.netBtc * days, gmt: 0, thAdded: 0, feesPaid: 0, finalDiscount: c.discount };
            }
            if (strategy === 'gmt') {
                return { btc: 0, gmt: r.netGmt * days, thAdded: 0, feesPaid: 0, finalDiscount: c.discount };
            }
            if (strategy === 'th') {
                let th = c.hashrate, totalTH = 0, totalFees = 0;
                for (let d = 0; d < days; d++) {
                    // Recalcule le discount avec le nouveau TH
                    const dynDiscount = getDynamicDiscount(th, gmtPrepaid, c.efficiency, c.elecCost);
                    const dayR = calcDailyReward(th, c.efficiency, c.elecCost, dynDiscount, currentBtcPrice, c.satPerTH);
                    if (!dayR) break;
                    // Le réinvestissement porte sur le NET, jamais sur le brut : les frais sont
                    // déduits avant que quoi que ce soit ne soit reçu. Vérifié empiriquement
                    // sur 19 jours consécutifs de croissance réelle — prédire depuis le net
                    // colle à ~2 %, depuis le brut c'est 5 à 8× trop.
                    const thGain = (dayR.netUsd / costPerTH) * (1 + bonusPct);
                    totalTH += thGain;
                    totalFees += dayR.feesUsd;
                    th += thGain;
                }
                const finalDiscount = getDynamicDiscount(th, gmtPrepaid, c.efficiency, c.elecCost);
                return { btc: 0, gmt: 0, thAdded: totalTH, feesPaid: totalFees, finalTH: th, finalDiscount };
            }
        }

        function calcStrategy() {
            const c = state.lastCalc;
            if (!c || !state.btcPrice || !state.gmtPrice) {
                alert(t('alert_calc_first'));
                return;
            }

            const costPerTH = parseFloat(document.getElementById('reinv-cost-per-th').value);
            const bonusPct = parseFloat(document.getElementById('reinv-bonus').value) / 100;
            const days = parseInt(document.getElementById('reinv-horizon').value);
            const gmtBalance = parseFloat(document.getElementById('reinv-gmt-balance').value) || 0;
            const reserveDays = parseInt(document.getElementById('reinv-reserve-days').value) || 30;
            const bp = state.btcPrice;
            const gp = state.gmtPrice;

            // === RESERVE GMT CALCULATION ===
            const r = calcDailyReward(c.hashrate, c.efficiency, c.elecCost, c.discount, bp, c.satPerTH);
            const dailyFeesGmt = r ? r.feesGmt : 0;
            const reserveNeeded = dailyFeesGmt * reserveDays;
            const reserveDeficit = reserveNeeded - gmtBalance;
            const reserveCovered = dailyFeesGmt > 0 ? Math.floor(gmtBalance / dailyFeesGmt) : 999;
            const reserveOk = reserveDeficit <= 0;

            // Days to fill reserve if converting rewards to GMT
            const dailyNetGmt = r ? r.netGmt : 0;
            const daysToFillReserve = reserveDeficit > 0 && dailyNetGmt > 0 ? Math.ceil(reserveDeficit / dailyNetGmt) : 0;

            const reserveEl = document.getElementById('strat-reserve');
            reserveEl.style.display = 'block';

            if (reserveOk) {
                reserveEl.innerHTML = `
                    <div class="reserve-alert ok">
                        <div style="display:flex;justify-content:space-between;align-items:center;">
                            <div>
                                <strong style="color:var(--green);font-size:1.1em;">${t('reserve_ok')}</strong><br>
                                <span style="color:var(--text-dim);">${t('reserve_you_have')} ${formatNumber(gmtBalance)} GMT — ${t('reserve_enough_for')} ${reserveCovered} ${t('reserve_days_of_fees')} (${t('reserve_goal')}: ${reserveDays} ${t('days')})</span>
                            </div>
                            <div style="text-align:right;">
                                <div style="font-size:0.85em;color:var(--text-dim)">${t('reserve_fees_day')}: ${dailyFeesGmt.toFixed(2)} GMT</div>
                                <div style="font-size:0.85em;color:var(--text-dim)">${t('reserve_needed')}: ${formatNumber(reserveNeeded)} GMT</div>
                            </div>
                        </div>
                        <div class="reserve-bar">
                            <div class="reserve-bar-fill" style="width:100%;background:var(--green)"></div>
                        </div>
                    </div>
                `;
            } else {
                const fillPct = Math.min(100, (gmtBalance / reserveNeeded) * 100);
                reserveEl.innerHTML = `
                    <div class="reserve-alert">
                        <div style="display:flex;justify-content:space-between;align-items:center;">
                            <div>
                                <strong style="color:var(--red);font-size:1.1em;">${t('reserve_fill_first')}</strong><br>
                                <span style="color:var(--text-dim);">${t('reserve_you_have')} ${formatNumber(gmtBalance)} GMT ${t('reserve_but_need')} ${formatNumber(reserveNeeded)} GMT ${t('reserve_for')} ${reserveDays} ${t('reserve_days_of_fees')}.</span><br>
                                <span style="color:var(--accent2);">${t('reserve_missing')} ${formatNumber(reserveDeficit)} GMT — ${t('reserve_convert_for')} ~${daysToFillReserve} ${t('days')} ${t('reserve_before_reinvest')}.</span>
                            </div>
                            <div style="text-align:right;">
                                <div style="font-size:0.85em;color:var(--text-dim)">${t('reserve_fees_day')}: ${dailyFeesGmt.toFixed(2)} GMT</div>
                                <div style="font-size:0.85em;color:var(--text-dim)">${t('reserve_covered')}: ${reserveCovered} / ${reserveDays} ${t('days')}</div>
                            </div>
                        </div>
                        <div class="reserve-bar">
                            <div class="reserve-bar-fill" style="width:${fillPct}%;background:var(--red)"></div>
                        </div>
                    </div>
                `;
            }

            // Generate BTC and GMT price ranges
            const btcSteps = 9;
            const gmtSteps = 9;
            const btcMin = Math.round(bp * 0.6 / 5000) * 5000;
            const btcMax = Math.round(bp * 2.5 / 5000) * 5000;
            const gmtMin = parseFloat((gp * 0.4).toFixed(4));
            const gmtMax = parseFloat((gp * 3).toFixed(4));

            const btcPrices = [];
            const gmtPrices = [];
            for (let i = 0; i < btcSteps; i++) btcPrices.push(Math.round(btcMin + (btcMax - btcMin) * i / (btcSteps - 1)));
            for (let i = 0; i < gmtSteps; i++) gmtPrices.push(parseFloat((gmtMin + (gmtMax - gmtMin) * i / (gmtSteps - 1)).toFixed(4)));

            // Run simulations at current market prices
            const simBtc = simulateStrategy('btc', c, days, bp, costPerTH, bonusPct);
            const simGmt = simulateStrategy('gmt', c, days, bp, costPerTH, bonusPct);
            const simTh = simulateStrategy('th', c, days, bp, costPerTH, bonusPct);
            if (!simBtc || !simGmt || !simTh) return;

            // Find closest grid position to current prices
            const closestBtcIdx = btcPrices.reduce((best, p, i) => Math.abs(p - bp) < Math.abs(btcPrices[best] - bp) ? i : best, 0);
            const closestGmtIdx = gmtPrices.reduce((best, p, i) => Math.abs(p - gp) < Math.abs(gmtPrices[best] - gp) ? i : best, 0);

            // Evaluate value at given future prices
            // BTC: accumulated BTC × future BTC price
            // GMT: accumulated GMT × future GMT price
            // TH:  revenue generated by the extra TH over 1 year at future BTC price - fees paid
            function evalAtPrices(futBtc, futGmt) {
                const vBtc = simBtc.btc * futBtc;
                const vGmt = simGmt.gmt * futGmt;
                // TH value = annual net revenue of the added TH at future prices
                const thReward = calcDailyReward(simTh.thAdded, c.efficiency, c.elecCost, c.discount, futBtc, c.satPerTH);
                const thAnnualRevenue = thReward ? thReward.netUsd * 365 : 0;
                const vTh = thAnnualRevenue - simTh.feesPaid;
                return { vBtc, vGmt, vTh };
            }

            // Current recommendation
            const { vBtc: vBtcNow, vGmt: vGmtNow, vTh: vThNow } = evalAtPrices(bp, gp);
            const nowAll = [
                { key: t('map_hold_btc'), val: vBtcNow, bg: '#f5c542', detail: `${simBtc.btc.toFixed(8)} BTC` },
                { key: t('map_convert_gmt'), val: vGmtNow, bg: '#2ecc71', detail: `${formatNumber(simGmt.gmt)} GMT` },
                { key: t('map_reinvest_th'), val: vThNow, bg: '#3498db', detail: `+${simTh.thAdded.toFixed(2)} TH (${t('map_annual_minus_fees')})` }
            ];
            const bestMarket = nowAll.reduce((a, b) => a.val > b.val ? a : b);

            const bestNow = !reserveOk
                ? { key: t('map_convert_gmt'), bg: '#2ecc71', override: true }
                : bestMarket;

            let recoHtml;
            if (!reserveOk) {
                recoHtml = `
                    <div class="reco-banner">
                        <div class="reco-badge" style="background:#2ecc71">GMT</div>
                        <div>
                            <div style="font-size:1.1em;"><strong>${t('reco_priority_reserve')}</strong></div>
                            <div style="color:var(--text-dim);margin-top:5px;">
                                ${t('reco_missing')} <strong>${formatNumber(reserveDeficit)} GMT</strong> ${t('reco_to_cover')} ${reserveDays} ${t('reserve_days_of_fees')}.
                                ${t('reco_convert_rewards')} ~<strong>${daysToFillReserve} ${t('days')}</strong>, ${t('reco_then_optimal')}.
                            </div>
                            <div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border);">
                                <span style="color:var(--text-dim);">${t('reco_best_after_reserve')}:</span>
                                <strong style="color:${bestMarket.bg};margin-left:8px;">${bestMarket.key}</strong>
                                <span style="color:var(--text-dim);margin-left:5px;">(${formatUSD(bestMarket.val)})</span>
                            </div>
                        </div>
                    </div>
                `;
            } else {
                recoHtml = `
                    <div class="reco-banner">
                        <div class="reco-badge" style="background:${bestNow.bg}">${bestNow.key}</div>
                        <div>
                            <div style="font-size:1.1em;">${t('reco_at_current_prices')} <strong>${days} ${t('days')}</strong>:</div>
                            <div style="margin-top:8px;">
                                ${nowAll.map(s => `<span style="margin-right:20px;${s.key === bestNow.key ? 'font-weight:700' : 'color:var(--text-dim)'}">${s.key}: ${formatUSD(s.val)}</span>`).join('')}
                            </div>
                        </div>
                    </div>
                `;
            }

            document.getElementById('strat-reco-box').innerHTML = recoHtml;

            // Build the grid
            // Grid layout: extra row at bottom for X labels, extra col at left for Y labels
            const cols = btcSteps + 1; // +1 for Y labels
            const grid = document.getElementById('strat-grid');
            grid.style.gridTemplateColumns = `50px repeat(${btcSteps}, 1fr)`;
            grid.innerHTML = '';

            // Rows from top (highest GMT) to bottom (lowest GMT)
            for (let gi = gmtSteps - 1; gi >= 0; gi--) {
                // Y label
                const yLabel = document.createElement('div');
                yLabel.className = 'grid-label-y';
                yLabel.textContent = gmtPrices[gi] < 1 ? '$' + gmtPrices[gi].toFixed(2) : '$' + gmtPrices[gi].toFixed(2);
                grid.appendChild(yLabel);

                for (let bi = 0; bi < btcSteps; bi++) {
                    const futBtc = btcPrices[bi];
                    const futGmt = gmtPrices[gi];
                    const { vBtc, vGmt, vTh } = evalAtPrices(futBtc, futGmt);

                    // All 3 negative = non rentable
                    const allNeg = vBtc <= 0 && vGmt <= 0 && vTh <= 0;

                    let zone;
                    if (allNeg) {
                        zone = 'bad-zone';
                    } else {
                        const all = [
                            { zone: 'btc-zone', val: vBtc },
                            { zone: 'gmt-zone', val: vGmt },
                            { zone: 'th-zone', val: vTh }
                        ];
                        zone = all.reduce((a, b) => a.val > b.val ? a : b).zone;
                    }

                    const isCurrent = bi === closestBtcIdx && gi === closestGmtIdx;
                    const cell = document.createElement('div');
                    cell.className = `grid-cell ${zone} ${isCurrent ? 'current' : ''}`;
                    cell.title = `BTC ${formatUSD(futBtc)} | GMT $${futGmt.toFixed(4)}\n─────────────\n${t('map_hold_btc')}: ${formatUSD(vBtc)}\n${t('map_convert_gmt')}: ${formatUSD(vGmt)}\n${t('map_reinvest_th')}: ${formatUSD(vTh)}`;
                    grid.appendChild(cell);
                }
            }

            // X labels row
            const emptyLabel = document.createElement('div');
            emptyLabel.className = 'grid-label-x';
            grid.appendChild(emptyLabel);
            for (let bi = 0; bi < btcSteps; bi++) {
                const xLabel = document.createElement('div');
                xLabel.className = 'grid-label-x';
                xLabel.textContent = '$' + (btcPrices[bi] / 1000).toFixed(0) + 'k';
                grid.appendChild(xLabel);
            }

            document.getElementById('strat-map').style.display = 'block';
        }

        // ===== STRATEGY LAB ===== (extracted to js/strategy-lab.js)

        // ===== LIVE DASHBOARD =====
        let lastStrategy = null;

        function updateDashboard(r, hashrate, efficiency) {
            if (!r) return;

            const bp = state.btcPrice;
            const gp = state.gmtPrice;

            // Today's gain
            document.getElementById('dash-today').textContent = formatProfit(r.netBtc, bp, r.netGmt, r.grossBtc);
            // Provenance : l'extension la capte depuis toujours, on ne l'affichait
            // pas. « Montrer les entrées » ne vaut rien si on cache leur origine.
            const srcBits = [];
            if (state.sources?.pr)  srcBits.push(`PR ${state.sources.pr}`);
            if (state.sources?.btc) srcBits.push(`BTC ${state.sources.btc}`);
            if (state.sources?.gmt) srcBits.push(`GMT ${state.sources.gmt}`);
            document.getElementById('dash-today-sub').textContent =
                `${t('dash_gross')}: ${formatVal(r.grossBtc, bp, r.grossGmt)} | ${t('dash_fees')}: ${formatVal(r.feesBtc, bp, r.feesGmt)}`
                + (srcBits.length ? ` · ${srcBits.join(' · ')}` : '');

            // Month estimate
            document.getElementById('dash-month').textContent = formatProfit(r.netBtc * 30, bp, r.netGmt * 30, r.grossBtc * 30);
            document.getElementById('dash-month-sub').textContent = `~${(r.grossBtc * 365).toFixed(8)} BTC/an`;

            // Miner info
            const level = getCurrentLevel(hashrate);
            const nextTH = getNextLevelTH(hashrate);
            const minerCountTxt = state.minerCount
                ? ` | ${state.minerCount} ${state.minerCount > 1 ? t('miners_plural', 'miners') : t('miners_one', 'miner')}`
                : '';
            document.getElementById('dash-miner').textContent = `${hashrate} TH | Lv.${level}${minerCountTxt}`;
            // Une moyenne d'efficacité qui ne couvre qu'une partie de la ferme
            // ne doit pas ressembler à une mesure : on dit sur combien de TH
            // elle porte réellement.
            const effPartialTxt = state.efficiencyPartial && state.efficiencyRatedPower
                ? ` · ~${efficiency} W/TH ${t('eff_over', 'over')} ${state.efficiencyRatedPower.toFixed(0)}/${hashrate} TH`
                : '';
            document.getElementById('dash-miner-sub').textContent =
                (nextTH ? `${t('dash_next')}: ${nextTH} TH (${nextTH - hashrate} TH)` : 'MAX') + effPartialTxt;

            // ===== STRATÉGIE OPTIMALE =====
            //
            // Les trois options se comparent à HORIZON COMMUN, en valeur
            // incrémentale et en dollars. La version précédente mettait en
            // regard 180 jours de revenu ENCAISSÉ (BTC, GMT) et un RYTHME
            // ANNUEL au jour 180 (TH) : deux grandeurs différentes, donc un
            // TH structurellement gonflé — chez une ferme de 700 TH il
            // annonçait +164 % pour TH quand l'écart réel est de +20 %.
            //
            // La ferme de départ vaut la même chose dans les trois scénarios,
            // donc elle s'annule : on ne compare que ce que chaque choix AJOUTE.
            const STRAT_HORIZON_DAYS = 180;
            const costPerTH = parseFloat(document.getElementById('reinv-cost-per-th').value)
                              || (typeof upgradeRate === 'function' ? upgradeRate() : 12.34);

            // Les entrées viennent des champs, comme partout ailleurs. L'ancien
            // code codait 0,05 $/kWh en dur — il ignorait donc le tarif détecté
            // par l'extension, et le PR retombait sur 45 alors que le reste de
            // l'app utilise 47 ou la valeur captée.
            const stratElec = parseFloat(document.getElementById('elec-cost').value) || ELEC_COST_DEFAULT;
            const stratDisc = parseFloat(document.getElementById('discount').value) || 0;
            const stratSat  = parseFloat(document.getElementById('sat-per-th').value) || state.satPerTH || 47;

            // BTC : on encaisse chaque jour, ferme inchangée. netUsdPaid, donc
            // zéro les jours où la protection de déficit met la ferme en pause.
            const btcVal = r.netUsdPaid * STRAT_HORIZON_DAYS;

            // GMT : même chose, mais crédité en GMT — la commission de
            // conversion de 2,25 % s'applique. À prix constants, prendre du GMT
            // coûte donc toujours un peu plus que prendre du BTC, et le dire
            // est une information, pas un défaut du modèle.
            const gmtVal = r.netGmtPaid * gp * STRAT_HORIZON_DAYS;

            // TH : on ne touche à rien, tout est réinvesti. La valeur ajoutée
            // est le hashrate GAGNÉ, valorisé au prix du TH — pas un débit
            // annualisé. Aucun revenu encaissé sur la période.
            let th = hashrate;
            for (let d = 0; d < STRAT_HORIZON_DAYS; d++) {
                const dayR = calcDailyReward(th, efficiency, stratElec, stratDisc, bp, stratSat);
                if (!dayR) break;
                // Net, pas brut — cf. la note dans la boucle du Strategy Lab.
                // Et netUsdPaid : un jour en pause ne réinvestit rien.
                th += (dayR.netUsdPaid / costPerTH) * (1 + TH_BONUS);
            }
            const thGained = th - hashrate;
            const thVal = thGained * costPerTH;

            const strategies = [
                { key: 'BTC', val: btcVal, color: '#f5c542' },
                { key: 'GMT', val: gmtVal, color: '#2ecc71' },
                { key: 'TH', val: thVal, color: '#3498db' }
            ];
            const best = strategies.reduce((a, b) => a.val > b.val ? a : b);

            const stratEl = document.getElementById('dash-strategy');
            // Exposé pour la bannière « depuis ta dernière visite » : lire une
            // valeur plutôt que de reparser le texte du DOM.
            window.__gmsOptimal = best.key;
            stratEl.textContent = best.key;
            stratEl.style.color = best.color;

            const card = document.getElementById('dash-strategy-card');
            card.style.borderColor = best.color;
            // Nommer l'horizon et l'unité : trois montants sans étiquette
            // invitaient à les lire comme des rendements annuels.
            document.getElementById('dash-strategy-sub').textContent =
                `${STRAT_HORIZON_DAYS}${t('strat_days_added', 'd added value')} — BTC ${formatUSD(btcVal)} · GMT ${formatUSD(gmtVal)} · TH ${formatUSD(thVal)}`
                + (thGained > 0 ? ` (+${thGained.toFixed(1)} TH)` : '');

            // Alert if strategy changed
            if (lastStrategy && lastStrategy !== best.key) {
                card.style.animation = 'pulse 1s 3';
                setTimeout(() => card.style.animation = '', 3000);
                showStrategyAlert(lastStrategy, best.key);
                sendNotification(t('notif_strategy'), `${t('notif_strategy_change')}: ${lastStrategy} → ${best.key}`);
            }
            if (previousStrategy === null) previousStrategy = best.key;
            lastStrategy = best.key;

            // Ticker
            document.getElementById('dash-ticker').textContent =
                `BTC ${formatUSD(bp)} | GMT $${gp.toFixed(4)} | ${new Date().toLocaleTimeString(currentLang === 'fr' ? 'fr-FR' : 'en-US')}`;

            // === Gain period toggle ===
            state._lastReward = r;
            updateGainDisplay();

            // === Wallet KPI (toggleable: BTC / GMT / Cash) ===
            updateWalletDisplay();

            // === Discount KPI ===
            const discTotalEl = document.getElementById('dash-discount-total');
            if (discTotalEl) {
                const totalDisc = parseFloat(document.getElementById('discount')?.value) || 0;
                discTotalEl.textContent = totalDisc.toFixed(2) + '%';
                discTotalEl.style.color = totalDisc >= 15 ? 'var(--green)' : totalDisc >= 5 ? 'var(--accent)' : 'var(--text-dim)';
            }

            // === New dashboard cards ===
            // Profit per day
            const profitEl = document.getElementById('dash-profit-day');
            if (profitEl) profitEl.textContent = formatProfit(r.netBtc, bp, r.netGmt, r.grossBtc);

            // Keep dash-gmt-wallet (hidden) up to date for any legacy reader
            const gmtWalletEl = document.getElementById('dash-gmt-wallet');
            const gmtPrepaid = parseFloat(document.getElementById('gmt-prepaid')?.value) || 0;
            if (gmtWalletEl) gmtWalletEl.textContent = gmtPrepaid.toFixed(1) + ' GMT';

            // Prepaid days — prefer API's discountAvailableDays when synced
            // (uses GoMining's own GMT price + fee formula, includes locked GMT).
            // Fall back to local calc for manual-entry users.
            const prepaidEl = document.getElementById('dash-prepaid-days');
            let prepaidDays;
            if (state.apiPrepaidDays != null) {
                prepaidDays = state.apiPrepaidDays;
            } else {
                prepaidDays = parseFloat(document.getElementById('discount')?.value) > 0
                    ? Math.round((gmtPrepaid + (parseFloat(document.getElementById('gmt-locked')?.value) || 0)) / (r.feesGmt > 0 ? r.feesGmt : 1))
                    : 0;
            }
            if (prepaidEl) {
                prepaidEl.textContent = prepaidDays + 'd';
                prepaidEl.style.color = prepaidDays > 30 ? 'var(--green)' : prepaidDays > 7 ? 'var(--accent)' : 'var(--red)';
            }

            // Next halving countdown (approx April 14, 2028)
            const halvingEl = document.getElementById('dash-halving');
            if (halvingEl) {
                const halvingDate = new Date('2028-04-14T00:00:00Z');
                const daysToHalving = Math.max(0, Math.round((halvingDate - new Date()) / 86400000));
                const years = Math.floor(daysToHalving / 365);
                const days = daysToHalving % 365;
                halvingEl.textContent = years > 0 ? `${years}y ${days}d` : `${days}d`;
            }

            // === Hero right column: Breakeven + Daily Fees ===
            const feesUsdPerDay = r.feesUsd;
            const grossBtcPerDay = r.grossBtc;
            const breakevenBtc = grossBtcPerDay > 0 ? feesUsdPerDay / grossBtcPerDay : 0;
            document.getElementById('dash-breakeven').textContent = formatUSD(breakevenBtc);
            // Annual ROI — feeds the Profit Card "ROI Period" stat
            const investValue = hashrate * (parseFloat(document.getElementById('cost-per-th-upgrade').value) || 12.34);
            const annualNet = r.netUsd * 365;
            const roiPeriodEl = document.getElementById('dh-roi-period');
            if (roiPeriodEl) roiPeriodEl.textContent = investValue > 0 ? (annualNet / investValue * 100).toFixed(1) + '%' : '—';
            // Daily fees — display unit + color follow the fee-mode toggle
            const feesEl = document.getElementById('dash-daily-fees');
            if (state.feeMode === 'btc') {
                feesEl.textContent = r.feesBtc.toFixed(8) + ' BTC';
                feesEl.style.color = 'var(--accent)';
            } else {
                feesEl.textContent = r.feesGmt.toFixed(2) + ' GMT';
                feesEl.style.color = 'var(--purple)';
            }

            // === Show calendar on dashboard if we have history ===
            if (state.rewardHistory?.length > 0) {
                document.getElementById('dash-history-section').style.display = 'block';
                showDashboardCalendar(state.rewardHistory);
            }

            // Update other dashboard sections
            updateMonthlyGoal();
            checkPriceAlerts();
            trackParamChanges();
            saveDashCache();
        }

        // ===== TH OBJECTIVE CALCULATOR =====
        function calcDaysToTarget(targetTH) {
            const c = state.lastCalc;
            if (!c || !state.btcPrice) return null;

            const costPerTH = parseFloat(document.getElementById('reinv-cost-per-th').value) || 12.34;
            const bonusPct = parseFloat(document.getElementById('reinv-bonus').value) / 100 || 0.05;
            let th = c.hashrate;
            let days = 0;
            const maxDays = 3650; // 10 years max

            while (th < targetTH && days < maxDays) {
                const dayR = calcDailyReward(th, c.efficiency, c.elecCost, c.discount, state.btcPrice, c.satPerTH);
                if (!dayR || dayR.grossUsd <= 0) return null;
                // Net, pas brut — cf. la note dans la boucle du Strategy Lab.
                const thGain = (dayR.netUsd / costPerTH) * (1 + bonusPct);
                th += thGain;
                days++;
            }

            return days >= maxDays ? null : { days, finalTH: th };
        }

        function updateThObjective(currentTH) {
            const section = document.getElementById('th-objective-section');
            section.style.display = 'block';

            const target = parseFloat(document.getElementById('th-target').value) || 128;
            const resultEl = document.getElementById('th-target-result');
            const milestonesEl = document.getElementById('th-milestones');

            if (target <= currentTH) {
                resultEl.textContent = t('th_already_reached');
                resultEl.style.color = 'var(--green)';
                milestonesEl.innerHTML = '';
                return;
            }

            const result = calcDaysToTarget(target);
            if (result) {
                const months = (result.days / 30).toFixed(1);
                resultEl.innerHTML = `<span style="font-size:1.3em">${result.days} ${t('days')}</span> <span style="color:var(--text-dim)">(~${months} ${t('months')})</span>`;
                resultEl.style.color = 'var(--green)';
            } else {
                resultEl.textContent = t('th_unreachable');
                resultEl.style.color = 'var(--red)';
            }

            // Show milestones (next power levels)
            const milestones = POWER_LEVELS.filter(p => p > currentTH && p <= Math.max(target, 512));
            let html = '<div style="display:flex;flex-wrap:wrap;gap:8px;">';
            for (const m of milestones.slice(0, 6)) {
                const res = calcDaysToTarget(m);
                if (res) {
                    html += `<div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:8px 12px;text-align:center;min-width:80px;">
                        <div style="font-weight:700;color:var(--accent2);">${m} TH</div>
                        <div style="font-size:0.8em;color:var(--text-dim);">${res.days}${t('d_suffix')} (~${(res.days/30).toFixed(0)}${t('m_suffix')})</div>
                    </div>`;
                }
            }
            html += '</div>';
            milestonesEl.innerHTML = html;
        }

        function updateThObjectiveWithCurve(currentTH) {
            const target = parseFloat(document.getElementById('th-target').value) || 128;
            const canvas = document.getElementById('th-curve-canvas');
            if (target <= currentTH) { canvas.style.display = 'none'; return; }
            const result = calcDaysToTargetWithCurve(target);
            if (result && result.curve.length > 2) {
                canvas.style.display = 'block';
                drawThCurve(canvas, result.curve, currentTH, target);
            } else {
                canvas.style.display = 'none';
            }
        }

        // Auto-update TH objective when target changes
        document.addEventListener('change', function(e) {
            if (e.target.id === 'th-target' && state.lastCalc) {
                updateThObjective(state.lastCalc.hashrate);
                updateThObjectiveWithCurve(state.lastCalc.hashrate);
            }
        });

        // ===== COMPARE STRATEGIES =====
        function compareStrategies() {
            if (!state.btcPrice || !state.gmtPrice) {
                alert(t('alert_load_data'));
                return;
            }

            const budget = parseFloat(document.getElementById('budget').value);
            const costPerThBuy = parseFloat(document.getElementById('cost-per-th-buy').value);
            const costPerThUpgrade = parseFloat(document.getElementById('cost-per-th-upgrade').value);
            const newEfficiency = parseFloat(document.getElementById('new-efficiency').value);
            const lockYears = parseFloat(document.getElementById('lock-duration').value);
            const veApr = parseFloat(document.getElementById('vegmt-apr').value);
            const elecCost = parseFloat(document.getElementById('elec-cost')?.value || 0.05);
            const discount = parseFloat(document.getElementById('discount')?.value || 10);

            // Strategy 1: Buy new NFT
            const thBuy = budget / costPerThBuy;
            const satPerTH = parseFloat(document.getElementById('sat-per-th').value) || 47;
            const rewardBuy = calcDailyReward(thBuy, newEfficiency, elecCost, discount, state.btcPrice, satPerTH);
            const yearProfitBuy = rewardBuy ? rewardBuy.netUsd * 365 : 0;
            const roiBuy = (yearProfitBuy / budget * 100);

            // Strategy 2: Upgrade existing NFT
            const thUpgrade = budget / costPerThUpgrade;
            const rewardUpgrade = calcDailyReward(thUpgrade, newEfficiency, elecCost, discount, state.btcPrice, satPerTH);
            const yearProfitUpgrade = rewardUpgrade ? rewardUpgrade.netUsd * 365 : 0;
            const roiUpgrade = (yearProfitUpgrade / budget * 100);

            // Strategy 3: Lock GMT
            const gmtTokens = budget / state.gmtPrice;
            const veGmtRatio = lockYears / 4; // linear: 4 years = 1:1
            const veGmt = gmtTokens * veGmtRatio;
            const yearRewardGmt = budget * (veApr / 100);
            const roiGmt = veApr * veGmtRatio; // simplified effective APR based on lock duration

            // Effective APR for lock: you get rewards proportional to veGMT, so shorter lock = less reward
            const effectiveAprGmt = veApr; // APR is already on the locked amount
            const yearRewardGmtEffective = budget * (effectiveAprGmt / 100);
            const roiGmtEffective = effectiveAprGmt;

            const bp = state.btcPrice;
            // Determine best
            const strategies = [
                { id: 'buy', roi: roiBuy },
                { id: 'upgrade', roi: roiUpgrade },
                { id: 'lock', roi: roiGmtEffective }
            ];
            const bestId = strategies.reduce((a, b) => a.roi > b.roi ? a : b).id;

            // Build cards
            const cardsHtml = `
                <div class="strategy-card ${bestId === 'buy' ? 'best' : ''}">
                    <h3>${t('strat_buy_nft')}</h3>
                    <div class="strategy-row"><span class="label">${t('strat_th_obtained')}</span><span>${thBuy.toFixed(1)} TH/s</span></div>
                    <div class="strategy-row"><span class="label">${t('strat_net_day')}</span><span class="${rewardBuy?.netGmt >= 0 ? 'positive' : 'negative'}">${formatProfit(rewardBuy?.netBtc || 0, bp, rewardBuy?.netGmt || 0, rewardBuy?.grossBtc || 0)}</span></div>
                    <div class="strategy-row"><span class="label">${t('strat_net_month')}</span><span class="${rewardBuy?.netGmt >= 0 ? 'positive' : 'negative'}">${formatProfit((rewardBuy?.netBtc || 0) * 30, bp, (rewardBuy?.netGmt || 0) * 30, (rewardBuy?.grossBtc || 0) * 30)}</span></div>
                    <div class="strategy-row"><span class="label">${t('strat_net_year')}</span><span class="${yearProfitBuy >= 0 ? 'positive' : 'negative'}">${formatProfit((rewardBuy?.netBtc || 0) * 365, bp, (rewardBuy?.netGmt || 0) * 365, (rewardBuy?.grossBtc || 0) * 365)}</span></div>
                    <div class="strategy-row"><span class="label">${t('strat_annual_roi')}</span><span class="${roiBuy >= 0 ? 'positive' : 'negative'}">${roiBuy.toFixed(1)}%</span></div>
                    <div class="strategy-row"><span class="label">${t('strat_payback_in')}</span><span>${rewardBuy?.netUsd > 0 ? Math.ceil(budget / rewardBuy.netUsd) + ' ' + t('days') : 'N/A'}</span></div>
                </div>

                <div class="strategy-card ${bestId === 'upgrade' ? 'best' : ''}">
                    <h3>${t('strat_upgrade_nft')}</h3>
                    <div class="strategy-row"><span class="label">${t('strat_th_added')}</span><span>+${thUpgrade.toFixed(1)} TH/s</span></div>
                    <div class="strategy-row"><span class="label">${t('strat_net_day')}</span><span class="${rewardUpgrade?.netGmt >= 0 ? 'positive' : 'negative'}">${formatProfit(rewardUpgrade?.netBtc || 0, bp, rewardUpgrade?.netGmt || 0, rewardUpgrade?.grossBtc || 0)}</span></div>
                    <div class="strategy-row"><span class="label">${t('strat_net_month')}</span><span class="${rewardUpgrade?.netGmt >= 0 ? 'positive' : 'negative'}">${formatProfit((rewardUpgrade?.netBtc || 0) * 30, bp, (rewardUpgrade?.netGmt || 0) * 30, (rewardUpgrade?.grossBtc || 0) * 30)}</span></div>
                    <div class="strategy-row"><span class="label">${t('strat_net_year')}</span><span class="${yearProfitUpgrade >= 0 ? 'positive' : 'negative'}">${formatProfit((rewardUpgrade?.netBtc || 0) * 365, bp, (rewardUpgrade?.netGmt || 0) * 365, (rewardUpgrade?.grossBtc || 0) * 365)}</span></div>
                    <div class="strategy-row"><span class="label">${t('strat_annual_roi')}</span><span class="${roiUpgrade >= 0 ? 'positive' : 'negative'}">${roiUpgrade.toFixed(1)}%</span></div>
                    <div class="strategy-row"><span class="label">${t('strat_payback_in')}</span><span>${rewardUpgrade?.netUsd > 0 ? Math.ceil(budget / rewardUpgrade.netUsd) + ' ' + t('days') : 'N/A'}</span></div>
                </div>

                <div class="strategy-card ${bestId === 'lock' ? 'best' : ''}">
                    <h3>${t('strat_lock_gmt')}</h3>
                    <div class="strategy-row"><span class="label">${t('strat_gmt_tokens')}</span><span>${formatNumber(gmtTokens)} GMT</span></div>
                    <div class="strategy-row"><span class="label">${t('strat_vegmt_received')}</span><span>${formatNumber(veGmt)} veGMT</span></div>
                    <div class="strategy-row"><span class="label">${t('strat_lock_duration')}</span><span>${lockYears >= 1 ? lockYears + ' ' + t('years') : (lockYears * 12) + ' ' + t('months')}</span></div>
                    <div class="strategy-row"><span class="label">${t('strat_est_rewards_year')}</span><span class="positive">${formatVal(yearRewardGmtEffective / bp, bp)}</span></div>
                    <div class="strategy-row"><span class="label">${t('strat_effective_apr')}</span><span class="positive">${roiGmtEffective.toFixed(1)}%</span></div>
                    <div class="strategy-row"><span class="label">${t('strat_payback_in')}</span><span>${roiGmtEffective > 0 ? Math.ceil(365 / roiGmtEffective * 100) + ' ' + t('days') : 'N/A'}</span></div>
                </div>
            `;

            document.getElementById('strategy-cards').innerHTML = cardsHtml;

            // Lock details
            document.getElementById('lock-details').innerHTML = `
                <div class="strategy-row"><span class="label">${t('lock_current_gmt')}</span><span>$${state.gmtPrice.toFixed(4)}</span></div>
                <div class="strategy-row"><span class="label">${t('lock_ratio')}</span><span>1 GMT locked ${lockYears} ${t('years')} = ${veGmtRatio.toFixed(2)} veGMT</span></div>
                <div class="strategy-row"><span class="label">${t('lock_note_label')}</span><span style="color:var(--text-dim);font-size:0.85em;">${t('lock_note_text')}</span></div>
            `;

            document.getElementById('compare-results').style.display = 'block';
        }

        // ===== UTILS =====
        function formatUSD(n) {
            if (n === undefined || n === null) return '--';
            return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        }

        function formatNumber(n) {
            return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        }

        function formatBigNumber(n) {
            if (n >= 1e15) return (n / 1e15).toFixed(2) + ' P';
            if (n >= 1e12) return (n / 1e12).toFixed(2) + ' T';
            if (n >= 1e9) return (n / 1e9).toFixed(2) + ' G';
            if (n >= 1e6) return (n / 1e6).toFixed(2) + ' M';
            return n.toLocaleString();
        }

        function formatHashrate(thps) {
            // Input is in GH/s from blockchain.info
            if (thps >= 1e12) return (thps / 1e12).toFixed(2) + ' ZH/s';
            if (thps >= 1e9) return (thps / 1e9).toFixed(2) + ' EH/s';
            if (thps >= 1e6) return (thps / 1e6).toFixed(2) + ' PH/s';
            if (thps >= 1e3) return (thps / 1e3).toFixed(2) + ' TH/s';
            return thps.toFixed(2) + ' GH/s';
        }

        // ===== TABS =====
        // Clavier sur la nav. Entrée et Espace activent, les flèches déplacent
        // le focus entre les onglets VISIBLES — plusieurs sont masqués et
        // doivent rester hors du parcours. Home/Fin vont aux extrémités.
        function initTabKeyboard() {
            const list = document.querySelector('.top-nav-tabs[role="tablist"]');
            if (!list) return;
            const visible = () => Array.from(list.querySelectorAll('[role="tab"]'))
                .filter(el => el.offsetParent !== null);
            list.addEventListener('keydown', (e) => {
                const tab = e.target.closest('[role="tab"]');
                if (!tab) return;
                if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
                    e.preventDefault();
                    switchTab(tab.dataset.tab);
                    return;
                }
                const tabs = visible();
                const i = tabs.indexOf(tab);
                if (i < 0) return;
                let j = null;
                if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = (i + 1) % tabs.length;
                else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') j = (i - 1 + tabs.length) % tabs.length;
                else if (e.key === 'Home') j = 0;
                else if (e.key === 'End') j = tabs.length - 1;
                if (j === null) return;
                e.preventDefault();
                // Déplacer le focus sans activer : l'utilisateur choisit avec
                // Entrée. Activer au passage ferait défiler tout le contenu
                // sous les doigts de quelqu'un qui ne fait que chercher.
                tabs.forEach(el => el.setAttribute('tabindex', '-1'));
                tabs[j].setAttribute('tabindex', '0');
                tabs[j].focus();
            });
        }

        function switchTab(name) {
            // Remove active from all tabs and nav items
            document.querySelectorAll('.tab-content').forEach(t => { t.classList.remove('active'); t.style.display = 'none'; });
            document.querySelectorAll('.nav-item').forEach(t => {
                t.classList.remove('active');
                if (t.getAttribute('role') === 'tab') {
                    t.setAttribute('aria-selected', 'false');
                    t.setAttribute('tabindex', '-1');
                }
            });

            // Sync URL hash (deep-link friendly without breaking current bookmarks)
            try {
                const hash = '#' + name;
                if (location.hash !== hash) history.replaceState(null, '', hash);
            } catch(_) {}

            // Activate target
            const target = document.querySelector(`#tab-${name}`);
            if (target) {
                target.style.display = 'block';
                requestAnimationFrame(() => target.classList.add('active'));
            }

            // Activate nav items
            document.querySelectorAll(`[data-tab="${name}"]`).forEach(el => {
                el.classList.add('active');
                if (el.getAttribute('role') === 'tab') {
                    el.setAttribute('aria-selected', 'true');
                    el.setAttribute('tabindex', '0');
                }
            });

            // Set section accent color
            const accentMap = {
                dashboard: '--a-dashboard', mining: '--a-mining', scenarios: '--a-scenarios',
                strategy: '--a-strategy', efficiency: '--a-efficiency',
                reinvest: '--a-reinvest', compare: '--a-compare', multisim: '--a-multisim', performance: '--a-performance',
                alerts: '--red', portfolio: '--accent'
            };
            const accentVar = accentMap[name] || '--accent';
            document.documentElement.style.setProperty('--current-accent', `var(${accentVar})`);

            // Scroll to top
            document.getElementById('main-content')?.scrollTo(0, 0);

            // Recalc triggers
            if (name === 'scenarios' && state.lastCalc) updateScenarios();
            if (name === 'multisim' && state.lastCalc) updateMultiSim();
            if (name === 'performance') updatePerformance();
            if (name === 'efficiency' && typeof updateEfficiencyCalc === 'function') updateEfficiencyCalc();
            if (name === 'alerts') checkPriceAlerts();
            if (name === 'portfolio') updatePortfolio();
        }

        // Collapsible toggle
        function toggleCollapsible(id) {
            document.getElementById(id).classList.toggle('collapsed');
        }

        // ===== IMPORT GOMINING JSON =====
        // ===== PERSISTENCE (localStorage) =====
        const SAVE_KEY = 'gomining_settings';
        const SAVE_FIELDS = [
            'hashrate', 'efficiency', 'elec-cost',
            'discount-maintenance', 'discount-vip', 'discount-streak', 'discount-solo',
            'reinv-cost-per-th', 'reinv-bonus', 'reinv-horizon', 'th-target',
            'reinv-gmt-balance', 'reinv-reserve-days',
            'budget', 'cost-per-th-buy', 'cost-per-th-upgrade',
            'new-efficiency', 'lock-duration', 'vegmt-apr',
            'alert-btc-high', 'alert-btc-low', 'alert-gmt-high', 'alert-gmt-low',
            'staking-gmt-weekly', 'monthly-goal'
        ];

        function saveSettings() {
            const data = {};
            SAVE_FIELDS.forEach(id => {
                const el = document.getElementById(id);
                if (el) data[id] = el.value;
            });
            localStorage.setItem(SAVE_KEY, JSON.stringify(data));
        }

        // ===== MANUAL ENTRY MODAL (full NFT params + BTC/GMT price overrides) =====
        function openManualEntry() {
            // Pre-fill price overrides with current live state
            const btcEl = document.getElementById('manual-btc-price');
            const gmtEl = document.getElementById('manual-gmt-price');
            if (btcEl) btcEl.value = state.btcPrice ? state.btcPrice.toFixed(2) : '';
            if (gmtEl) gmtEl.value = state.gmtPrice ? state.gmtPrice.toFixed(4) : '';
            document.getElementById('manual-entry-modal').style.display = 'flex';
            // Auto-focus the first input — keyboard-friendly
            setTimeout(() => document.getElementById('hashrate')?.focus(), 60);
        }
        function closeManualEntry() {
            document.getElementById('manual-entry-modal').style.display = 'none';
        }
        // Reset all NFT-Miner-Parameters fields to GoMining-typical defaults
        // (matches the placeholder values in the HTML).
        window.resetManualEntry = function () {
            const defaults = {
                'hashrate': 1, 'efficiency': 15, 'elec-cost': 0.05,
                'discount-maintenance': 0, 'discount-vip': 0,
                'discount-streak': 0, 'discount-solo': 0,
                'gmt-prepaid': 0, 'gmt-locked': 0,
                'sat-per-th': 47,
                'manual-btc-price': '', 'manual-gmt-price': '',
            };
            Object.entries(defaults).forEach(([id, val]) => {
                const el = document.getElementById(id);
                if (el) el.value = val;
            });
        };

        function applyManualPrices() {
            // Push manual price overrides into state and trigger recalc.
            // Empty values leave the live prices untouched.
            const btc = parseFloat(document.getElementById('manual-btc-price').value);
            const gmt = parseFloat(document.getElementById('manual-gmt-price').value);
            if (!isNaN(btc) && btc > 0) {
                state.btcPrice = btc;
                const btcPriceEl = document.getElementById('btc-price');
                if (btcPriceEl) btcPriceEl.textContent = formatUSD(btc);
            }
            if (!isNaN(gmt) && gmt > 0) {
                state.gmtPrice = gmt;
                const gmtPriceEl = document.getElementById('gmt-price');
                if (gmtPriceEl) gmtPriceEl.textContent = '$' + gmt.toFixed(4);
            }
            saveSettings();
            if (typeof calculate === 'function') calculate();
            if (typeof toast === 'function') toast('Settings applied', 'success', 2200);
        }

        function loadSettings() {
            try {
                const data = JSON.parse(localStorage.getItem(SAVE_KEY));
                if (!data) return;
                SAVE_FIELDS.forEach(id => {
                    const el = document.getElementById(id);
                    if (el && data[id] !== undefined) el.value = data[id];
                });
                // Migrate electricity cost if it was changed to wrong value
                const elecEl = document.getElementById('elec-cost');
                if (elecEl && parseFloat(elecEl.value) === 0.046) elecEl.value = ELEC_COST_DEFAULT;
            } catch (e) {}
        }

// Auto-save on any input change
        // Auto-save et auto-calcul sur chaque changement
        function autoRecalc() {
            saveSettings();
            if (state.btcPrice && state.gmtPrice) {
                calculate();
            }
        }
        document.querySelectorAll('input, select').forEach(el => {
            el.addEventListener('change', autoRecalc);
        });

        // ===== SYNC FROM EXTENSION (clipboard) =====
        async function syncFromExtension() {
            try {
                const text = await navigator.clipboard.readText();
                if (text.startsWith('GMDATA:')) {
                    const json = text.substring(7);
                    const essentials = JSON.parse(json);
                    applyEssentials(essentials);
                    alert(t('sync_success'));
                } else {
                    alert(t('sync_no_data'));
                }
            } catch(e) {
                alert(t('sync_clipboard_denied'));
            }
        }

        function applyEssentials(data) {

            // Miner
            if (data.miner?.power) syncField('hashrate', data.miner.power);
            if (data.miner?.energyEfficiency) syncField('efficiency', data.miner.energyEfficiency);

            // L'extension capte plus que ce qu'on affichait. Ces champs
            // existaient depuis des versions sans jamais être lus :
            //  · minerCount        combien de mineurs on possède
            //  · efficiencyPartial la moyenne ne couvre pas toute la ferme
            //  · *Source           d'où sort chaque prix
            //  · c1/c2 de GoMining leurs composantes de frais, pour se vérifier
            // Les garder invisibles, c'est présenter une estimation comme une
            // mesure — exactement ce qu'on passe la semaine à corriger.
            if (data.miner?.minerCount) state.minerCount = data.miner.minerCount;
            if (data.miner?.efficiencyPartial !== undefined) {
                state.efficiencyPartial = !!data.miner.efficiencyPartial;
                state.efficiencyRatedPower = data.miner.efficiencyRatedPower || null;
            }
            state.sources = Object.assign({}, state.sources, {
                pr:  data.income?.prPerThSource   || state.sources?.pr  || null,
                gmt: data.prices?.gmtPriceSource  || state.sources?.gmt || null,
                btc: data.prices?.btcPriceSource  || state.sources?.btc || null,
            });
            if (data.income?.c2PerTh) state.gmC2PerTh = data.income.c2PerTh;
            if (data.income?.c1PerThPerWt) state.gmC1PerThPerWt = data.income.c1PerThPerWt;

            // Wallet
            if (data.wallet?.gmtBalance !== undefined) document.getElementById('gmt-prepaid').value = parseFloat(data.wallet.gmtBalance).toFixed(2);
            if (data.wallet?.gmtLocked !== undefined) document.getElementById('gmt-locked').value = data.wallet.gmtLocked;
            if (data.wallet?.btcBalance !== undefined) state.btcWalletBalance = data.wallet.btcBalance;

            // Capital externe, reconstitué depuis le relevé de transactions.
            // Reste null si le relevé n'a pas été capté — le Portfolio doit
            // pouvoir distinguer « aucun dépôt » de « je n'en sais rien ».
            // Couverture des pages GoMining : ce qui est capté, ce qui manque.
            // Même raisonnement pour la couverture : on garde l'union de ce qu'on a
            // déjà vu et de ce qui arrive. Un endpoint capté hier puis purgé ne
            // doit pas faire régresser la liste.
            if (data.coverage) {
                const prev = state.coverage || {};
                const merged = {};
                for (const k of new Set([...Object.keys(prev), ...Object.keys(data.coverage)])) {
                    merged[k] = prev[k] === true || data.coverage[k] === true;
                }
                state.coverage = merged;
                try { localStorage.setItem('gms_coverage', JSON.stringify(merged)); } catch (e) {}
            }
            if (data.capital) {
                state.capital = mergeCapital(state.capital, data.capital);
                saveCapital(state.capital);
            }

            // Termes complémentaires de la formule GoMining, mesurés sur le dernier
            // jour complet : bonus GoBTC Pay et commission de réinvestissement.
            // Tarif électrique : GoMining le publie dans incomeStatistic.kilowattHour.
            // C'était le dernier paramètre laissé à la saisie manuelle, et une
            // valeur erronée y pèse lourd — $0,06 au lieu de $0,05 retirait 20 %
            // sur la moitié des frais, soit $2,30/jour sur cette ferme.
            // Gains à vie, tenus par GoMining — Miner Wars compris.
            if (data.miner?.bonusMinerPower > 0) state.bonusMinerPower = data.miner.bonusMinerPower;

            // Taux d'upgrade déduit de l'historique : il remplace le nombre codé
            // en dur et renseigne les champs, qui restent modifiables.
            if (data.income?.upgradeRateUsd > 0) {
                state.upgradeRateUsd = data.income.upgradeRateUsd;
                try { localStorage.setItem('gms_upgrade_rate', JSON.stringify(data.income.upgradeRateUsd)); } catch (e) {}
                for (const id of ['cost-per-th-upgrade', 'reinv-cost-per-th', 'strategy-cost-per-th']) {
                    const el = document.getElementById(id);
                    // Ne jamais écraser une valeur que l'utilisateur a saisie
                    // lui-même : le champ du Strategy Lab marque ses éditions.
                    if (el && el.dataset.userEdited !== '1') {
                        el.value = data.income.upgradeRateUsd.toFixed(2);
                    }
                }
            }
            if (data.income?.lifetime?.btc > 0) {
                state.lifetimeIncome = data.income.lifetime;
                try { localStorage.setItem('gms_lifetime_income', JSON.stringify(data.income.lifetime)); } catch (e) {}
            }
            if (data.income?.elecCostKwh > 0) {
                syncField('elec-cost', data.income.elecCostKwh);
            }
            if (data.income?.gbpSatPerTh !== undefined) state.gbpSatPerTh = data.income.gbpSatPerTh;
            if (data.income?.reinvestCommissionRate !== undefined) state.reinvestCommissionRate = data.income.reinvestCommissionRate;

            // Discounts (API returns decimals: 0.03 = 3%)
            // The API is the source of truth — set discountFromApi so the
            // local prepaid-days heuristic in updatePrepaidDiscount() doesn't
            // overwrite the token discount on next fetchLiveData / input change.
            if (data.discount?.streak !== undefined) document.getElementById('discount-streak').value = (data.discount.streak * 100).toFixed(1);
            if (data.discount?.vip !== undefined) document.getElementById('discount-vip').value = (data.discount.vip * 100).toFixed(1);
            if (data.discount?.miningMode !== undefined) document.getElementById('discount-solo').value = (data.discount.miningMode * 100).toFixed(2);
            if (data.discount?.token !== undefined) {
                document.getElementById('discount-maintenance').value = (data.discount.token * 100).toFixed(1);
                state.discountFromApi = true;
            }
            if (data.discount?.availableDays !== undefined && data.discount.availableDays > 0) {
                state.apiPrepaidDays = data.discount.availableDays;
            }

            // Prices — GoMining API prices have priority over CoinGecko
            // Fallback: prices from the last complete day (yesterday) of reward history
            const lastDay = getLastCompleteRewardDay(data.rewardHistory);

            const apiGmt = data.prices?.gmtPrice || (lastDay?.gmtPrice) || null;
            const apiBtc = data.prices?.btcPrice || (lastDay?.btcPrice) || null;

            // GoMining's prices are snapshots from the user's last visit to
            // app.gomining.com — they can be hours stale. We keep them in
            // `apiBtcPrice` / `apiGmtPrice` (used for Mining Wars sat/TH math
            // that needs to match GoMining's app exactly), but DON'T overwrite
            // the live display prices (`btcPrice` / `gmtPrice`) which come
            // from Binance/CoinGecko via fetchLiveData and are real-time.
            if (apiBtc) {
                state.apiBtcPrice = apiBtc;
                // Only seed the live price if we have nothing live yet
                if (!state.btcPrice) {
                    state.btcPrice = apiBtc;
                    document.getElementById('btc-price').textContent = formatUSD(state.btcPrice);
                }
            }
            if (apiGmt) {
                state.apiGmtPrice = apiGmt;
                if (!state.gmtPrice) {
                    state.gmtPrice = apiGmt;
                    document.getElementById('gmt-price').textContent = '$' + state.gmtPrice.toFixed(4);
                }
            }

            // Store reward history — merge with existing to avoid losing days
            // (dashboard sync returns ~6 days, rewards page ~20 days)
            if (data.rewardHistory?.length > 0) {
                state.rewardHistory = mergeRewardHistory(state.rewardHistory, data.rewardHistory);
                saveRewardHistory(state.rewardHistory);
                showValidation(state.rewardHistory);
                // Record performance tracking
                recordPerformance(state.rewardHistory);
            }

            // Income / sat per TH — prefer last complete day from reward history
            // totalIncomePerThToday is accumulated since midnight UTC (partial day = wrong PR)
            {
                const gmtP = apiGmt || state.apiGmtPrice || state.gmtPrice;
                const btcP = apiBtc || state.apiBtcPrice || state.btcPrice;
                let satPerTH = null;

                // Primary: last complete day from reward history (always yesterday,
                // never today — see getLastCompleteRewardDay).
                // Read from the merged state.rewardHistory rather than the just-arrived
                // payload — when this sync didn't include reward data (e.g. dashboard-only
                // visit), the merged history still has yesterday's complete day from a
                // previous sync, and PR refreshes to reflect it instead of staying stuck.
                let latestForPR = null;
                if (state.rewardHistory?.length > 0) {
                    latestForPR = getLastCompleteRewardDay(state.rewardHistory);
                    if (latestForPR && latestForPR.poolReward && latestForPR.power) {
                        satPerTH = Math.round(latestForPR.poolReward / latestForPR.power * 1e8);
                    }
                }

                // Fallback: totalIncomePerThToday (partial day, varies by hour).
                // Only used as absolute last resort if we have no history AND no
                // existing apiSatPerTH from a previous load — and never overwrites a
                // good value, so PR stays stable across syncs.
                if (!satPerTH && !state.apiSatPerTH && data.income?.prPerThGmt && gmtP && btcP) {
                    const prBtcPerTH = data.income.prPerThGmt * gmtP / btcP;
                    satPerTH = Math.round(prBtcPerTH * 1e8);
                }

                if (satPerTH) {
                    syncField('sat-per-th', satPerTH);
                    state.satPerTH = satPerTH;
                    state.apiSatPerTH = satPerTH;
                    document.getElementById('net-hashrate').textContent = satPerTH + ' PR';
                }
            }

            // Auto-fill cost per TH from extension data (upgrade price endpoint)
            if (data.upgrade?.costPerTH && data.upgrade.costPerTH > 0) {
                state.costPerTH = data.upgrade.costPerTH;
                if (typeof updateStrategyPriceHints === 'function') updateStrategyPriceHints();
            }

            // `data.staking` vaut `{}` — un objet VIDE, donc « vrai » — quand
            // l'extension n'a pas les données du lock, c'est-à-dire dès que son
            // cache 24 h a expiré. L'affecter sans condition effaçait donc à
            // chaque synchro ce qu'on avait : la ligne veGMT ne se cochait jamais,
            // même juste après avoir visité la page. Même piège que pour le
            // capital, et la même règle s'applique : on ne remplace que par
            // quelque chose de plus riche.
            if (data.staking && (data.staking.gmtLocked || data.staking.votes)) {
                state.staking = data.staking;
                try { localStorage.setItem('gms_staking', JSON.stringify(data.staking)); } catch (e) {}
            }

            // Auto-fill staking weekly GMT from extension data
            if (data.staking?.weeklyGmtReward) {
                const stakingEl = document.getElementById('staking-gmt-weekly');
                if (stakingEl) {
                    stakingEl.value = data.staking.weeklyGmtReward.toFixed(2);
                    saveSettings();
                }
            }

            // Track sync time
            state.lastSyncTime = Date.now();
            updateSyncStatus();

            // Recalculate
            calcTotalDiscount();
            saveSettings();
            calculate();

            // Le Portfolio ne se redessinait QUE lors du passage sur son onglet.
            // Un utilisateur déjà dessus voyait donc un rendu antérieur à l'arrivée
            // des données : le capital, la ventilation et la moyenne étaient bien
            // en mémoire, l'écran ne les relisait jamais. C'est ce qui donnait
            // « d'après tes saisies manuelles » alors que le relevé était là.
            if (typeof updatePortfolio === 'function') {
                try { updatePortfolio(); } catch (e) {}
            }
            if (typeof renderScanChecklist === 'function') {
                try { renderScanChecklist(); } catch (e) {}
            }
        }

        // ===== VALIDATION =====
        function getRewardTypeLabel(day) {
            if (day.reinvestInTH) return 'TH';
            if (day.toWalletType === 'VIRTUAL_GMT') return 'GMT';
            if (day.toWalletType === 'VIRTUAL_BTC' || day.toWalletType === 'BTC') return 'BTC';
            if (day.reinvestment) return 'GMT'; // reinvestment in GMT mode
            return 'BTC';
        }

        function getRewardTypeColor(day) {
            const type = getRewardTypeLabel(day);
            if (type === 'TH') return 'var(--green)';
            if (type === 'GMT') return 'var(--purple)';
            return 'var(--accent)';
        }

        function showValidation(history) {
            if (!history || history.length === 0) return;
            const section = document.getElementById('validation-section');
            section.style.display = 'block';

            const latest = history[history.length - 1];
            if (!latest.poolReward || !latest.gmtPrice) return;

            // My calculation for same params
            const myR = calcDailyReward(
                latest.power, 15, 0.05, latest.totalDiscount * 100,
                latest.btcPrice, Math.round(latest.poolReward / latest.power * 1e8)
            );

            if (!myR) return;

            const gmActualC1 = latest.c1;
            const gmActualC2 = latest.c2;
            const gmActualGross = latest.poolReward;
            // Net = brut - frais (pas valueBtc qui est le montant réinvesti avant frais GMT)
            const gmActualNet = gmActualGross - gmActualC1 - gmActualC2;

            const rows = [
                { label: t('val_row_gross'), gm: gmActualGross, my: myR.grossBtc, unit: 'BTC' },
                { label: t('val_row_c1'), gm: gmActualC1, my: myR.feesBtc * (gmActualC1 / (gmActualC1 + gmActualC2)), unit: 'BTC' },
                { label: t('val_row_c2'), gm: gmActualC2, my: myR.feesBtc * (gmActualC2 / (gmActualC1 + gmActualC2)), unit: 'BTC' },
                { label: t('val_row_net'), gm: gmActualNet, my: myR.netBtc, unit: 'BTC' }
            ];

            let html = `<div style="font-size:0.85em;color:var(--text-dim);margin-bottom:10px;">
                ${t('val_last_data')}: ${latest.date} | ${latest.power} TH | Discount: ${(latest.totalDiscount * 100).toFixed(2)}% | GMT: $${latest.gmtPrice}
            </div>`;
            html += `<table><thead><tr><th style="text-align:left">${t('val_metric')}</th><th>GoMining</th><th>${t('val_simulator')}</th><th>${t('perf_gap')}</th></tr></thead><tbody>`;

            for (const row of rows) {
                const ecart = row.gm > 0 ? ((row.my - row.gm) / row.gm * 100).toFixed(2) : '--';
                const ecartColor = Math.abs(parseFloat(ecart)) < 1 ? 'var(--green)' : Math.abs(parseFloat(ecart)) < 5 ? 'var(--accent)' : 'var(--red)';
                html += `<tr>
                    <td>${row.label}</td>
                    <td>${row.gm?.toFixed(8)} ${row.unit}</td>
                    <td>${row.my?.toFixed(8)} ${row.unit}</td>
                    <td style="color:${ecartColor};font-weight:700">${ecart}%</td>
                </tr>`;
            }
            html += '</tbody></table>';

            const overallEcart = gmActualNet > 0 ? Math.abs((myR.netBtc - gmActualNet) / gmActualNet * 100) : 0;
            if (overallEcart < 1) {
                html += `<div style="margin-top:10px;color:var(--green);font-weight:700;">${t('val_accuracy')}: ${(100 - overallEcart).toFixed(2)}% - ${t('val_validated')}</div>`;
            } else {
                html += `<div style="margin-top:10px;color:var(--accent);font-weight:700;">${t('val_net_gap')}: ${overallEcart.toFixed(2)}% — ${t('val_check_params')}</div>`;
            }

            document.getElementById('validation-content').innerHTML = html;
        }

        // ===== REWARD HISTORY CALENDAR =====
        // Replicates GoMining's "Reward" column formula for a day's net
        // GMT income. The displayed value matches what the user sees in
        // their app.gomining.com rewards table.
        //
        //   gross GMT = poolReward (BTC) × btcPrice / gmtPrice
        //   fees per TH (GMT) = (electricity + service) × (1 − discount)
        //   net GMT = gross − fees × power
        //
        // This bypasses the API field `maintenanceForWithdrawInGmt`
        // (which mysteriously over-deducts by ~5–10 GMT — likely a hidden
        // withdraw fee folded into that field).
        function computeDayNetGmt(day) {
            // Match GoMining's "Reward" column: PR − Electricity − Service.
            //
            // GROSS GMT — derive from poolReward (BTC) when its value
            // is internally consistent (within 25 % of the expected
            // power × ~46 sat/TH/day). Some stored entries are
            // partial-day captures whose poolReward is too small —
            // detect that and fall back to `power × satPerTH × btcP/gmtP`
            // which is reliable across days.
            //
            // FEES — calcDailyReward formula using day's gmtPrice +
            // power + totalDiscount (stored as fraction 0.0938 not 9.38).
            const btcP = day.btcPrice || state.btcPrice || 67000;
            const gmtP = day.gmtPrice || state.gmtPrice || 0.3;
            const power = day.power || 0;
            if (!btcP || !gmtP || !power) return 0;

            const satPerTH = state.satPerTH || state.apiSatPerTH || 47;
            const expectedGross = satPerTH * power * btcP / gmtP / 1e8;

            // Trust poolReward if within 25 % of expected gross
            let grossGmt = expectedGross;
            if (day.poolReward) {
                const fromStored = day.poolReward * btcP / gmtP;
                if (Math.abs(fromStored - expectedGross) / expectedGross < 0.25) {
                    grossGmt = fromStored;
                }
            }

            const ELEC_USD_KWH = 0.05;
            const EFFICIENCY_W_TH = 15;
            const discountMult = 1 - (day.totalDiscount || 0);
            const c1Per = (ELEC_USD_KWH * 24 * EFFICIENCY_W_TH / gmtP / 1000) * discountMult;
            const c2Per = (SERVICE_COST_PER_TH / gmtP) * discountMult;
            const totalFees = (c1Per + c2Per) * power;
            return grossGmt - totalFees;
        }

        function showDashboardCalendar(history) {
            if (!history || history.length < 1) return;
            const el = document.getElementById('dash-history-chart');
            if (!el) return;
            // Reuse the same rendering logic as showRewardChart but target dashboard element
            renderCalendar(history, el);
        }

function renderCalendar(history, chartEl) {
            if (!history || !chartEl) return;

            // Build a map of date → reward
            const rewardMap = {};
            for (const day of history) {
                rewardMap[day.date] = day;
            }

            // Find date range
            const firstDate = new Date(history[0].date + 'T00:00:00');
            const lastDate = new Date(history[history.length - 1].date + 'T00:00:00');

            // Start from the Monday of the first week
            const startDate = new Date(firstDate);
            startDate.setDate(startDate.getDate() - ((startDate.getDay() + 6) % 7)); // Monday

            // End at Sunday of last week
            const endDate = new Date(lastDate);
            endDate.setDate(endDate.getDate() + (7 - endDate.getDay()) % 7); // Sunday

            const dayNames = currentLang === 'fr' ? ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'] : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

            let html = '<div style="display:flex;gap:15px;margin-bottom:10px;font-size:0.75em;color:var(--text-dim);">';
            html += '<span><span style="display:inline-block;width:10px;height:10px;background:var(--accent);border-radius:2px;"></span> BTC</span>';
            html += '<span><span style="display:inline-block;width:10px;height:10px;background:var(--purple);border-radius:2px;"></span> GMT</span>';
            html += '<span><span style="display:inline-block;width:10px;height:10px;background:var(--green);border-radius:2px;"></span> TH</span>';
            html += '</div>';

            // Calculate weekly NET totals.
            // Net = gross reward − (electricity + service) fees, computed via
            // computeDayNetGmt and converted to BTC at each day's historical
            // prices so USD reflects what was actually received that week
            // (not today's BTC price).
            const weeklyTotalsBtc = {};
            const weeklyTotalsUsd = {};
            for (const day of history) {
                const d = new Date(day.date + 'T00:00:00');
                const weekStart = new Date(d);
                weekStart.setDate(d.getDate() - ((d.getDay() + 6) % 7));
                const weekKey = weekStart.toISOString().substring(0, 10);

                const netGmt = computeDayNetGmt(day);
                const gmtP = day.gmtPrice || state.gmtPrice || 0;
                const btcP = day.btcPrice || state.btcPrice || 0;
                if (!netGmt || !gmtP || !btcP) continue;
                const netUsd = netGmt * gmtP;
                const netBtc = netUsd / btcP;

                weeklyTotalsBtc[weekKey] = (weeklyTotalsBtc[weekKey] || 0) + netBtc;
                weeklyTotalsUsd[weekKey] = (weeklyTotalsUsd[weekKey] || 0) + netUsd;
            }

            // Calendar grid with weekly total column
            html += '<div style="display:grid;grid-template-columns:repeat(7,1fr) 80px;gap:3px;">';

            // Header
            for (const name of dayNames) {
                html += `<div style="text-align:center;font-size:0.75em;font-weight:700;color:var(--text-dim);padding:5px 0;">${name}</div>`;
            }
            html += `<div style="text-align:center;font-size:0.75em;font-weight:700;color:var(--accent);padding:5px 0;">${t('cal_week')}</div>`;

            // Days
            const todayStr = new Date().toISOString().substring(0, 10);
            let weekDayCount = 0;
            let currentWeekKey = null;
            const current = new Date(startDate);
            while (current <= endDate) {
                const dateStr = current.toISOString().substring(0, 10);
                const day = rewardMap[dateStr];
                const dayNum = current.getDate();
                const isInRange = current >= firstDate && current <= lastDate;

                // Track week key for totals
                const wk = new Date(current);
                wk.setDate(current.getDate() - ((current.getDay() + 6) % 7));
                currentWeekKey = wk.toISOString().substring(0, 10);

                if (day) {
                    const type = getRewardTypeLabel(day);
                    const color = getRewardTypeColor(day);
                    const btcRef = day.btcPrice || state.btcPrice || 67000;
                    const gmtRef = day.gmtPrice || state.gmtPrice || 0.3;
                    let valueText = '';
                    if (type === 'BTC') {
                        valueText = day.valueBtc.toFixed(8);
                    } else if (type === 'GMT') {
                        // Match GoMining's "Reward" column directly:
                        //   net = poolReward (BTC) × btc/gmt − fees
                        //   fees per TH = (c1 + c2) computed via calcDailyReward
                        //                 formula using the day's discount.
                        // Earlier we used `gmtIncome − maintenanceGmt`, but
                        // `maintenanceForWithdrawInGmt` from the API
                        // includes a hidden withdraw fee on top of
                        // electricity+service, so the result was 15–20×
                        // smaller than what GoMining shows.
                        valueText = computeDayNetGmt(day).toFixed(2);
                    } else if (type === 'TH') {
                        // Pour un jour PASSÉ, les TH gagnés ne sont pas à estimer :
                        // ils sont observables. La puissance du lendemain moins celle
                        // du jour donne exactement ce qui a été ajouté, sans taux, sans
                        // bonus, sans hypothèse.
                        //
                        // On n'estime que si le lendemain manque encore. Et l'estimation
                        // reposait sur un taux figé à 12,34 $ : il valait 12,08 $ en
                        // juillet et ~10,19 $ fin août, d'où 0,859 TH affiché pour 1,04
                        // réellement gagnés. Le taux est désormais déduit — mais rien ne
                        // vaut la mesure quand elle existe.
                        const observed = observedThGain(day.date);
                        if (observed !== null) {
                            valueText = '+' + observed.toFixed(3);
                        } else {
                            const est = day.valueBtc * btcRef / upgradeRate() * (1 + TH_BONUS);
                            valueText = '~' + est.toFixed(3);   // le tilde dit que c'est estimé
                        }
                    }

                    const isToday = dateStr === todayStr;
                    const todayRing = isToday ? 'box-shadow:0 0 0 2px rgba(247,147,26,0.55), 0 0 14px rgba(247,147,26,0.30);' : '';
                    const todayBadge = isToday ? '<span style="position:absolute;top:2px;right:4px;font-size:0.55em;font-weight:800;color:var(--accent);text-transform:uppercase;letter-spacing:0.06em;">today</span>' : '';
                    html += `<div style="background:var(--bg);border:2px solid ${color};border-radius:6px;padding:4px;min-height:55px;position:relative;${todayRing}">
                        ${todayBadge}
                        <div style="font-size:0.65em;color:var(--text-dim);">${dayNum}</div>
                        <div style="font-size:0.7em;font-weight:700;color:${color};margin-top:2px;">${valueText}</div>
                        <div style="font-size:0.6em;color:var(--text-dim);margin-top:1px;">${type}</div>
                    </div>`;
                } else if (isInRange) {
                    const isToday = dateStr === todayStr;
                    const todayRing = isToday ? 'opacity:1;box-shadow:0 0 0 2px rgba(247,147,26,0.55);' : '';
                    html += `<div style="background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:4px;min-height:55px;opacity:0.3;${todayRing}">
                        <div style="font-size:0.65em;color:${isToday ? 'var(--accent)' : 'var(--text-dim)'};font-weight:${isToday ? 700 : 400};">${dayNum}${isToday ? ' · today' : ''}</div>
                    </div>`;
                } else {
                    html += `<div style="min-height:55px;opacity:0.1;">
                        <div style="font-size:0.65em;color:var(--text-dim);padding:4px;">${dayNum}</div>
                    </div>`;
                }

                weekDayCount++;
                // End of week (Sunday) — add weekly NET total cell
                if (weekDayCount % 7 === 0) {
                    const wBtc = weeklyTotalsBtc[currentWeekKey] || 0;
                    const wUsd = weeklyTotalsUsd[currentWeekKey] || 0;
                    if (wBtc > 0) {
                        html += `<div style="background:rgba(247,147,26,0.06);border:1px solid rgba(247,147,26,0.15);border-radius:6px;padding:4px;min-height:55px;display:flex;flex-direction:column;align-items:center;justify-content:center;">
                            <div style="font-size:0.7em;font-weight:700;color:var(--accent);">${formatUSD(wUsd)}</div>
                            <div style="font-size:0.55em;color:var(--text-dim);">${wBtc.toFixed(8)}</div>
                        </div>`;
                    } else {
                        html += '<div style="min-height:55px;"></div>';
                    }
                }

                current.setDate(current.getDate() + 1);
            }

            html += '</div>';

            // Total summary — net GMT (brut - frais), brut BTC
            let totalBtc = 0, totalGmtNet = 0, totalGmtFees = 0;
            let totalDays = history.length;
            for (const day of history) {
                totalBtc += day.valueBtc;
                const type = getRewardTypeLabel(day);
                if (type === 'GMT') {
                    // Same as per-cell: use the calcDailyReward-based
                    // formula so totals match GoMining's table.
                    const net = computeDayNetGmt(day);
                    if (net != null) totalGmtNet += net;
                    // Fees inferred = grossGmt − net for transparency
                    const btcP = day.btcPrice || state.btcPrice || 67000;
                    const gmtP = day.gmtPrice || state.gmtPrice || 0.3;
                    const grossGmt = (day.poolReward || 0) * btcP / gmtP;
                    totalGmtFees += Math.max(0, grossGmt - net);
                }
            }
            html += `<div style="margin-top:12px;display:flex;flex-wrap:wrap;gap:20px;font-size:0.85em;">
                <span style="color:var(--text-dim);">Total: <strong style="color:var(--green)">${totalBtc.toFixed(8)} BTC</strong> (${formatUSD(totalBtc * state.btcPrice)})</span>
                ${totalGmtNet > 0 ? `<span style="color:var(--text-dim);">Net GMT: <strong style="color:var(--purple)">${totalGmtNet.toFixed(2)} GMT</strong> (${t('dash_fees')}: ${totalGmtFees.toFixed(2)})</span>` : ''}
                <span style="color:var(--text-dim);">${t('cal_average')}: <strong style="color:var(--accent2)">${(totalBtc / totalDays).toFixed(8)} BTC</strong>/${t('cal_day')}</span>
                <span style="color:var(--text-dim);">${totalDays} ${t('days')}</span>
            </div>`;

            chartEl.style.height = 'auto';
            chartEl.innerHTML = html;
        }

        // ===== LIVE TICKER =====
        let tickerInterval = null;
        let tickerAccumulated = 0;
        let tickerPerSecond = 0;

        function startTicker(dailyNetUsd) {
            tickerPerSecond = dailyNetUsd / 86400;
            const now = new Date();
            const secondsSinceMidnight = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
            tickerAccumulated = tickerPerSecond * secondsSinceMidnight;

            document.getElementById('live-ticker').style.display = 'flex';

            if (tickerInterval) clearInterval(tickerInterval);
            tickerInterval = setInterval(() => {
                tickerAccumulated += tickerPerSecond;
                document.getElementById('ticker-gain').textContent = formatUSD(tickerAccumulated);
            }, 1000);

            // Update prices in ticker
            if (state.btcPrice) document.getElementById('ticker-btc').textContent = '$' + Math.round(state.btcPrice).toLocaleString();
            if (state.gmtPrice) document.getElementById('ticker-gmt').textContent = '$' + state.gmtPrice.toFixed(4);
            if (state.satPerTH) document.getElementById('ticker-pr').textContent = state.satPerTH;

            updateSyncStatus();
        }

        // ===== DATA SOURCE INDICATOR =====
        function updateSyncStatus() {
            const dot = document.getElementById('sync-dot');
            const label = document.getElementById('sync-label');
            const status = document.getElementById('sync-status');
            const lastSync = state.lastSyncTime;

            // Freshness guard: "auto-sync active" only means a sync event fired,
            // NOT that the data is current. If the newest COMPLETE reward day is
            // several days old (e.g. the GoMining rewards page hasn't been opened
            // in a while), the numbers on screen are stale — say so plainly
            // instead of showing a reassuring green dot.
            const lastDay = getLastCompleteRewardDay(state.rewardHistory);
            let staleDays = 0;
            if (lastDay?.date) {
                staleDays = Math.floor(
                    (Date.parse(new Date().toISOString().substring(0, 10)) - Date.parse(lastDay.date)) / 86400000
                );
            }

            // GoMining écrit l'enregistrement d'un jour le LENDEMAIN : le 27, le jour
            // complet le plus récent possible est le 26. `staleDays = 1` est donc
            // parfaitement à jour, et `2` signifie qu'il manque UN jour, pas deux.
            //
            // On annonce donc la date du dernier jour connu plutôt qu'un compteur
            // qu'il faut interpréter, et on nomme la page Rewards — l'ancien
            // message disait « rouvre GoMining », ce que l'utilisateur venait de
            // faire sans que ça change quoi que ce soit.
            const missing = Math.max(0, staleDays - 1);
            if (missing >= 3) {
                dot.className = 'sync-dot stale';
                label.textContent = t('sync_stale').replace('{d}', lastDay.date);
            } else if (missing >= 1) {
                dot.className = 'sync-dot warn';
                label.textContent = t('sync_behind').replace('{d}', lastDay.date);
            } else if (state.autoSyncActive) {
                dot.className = 'sync-dot live';
                label.textContent = t('sync_active');
            } else if (lastSync) {
                const ago = Math.round((Date.now() - lastSync) / 60000);
                dot.className = 'sync-dot' + (ago < 10 ? ' live' : '');
                label.textContent = ago < 1 ? t('sync_less_1min') : `${t('sync_ago')} ${ago} min`;
            } else {
                dot.className = 'sync-dot';
                label.textContent = t('sync_none');
            }

            // Hover tooltip with the absolute last-sync time
            // Uses both `title` (native fallback) and `data-tip` (CSS custom tooltip)
            if (status) {
                let tipText;
                if (lastSync) {
                    const d = new Date(lastSync);
                    const time = d.toLocaleTimeString(currentLang === 'fr' ? 'fr-CA' : 'en-US',
                        { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                    const date = d.toLocaleDateString(currentLang === 'fr' ? 'fr-CA' : 'en-US',
                        { day: 'numeric', month: 'short' });
                    tipText = (t('sync_last') || 'Last sync') + ': ' + date + ' · ' + time;
                } else {
                    tipText = t('sync_none') || 'No sync yet';
                }
                status.title = tipText;
                status.setAttribute('data-tip', tipText);
            }
        }

        // ===== WALLET MODE TOGGLE (BTC / GMT / Cash) =====
        function setWalletMode(mode) {
            state.walletMode = mode;
            const colorByMode = { btc: 'var(--accent)', gmt: 'var(--purple)', cash: 'var(--green)' };
            ['btc', 'gmt', 'cash'].forEach(m => {
                const btn = document.getElementById('wallet-btn-' + m);
                if (btn) {
                    btn.style.background = m === mode ? colorByMode[m] : 'transparent';
                    btn.style.color = m === mode ? '#000' : 'var(--text-dim)';
                    btn.style.border = m === mode ? 'none' : '1px solid var(--border)';
                }
            });
            updateWalletDisplay();
        }
        function updateWalletDisplay() {
            const el = document.getElementById('dash-wallet');
            if (!el) return;
            const mode = state.walletMode || 'btc';
            // "Wallet" = liquid holdings only. Locked GMT is staked / not accessible,
            // so it is intentionally excluded from all three modes (BTC / GMT / Cash).
            const btcBalance = state.btcWalletBalance || 0;
            const gmtWallet = parseFloat(document.getElementById('gmt-prepaid')?.value) || 0;
            const bp = state.btcPrice || 0;
            const gp = state.gmtPrice || 0;

            if (mode === 'btc') {
                const usd = btcBalance * bp;
                el.innerHTML = btcBalance.toFixed(8) + ' BTC <span style="color:var(--text-dim);font-weight:500;font-size:0.6em;">($' + usd.toFixed(2) + ')</span>';
                el.className = 'value btc';
                el.style.fontSize = '1.3em';
            } else if (mode === 'gmt') {
                const usd = gmtWallet * gp;
                el.innerHTML = gmtWallet.toFixed(2) + ' GMT <span style="color:var(--text-dim);font-weight:500;font-size:0.6em;">($' + usd.toFixed(2) + ')</span>';
                el.className = 'value gmt';
                el.style.fontSize = '1.3em';
            } else { // cash
                const totalUsd = btcBalance * bp + gmtWallet * gp;
                el.textContent = '$' + totalUsd.toFixed(2);
                el.className = 'value';
                el.style.color = 'var(--green)';
                el.style.fontSize = '1.3em';
            }
        }

        // ===== GAIN PERIOD TOGGLE =====
        let gainPeriod = (() => {
            try {
                const saved = localStorage.getItem('gms_gain_period');
                if (['day', 'month', 'year'].includes(saved)) return saved;
            } catch(_) {}
            return 'day';
        })();

        function setGainPeriod(period) {
            gainPeriod = period;
            try { localStorage.setItem('gms_gain_period', period); } catch(_) {}
            ['day', 'month', 'year'].forEach(p => {
                const btn = document.getElementById('gain-btn-' + p);
                if (btn) {
                    btn.style.background = p === period ? 'var(--green)' : 'transparent';
                    btn.style.color = p === period ? '#000' : 'var(--text-dim)';
                    btn.style.border = p === period ? 'none' : '1px solid var(--border)';
                }
            });
            updateGainDisplay();
        }

        function updateGainDisplay() {
            const r = state._lastReward;
            if (!r) return;
            const bp = state.btcPrice;
            const el = document.getElementById('dash-today');
            const sub = document.getElementById('dash-today-sub');
            if (!el) return;

            if (gainPeriod === 'day') {
                el.textContent = formatProfit(r.netBtc, bp, r.netGmt, r.grossBtc);
                if (sub) sub.textContent = `${t('dash_gross')}: ${formatVal(r.grossBtc, bp, r.grossGmt)} | ${t('dash_fees')}: ${formatVal(r.feesBtc, bp, r.feesGmt)}`;
            } else if (gainPeriod === 'month') {
                el.textContent = formatProfit(r.netBtc * 30, bp, r.netGmt * 30, r.grossBtc * 30);
                if (sub) sub.textContent = `~${(r.grossBtc * 365).toFixed(8)} BTC/${t('cal_year_short')}`;
            } else {
                el.textContent = formatProfit(r.netBtc * 365, bp, r.netGmt * 365, r.grossBtc * 365);
                if (sub) sub.textContent = `~${(r.grossBtc * 365).toFixed(8)} BTC`;
            }
        }

        // ===== STRATEGY ALERT =====
        let previousStrategy = null;

        function showStrategyAlert(oldStrat, newStrat) {
            const el = document.getElementById('strategy-alert');
            const colors = { BTC: '#f5c542', GMT: '#2ecc71', TH: '#3498db' };
            el.style.display = 'flex';
            el.className = 'strategy-alert';
            el.style.borderColor = colors[newStrat] || 'var(--accent)';
            el.innerHTML = `
                <span class="alert-icon">${newStrat === 'TH' ? '⛏' : newStrat === 'GMT' ? '💎' : '₿'}</span>
                <span class="alert-text">
                    <strong>${t('alert_strategy_change')}:</strong> ${oldStrat} → <strong style="color:${colors[newStrat]}">${newStrat}</strong><br>
                    <span style="color:var(--text-dim);font-size:0.85em;">${t('alert_conditions_suggest')}</span>
                </span>
                <span class="alert-close" onclick="this.parentElement.style.display='none'">✕</span>
            `;
            // Color the header
            document.getElementById('main-header').style.borderBottomColor = colors[newStrat] || 'var(--border)';
        }

        // ===== ENHANCED TH OBJECTIVE (with curve) =====
        function calcDaysToTargetWithCurve(targetTH) {
            const c = state.lastCalc;
            if (!c || !state.btcPrice) return null;

            const costPerTH = parseFloat(document.getElementById('reinv-cost-per-th').value) || 12.34;
            const bonusPct = parseFloat(document.getElementById('reinv-bonus').value) / 100 || 0.05;
            let th = c.hashrate;
            const curve = [{ day: 0, th }];
            let days = 0;
            const maxDays = 3650;

            while (th < targetTH && days < maxDays) {
                const dayR = calcDailyReward(th, c.efficiency, c.elecCost, c.discount, state.btcPrice, c.satPerTH);
                if (!dayR || dayR.grossUsd <= 0) return null;
                // Net, pas brut — cf. la note dans la boucle du Strategy Lab.
            th += (dayR.netUsd / costPerTH) * (1 + bonusPct);
                days++;
                if (days % Math.max(1, Math.floor(days / 50)) === 0 || th >= targetTH) {
                    curve.push({ day: days, th });
                }
            }
            if (days >= maxDays) return null;
            return { days, finalTH: th, curve };
        }

        function drawThCurve(canvas, curve, currentTH, targetTH) {
            if (!canvas || !curve || curve.length < 2) return;
            const ctx = canvas.getContext('2d');
            const dpr = window.devicePixelRatio || 1;
            const w = canvas.clientWidth;
            const h = canvas.clientHeight;
            canvas.width = w * dpr;
            canvas.height = h * dpr;
            ctx.scale(dpr, dpr);

            const pad = { top: 20, right: 20, bottom: 35, left: 55 };
            const cw = w - pad.left - pad.right;
            const ch = h - pad.top - pad.bottom;
            const maxDay = curve[curve.length - 1].day;
            const minTH = currentTH * 0.95;
            const maxTH = Math.max(targetTH * 1.05, curve[curve.length - 1].th * 1.05);

            const xScale = d => pad.left + (d / maxDay) * cw;
            const yScale = t => pad.top + ch - ((t - minTH) / (maxTH - minTH)) * ch;

            // Grid
            ctx.strokeStyle = '#30363d'; ctx.lineWidth = 0.5;
            for (let i = 0; i <= 4; i++) {
                const y = pad.top + (ch / 4) * i;
                ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(w - pad.right, y); ctx.stroke();
            }

            // Target line
            ctx.strokeStyle = '#f85149'; ctx.lineWidth = 1; ctx.setLineDash([6, 4]);
            const ty = yScale(targetTH);
            ctx.beginPath(); ctx.moveTo(pad.left, ty); ctx.lineTo(w - pad.right, ty); ctx.stroke();
            ctx.setLineDash([]);
            ctx.fillStyle = '#f85149'; ctx.font = '11px sans-serif';
            ctx.fillText(targetTH + ' TH', w - pad.right - 50, ty - 5);

            // Power level lines
            ctx.strokeStyle = 'rgba(88,166,255,0.2)'; ctx.lineWidth = 0.5;
            for (const p of POWER_LEVELS) {
                if (p > minTH && p < maxTH && p !== targetTH) {
                    const py = yScale(p);
                    ctx.beginPath(); ctx.moveTo(pad.left, py); ctx.lineTo(w - pad.right, py); ctx.stroke();
                    ctx.fillStyle = 'rgba(88,166,255,0.4)'; ctx.font = '9px sans-serif';
                    ctx.fillText(p + '', pad.left + 2, py - 2);
                }
            }

            // Curve
            ctx.strokeStyle = '#3fb950'; ctx.lineWidth = 2.5;
            ctx.beginPath();
            curve.forEach((p, i) => {
                const x = xScale(p.day), y = yScale(p.th);
                i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
            });
            ctx.stroke();

            // Fill under curve
            ctx.fillStyle = 'rgba(63,185,80,0.08)';
            ctx.beginPath();
            curve.forEach((p, i) => {
                const x = xScale(p.day), y = yScale(p.th);
                i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
            });
            ctx.lineTo(xScale(maxDay), yScale(minTH));
            ctx.lineTo(xScale(0), yScale(minTH));
            ctx.closePath(); ctx.fill();

            // Axes labels
            ctx.fillStyle = '#8b949e'; ctx.font = '11px sans-serif';
            ctx.textAlign = 'center';
            for (let i = 0; i <= 5; i++) {
                const d = Math.round(maxDay / 5 * i);
                ctx.fillText(d + 'j', xScale(d), h - 8);
            }
            ctx.textAlign = 'right';
            for (let i = 0; i <= 4; i++) {
                const t = minTH + (maxTH - minTH) / 4 * (4 - i);
                ctx.fillText(Math.round(t) + '', pad.left - 5, pad.top + (ch / 4) * i + 4);
            }
        }

        // ===== MULTI-SCENARIO SIMULATION =====
        function updateMultiSim() {
            const c = state.lastCalc;
            if (!c || !state.btcPrice || !state.gmtPrice) return;

            const btcChange = parseInt(document.getElementById('sim-btc-change').value) / 100;
            const diffChange = parseInt(document.getElementById('sim-diff-change').value) / 100;
            const reinvest = document.getElementById('sim-reinvest').checked;

            document.getElementById('sim-btc-val').textContent = (btcChange >= 0 ? '+' : '') + Math.round(btcChange * 100) + '%';
            document.getElementById('sim-diff-val').textContent = (diffChange >= 0 ? '+' : '') + Math.round(diffChange * 100) + '%';

            const canvas = document.getElementById('sim-chart');
            const ctx = canvas.getContext('2d');
            const dpr = window.devicePixelRatio || 1;
            const w = canvas.clientWidth;
            const h = canvas.clientHeight;
            canvas.width = w * dpr; canvas.height = h * dpr;
            ctx.scale(dpr, dpr);

            const pad = { top: 20, right: 20, bottom: 35, left: 65 };
            const cw = w - pad.left - pad.right;
            const ch = h - pad.top - pad.bottom;

            const months = 12;
            const costPerTH = parseFloat(document.getElementById('reinv-cost-per-th').value) || 12.34;

            // Simulate 3 scenarios: pessimistic, base (sliders), optimistic
            function simulate(btcMult, diffMult, doReinvest) {
                const points = [];
                let cumProfit = 0;
                let th = c.hashrate;
                for (let m = 0; m <= months; m++) {
                    const t = m / months;
                    const btcP = state.btcPrice * (1 + btcMult * t);
                    const satTH = Math.round(c.satPerTH / (1 + diffMult * t));
                    const r = calcDailyReward(th, c.efficiency, c.elecCost, c.discount, btcP, satTH);
                    if (!r) { points.push({ m, val: cumProfit }); continue; }
                    const monthProfit = r.netUsd * 30;
                    if (doReinvest && m > 0) {
                        // Net, pas brut — cf. la note dans la boucle du Strategy Lab.
                        th += (r.netUsd * 30 / costPerTH) * 1.05;
                    }
                    cumProfit += monthProfit;
                    points.push({ m, val: cumProfit, th });
                }
                return points;
            }

            const base = simulate(btcChange, diffChange, reinvest);
            const opti = simulate(btcChange + 0.3, diffChange - 0.1, reinvest);
            const pess = simulate(btcChange - 0.3, diffChange + 0.2, reinvest);

            const allVals = [...base, ...opti, ...pess].map(p => p.val);
            const minV = Math.min(0, ...allVals);
            const maxV = Math.max(1, ...allVals);
            const range = maxV - minV || 1;

            const xScale = m => pad.left + (m / months) * cw;
            const yScale = v => pad.top + ch - ((v - minV) / range) * ch;

            // Clear
            ctx.clearRect(0, 0, w, h);

            // Grid
            ctx.strokeStyle = '#30363d'; ctx.lineWidth = 0.5;
            for (let i = 0; i <= 4; i++) {
                const y = pad.top + (ch / 4) * i;
                ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(w - pad.right, y); ctx.stroke();
            }

            // Zero line
            if (minV < 0) {
                ctx.strokeStyle = 'rgba(248,81,73,0.4)'; ctx.lineWidth = 1;
                ctx.beginPath(); ctx.moveTo(pad.left, yScale(0)); ctx.lineTo(w - pad.right, yScale(0)); ctx.stroke();
            }

            // Draw shaded cone between optimistic and pessimistic
            ctx.fillStyle = 'rgba(88,166,255,0.06)';
            ctx.beginPath();
            opti.forEach((p, i) => { const x = xScale(p.m), y = yScale(p.val); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); });
            for (let i = pess.length - 1; i >= 0; i--) { ctx.lineTo(xScale(pess[i].m), yScale(pess[i].val)); }
            ctx.closePath(); ctx.fill();

            // Lines
            function drawLine(pts, color, width, dash) {
                ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash || []);
                ctx.beginPath();
                pts.forEach((p, i) => { const x = xScale(p.m), y = yScale(p.val); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); });
                ctx.stroke(); ctx.setLineDash([]);
            }
            drawLine(opti, 'rgba(63,185,80,0.4)', 1, [4, 3]);
            drawLine(pess, 'rgba(248,81,73,0.4)', 1, [4, 3]);
            drawLine(base, '#58a6ff', 2.5);

            // End values
            ctx.font = '11px sans-serif';
            ctx.fillStyle = '#58a6ff'; ctx.textAlign = 'left';
            ctx.fillText(formatUSD(base[months].val), xScale(months) + 4, yScale(base[months].val));
            ctx.fillStyle = 'rgba(63,185,80,0.6)';
            ctx.fillText(formatUSD(opti[months].val), xScale(months) + 4, yScale(opti[months].val) - 12);
            ctx.fillStyle = 'rgba(248,81,73,0.6)';
            ctx.fillText(formatUSD(pess[months].val), xScale(months) + 4, yScale(pess[months].val) + 14);

            // Axes labels
            ctx.fillStyle = '#8b949e'; ctx.font = '11px sans-serif'; ctx.textAlign = 'center';
            for (let m = 0; m <= months; m += 2) ctx.fillText('M' + m, xScale(m), h - 8);
            ctx.textAlign = 'right';
            for (let i = 0; i <= 4; i++) {
                const v = maxV - (range / 4) * i;
                ctx.fillText(formatUSD(v), pad.left - 5, pad.top + (ch / 4) * i + 4);
            }

            // Summary
            const finalTH = reinvest ? base[months].th : c.hashrate;
            document.getElementById('sim-summary').innerHTML = `
                <span style="color:var(--accent2);">${t('sim_cum_profit')}: <strong>${formatUSD(base[months].val)}</strong></span>
                <span style="color:rgba(63,185,80,0.8);">${t('sim_optimistic')}: ${formatUSD(opti[months].val)}</span>
                <span style="color:rgba(248,81,73,0.8);">${t('sim_pessimistic')}: ${formatUSD(pess[months].val)}</span>
                ${reinvest ? `<span style="color:var(--green);">${t('sim_final_th')}: ${Math.round(finalTH)}</span>` : ''}
            `;
        }

        // Slider events
        ['sim-btc-change', 'sim-diff-change', 'sim-reinvest'].forEach(id => {
            document.getElementById(id).addEventListener('input', () => {
                if (state.lastCalc) updateMultiSim();
            });
        });

        // ===== REWARD HISTORY PERSISTENCE =====
        const RH_KEY = 'gomining_reward_history';
        // v2 : les dates viennent de incomeStatistic.calculatedAt, soit un jour
        // plus tôt que la v1 qui utilisait createdAt. Sans invalidation, les
        // anciennes entrées cohabiteraient avec les nouvelles — les mêmes
        // récompenses sous deux dates, un calendrier doublé, et un « dernier jour
        // complet » choisi sur une entrée fantôme, d'où un PR faux.
        const RH_VERSION = 'v2';

        // Returns the last reward-history entry that's NOT today's partial day,
        // or NULL if no complete day exists (e.g. fresh sync with only today).
        // Returning null is critical — callers must NOT compute PR from a partial
        // entry, which would give bogus values like "14" when reality is 46.
        // Two filters (defense-in-depth):
        //   1. `partial: true` flag set by the extension (v1.3+)
        //   2. date strictly before today UTC (works for older extension data
        //      that doesn't have the flag, and as a safety net)
        function getLastCompleteRewardDay(history) {
            if (!history || !history.length) return null;
            const todayUtc = new Date().toISOString().substring(0, 10);
            for (let i = history.length - 1; i >= 0; i--) {
                const d = history[i];
                if (!d.date) continue;
                if (d.partial === true) continue;
                if (d.date >= todayUtc) continue;
                return d;
            }
            return null;
        }

        function mergeRewardHistory(existing, incoming) {
            const byDate = new Map();
            for (const r of (existing || [])) {
                if (r.date) byDate.set(r.date, r);
            }
            for (const r of (incoming || [])) {
                if (r.date) byDate.set(r.date, r); // newer data wins
            }
            // Keep last 30 days only
            const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().substring(0, 10);
            return Array.from(byDate.values())
                .filter(r => r.date >= cutoff)
                .sort((a, b) => a.date.localeCompare(b.date));
        }

        function saveRewardHistory(history) {
            // Ne rien couper en cas d'échec : l'historique d'un joueur Miner
            // Wars est irremplaçable, et amputer pour faire de la place a déjà
            // failli détruire cinq semaines de données. On signale, c'est tout.
            if (persist(RH_KEY, history)) persist(RH_KEY + '_ver', RH_VERSION);
        }

        // ===== CAPITAL EXTERNE, PERSISTÉ =====
        // Le relevé de transactions brut est purgé par l'extension au bout de 24 h,
        // conformément à ce qu'annonce notre politique de confidentialité. On garde
        // donc ici le RÉSULTAT du calcul, pas les transactions : quelques nombres,
        // qui suffisent au Portfolio et évitent de refaire défiler des dizaines de
        // pages d'historique chaque jour.
        // Bonus de réinvestissement en TH, annoncé par GoMining lui-même
        // (« Get 5% more rewards by converting them into power »).
        const TH_BONUS = 0.05;

        // Coût d'un TH, par ordre de fiabilité :
        //   1. déduit de l'historique par l'extension — exact, suit le marché
        //   2. le champ réglable par l'utilisateur
        //   3. 12,34, dernier recours
        // TH réellement ajoutés le lendemain d'un jour donné, lus dans l'historique.
        // Retourne null si le lendemain n'est pas encore connu — auquel cas il faut
        // bien estimer, mais on le dira.
        function observedThGain(dateStr) {
            const hist = state.rewardHistory || [];
            const byDate = new Map(hist.filter(d => d && d.date).map(d => [d.date, d]));
            const cur = byDate.get(dateStr);
            if (!cur || !(cur.power > 0)) return null;
            const t = Date.parse(dateStr + 'T00:00:00Z');
            if (!isFinite(t)) return null;
            const nextStr = new Date(t + 86400000).toISOString().substring(0, 10);
            const next = byDate.get(nextStr);
            if (!next || !(next.power > 0)) return null;
            const delta = next.power - cur.power;
            return delta > 0 ? delta : null;
        }

        function upgradeRate() {
            const derived = state.upgradeRateUsd;
            if (derived > 0) return derived;
            const field = parseFloat(document.getElementById('cost-per-th-upgrade')?.value)
                       || parseFloat(document.getElementById('reinv-cost-per-th')?.value);
            return field > 0 ? field : 12.34;
        }

        const CAPITAL_KEY = 'gms_capital';
        const CAPITAL_VERSION = 'v1';

        function loadCapital() {
            try {
                if (localStorage.getItem(CAPITAL_KEY + '_ver') !== CAPITAL_VERSION) {
                    localStorage.removeItem(CAPITAL_KEY);
                    return null;
                }
                return JSON.parse(localStorage.getItem(CAPITAL_KEY)) || null;
            } catch (e) { return null; }
        }

        function saveCapital(cap) {
            try {
                localStorage.setItem(CAPITAL_KEY, JSON.stringify(cap));
                localStorage.setItem(CAPITAL_KEY + '_ver', CAPITAL_VERSION);
            } catch (e) {}
        }

        // Une visite qui ne touche pas la page des transactions ne voit que
        // quelques lignes : elle ne doit PAS écraser un calcul fondé sur tout
        // l'historique. On ne remplace donc que si la nouvelle mesure s'appuie sur
        // au moins autant de transactions.
        function mergeCapital(stored, incoming) {
            if (!incoming) return stored;
            if (!stored) return incoming;

            // Un objet issu d'un schéma plus ancien perd toujours, quel que soit
            // son nombre de transactions — il ne pourra JAMAIS acquérir le champ
            // qui lui manque.
            //
            // C'est un piège que la première version posait : un capital calculé
            // sur 121 transactions par une extension antérieure à `byCategory`
            // battait éternellement un calcul plus récent mais assis sur moins de
            // lignes. La ventilation ne pouvait alors plus jamais se remplir, quoi
            // que fasse l'utilisateur — recharger, re-scanner, rien n'y faisait.
            const richer = (x) => !!(x && x.byCategory && Object.keys(x.byCategory).length > 0);
            if (richer(incoming) && !richer(stored)) return incoming;
            if (richer(stored) && !richer(incoming)) return stored;

            const a = incoming.txCount || 0;
            const b = stored.txCount || 0;
            return a >= b ? incoming : stored;
        }

        // Décale les dates d'un stockage v1 d'un jour en arrière. Les entrées v1
        // étaient datées de createdAt — la date d'écriture GoMining — alors que le
        // jour miné est la veille. Le décalage est déterministe, donc la conversion
        // est SANS PERTE : il n'y avait aucune raison de jeter ces jours.
        function migrateRewardHistoryV1toV2(history) {
            const shift = (d) => {
                const t = Date.parse(String(d).substring(0, 10) + 'T00:00:00Z');
                return isFinite(t) ? new Date(t - 86400000).toISOString().substring(0, 10) : null;
            };
            const out = [];
            const seen = new Set();
            for (const day of history || []) {
                const nd = shift(day?.date);
                if (!nd || seen.has(nd)) continue;   // dédoublonner au cas où
                seen.add(nd);
                out.push({ ...day, date: nd, partial: false });
            }
            return out.sort((a, b) => String(a.date).localeCompare(String(b.date)));
        }

        function loadRewardHistory() {
            try {
                const ver = localStorage.getItem(RH_KEY + '_ver');
                if (ver !== RH_VERSION) {
                    let raw = null;
                    try { raw = JSON.parse(localStorage.getItem(RH_KEY)); } catch (e) {}
                    // Migrer plutôt que jeter. Un stockage jamais versionné est du v1 :
                    // ses dates sont décalées d'un jour, ce qui se répare exactement.
                    // Ce qu'un utilisateur avait accumulé au-delà de ce que l'extension
                    // retient encore serait sinon perdu pour de bon.
                    const migrated = (ver === null && Array.isArray(raw) && raw.length > 0)
                        ? migrateRewardHistoryV1toV2(raw)
                        : [];
                    localStorage.setItem(RH_KEY, JSON.stringify(migrated));
                    localStorage.setItem(RH_KEY + '_ver', RH_VERSION);
                    return migrated;
                }
                return JSON.parse(localStorage.getItem(RH_KEY)) || [];
            } catch(e) { return []; }
        }

        // ===== PERFORMANCE TRACKING =====
        const PERF_KEY = 'gomining_performance';
        // v4 : les entrées v3 ont été enregistrées contre des dates décalées d'un
        // jour (avant le passage à calculatedAt). Comparer un « réel » du 26 à un
        // « projeté » du 25 fausse le score de précision.
        const PERF_VERSION = 'v4';

        function loadPerformance() {
            try {
                const ver = localStorage.getItem(PERF_KEY + '_ver');
                if (ver !== PERF_VERSION) {
                    localStorage.removeItem(PERF_KEY);
                    localStorage.setItem(PERF_KEY + '_ver', PERF_VERSION);
                    return [];
                }
                return JSON.parse(localStorage.getItem(PERF_KEY)) || [];
            } catch(e) { return []; }
        }

        function savePerformanceEntry(date, actual, projected) {
            const perf = loadPerformance();
            const existing = perf.findIndex(p => p.date === date);
            const entry = { date, actual, projected };
            if (existing >= 0) perf[existing] = entry;
            else perf.push(entry);
            // Keep last 90 days
            while (perf.length > 90) perf.shift();
            localStorage.setItem(PERF_KEY, JSON.stringify(perf));
        }

        function recordPerformance(rewardHistory) {
            if (!rewardHistory || !state.lastCalc || !state.btcPrice) return;
            const c = state.lastCalc;
            for (const day of rewardHistory) {
                // Use poolReward (raw gross mining yield) as the source of truth, NOT valueBtc.
                // valueBtc includes reinvestment bonuses and ambassador rewards, so it always
                // overstates the simulator's "accuracy" — the simulator doesn't know about bonuses.
                // Accuracy = how well we predict GROSS mining yield. Compare gross-to-gross.
                if (!day.date || !day.poolReward) continue;
                const bp = day.btcPrice || state.btcPrice;
                const power = day.power || c.hashrate;

                // Calculer sat/TH depuis poolReward (BTC) du jour
                let satTH = c.satPerTH;
                if (day.poolReward && power && bp) {
                    satTH = Math.round(day.poolReward / power * 1e8);
                }

                const projected = calcDailyReward(power, c.efficiency, c.elecCost, c.discount, bp, satTH);

                savePerformanceEntry(day.date, {
                    valueBtc: day.poolReward,
                    valueUsd: day.poolReward * bp
                }, {
                    valueBtc: projected ? projected.grossBtc : 0,
                    valueUsd: projected ? projected.grossUsd : 0
                });
            }
        }

        function updatePerformance() {
            const perf = loadPerformance();
            if (perf.length < 2) {
                document.getElementById('perf-score-box').style.display = 'none';
                document.getElementById('perf-table').innerHTML = '<p style="color:var(--text-dim);">' + t('perf_no_data') + '</p>';
                return;
            }

            document.getElementById('perf-score-box').style.display = 'block';

            let totalActual = 0, totalProjected = 0, totalError = 0;
            perf.forEach(p => {
                totalActual += p.actual.valueUsd;
                totalProjected += p.projected.valueUsd;
                totalError += Math.abs(p.actual.valueUsd - p.projected.valueUsd);
            });

            const accuracy = totalActual > 0 ? Math.max(0, 100 - (totalError / totalActual * 100)) : 0;
            document.getElementById('perf-accuracy').textContent = accuracy.toFixed(1) + '%';
            document.getElementById('perf-accuracy').className = 'perf-score ' + (accuracy >= 95 ? 'positive' : accuracy >= 85 ? '' : 'negative');
            document.getElementById('perf-actual').textContent = formatUSD(totalActual);
            document.getElementById('perf-projected').textContent = formatUSD(totalProjected);

            // Draw chart
            const canvas = document.getElementById('perf-chart');
            const ctx = canvas.getContext('2d');
            const dpr = window.devicePixelRatio || 1;
            const w = canvas.clientWidth, h = canvas.clientHeight;
            canvas.width = w * dpr; canvas.height = h * dpr;
            ctx.scale(dpr, dpr);

            const pad = { top: 20, right: 20, bottom: 35, left: 65 };
            const cw = w - pad.left - pad.right, ch = h - pad.top - pad.bottom;

            let cumActual = 0, cumProjected = 0;
            const actPts = [], prjPts = [];
            perf.forEach((p, i) => {
                cumActual += p.actual.valueUsd;
                cumProjected += p.projected.valueUsd;
                actPts.push({ x: i, v: cumActual });
                prjPts.push({ x: i, v: cumProjected });
            });

            const maxV = Math.max(...actPts.map(p => p.v), ...prjPts.map(p => p.v), 1);
            const n = perf.length - 1 || 1;
            const xS = i => pad.left + (i / n) * cw;
            const yS = v => pad.top + ch - (v / maxV) * ch;

            ctx.clearRect(0, 0, w, h);
            ctx.strokeStyle = '#30363d'; ctx.lineWidth = 0.5;
            for (let i = 0; i <= 4; i++) { const y = pad.top + ch / 4 * i; ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(w - pad.right, y); ctx.stroke(); }

            // Actual line
            ctx.strokeStyle = '#f7931a'; ctx.lineWidth = 2.5;
            ctx.beginPath();
            actPts.forEach((p, i) => { i === 0 ? ctx.moveTo(xS(p.x), yS(p.v)) : ctx.lineTo(xS(p.x), yS(p.v)); });
            ctx.stroke();

            // Projected line
            ctx.strokeStyle = '#58a6ff'; ctx.lineWidth = 2; ctx.setLineDash([5, 3]);
            ctx.beginPath();
            prjPts.forEach((p, i) => { i === 0 ? ctx.moveTo(xS(p.x), yS(p.v)) : ctx.lineTo(xS(p.x), yS(p.v)); });
            ctx.stroke(); ctx.setLineDash([]);

            // Legend
            ctx.font = '11px sans-serif';
            ctx.fillStyle = '#f7931a'; ctx.fillText(t('perf_actual'), pad.left + 5, pad.top + 12);
            ctx.fillStyle = '#58a6ff'; ctx.fillText(t('perf_projected'), pad.left + 45, pad.top + 12);

            // Axes
            ctx.fillStyle = '#8b949e'; ctx.textAlign = 'center';
            const step = Math.max(1, Math.floor(perf.length / 6));
            for (let i = 0; i < perf.length; i += step) {
                ctx.fillText(perf[i].date.substring(5), xS(i), h - 8);
            }
            ctx.textAlign = 'right';
            for (let i = 0; i <= 4; i++) {
                const v = maxV - maxV / 4 * i;
                ctx.fillText(formatUSD(v), pad.left - 5, pad.top + ch / 4 * i + 4);
            }

            // Table
            let tableHtml = `<table><thead><tr><th>Date</th><th>${t('perf_actual')}</th><th>${t('perf_projected')}</th><th>${t('perf_gap')}</th></tr></thead><tbody>`;
            perf.slice(-15).reverse().forEach(p => {
                const ecart = p.actual.valueUsd - p.projected.valueUsd;
                const pct = p.projected.valueUsd > 0 ? (ecart / p.projected.valueUsd * 100).toFixed(1) : '0';
                tableHtml += `<tr>
                    <td>${p.date}</td>
                    <td>${formatUSD(p.actual.valueUsd)}</td>
                    <td>${formatUSD(p.projected.valueUsd)}</td>
                    <td class="${ecart >= 0 ? 'positive' : 'negative'}">${ecart >= 0 ? '+' : ''}${pct}%</td>
                </tr>`;
            });
            tableHtml += '</tbody></table>';
            document.getElementById('perf-table').innerHTML = tableHtml;
        }

        // ===== AUTO-SYNC LISTENER =====
        // Only toast on the FIRST successful sync of this page-load. Subsequent
        // syncs update data + the Connection Pulse pill silently — users don't
        // want a popup every 30 seconds.
        let _firstSyncToastShown = false;
        // Minimum extension version we are willing to let people run.
        // 2.4 is the first build that stops caching GoMining's sign-in response
        // (which carried an e-mail address, login IP, KYC status and a live JWT).
        // Anyone below it installed from the zip and gets no automatic updates,
        // so this banner is now a migration path: it points them at the Chrome
        // Web Store listing, where updates arrive on their own, and it clears
        // itself the moment a 2.4+ build reports in.
        // Ce seuil doit toujours valoir la version que le store SERT RÉELLEMENT,
        // jamais celle qui est en examen : promettre une version que la fiche ne
        // propose pas encore envoie l'utilisateur dans un cul-de-sac.
        //
        // 2026-08-31 : la 4.7 est SERVIE par le store (fiche vérifiée), donc le
        // seuil passe à 4.7. Tout ce qui est en dessous est soit une installation
        // manuelle — le public visé, puisque le téléchargement direct a été
        // retiré — soit une mise à jour automatique en vol, qui se règle en
        // quelques heures.
        //
        // Depuis la 4.6 : le Bonus miner est sommé dans la puissance de ferme,
        // les récompenses sont datées sur calculatedAt, la liste blanche
        // d'endpoints s'applique. La 4.7 ajoute que la moyenne d'efficacité
        // n'est plus calculée sur des mineurs muets supposés au meilleur cas.
        // En dessous, les chiffres du site sont faux et pas seulement vieux.
        const MIN_EXT_VERSION = '4.7';
        const EXT_STORE_URL = 'https://chromewebstore.google.com/detail/gmsim-%E2%80%94-miner-sync/llchhkfpkjbkiabpofbpfilicpbnihhp';
        function extVersionOutdated(v) {
            if (!v) return true; // no version reported → pre-2.0 build
            const a = String(v).split('.').map(n => parseInt(n, 10) || 0);
            const b = MIN_EXT_VERSION.split('.').map(n => parseInt(n, 10) || 0);
            for (let i = 0; i < Math.max(a.length, b.length); i++) {
                const x = a[i] || 0, y = b[i] || 0;
                if (x < y) return true;
                if (x > y) return false;
            }
            return false;
        }
        function maybeShowExtUpdateBanner(data) {
            try {
                const existing = document.getElementById('gm-ext-update-banner');
                if (!extVersionOutdated(data && data.extVersion)) {
                    if (existing) existing.remove(); // updated → self-clear
                    return;
                }
                if (sessionStorage.getItem('gm_ext_banner_dismissed') === '1') return;
                if (existing) return;
                const bar = document.createElement('div');
                bar.id = 'gm-ext-update-banner';
                bar.className = 'gm-ext-update-banner';
                const span = document.createElement('span');
                span.textContent = t('ext_update_msg') + ' ';
                const link = document.createElement('a');
                link.href = EXT_STORE_URL;
                link.target = '_blank';
                link.rel = 'noopener';
                link.className = 'gm-ext-banner-link';
                link.textContent = t('ext_update_cta');
                span.appendChild(link);
                const x = document.createElement('button');
                x.type = 'button';
                x.className = 'gm-ext-banner-x';
                x.setAttribute('aria-label', 'close');
                x.textContent = '×';
                x.addEventListener('click', () => {
                    sessionStorage.setItem('gm_ext_banner_dismissed', '1');
                    bar.remove();
                });
                bar.appendChild(span);
                bar.appendChild(x);
                document.body.appendChild(bar);
            } catch (e) {}
        }

        function checkAutoSync() {
            try {
                const raw = localStorage.getItem('gomining_autosync');
                if (!raw) return;
                const data = JSON.parse(raw);
                if (!data || !data.timestamp) return;
                // Prompt to reload an outdated extension even if the data itself
                // hasn't changed since last check (runs before the timestamp guard).
                maybeShowExtUpdateBanner(data);
                // Only apply if newer than last sync
                if (state.lastAutoSyncTimestamp === data.timestamp) return;
                state.lastAutoSyncTimestamp = data.timestamp;
                state.autoSyncActive = true;
                state.lastSyncTime = Date.now();
                applyEssentials(data);
                updateSyncStatus();
                console.log('[GoMining] Auto-sync applied:', data.timestamp);
                // Toast only ONCE per page-load. After that, the Connection
                // Pulse pill (top-nav) is the silent in-sync indicator.
                if (!_firstSyncToastShown && typeof toast === 'function') {
                    _firstSyncToastShown = true;
                    toast('Synced from extension', 'success', 2500);
                }
            } catch(e) {}
        }

        window.addEventListener('storage', (e) => {
            if (e.key === 'gomining_autosync') checkAutoSync();
        });
        // Same-window writes don't fire StorageEvent — also listen for the
        // CustomEvent the sync-bridge dispatches and a low-frequency poll.
        document.addEventListener('gomining-autosync', () => checkAutoSync());
        let _lastAutoSyncRaw = null;
        setInterval(() => {
            try {
                const cur = localStorage.getItem('gomining_autosync');
                if (cur && cur !== _lastAutoSyncRaw) { _lastAutoSyncRaw = cur; checkAutoSync(); }
            } catch {}
        }, 5000);
        // Refresh the Connection Pulse pill's "X min ago" label every 30s.
        setInterval(() => { try { updateSyncStatus(); } catch {} }, 30000);

        // ===== EXPORT / IMPORT =====
        function exportAllData() {
            const data = {
                version: 2,
                exportDate: new Date().toISOString(),
                settings: JSON.parse(localStorage.getItem('gomining_settings') || '{}'),
                transactions: JSON.parse(localStorage.getItem(TX_KEY) || '[]'),
                performance: JSON.parse(localStorage.getItem(PERF_KEY) || '[]'),
                changelog: JSON.parse(localStorage.getItem(CHANGELOG_KEY) || '[]'),
                dashCache: JSON.parse(localStorage.getItem(DASH_CACHE_KEY) || '{}')
            };
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `gomining-backup-${new Date().toISOString().slice(0, 10)}.json`;
            a.click();
            URL.revokeObjectURL(url);
            if (typeof toast === 'function') toast('Backup exported', 'success', 2200);
        }

        // CSV export — Portfolio transactions only (spreadsheet-friendly)
        window.exportTransactionsCsv = function () {
            const txs = JSON.parse(localStorage.getItem(TX_KEY) || '[]');
            if (!txs.length) {
                if (typeof toast === 'function') toast('No transactions to export', 'info', 2500);
                return;
            }
            const esc = v => {
                const s = (v ?? '').toString().replace(/"/g, '""');
                return /[",\n]/.test(s) ? `"${s}"` : s;
            };
            const header = 'date,category,amount_usd,gmt_amount,gmt_price,th_added,note';
            const rows = txs.map(t =>
                [t.date, t.category, t.amount, t.gmtAmount || '', t.gmtPrice || '', t.th || '', t.note || '']
                    .map(esc).join(',')
            );
            const csv = [header, ...rows].join('\n');
            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `gomining-transactions-${new Date().toISOString().slice(0, 10)}.csv`;
            a.click();
            URL.revokeObjectURL(url);
            if (typeof toast === 'function') toast(`Exported ${txs.length} transactions`, 'success', 2500);
        };

        function importAllData(event) {
            const file = event.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = function(e) {
                try {
                    const data = JSON.parse(e.target.result);
                    if (!data.version) { alert(t('import_invalid')); return; }
                    if (!confirm(t('import_confirm', 'Import backup from') + ' ' + (data.exportDate?.substring(0, 10) || '?') + '?\n' + t('import_overwrite'))) return;

                    if (data.settings) localStorage.setItem('gomining_settings', JSON.stringify(data.settings));
                    if (data.transactions) localStorage.setItem(TX_KEY, JSON.stringify(data.transactions));
                    if (data.performance) localStorage.setItem(PERF_KEY, JSON.stringify(data.performance));
                    if (data.changelog) localStorage.setItem(CHANGELOG_KEY, JSON.stringify(data.changelog));

                    alert(t('import_success'));
                    location.reload();
                } catch(err) {
                    alert(t('import_error') + ': ' + err.message);
                }
            };
            reader.readAsText(file);
            event.target.value = '';
        }

        // ===== MONTHLY GOAL =====
        function updateMonthlyGoal() {
            const goal = parseFloat(document.getElementById('monthly-goal')?.value) || 20;
            const now = new Date();
            const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();

            // Gain mining mensuel estimé (basé sur le taux actuel)
            let miningDailyUsd = 0;
            if (state.lastCalc) {
                const c = state.lastCalc;
                const r = calcDailyReward(c.hashrate, c.efficiency, c.elecCost, c.discount, state.btcPrice, c.satPerTH);
                if (r) miningDailyUsd = r.netUsd;
            }

            // Gain staking mensuel estimé
            const stakingGmtWeekly = parseFloat(document.getElementById('staking-gmt-weekly')?.value) || 0;
            const stakingDailyUsd = (stakingGmtWeekly / 7) * (state.gmtPrice || 0);

            const totalDailyUsd = miningDailyUsd + stakingDailyUsd;
            const monthlyEstimate = totalDailyUsd * daysInMonth;

            const pct = goal > 0 ? Math.min(100, monthlyEstimate / goal * 100) : 0;
            const diff = monthlyEstimate - goal;

            document.getElementById('goal-bar').style.width = pct + '%';
            document.getElementById('goal-bar').style.background = pct >= 100
                ? 'linear-gradient(90deg,var(--green),var(--accent2))'
                : 'linear-gradient(90deg,var(--accent),var(--red))';
            document.getElementById('goal-current').textContent = `${formatUSD(monthlyEstimate)}/${t('goal_month_est')} (${pct.toFixed(0)}%)`;
            document.getElementById('goal-current').style.color = pct >= 100 ? 'var(--green)' : 'var(--accent)';
            document.getElementById('goal-remaining').textContent = diff >= 0
                ? `+${formatUSD(diff)} ${t('goal_above')}`
                : `${formatUSD(Math.abs(diff))} ${t('goal_missing')} — Mining: ${formatUSD(miningDailyUsd * daysInMonth)}${stakingDailyUsd > 0 ? ' + Staking: ' + formatUSD(stakingDailyUsd * daysInMonth) : ''}`;
        }

        document.getElementById('monthly-goal')?.addEventListener('change', () => { updateMonthlyGoal(); saveSettings(); });


        // ===== CHANGE LOG =====
        const CHANGELOG_KEY = 'gomining_changelog';

        function loadChangelog() {
            try { return JSON.parse(localStorage.getItem(CHANGELOG_KEY)) || []; } catch(e) { return []; }
        }

        function logChange(field, oldVal, newVal) {
            if (oldVal === newVal) return;
            const log = loadChangelog();
            log.push({
                date: new Date().toISOString(),
                field,
                from: oldVal,
                to: newVal
            });
            // Keep last 100 entries
            while (log.length > 100) log.shift();
            localStorage.setItem(CHANGELOG_KEY, JSON.stringify(log));
        }

        // Track parameter changes
        let _prevParams = {};
        function trackParamChanges() {
            const fields = { hashrate: 'TH', efficiency: 'W/TH', 'sat-per-th': 'PR sat/TH', 'discount': 'Discount %' };
            Object.keys(fields).forEach(id => {
                const el = document.getElementById(id);
                if (!el) return;
                const val = el.value;
                if (_prevParams[id] !== undefined && _prevParams[id] !== val) {
                    logChange(fields[id], _prevParams[id], val);
                }
                _prevParams[id] = val;
            });
        }

        // ===== i18n TRANSLATION =====
        const TRANSLATIONS = {
            en: {
                // Sidebar
                nav_subtitle: 'Simulator & Strategies',
                nav_dashboard: 'Dashboard', nav_simulator: 'Simulator', nav_scenarios: 'BTC Scenarios',
                nav_strategy: 'Strategy Lab',
                nav_reinvest: 'Reinvestment', nav_compare: 'Compare', nav_simulation: 'Simulation',
                nav_performance: 'Performance', nav_alerts: 'Alerts', nav_portfolio: 'Portfolio',
                nav_efficiency: 'Efficiency',
                pin_conflict: 'Your extension reports different values than the ones you typed:',
                pin_use_ext: 'Use extension data',
                pin_keep_mine: 'Keep mine',
                gate_guest: 'Use it without an account →',
                gate_guest_note: 'Full calculator, no sign-up. An account saves your scenarios; the extension fills your numbers in for you.',
                sw_quota: 'This browser\'s storage is full, so your reward history has stopped saving. Nothing already saved was deleted. Clear site data for another site, or export your history.',
                sw_blocked: 'This browser is blocking local storage, so your reward history and portfolio will not survive a reload. Private browsing usually causes this.',
                po_invented_1: 'No price feed reached — the',
                po_invented_2: 'price below is a placeholder written into the app, not a market price. Every figure derived from it is meaningless until a feed responds.',
                po_cached: 'Live prices unreachable — using the last price this browser saw',
                po_under_hour: 'under an hour old',
                po_no_mempool: 'Network difficulty is unavailable, so Pool Reward falls back to your last synced value.',
                stk_yield: 'Annual yield',
                miners_one: 'miner', miners_plural: 'miners',
                eff_over: 'over',
                vegmt_yield: 'veGMT yield',
                strat_days_added: 'd added value',
                paused_farm: 'Farm paused — GoMining stops all fees',
                paused_would_be: 'would be',
                paused_short: 'paused',
                eff_k_restored: 'Income restored',
                eff_k_restored_sub: 'farm currently paused — earns nothing today',
                eff_n_6: '<strong>A paused farm changes the maths.</strong> GoMining pauses a farm that would mine at a loss, so above a certain W/TH it earns nothing instead of losing money — and pays no electricity while paused. For such a farm the upgrade does not cut a bill, it restores income, and the figures above only apply once it is running again.',
                eff_cmp_paused: 'GoMining pauses a farm that would mine at a loss and restarts it when it turns profitable again. At this efficiency the farm earns nothing rather than losing money — so the electricity saving above only applies once it is running.',
                eff_cmp_paused_reach: 'It needs to reach',
                eff_cmp_paused_costs: ' to run again, which costs ',
                eff_cmp_paused_nofix: 'It does not turn profitable at any efficiency down to 12 W/TH — check your electricity rate and Pool Reward before spending anything.',
                eff_n_1: '<strong>It is not a bet on Bitcoin.</strong> Your hashrate does not change, so your revenue does not either. Both the cost and the saving are in dollars — this is one of the few GoMining decisions whose payback does not depend on the BTC price.',
                eff_n_2: '<strong>Payback is the same at any farm size.</strong> Cost and saving both scale per TH, so 16 TH and 700 TH pay back on the same date. You cannot start small to test it.',
                eff_n_3: '<strong>Resale value is not counted, so the payback is pessimistic.</strong> A more efficient miner sells for more per TH on the secondary market, which shortens the real payback by an amount we cannot yet measure. For the cheap bands it changes nothing; for the last three watts it may decide the question entirely.',
                eff_n_4: '<strong>Prices are the ones GoMining published on 28 August 2026</strong>, fixed in USD. They change only when GoMining reprices, and this table will not know until it is updated.',
                eff_n_5: '<strong>Inside one price band, the payback is flat.</strong> Cost and saving both scale with the number of steps, so stopping halfway through a band buys you nothing in return — it only spends less. If a band is worth entering, it is worth taking to its floor.',
                eff_eyebrow: 'Watts · Cost · Payback',
                eff_title: '⚡ Efficiency Calculator',
                eff_intro: 'Lowering your W/TH cuts your electricity bill every day and costs you once. GoMining shows the price; it does not show the payback. This does — and tells you where to stop.',
                eff_f_th: 'Hashrate (TH)', eff_f_th_hint: 'From your farm',
                eff_f_from: 'Current (W/TH)', eff_f_from_hint: 'Hashrate-weighted',
                eff_f_to: 'Target (W/TH)', eff_f_to_hint: '12 is the floor',
                eff_f_elec: 'Electricity ($/kWh)', eff_f_elec_hint: 'Detected',
                eff_f_disc: 'Discount (%)', eff_f_disc_hint: 'Cuts the saving, not the price',
                eff_reset: 'Reset to my farm',
                eff_r_title: 'What this upgrade costs and returns',
                eff_r_sub: 'The upgrade is charged at full price — your discount does not apply to it. It applies to the electricity, which means it also shrinks the saving and lengthens the payback.',
                eff_l_title: 'Where to stop',
                eff_l_sub: 'GoMining prices the easy watts at almost nothing and the last few at a premium. Each row is one price band: read down and stop where the return no longer justifies it. Click a row to set it as your target.',
                eff_l_step: 'Step', eff_l_cost: 'Cost', eff_l_saving: 'Saved / day',
                eff_l_payback: 'Payback', eff_l_return: 'Annual return',
                eff_l_hint: 'Highlighted rows are inside your current target. Cumulative figures assume you take every band above.',
                eff_n_title: 'What this does and does not account for',
                eff_k_cost: 'Upgrade cost', eff_k_saving: 'Electricity saved',
                eff_k_payback: 'Payback', eff_k_payback_sub: 'independent of farm size',
                eff_k_return: 'Annual return',
                eff_day: 'day', eff_year: 'yr', eff_days: 'days', eff_years: 'yr',
                eff_saved: 'saved', eff_cum: 'cumulative',
                eff_v_great: 'far better than buying TH', eff_v_good: 'better than buying TH',
                eff_v_close: 'about the same as buying TH', eff_v_poor: 'worse than buying TH',
                eff_v_fast: 'pays back fast', eff_v_solid: 'solid return',
                eff_v_slow: 'slow return', eff_v_verylow: 'very low return',
                eff_cmp_label: 'For comparison, a dollar spent on more hashrate returns',
                eff_cmp_per_year: 'per year',
                eff_cmp_missing: 'Buying-hashrate return is unknown until your farm data is loaded — scan your GoMining pages to compare the two.',
                eff_pick_lower: 'Pick a target below your current efficiency to see what it costs and what it pays back.',
                eff_at_floor: 'You are at 12 W/TH — the floor. There is nothing left to upgrade.',
                sec_strategy_lab: '🧪 Strategy Lab',
                strategy_intro: "Build a day-by-day reinvestment plan and see what you'd earn over the period. Choose for each day: collect BTC, reinvest in GMT, or buy more TH.",
                strategy_period: 'Period',
                strategy_period_7: '7 days', strategy_period_14: '14 days', strategy_period_30: '30 days',
                strategy_quick_fill: 'Quick fill', strategy_smart_label: 'Smart fill',
                strategy_eyebrow: 'Lab · Plan & Project',
                strategy_step1_title: 'Pre-fill the plan', strategy_step1_sub: 'Use a quick fill or let smart-fill cover your fees first.',
                strategy_step2_title: 'Tune day-by-day', strategy_step2_sub: 'Click any cell to cycle through BTC / GMT / TH for that day.',
                strategy_step2_title_weekly: 'Tune week-by-week', strategy_step2_sub_weekly: 'Click any cell to cycle through BTC / GMT / TH for that week.',
                strategy_all_btc: 'All BTC', strategy_all_gmt: 'All GMT', strategy_all_th: 'All TH',
                strategy_prices: 'Price Overrides (optional)',
                strategy_prices_hint: 'Test scenarios — what if BTC pumps or GMT moves? Leave blank to use current snapshot.',
                strategy_btc_price: 'BTC Price ($)', strategy_gmt_price: 'GMT Price ($)', strategy_cost_per_th: 'Cost per TH ($)',
                strategy_cost_per_th_hint: 'Derived from your history; edit to override',
                strategy_reinvest_cost: 'Reinvest cost per TH ($)',
                strategy_reinvest_cost_hint: 'Upgrade rate, derived from your own history — used to compute TH gained when reinvesting',
                strategy_market_th_price: 'Market TH price ($)',
                strategy_market_th_price_hint: 'Live marketplace price (volatile, changes minute-to-minute). Used only for the asset paper-value display. Leave blank to fall back to reinvest cost.',
                strategy_th_market: 'market',
                strategy_th_fallback: 'fallback to reinvest cost',
                strategy_period_by_period: 'Period-by-period',
                strategy_col_period: 'Period', strategy_col_plan: 'Plan',
                strategy_col_gross: 'Gross', strategy_col_fees: 'Fees', strategy_col_net: 'Net',
                strategy_col_end_th: 'End TH/s', strategy_col_end_portfolio: 'End portfolio',
                strategy_current: 'current',
                strategy_auto: 'Auto-filled', strategy_from_sync: 'from sync',
                strategy_week: 'Week',
                strategy_inputs_used: 'Inputs used',
                strategy_verify_inputs: "⚠ Inputs come from the Simulator tab. Update them there if numbers don't match your reality.",
                strategy_smart_th: '⚖ GMT → TH',
                strategy_smart_btc: '⚖ GMT → BTC',
                strategy_smart_btc_th: '⚖ BTC → TH',
                strategy_smart_result_v2: 'Mine {source} for {x} days to cover fees, then switch to {target} for the remaining {y} days.',
                strategy_smart_hint: 'Auto-fill: GMT-mining first to cover all fees, then switch to your target.',
                strategy_smart_result: 'Mine GMT for {x} days to cover fees, then switch to {target} for the remaining {y} days.',
                strategy_smart_impossible: "Cannot cover fees: GMT mining doesn't earn enough to cover daily fees with current params.",
                strategy_source_real: 'Using real GoMining data from', strategy_source_match: '— matches the Validation table.',
                lbl_fees_in: 'Fees:',
                strategy_run: 'Run Simulation',
                strategy_results: 'Results',
                strategy_total_btc: 'Total BTC', strategy_total_gmt: 'Total GMT', strategy_total_th: 'TH Gained', strategy_total_fees: 'Fees Paid',
                strategy_net_btc: 'BTC Net', strategy_net_gmt: 'GMT Net',
                strategy_gross_btc: 'BTC Gross', strategy_gross_gmt: 'GMT Gross',
                strategy_total_btc_net: 'Total BTC (net)', strategy_total_gmt_net: 'Total GMT (net)', strategy_total_th_net: 'Total TH (net)',
                strategy_no_th_fees: 'no fees on TH',
                strategy_mode_label: 'Mode',
                strategy_mode_monthly: 'Monthly',
                strategy_mode_daily: 'Daily',
                strategy_monthly_label: 'Projection length',
                strategy_month_singular: 'month', strategy_months: 'months',
                strategy_month_label: 'Month',
                strategy_weekly_slots: 'weekly slots',
                strategy_results_label: 'Results',
                strategy_net_cash: 'Net cash profit (BTC + GMT − fees)', strategy_th_gained_label: '+ Hashrate gained', strategy_th_paper_value: 'asset, paper value',
                strategy_used_prices: 'Prices used',
                refresh: 'Refresh', sidebar_guide: 'Extension Guide',
                btn_export: 'Export', btn_export_csv: 'Export transactions (CSV)', btn_import: 'Import',
                tx_date_today: 'Today', tx_date_yesterday: 'Yesterday',
                // KPIs
                kpi_today: 'Est. Gain Today', kpi_month: 'Gain This Month', kpi_miner: 'Miner', kpi_strategy: 'Optimal Strategy',
                kpi_pool_reward: 'Pool Reward', kpi_gmt_wallet: 'GMT Wallet', kpi_prepaid_days: 'Prepaid Days', kpi_next_halving: 'Next Halving',
                kpi_wallet: 'Wallet', kpi_discount: 'Discount',
                // Section titles
                sec_monthly_goal: 'Monthly Goal',
                dh_btc_price: 'BTC Price (USD)', dh_gmt_price: 'GMT Price (USD)',
                sec_reward_history: 'Reward History', sec_price_alerts: 'Price Alerts', sec_portfolio: 'My Portfolio',
                sec_add_invest: 'Add Investment', sec_staking: 'veGMT Lock Rewards', sec_breakdown: 'Breakdown',
                sec_projection: 'Projection', sec_transactions: 'Transaction History',
                sec_performance: 'Performance Tracking', sec_multisim: 'Multi-Scenario Simulation',
                sec_mining_params: 'NFT Miner Parameters', sec_results: 'Results',
                sec_btc_scenarios: 'Profits by Bitcoin Price', sec_strategy_map: 'Strategy Map — BTC × GMT',
                port_eyebrow: 'Portfolio · Performance', port_title: 'Your Portfolio',
                port_sub: 'Track every BTC, GMT, and TH dollar in and out. See P&L, ROI, and the live value of your miner.',
                scn_at_current: 'At current price', scn_bear: 'Bear case', scn_bull: 'Bull case',
                scn_chart_title: 'Net Profit / Day by BTC Price',
                scn_chart_desc: "Curve based on your current NFT parameters. Orange marker = today's BTC price. Red marker = breakeven.",
                scn_legend_curve: 'Net profit', scn_legend_current: 'Current price', scn_legend_breakeven: 'Breakeven', scn_legend_custom: 'Custom',
                scn_explore_title: 'Explore scenarios', scn_add: 'Add', scn_now: 'Now', scn_share: 'Share',
                scn_compare_title: 'Compare two scenarios', scn_compare_desc: 'Pick any two BTC prices and see them stacked side by side.',
                scn_scenario_a: 'Scenario A ($)', scn_scenario_b: 'Scenario B ($)',
                sec_compare: 'Compare: Buy vs Upgrade vs Lock GMT',
                sec_th_objective: 'TH Objective', sec_validation: 'Validation vs GoMining',
                sec_vegmt_lock_info: 'veGOMINING Lock Info',
                sec_current_status: 'Current Status',
                // Mining form
                lbl_hashrate: 'Hashrate (TH/s)', lbl_efficiency: 'Energy Efficiency (W/TH)', lbl_elec_cost: 'Electricity Cost ($/kWh)',
                lbl_gmt_wallet: 'GMT in Wallet', lbl_gmt_locked: 'GMT Locked (tokenomics)', lbl_sat_per_th: 'sat/TH/day (PR)',
                hint_hashrate: '1 TH/s (level 1) to 5000 TH/s (level 20)', hint_efficiency: '12 W/TH (best) to 50 W/TH (worst)',
                hint_elec_cost: 'Auto-filled from GoMining\'s own rate', hint_gmt_wallet: 'Virtual GMT wallet balance',
                hint_gmt_locked: 'Tokens locked in veGOMINING', hint_sat_per_th: 'Auto-calculated — manually adjustable from your dashboard',
                // Result cards
                res_gross_day: 'Gross Revenue / Day', res_fees_day: 'Fees / Day', res_net_day: 'Net Profit / Day',
                res_net_month: 'Net Profit / Month', res_net_year: 'Net Profit / Year',
                lbl_th_target: 'Target TH', lbl_result: 'Result',
                // Scenario table
                th_btc_price: 'BTC Price', th_gross_day: 'Gross/Day', th_fees_day: 'Fees/Day',
                th_net_day: 'Net/Day', th_net_month: 'Net/Month', th_net_year: 'Net/Year',
                scenarios_desc: 'Based on your NFT parameters above. Orange line = current price.',
                lbl_custom_btc: 'Custom BTC Price to Add ($)',
                // Reinvest form
                reinvest_desc: 'Based on future BTC and GMT prices, what is the best action?',
                lbl_cost_per_th_upgrade: 'Cost per TH Upgrade ($)', lbl_reinv_bonus: 'TH Reinvestment Bonus (%)',
                lbl_horizon: 'Horizon (days)', lbl_gmt_balance: 'Current GMT Balance',
                lbl_reserve_days: 'Desired GMT Reserve Days',
                hint_gmt_balance: 'How much GMT you have in your wallet', hint_reserve_days: 'How many days of fees you want in reserve',
                btn_generate_map: 'Generate Map',
                // Legend
                legend_hold_btc: 'Hold BTC', legend_convert_gmt: 'Convert to GMT', legend_reinvest_th: 'Reinvest in TH',
                legend_unprofitable: 'Unprofitable', legend_current_pos: 'Current Position',
                map_ylabel: 'GMT Price (USD)', map_xlabel: 'BTC Price (USD)',
                // Compare form
                compare_desc: 'For the same budget, which strategy yields the most?',
                lbl_budget: 'Available Budget ($)', lbl_cost_per_th_buy: 'Avg Price per TH/s ($) — Buy NFT',
                lbl_cost_per_th_upg: 'Price per TH/s ($) — Upgrade Existing',
                lbl_new_efficiency: 'New/Upgrade Efficiency (W/TH)', lbl_lock_duration: 'GMT Lock Duration (years)',
                lbl_vegmt_apr: 'Estimated veGOMINING APR (%)',
                hint_cost_per_th_buy: 'Marketplace: $21-26/TH (API confirmed)', hint_cost_per_th_upg: 'Auto-filled from your own history — it follows the GMT price',
                hint_vegmt_apr: 'Variable — check current rewards',
                opt_3months: '3 months', opt_6months: '6 months', opt_1year: '1 year', opt_2years: '2 years', opt_4years: '4 years',
                btn_compare: 'Compare',
                // Multisim
                multisim_desc: 'Project your profits over 12 months by varying BTC and network difficulty.',
                lbl_btc_variation: 'BTC Variation', lbl_diff_variation: 'Difficulty Variation',
                lbl_reinvest_th: 'Reinvest in TH', hint_compound_th: 'Compound gains into TH',
                // Performance
                perf_desc: 'Compare your actual gains (extension) vs simulator projections.',
                perf_accuracy: 'Simulator Accuracy', perf_actual_cum: 'Cumulative Actual Gains', perf_projected_cum: 'Cumulative Projected Gains',
                perf_auto_fill: 'Data fills automatically with each sync from the extension.',
                btn_reset_data: 'Reset Data', perf_reset_confirm: 'Performance data reset.',
                perf_actual: 'Actual', perf_projected: 'Projected', perf_gap: 'Gap',
                perf_no_data: 'Not enough data. Sync a few times from the extension to accumulate data.',
                // Alerts
                lbl_alert_btc_high: 'Alert if BTC > ($)', lbl_alert_btc_low: 'Alert if BTC < ($)',
                lbl_alert_gmt_high: 'Alert if GMT > ($)', lbl_alert_gmt_low: 'Alert if GMT < ($)',
                btn_enable_notif: 'Enable Browser Notifications',
                lbl_current_btc: 'Current BTC', lbl_current_gmt: 'Current GMT',
                alerts_none: 'No alerts triggered. Set thresholds above.',
                // Portfolio
                lbl_staking_weekly: 'GMT Received / Week (veGMT lock)', hint_staking_weekly: 'Auto-filled from extension (visit your veGMT lock page)',
                lbl_date: 'Date', lbl_category: 'Category', lbl_amount: 'Amount', lbl_currency: 'Currency',
                lbl_th_added: 'TH Added', hint_th_added: 'For your records — the simulator hashrate is auto-synced from GoMining', lbl_note: 'Note', btn_add: '+ Add',
                cat_nft: '⛏ Buy NFT', cat_upgrade: '⬆ Upgrade TH', cat_upgrade_wth: '⚡ Upgrade W/TH', cat_lock: '🔒 Lock GMT', cat_staking: '💎 Staking veGMT', cat_other: '📦 Other',
                cat_nft_label: 'Buy NFT', cat_upgrade_label: 'Upgrade TH', cat_upgrade_wth_label: 'Upgrade W/TH',
                cat_lock_label: 'Lock GMT', cat_staking_label: 'Staking veGMT', cat_other_label: 'Other',
                port_total_invested: 'External Capital', port_cumulative: 'Cumulative Gains',
                port_pnl: 'Profit / Loss', port_roi_label: 'ROI',
                port_active_days: 'Active Days', port_daily_avg: 'Avg Gain / Day',
                port_payback: 'Investment Payback', port_asset_value: 'Replacement Value', port_paid_back: 'Paid Back!',
                // Labels
                lbl_breakeven: 'Breakeven BTC', lbl_daily_fees: 'Daily Fees',
                lbl_objective: 'Objective $', lbl_today_label: 'today',
                alerts_desc: 'Set price thresholds and get notified when they are triggered.',
                mob_scenarios: 'Scenarios',
                // Onboarding
                onboard_title: 'Welcome to GMSim', onboard_desc: 'The most complete investment tool for GoMining NFT miners. Track your profits, compare strategies, and optimize your mining rewards.',
                onboard_s1_title: 'Install the Chrome Extension', onboard_s1_desc: 'It auto-syncs your GoMining data. Load it from the extension/ folder in developer mode.',
                onboard_s2_title: 'Visit app.gomining.com', onboard_s2_desc: 'Navigate through your miner and rewards pages. The extension captures your data automatically.',
                onboard_s3_title: 'Come back here', onboard_s3_desc: 'Your dashboard fills automatically. Or enter your miner details manually in the Simulator tab.',
                onboard_btn: 'Get Started', onboard_guide: 'How to install the extension',
                guide_title: 'Chrome Extension Installation',
                guide_download: '⬇ Download Extension',
                ext_update_msg: '⚠ Your GMSim extension was installed by hand and will never update itself. Reinstall it from the Chrome Web Store: it updates on its own, it no longer keeps a copy of your GoMining sign-in data, and it fixes farm power, reward dates and the daily profit figure. The manual download has been retired.',
                ext_update_cta: 'Install from the Chrome Web Store →',
                guide_s1: 'Download and <strong>unzip</strong> the file above',
                guide_s2: 'Open <strong>chrome://extensions/</strong> in your browser',
                guide_s3: 'Enable <strong>"Developer mode"</strong> (toggle in the top right corner)',
                guide_s4: 'Click <strong>"Load unpacked"</strong>',
                guide_s5: 'Select the <strong>extension/</strong> folder from the unzipped files',
                guide_s6: 'Visit <strong>app.gomining.com</strong> — the extension icon should appear',
                guide_s7: 'Navigate to your miner rewards page, then come back here. Data syncs automatically!',
                disclaimer: 'This tool provides estimates only and is not financial advice. Calculations are based on current conditions and may not reflect actual returns. DYOR.',
                footer_text: 'GMSim', footer_disclaimer: 'Not financial advice. Use at your own risk.',
                // JS dynamic strings
                loading: 'Loading...', refresh_data: 'Refresh Data', last_update: 'Last update',
                alert_load_data: 'Please load live data first.', alert_calc_first: 'First calculate your profits in the Mining Simulator tab.',
                danger_title: 'Danger Zone — Profitability Thresholds', danger_current_btc: 'Current BTC Price',
                danger_breakeven: 'BTC Breakeven (profit = 0)', danger_margin: 'margin', danger_safety: 'Safety Margin',
                danger_btc_can_drop: 'BTC can drop by this amount',
                miner_info: 'Miner Info', miner_current_level: 'Current Level', miner_next_level: 'Next Level',
                miner_needed: 'needed', miner_upgrade_cost: 'Direct Upgrade Cost',
                dash_gross: 'Gross', dash_fees: 'Fees', dash_next: 'Next',
                days: 'days', months: 'months', years: 'years', d_suffix: 'd', m_suffix: 'mo', and: 'and',
                th_already_reached: 'Objective already reached!', th_unreachable: 'Not reachable under current conditions',
                strat_buy_nft: 'Buy a New NFT', strat_upgrade_nft: 'Upgrade an Existing NFT', strat_lock_gmt: 'Lock GMT (veGOMINING)',
                strat_th_obtained: 'TH/s Obtained', strat_th_added: 'TH/s Added',
                strat_net_day: 'Net Profit/Day', strat_net_month: 'Net Profit/Month', strat_net_year: 'Net Profit/Year',
                strat_annual_roi: 'Annual ROI', strat_payback_in: 'Payback In',
                strat_gmt_tokens: 'GMT Tokens', strat_vegmt_received: 'veGOMINING Received',
                strat_lock_duration: 'Lock Duration', strat_est_rewards_year: 'Est. Rewards/Year', strat_effective_apr: 'Effective APR',
                lock_current_gmt: 'Current GMT Price', lock_ratio: 'veGMT Ratio', lock_note_label: 'Note',
                lock_note_text: 'veGMT decreases linearly until expiration. APR is an estimate.',
                reserve_ok: 'GMT Reserve OK', reserve_fill_first: 'Fill your GMT reserve first!',
                reserve_you_have: 'You have', reserve_enough_for: 'enough for', reserve_days_of_fees: 'days of fees',
                reserve_goal: 'goal', reserve_fees_day: 'Fees/day', reserve_needed: 'Reserve needed',
                reserve_but_need: 'but need', reserve_for: 'for', reserve_missing: 'Missing',
                reserve_convert_for: 'convert to GMT for', reserve_before_reinvest: 'before BTC or TH reinvest', reserve_covered: 'Covered',
                map_hold_btc: 'Hold BTC', map_convert_gmt: 'Convert GMT', map_reinvest_th: 'Reinvest TH',
                map_annual_minus_fees: 'annual revenue - fees',
                reco_priority_reserve: 'Priority: fill your GMT reserve', reco_missing: 'You are missing',
                reco_to_cover: 'to cover', reco_convert_rewards: 'Convert your rewards to GMT for',
                reco_then_optimal: 'then switch to the optimal strategy', reco_best_after_reserve: 'Best strategy once reserve is OK',
                reco_at_current_prices: 'At current prices over',
                sim_cum_profit: 'Cumulative 12-month profit', sim_optimistic: 'Optimistic', sim_pessimistic: 'Pessimistic', sim_final_th: 'Final TH',
                sync_active: 'Auto-sync active', sync_less_1min: 'Sync < 1 min', sync_ago: 'Sync', sync_none: 'No sync', sync_last: 'Last sync', sync_stale: 'Rewards stop at {d} — open GoMining\'s Rewards page to catch up',
                sync_behind: 'Rewards up to {d} — one day behind, open the Rewards page',
                cat_deposit_label: 'Deposit (money in)',
                cat_deposit: '💵 Deposit (money in)',
                port_recovered_label: 'Recovered',
                port_cost_per_th: 'Cost / TH',
                port_cum_lifetime: 'Lifetime, from GoMining\'s own totals',
                port_cum_lifetime_mw: 'Lifetime, GoMining\'s totals — includes {mw} from Miner Wars',
                port_cum_measured: 'Over the days this site was open',
                port_cum_estimate: 'Estimated from the current daily rate',
                port_avg_window: 'Over the last {n} measured day(s)',
                port_avg_calc: 'No measured day yet — calculated rate',
                port_pct_year: '%/year',
                port_bd_ledger: 'Filled in from your GoMining transactions — nothing to enter by hand. Percentages are shares of what you spent; deposits are the capital it came from. Manual entries stay in the table below and are not counted twice.',
                port_bd_manual: 'From your manual entries. Visit your GoMining transaction history to have this filled in automatically.',
                port_bd_no_cats: 'captured before categorisation existed — reload the extension',
                port_bd_unknown: 'uncategorised movement types seen: {types} — tell us and we will map them',
                port_asset_balances: 'in balances',
                stk_earned: 'Earned so far', stk_locked: 'GMT locked', stk_unlocks: 'Unlocks in',
                scan_title: 'What to open on GoMining',
                scan_lead: 'Each page feeds a different part of your data. Open the ones you want unlocked — once each. After that the extension keeps them up to date on its own.',
                scan_p_miners: 'My miners', scan_u_miners: 'Farm power, miner count, efficiency, discount and balances',
                scan_p_rewards: 'Rewards', scan_u_rewards: 'Reward history, pool reward and your real daily profit',
                scan_p_tx: 'Wallet › Transactions', scan_u_tx: 'Invested capital and the spending breakdown — scroll the list once',
                scan_p_lock: 'Lock › My lock › veGMT (no direct link — the URL is unique to your position)', scan_u_lock: 'Locked GMT and staking rewards',
                scan_p_home: 'GoMining home', scan_u_home: 'Live GMT and BTC prices, and today\'s partial pool reward',
                scan_note_live: 'Ticked items are already captured. The extension refreshes them whenever you browse GoMining.',
                scan_note_none: 'No extension detected yet — install it first and this list will show what is captured.',
                tx_auto: 'auto', tx_count_label: 'transactions',
                tx_from_gomining: 'from GoMining', tx_manual: 'entered by hand',
                port_asset_hint: 'TH valued at the in-app upgrade rate — what it would cost to rebuild your farm today, not a resale quote. Plus locked and liquid balances.',
                port_need_deposit: 'Add a Deposit entry — only money from outside counts as capital.',
                port_capital_fallback: 'Estimated from purchases. Log your deposits for an exact figure.',
                port_capital_ledger: 'From your GoMining deposits — {gmt} GMT, converted at your own historical rates.',
                port_capital_unvalued: 'Deposits found, but in a currency you never converted — no honest rate to value them.',
                guide_store_cta: 'Install from the Chrome Web Store',
                guide_ns1: 'Click <strong>Add to Chrome</strong> on the store page that opens',
                guide_ns2: 'Open <strong>app.gomining.com</strong> and sign in — the extension icon appears bottom-right',
                guide_ns3: 'Visit your <strong>Rewards</strong> page once, then come back here. Everything syncs on its own from then on.',
                guide_store_note: 'Installing from the store means the extension updates itself — no reloading by hand, ever.',
                hist_uptodate: 'Up to date',
                hist_behind_hint: 'Open GoMining\u2019s Rewards page to refresh — or, if you earn through Miner Wars, GMSim does not compute those rewards yet.',
                hist_missing_pre: 'Missing', hist_missing_post: ' day(s)',
                wb_lead: 'Since your last visit', wb_days: 'd', wb_strategy: 'Optimal strategy',
                alerts_label: 'Alerts', alerts_optin: 'Email me when my optimal strategy changes',
                alerts_note: 'Off by default. No other email is ever sent, and you can turn this off here at any time.',
                sync_success: 'Data synced from extension!',
                sync_no_data: 'No GoMining data in clipboard.\n\n1. Go to app.gomining.com\n2. Click "Copy data for Simulator" in the extension panel\n3. Come back here and click "Sync Extension"',
                sync_clipboard_denied: 'Clipboard access denied.\nClick somewhere on the page first, then try again.',
                alert_strategy_change: 'Recommended strategy change',
                alert_conditions_suggest: 'Current conditions (BTC/GMT/difficulty) suggest a change.',
                notif_strategy: 'GoMining Strategy', notif_strategy_change: 'Recommended change', notif_price_alert: 'GoMining Price Alert',
                val_metric: 'Metric', val_simulator: 'Simulator', val_last_data: 'Latest data',
                val_accuracy: 'Accuracy', val_validated: 'Calculations validated!', val_net_gap: 'Net gap', val_check_params: 'check parameters',
                val_row_gross: 'Pool Reward (gross)', val_row_c1: 'C1 (electricity)', val_row_c2: 'C2 (service)', val_row_net: 'Net reward',
                manual_entry_btn: 'Enter manually', manual_entry_desc: 'Edit your miner data and prices. Changes recalculate automatically.',
                manual_entry_btc: 'BTC Price (USD)', manual_entry_btc_hint: 'Override the live BTC price for what-if simulations',
                manual_entry_gmt: 'GMT Price (USD)', manual_entry_gmt_hint: 'Override the live GMT price for what-if simulations',
                manual_entry_close: 'Close', manual_entry_apply: 'Apply & Close', manual_entry_reset: '↺ Reset to defaults',
                cal_week: 'Week', cal_average: 'Average', cal_day: 'day', cal_week_short: 'wk',
                cal_empty: 'Sync your GoMining data to see your reward history calendar.', cal_empty_cta: 'Install extension to auto-sync',
                goal_month_est: 'month estimated', goal_above: 'above objective', goal_missing: 'missing',
                import_invalid: 'Invalid file.', import_confirm: 'Import backup from',
                import_overwrite: 'This will overwrite your current data.',
                import_success: 'Import successful! Page will reload.', import_error: 'File read error',
                tx_fill_date_amount: 'Fill in the date and amount.', tx_gmt_unavailable: 'GMT price unavailable. Refresh data.',
                tx_no_transactions: 'No transactions yet', tx_no_transactions_hint: 'Use the Add Investment form above to start tracking your portfolio.', tx_no_match: 'No transactions match your filter.',
                tx_category: 'Category', tx_delete_confirm: 'Delete this transaction?',
                proj_3months: '3 months', proj_6months: '6 months', proj_1year: '1 year', proj_annualized_roi: 'Annualized ROI'
            },
            fr: {
                // Sidebar
                nav_subtitle: 'Simulateur & Stratégies',
                nav_dashboard: 'Dashboard', nav_simulator: 'Simulateur', nav_scenarios: 'Scénarios BTC',
                nav_strategy: 'Labo Stratégie',
                nav_reinvest: 'Réinvestissement', nav_compare: 'Comparer', nav_simulation: 'Simulation',
                nav_performance: 'Performance', nav_alerts: 'Alertes', nav_portfolio: 'Portfolio',
                nav_efficiency: 'Efficacité',
                pin_conflict: 'Ton extension rapporte des valeurs différentes de celles que tu as saisies :',
                pin_use_ext: 'Utiliser les données de l\'extension',
                pin_keep_mine: 'Garder les miennes',
                gate_guest: 'L\'utiliser sans compte →',
                gate_guest_note: 'Le calculateur au complet, sans inscription. Le compte sauvegarde tes scénarios ; l\'extension remplit tes chiffres à ta place.',
                sw_quota: 'Le stockage de ce navigateur est plein : ton historique de récompenses ne s\'enregistre plus. Rien de déjà enregistré n\'a été supprimé. Libère de l\'espace en effaçant les données d\'un autre site, ou exporte ton historique.',
                sw_blocked: 'Ce navigateur bloque le stockage local : ton historique et ton portfolio ne survivront pas à un rechargement. C\'est généralement la navigation privée.',
                po_invented_1: 'Aucune source de prix n\'a répondu — le prix',
                po_invented_2: 'ci-dessous est une valeur écrite dans l\'app, pas un prix de marché. Tout chiffre qui en découle ne veut rien dire jusqu\'à ce qu\'une source réponde.',
                po_cached: 'Prix en direct injoignables — on utilise le dernier prix vu par ce navigateur',
                po_under_hour: 'moins d\'une heure',
                po_no_mempool: 'La difficulté du réseau est indisponible : le Pool Reward retombe sur ta dernière valeur synchronisée.',
                stk_yield: 'Rendement annuel',
                miners_one: 'mineur', miners_plural: 'mineurs',
                eff_over: 'sur',
                vegmt_yield: 'rendement veGMT',
                strat_days_added: 'j de valeur ajoutée',
                paused_farm: 'Ferme en pause — GoMining arrête tous les frais',
                paused_would_be: 'serait de',
                paused_short: 'en pause',
                eff_k_restored: 'Revenu restauré',
                eff_k_restored_sub: 'ferme en pause — elle ne gagne rien aujourd\'hui',
                eff_n_6: '<strong>Une ferme en pause change le calcul.</strong> GoMining met en pause une ferme qui minerait à perte : au-delà d\'un certain W/TH elle ne gagne rien au lieu de perdre — et ne paie pas d\'électricité pendant l\'arrêt. Pour une telle ferme, l\'upgrade ne réduit pas une facture, il restaure un revenu, et les chiffres ci-dessus ne s\'appliquent qu\'une fois qu\'elle tourne.',
                eff_cmp_paused: 'GoMining met en pause une ferme qui minerait à perte et la redémarre quand elle redevient rentable. À cette efficacité, la ferme ne gagne rien plutôt que de perdre — donc l\'économie d\'électricité ci-dessus ne s\'applique qu\'une fois qu\'elle tourne.',
                eff_cmp_paused_reach: 'Il lui faut atteindre',
                eff_cmp_paused_costs: ' pour repartir, ce qui coûte ',
                eff_cmp_paused_nofix: 'Elle ne redevient rentable à aucune efficacité jusqu\'à 12 W/TH — vérifie ton tarif électrique et ton Pool Reward avant de dépenser quoi que ce soit.',
                eff_n_1: '<strong>Ce n\'est pas un pari sur le Bitcoin.</strong> Ton hashrate ne change pas, donc ton revenu non plus. Le coût et l\'économie sont tous deux en dollars — c\'est l\'une des rares décisions GoMining dont le retour ne dépend pas du prix du BTC.',
                eff_n_2: '<strong>Le retour est le même quelle que soit la taille de la ferme.</strong> Le coût et l\'économie montent tous deux par TH : 16 TH et 700 TH se rentabilisent à la même date. Impossible d\'essayer petit pour voir.',
                eff_n_3: '<strong>La valeur de revente n\'est pas comptée, donc le retour est pessimiste.</strong> Un mineur plus efficace se revend plus cher par TH sur le marché secondaire, ce qui raccourcit le vrai retour d\'un montant qu\'on ne sait pas encore mesurer. Pour les bandes bon marché ça ne change rien ; pour les trois derniers watts, ça peut tout décider.',
                eff_n_4: '<strong>Les prix sont ceux affichés par GoMining le 28 août 2026</strong>, fixes en USD. Ils ne changent que quand GoMining reprice, et cette table ne le saura pas avant d\'être mise à jour.',
                eff_n_5: '<strong>À l\'intérieur d\'une bande de prix, le retour est plat.</strong> Le coût et l\'économie montent tous deux avec le nombre de paliers : s\'arrêter au milieu d\'une bande n\'améliore rien, ça dépense seulement moins. Si une bande vaut la peine d\'être entamée, elle vaut la peine d\'être terminée.',
                eff_eyebrow: 'Watts · Coût · Retour',
                eff_title: '⚡ Calculateur d\'efficacité',
                eff_intro: 'Baisser ton W/TH réduit ta facture d\'électricité chaque jour et te coûte une seule fois. GoMining affiche le prix, jamais le retour. Ceci le calcule — et te dit où arrêter.',
                eff_f_th: 'Hashrate (TH)', eff_f_th_hint: 'Depuis ta ferme',
                eff_f_from: 'Actuel (W/TH)', eff_f_from_hint: 'Pondéré par le hashrate',
                eff_f_to: 'Cible (W/TH)', eff_f_to_hint: '12 est le plancher',
                eff_f_elec: 'Électricité ($/kWh)', eff_f_elec_hint: 'Détecté',
                eff_f_disc: 'Remise (%)', eff_f_disc_hint: 'Réduit l\'économie, pas le prix',
                eff_reset: 'Revenir à ma ferme',
                eff_r_title: 'Ce que cet upgrade coûte et rapporte',
                eff_r_sub: 'L\'upgrade est facturé plein prix — ta remise ne s\'y applique pas. Elle s\'applique à l\'électricité, donc elle réduit aussi l\'économie et allonge le retour.',
                eff_l_title: 'Où s\'arrêter',
                eff_l_sub: 'GoMining vend les watts faciles presque gratuitement et les derniers à prix d\'or. Chaque ligne est un palier de prix : lis vers le bas et arrête-toi quand le rendement ne le justifie plus. Clique une ligne pour en faire ta cible.',
                eff_l_step: 'Palier', eff_l_cost: 'Coût', eff_l_saving: 'Économie / jour',
                eff_l_payback: 'Retour', eff_l_return: 'Rendement annuel',
                eff_l_hint: 'Les lignes surlignées sont dans ta cible actuelle. Les cumuls supposent que tu prends tous les paliers au-dessus.',
                eff_n_title: 'Ce que ce calcul prend en compte, et ce qu\'il ignore',
                eff_k_cost: 'Coût de l\'upgrade', eff_k_saving: 'Électricité économisée',
                eff_k_payback: 'Retour', eff_k_payback_sub: 'indépendant de la taille de la ferme',
                eff_k_return: 'Rendement annuel',
                eff_day: 'jour', eff_year: 'an', eff_days: 'jours', eff_years: 'ans',
                eff_saved: 'économisés', eff_cum: 'cumulé',
                eff_v_great: 'bien mieux qu\'acheter du TH', eff_v_good: 'mieux qu\'acheter du TH',
                eff_v_close: 'équivalent à acheter du TH', eff_v_poor: 'moins bien qu\'acheter du TH',
                eff_v_fast: 'se rentabilise vite', eff_v_solid: 'bon rendement',
                eff_v_slow: 'rendement lent', eff_v_verylow: 'rendement très faible',
                eff_cmp_label: 'À titre de comparaison, un dollar mis en hashrate rapporte',
                eff_cmp_per_year: 'par an',
                eff_cmp_missing: 'Le rendement du hashrate est inconnu tant que les données de ta ferme ne sont pas chargées — scanne tes pages GoMining pour comparer les deux.',
                eff_pick_lower: 'Choisis une cible sous ton efficacité actuelle pour voir ce que ça coûte et ce que ça rapporte.',
                eff_at_floor: 'Tu es à 12 W/TH — le plancher. Il n\'y a plus rien à améliorer.',
                sec_strategy_lab: '🧪 Labo Stratégie',
                strategy_intro: "Construis un plan de réinvestissement jour par jour et vois combien tu gagnerais sur la période. Choisis pour chaque jour : collecter BTC, réinvestir en GMT, ou acheter du TH.",
                strategy_period: 'Période',
                strategy_period_7: '7 jours', strategy_period_14: '14 jours', strategy_period_30: '30 jours',
                strategy_quick_fill: 'Remplir vite', strategy_smart_label: 'Auto-fill',
                strategy_eyebrow: 'Lab · Plan & Projection',
                strategy_step1_title: 'Pré-remplir le plan', strategy_step1_sub: "Utilise un quick fill ou laisse le smart-fill couvrir tes frais en premier.",
                strategy_step2_title: 'Ajuster jour par jour', strategy_step2_sub: "Clique sur une cellule pour passer entre BTC / GMT / TH pour ce jour-là.",
                strategy_step2_title_weekly: 'Ajuster semaine par semaine', strategy_step2_sub_weekly: "Clique sur une cellule pour passer entre BTC / GMT / TH pour cette semaine-là.",
                strategy_all_btc: 'Tout BTC', strategy_all_gmt: 'Tout GMT', strategy_all_th: 'Tout TH',
                strategy_prices: 'Prix personnalisés (optionnel)',
                strategy_prices_hint: 'Teste des scénarios — que se passe-t-il si BTC monte ou si GMT bouge ? Laisse vide pour utiliser les prix actuels.',
                strategy_btc_price: 'Prix BTC ($)', strategy_gmt_price: 'Prix GMT ($)', strategy_cost_per_th: 'Coût par TH ($)',
                strategy_cost_per_th_hint: 'Déduit de ton historique ; modifie pour forcer une valeur',
                strategy_reinvest_cost: 'Coût de réinvest par TH ($)',
                strategy_reinvest_cost_hint: 'Tarif d\'upgrade, déduit de ton historique — sert à calculer les TH gagnés en réinvestissant',
                strategy_market_th_price: 'Prix marché du TH ($)',
                strategy_market_th_price_hint: 'Prix marketplace en direct (volatile, change à la minute). Sert uniquement à afficher la valeur papier de l\'actif. Laisse vide pour utiliser le coût de réinvest.',
                strategy_th_market: 'marché',
                strategy_th_fallback: 'défaut sur coût de réinvest',
                strategy_period_by_period: 'Détail par période',
                strategy_col_period: 'Période', strategy_col_plan: 'Plan',
                strategy_col_gross: 'Brut', strategy_col_fees: 'Frais', strategy_col_net: 'Net',
                strategy_col_end_th: 'TH/s final', strategy_col_end_portfolio: 'Portefeuille final',
                strategy_current: 'actuel',
                strategy_auto: 'Auto-rempli', strategy_from_sync: 'depuis sync',
                strategy_week: 'Semaine',
                strategy_inputs_used: 'Paramètres utilisés',
                strategy_verify_inputs: '⚠ Les paramètres viennent de l\'onglet Simulateur. Modifie-les là si les chiffres ne correspondent pas à ta réalité.',
                strategy_smart_th: '⚖ GMT → TH',
                strategy_smart_btc: '⚖ GMT → BTC',
                strategy_smart_btc_th: '⚖ BTC → TH',
                strategy_smart_result_v2: 'Mine du {source} pendant {x} jours pour couvrir les frais, puis passe à {target} pour les {y} jours restants.',
                strategy_smart_hint: 'Auto-remplir : miner en GMT d\'abord pour couvrir tous les frais, puis basculer vers ta cible.',
                strategy_smart_result: 'Mine en GMT pendant {x} jours pour couvrir les frais, puis bascule en {target} pour les {y} jours restants.',
                strategy_smart_impossible: 'Impossible de couvrir les frais : le minage GMT ne génère pas assez avec les paramètres actuels.',
                strategy_source_real: 'Utilise les vraies données GoMining du', strategy_source_match: '— correspond au tableau de Validation.',
                lbl_fees_in: 'Frais :',
                strategy_run: 'Lancer la Simulation',
                strategy_results: 'Résultats',
                strategy_total_btc: 'Total BTC', strategy_total_gmt: 'Total GMT', strategy_total_th: 'TH Gagnés', strategy_total_fees: 'Frais Payés',
                strategy_net_btc: 'BTC Net', strategy_net_gmt: 'GMT Net',
                strategy_gross_btc: 'BTC Brut', strategy_gross_gmt: 'GMT Brut',
                strategy_total_btc_net: 'Total BTC (net)', strategy_total_gmt_net: 'Total GMT (net)', strategy_total_th_net: 'Total TH (net)',
                strategy_no_th_fees: 'pas de frais sur TH',
                strategy_mode_label: 'Mode',
                strategy_mode_monthly: 'Mensuel',
                strategy_mode_daily: 'Quotidien',
                strategy_monthly_label: 'Durée de projection',
                strategy_month_singular: 'mois', strategy_months: 'mois',
                strategy_month_label: 'Mois',
                strategy_weekly_slots: 'plages hebdo',
                strategy_results_label: 'Résultats',
                strategy_net_cash: 'Profit net liquide (BTC + GMT − frais)', strategy_th_gained_label: '+ Hashrate gagné', strategy_th_paper_value: 'actif, valeur papier',
                strategy_used_prices: 'Prix utilisés',
                refresh: 'Rafraîchir', sidebar_guide: "Guide d'extension",
                btn_export: 'Export', btn_export_csv: 'Export transactions (CSV)', btn_import: 'Import',
                tx_date_today: "Aujourd'hui", tx_date_yesterday: 'Hier',
                // KPIs
                kpi_today: "Gain estimé aujourd'hui", kpi_month: 'Gain ce mois', kpi_miner: 'Mineur', kpi_strategy: 'Stratégie optimale',
                kpi_pool_reward: 'Pool Reward', kpi_gmt_wallet: 'GMT Wallet', kpi_prepaid_days: 'Jours prépayés', kpi_next_halving: 'Prochain Halving',
                kpi_wallet: 'Portefeuille', kpi_discount: 'Discount',
                // Section titles
                sec_monthly_goal: 'Objectif Mensuel',
                dh_btc_price: 'Prix BTC (USD)', dh_gmt_price: 'Prix GMT (USD)',
                sec_reward_history: 'Historique des Rewards', sec_price_alerts: 'Alertes de Prix', sec_portfolio: 'Mon Portfolio',
                sec_add_invest: 'Ajouter un investissement', sec_staking: 'Revenus veGMT Lock', sec_breakdown: 'Répartition',
                sec_projection: 'Projection', sec_transactions: 'Historique des Transactions',
                sec_performance: 'Suivi de Performance', sec_multisim: 'Simulation Multi-Scénarios',
                sec_mining_params: 'Paramètres NFT Mineur', sec_results: 'Résultats',
                sec_btc_scenarios: 'Profits selon le prix du Bitcoin', sec_strategy_map: 'Carte Stratégique — BTC × GMT',
                port_eyebrow: 'Portfolio · Performance', port_title: 'Ton Portfolio',
                port_sub: 'Suis chaque dollar BTC, GMT et TH entrant et sortant. Vois ton P&L, ROI et la valeur live de ton mineur.',
                scn_at_current: 'Au prix actuel', scn_bear: 'Bear case', scn_bull: 'Bull case',
                scn_chart_title: 'Profit Net / jour selon le prix BTC',
                scn_chart_desc: "Courbe basée sur tes paramètres NFT. Marqueur orange = prix BTC d'aujourd'hui. Marqueur rouge = breakeven.",
                scn_legend_curve: 'Profit net', scn_legend_current: 'Prix actuel', scn_legend_breakeven: 'Breakeven', scn_legend_custom: 'Custom',
                scn_explore_title: 'Explore les scénarios', scn_add: 'Ajouter', scn_now: 'Actuel', scn_share: 'Partager',
                scn_compare_title: 'Comparer deux scénarios', scn_compare_desc: 'Choisis deux prix BTC et vois les côte à côte.',
                scn_scenario_a: 'Scénario A ($)', scn_scenario_b: 'Scénario B ($)',
                sec_compare: 'Comparer : Acheter vs Upgrader vs Lock GMT',
                sec_th_objective: 'Objectif TH', sec_validation: 'Validation vs GoMining',
                sec_vegmt_lock_info: 'Info veGOMINING Lock',
                sec_current_status: 'Statut actuel',
                // Mining form
                lbl_hashrate: 'Puissance de calcul (TH/s)', lbl_efficiency: 'Efficacité énergétique (W/TH)', lbl_elec_cost: 'Coût électricité ($/kWh)',
                lbl_gmt_wallet: 'GMT dans le wallet', lbl_gmt_locked: 'GMT locked (tokenomics)', lbl_sat_per_th: 'sat/TH/jour (PR)',
                hint_hashrate: '1 TH/s (niveau 1) à 5000 TH/s (niveau 20)', hint_efficiency: '12 W/TH (meilleur) à 50 W/TH (pire)',
                hint_elec_cost: 'Renseigné automatiquement au tarif GoMining', hint_gmt_wallet: 'Balance GMT virtuel wallet',
                hint_gmt_locked: 'Tokens lockés en veGOMINING', hint_sat_per_th: 'Auto-calculé — ajustable manuellement depuis ton dashboard',
                // Result cards
                res_gross_day: 'Revenu brut / jour', res_fees_day: 'Frais / jour', res_net_day: 'Profit net / jour',
                res_net_month: 'Profit net / mois', res_net_year: 'Profit net / an',
                lbl_th_target: 'TH cible', lbl_result: 'Résultat',
                // Scenario table
                th_btc_price: 'Prix BTC', th_gross_day: 'Revenu brut/jour', th_fees_day: 'Frais/jour',
                th_net_day: 'Profit net/jour', th_net_month: 'Profit net/mois', th_net_year: 'Profit net/an',
                scenarios_desc: 'Basé sur tes paramètres NFT ci-dessus. La ligne orange = prix actuel.',
                lbl_custom_btc: 'Prix BTC personnalisé à ajouter ($)',
                // Reinvest form
                reinvest_desc: 'Selon les prix futurs de BTC et GMT, quelle est la meilleure action ?',
                lbl_cost_per_th_upgrade: 'Coût par TH upgrade ($)', lbl_reinv_bonus: 'Bonus TH réinvestissement (%)',
                lbl_horizon: 'Horizon (jours)', lbl_gmt_balance: 'Balance GMT actuelle',
                lbl_reserve_days: 'Jours de réserve GMT souhaités',
                hint_gmt_balance: 'Combien de GMT tu as dans ton wallet', hint_reserve_days: 'Combien de jours de frais tu veux en réserve',
                btn_generate_map: 'Générer la carte',
                // Legend
                legend_hold_btc: 'Garder BTC', legend_convert_gmt: 'Convertir en GMT', legend_reinvest_th: 'Réinvestir en TH',
                legend_unprofitable: 'Non rentable', legend_current_pos: 'Position actuelle',
                map_ylabel: 'Prix GMT (USD)', map_xlabel: 'Prix BTC (USD)',
                // Compare form
                compare_desc: 'Pour un même budget, quelle stratégie rapporte le plus ?',
                lbl_budget: 'Budget disponible ($)', lbl_cost_per_th_buy: 'Prix moyen par TH/s ($) — achat NFT',
                lbl_cost_per_th_upg: 'Prix par TH/s ($) — upgrade existant',
                lbl_new_efficiency: 'Efficacité du nouveau/upgrade (W/TH)', lbl_lock_duration: 'Durée de lock GMT (années)',
                lbl_vegmt_apr: 'APR estimé veGOMINING (%)',
                hint_cost_per_th_buy: 'Marketplace: $21-26/TH (API confirmé)', hint_cost_per_th_upg: 'Déduit de ton historique — il suit le prix du GMT',
                hint_vegmt_apr: 'Variable — vérifier les rewards actuels',
                opt_3months: '3 mois', opt_6months: '6 mois', opt_1year: '1 an', opt_2years: '2 ans', opt_4years: '4 ans',
                btn_compare: 'Comparer',
                // Multisim
                multisim_desc: 'Projette tes profits sur 12 mois en variant BTC et la difficulté réseau.',
                lbl_btc_variation: 'Variation BTC', lbl_diff_variation: 'Variation difficulté',
                lbl_reinvest_th: 'Réinvestir en TH', hint_compound_th: 'Compound les gains en TH',
                // Performance
                perf_desc: 'Compare tes gains réels (extension) vs les projections du simulateur.',
                perf_accuracy: 'Précision simulateur', perf_actual_cum: 'Gains réels cumulés', perf_projected_cum: 'Gains projetés cumulés',
                perf_auto_fill: "Les données se remplissent automatiquement à chaque sync depuis l'extension.",
                btn_reset_data: 'Reset données', perf_reset_confirm: 'Données de performance réinitialisées.',
                perf_actual: 'Réel', perf_projected: 'Projeté', perf_gap: 'Écart',
                perf_no_data: "Pas assez de données. Fais quelques syncs depuis l'extension pour accumuler des données.",
                // Alerts
                lbl_alert_btc_high: 'Alerte si BTC > ($)', lbl_alert_btc_low: 'Alerte si BTC < ($)',
                lbl_alert_gmt_high: 'Alerte si GMT > ($)', lbl_alert_gmt_low: 'Alerte si GMT < ($)',
                btn_enable_notif: 'Activer notifications navigateur',
                lbl_current_btc: 'BTC actuel', lbl_current_gmt: 'GMT actuel',
                alerts_none: 'Aucune alerte déclenchée. Configure des seuils ci-dessus.',
                // Portfolio
                lbl_staking_weekly: 'GMT reçus / semaine (lock veGMT)', hint_staking_weekly: "Auto-rempli depuis l'extension (visite ta page veGMT lock)",
                lbl_date: 'Date', lbl_category: 'Catégorie', lbl_amount: 'Montant', lbl_currency: 'Devise',
                lbl_th_added: 'TH ajoutés', hint_th_added: 'Pour ton historique — le hashrate du simulateur est sync auto depuis GoMining', lbl_note: 'Note', btn_add: '+ Ajouter',
                cat_nft: '⛏ Achat NFT', cat_upgrade: '⬆ Upgrade TH', cat_upgrade_wth: '⚡ Upgrade W/TH',
                cat_lock: '🔒 Lock GMT', cat_staking: '💎 Staking veGMT', cat_other: '📦 Autre',
                cat_nft_label: 'Achat NFT', cat_upgrade_label: 'Upgrade TH', cat_upgrade_wth_label: 'Upgrade W/TH',
                cat_lock_label: 'Lock GMT', cat_staking_label: 'Staking veGMT', cat_other_label: 'Autre',
                port_total_invested: 'Capital externe', port_cumulative: 'Gains cumulés',
                port_pnl: 'Profit / Perte', port_roi_label: 'ROI',
                port_active_days: 'Jours actifs', port_daily_avg: 'Gain moyen / jour',
                port_payback: 'Retour investissement', port_asset_value: 'Valeur de remplacement', port_paid_back: 'Remboursé !',
                // Labels
                lbl_breakeven: 'Breakeven BTC', lbl_daily_fees: 'Frais quotidiens',
                lbl_objective: 'Objectif $', lbl_today_label: "aujourd'hui",
                alerts_desc: "Configurez des seuils de prix et recevez une notification quand ils sont dépassés.",
                mob_scenarios: 'Scénarios',
                // Onboarding
                onboard_title: 'Bienvenue sur GMSim', onboard_desc: "L'outil d'investissement le plus complet pour les mineurs NFT GoMining. Suivez vos profits, comparez les stratégies et optimisez vos revenus de minage.",
                onboard_s1_title: "Installez l'extension Chrome", onboard_s1_desc: "Elle synchronise automatiquement vos données GoMining. Chargez-la depuis le dossier extension/ en mode développeur.",
                onboard_s2_title: 'Visitez app.gomining.com', onboard_s2_desc: "Naviguez dans vos pages de mineur et rewards. L'extension capture vos données automatiquement.",
                onboard_s3_title: 'Revenez ici', onboard_s3_desc: "Votre dashboard se remplit automatiquement. Ou entrez vos détails manuellement dans l'onglet Simulateur.",
                onboard_btn: 'Commencer', onboard_guide: "Comment installer l'extension",
                guide_title: "Installation de l'extension Chrome",
                guide_download: "⬇ Télécharger l'extension",
                ext_update_msg: '⚠ Ton extension GMSim a été installée à la main et ne se mettra jamais à jour. Réinstalle-la depuis le Chrome Web Store : elle se met à jour toute seule, elle ne conserve plus de copie de tes données de connexion GoMining, et elle corrige la puissance de ferme, les dates de récompenses et le profit quotidien. Le téléchargement manuel a été retiré.',
                ext_update_cta: 'Installer depuis le Chrome Web Store →',
                guide_s1: 'Téléchargez et <strong>décompressez</strong> le fichier ci-dessus',
                guide_s2: 'Ouvrez <strong>chrome://extensions/</strong> dans votre navigateur',
                guide_s3: 'Activez le <strong>"Mode développeur"</strong> (en haut à droite)',
                guide_s4: 'Cliquez sur <strong>"Charger l\'extension non empaquetée"</strong>',
                guide_s5: 'Sélectionnez le dossier <strong>extension/</strong> des fichiers décompressés',
                guide_s6: 'Visitez <strong>app.gomining.com</strong> — l\'icône de l\'extension devrait apparaître',
                guide_s7: 'Naviguez vers votre page de rewards, puis revenez ici. Les données se synchronisent automatiquement !',
                disclaimer: "Cet outil fournit des estimations uniquement et ne constitue pas un conseil financier. Les calculs sont basés sur les conditions actuelles. Faites vos propres recherches.",
                footer_text: 'GMSim', footer_disclaimer: "Pas un conseil financier. Utilisez à vos risques.",
                // JS dynamic strings
                loading: 'Chargement...', refresh_data: 'Rafraîchir les données', last_update: 'Dernière mise à jour',
                alert_load_data: "Veuillez d'abord charger les données en direct.", alert_calc_first: "Calcule d'abord tes profits dans l'onglet Simulateur Mining.",
                danger_title: 'Zone de danger — Seuils de rentabilité', danger_current_btc: 'Prix BTC actuel',
                danger_breakeven: 'BTC Breakeven (profit = 0)', danger_margin: 'de marge', danger_safety: 'Marge de sécurité',
                danger_btc_can_drop: 'BTC peut baisser de ce montant',
                miner_info: 'Info Mineur', miner_current_level: 'Niveau actuel', miner_next_level: 'Prochain palier',
                miner_needed: 'nécessaires', miner_upgrade_cost: 'Coût upgrade direct',
                dash_gross: 'Brut', dash_fees: 'Frais', dash_next: 'Prochain',
                days: 'jours', months: 'mois', years: 'ans', d_suffix: 'j', m_suffix: 'm', and: 'et',
                th_already_reached: 'Objectif déjà atteint !', th_unreachable: 'Non atteignable aux conditions actuelles',
                strat_buy_nft: 'Acheter un nouveau NFT', strat_upgrade_nft: 'Upgrader un NFT existant', strat_lock_gmt: 'Lock GMT (veGOMINING)',
                strat_th_obtained: 'TH/s obtenus', strat_th_added: 'TH/s ajoutés',
                strat_net_day: 'Profit net/jour', strat_net_month: 'Profit net/mois', strat_net_year: 'Profit net/an',
                strat_annual_roi: 'ROI annuel', strat_payback_in: 'Retour en',
                strat_gmt_tokens: 'Tokens GMT', strat_vegmt_received: 'veGOMINING reçus',
                strat_lock_duration: 'Durée du lock', strat_est_rewards_year: 'Rewards estimés/an', strat_effective_apr: 'APR effectif',
                lock_current_gmt: 'Prix GMT actuel', lock_ratio: 'Ratio veGMT', lock_note_label: 'Note',
                lock_note_text: "Les veGMT décroissent linéairement jusqu'à expiration. L'APR est une estimation.",
                reserve_ok: 'Réserve GMT OK', reserve_fill_first: "Remplis ta réserve GMT d'abord !",
                reserve_you_have: 'Tu as', reserve_enough_for: 'assez pour', reserve_days_of_fees: 'jours de frais',
                reserve_goal: 'objectif', reserve_fees_day: 'Frais/jour', reserve_needed: 'Réserve nécessaire',
                reserve_but_need: "mais il t'en faut", reserve_for: 'pour', reserve_missing: 'Manque',
                reserve_convert_for: 'convertis en GMT pendant', reserve_before_reinvest: 'avant de faire BTC ou TH reinvest', reserve_covered: 'Couvert',
                map_hold_btc: 'Garder BTC', map_convert_gmt: 'Convertir GMT', map_reinvest_th: 'Réinvestir TH',
                map_annual_minus_fees: 'revenu annuel - frais',
                reco_priority_reserve: 'Priorité : remplir ta réserve GMT', reco_missing: 'Il te manque',
                reco_to_cover: 'pour couvrir', reco_convert_rewards: 'Convertis tes rewards en GMT pendant',
                reco_then_optimal: 'ensuite passe à la stratégie optimale', reco_best_after_reserve: 'Meilleure stratégie une fois la réserve OK',
                reco_at_current_prices: 'Aux prix actuels sur',
                sim_cum_profit: 'Profit cumulé 12 mois', sim_optimistic: 'Optimiste', sim_pessimistic: 'Pessimiste', sim_final_th: 'TH final',
                sync_active: 'Auto-sync actif', sync_less_1min: 'Sync < 1 min', sync_ago: 'Sync il y a', sync_none: 'Pas de sync', sync_last: 'Dernière sync', sync_stale: 'Récompenses arrêtées au {d} — ouvre la page Rewards de GoMining',
                sync_behind: 'Récompenses jusqu\'au {d} — un jour de retard, ouvre la page Rewards',
                cat_deposit_label: 'Dépôt (argent entrant)',
                cat_deposit: '💵 Dépôt (argent entrant)',
                port_recovered_label: 'Récupéré',
                port_cost_per_th: 'Coût / TH',
                port_cum_lifetime: 'Depuis le début, d\'après les totaux de GoMining',
                port_cum_lifetime_mw: 'Depuis le début, totaux GoMining — dont {mw} de Miner Wars',
                port_cum_measured: 'Sur les jours où ce site a été ouvert',
                port_cum_estimate: 'Estimé d\'après le rythme quotidien actuel',
                port_avg_window: 'Sur les {n} dernier(s) jour(s) mesuré(s)',
                port_avg_calc: 'Aucun jour mesuré — rythme calculé',
                port_pct_year: ' %/an',
                port_bd_ledger: 'Rempli depuis tes transactions GoMining — rien à saisir. Les pourcentages sont des parts de ce que tu as dépensé ; les dépôts sont le capital d\'où ça vient. Tes lignes manuelles restent dans la table et ne sont pas comptées deux fois.',
                port_bd_manual: 'D\'après tes saisies manuelles. Passe sur ton historique de transactions GoMining pour que ce soit rempli automatiquement.',
                port_bd_no_cats: 'capturé avant la catégorisation — recharge l\'extension',
                port_bd_unknown: 'types de mouvement non catégorisés : {types} — signale-le et on les mappera',
                port_asset_balances: 'en soldes',
                stk_earned: 'Gagné à ce jour', stk_locked: 'GMT verrouillés', stk_unlocks: 'Déblocage dans',
                scan_title: 'Quelles pages ouvrir sur GoMining',
                scan_lead: 'Chaque page alimente une partie différente de tes données. Ouvre celles que tu veux débloquer — une fois chacune. Ensuite l\'extension les tient à jour toute seule.',
                scan_p_miners: 'My miners', scan_u_miners: 'Puissance de ferme, nombre de mineurs, efficacité, remise et soldes',
                scan_p_rewards: 'Rewards', scan_u_rewards: 'Historique des récompenses, pool reward et ton vrai profit quotidien',
                scan_p_tx: 'Wallet › Transactions', scan_u_tx: 'Capital investi et ventilation des dépenses — fais défiler la liste une fois',
                scan_p_lock: 'Lock › My lock › veGMT (pas de lien direct — l\'URL est propre à ta position)', scan_u_lock: 'GMT verrouillés et récompenses de staking',
                scan_p_home: 'Accueil GoMining', scan_u_home: 'Prix GMT et BTC en direct, et le pool reward partiel du jour',
                scan_note_live: 'Les éléments cochés sont déjà captés. L\'extension les rafraîchit à chaque passage sur GoMining.',
                scan_note_none: 'Aucune extension détectée — installe-la d\'abord et cette liste montrera ce qui est capté.',
                tx_auto: 'auto', tx_count_label: 'transactions',
                tx_from_gomining: 'depuis GoMining', tx_manual: 'saisies à la main',
                port_asset_hint: 'TH valorisés au taux d\'upgrade in-app — ce que coûterait de reconstituer ta ferme aujourd\'hui, pas une cote de revente. Plus tes soldes verrouillés et liquides.',
                port_need_deposit: 'Ajoute une ligne Dépôt — seul l\'argent venu de l\'extérieur compte comme capital.',
                port_capital_fallback: 'Estimé d\'après tes achats. Saisis tes dépôts pour un chiffre exact.',
                port_capital_ledger: 'Depuis tes dépôts GoMining — {gmt} GMT, convertis à tes propres taux historiques.',
                port_capital_unvalued: 'Dépôts trouvés, mais dans une devise que tu n\'as jamais convertie — aucun taux honnête pour les valoriser.',
                guide_store_cta: 'Installer depuis le Chrome Web Store',
                guide_ns1: 'Clique <strong>Ajouter à Chrome</strong> sur la page du store qui s\'ouvre',
                guide_ns2: 'Ouvre <strong>app.gomining.com</strong> et connecte-toi — l\'icône apparaît en bas à droite',
                guide_ns3: 'Passe une fois sur ta page <strong>Rewards</strong>, puis reviens ici. Tout se synchronise ensuite tout seul.',
                guide_store_note: 'Installée depuis le store, l\'extension se met à jour toute seule — plus jamais de rechargement à la main.',
                hist_uptodate: 'À jour',
                hist_behind_hint: 'Ouvre la page Rewards de GoMining pour rafraîchir — ou, si tes gains passent par Miner Wars, GMSim ne calcule pas encore ces revenus.',
                hist_missing_pre: 'Manque', hist_missing_post: ' jour(s)',
                wb_lead: 'Depuis ta dernière visite', wb_days: 'j', wb_strategy: 'Stratégie optimale',
                alerts_label: 'Alertes', alerts_optin: 'Préviens-moi par courriel quand ma stratégie optimale change',
                alerts_note: 'Désactivé par défaut. Aucun autre courriel n\u2019est envoyé, et tu peux le couper ici quand tu veux.',
                sync_success: "Données synchronisées depuis l'extension !",
                sync_no_data: "Aucune donnée GoMining dans le presse-papier.\n\n1. Va sur app.gomining.com\n2. Clique \"Copier données pour Simulateur\" dans le panel de l'extension\n3. Reviens ici et clique \"Sync Extension\"",
                sync_clipboard_denied: "Accès au presse-papier refusé.\nClique d'abord quelque part sur la page, puis réessaie.",
                alert_strategy_change: 'Changement de stratégie recommandé',
                alert_conditions_suggest: 'Les conditions actuelles (BTC/GMT/difficulté) suggèrent de changer.',
                notif_strategy: 'GoMining Stratégie', notif_strategy_change: 'Changement recommandé', notif_price_alert: 'GoMining Alerte Prix',
                val_metric: 'Métrique', val_simulator: 'Simulateur', val_last_data: 'Dernière donnée',
                val_accuracy: 'Précision', val_validated: 'Calculs validés !', val_net_gap: 'Écart net', val_check_params: 'vérifier les paramètres',
                val_row_gross: 'Pool Reward (brut)', val_row_c1: 'C1 (électricité)', val_row_c2: 'C2 (service)', val_row_net: 'Profit net',
                manual_entry_btn: 'Entrer manuellement', manual_entry_desc: 'Modifie tes données de mineur et les prix. Les changements recalculent automatiquement.',
                connect_extension: "Connecter l'extension", connection_pulse: 'Pulse de connexion', filter_all: 'Toutes catégories', language: 'Langue',
                dh_subtitle: 'Simulateur Bitcoin Mining pour détenteurs de NFT GoMining',
                dh_net_profit: 'Profit Net :', dh_roi_period: 'Période ROI', dh_daily_payout: 'Paiement quotidien', dh_trend: 'Tendance',
                dh_miner_power: 'Puissance mineur',
                rewelcome_title: 'Bienvenue dans le nouveau GMSim',
                rewelcome_desc: 'Une refonte visuelle complète — mêmes données, beaucoup plus polish. Voici ce qui change :',
                rewelcome_f2_title: 'Dashboard plus propre',
                rewelcome_f2_desc: 'Hero de profit, calendrier Net hebdo, et toutes les stats que tu utilises (Daily Fees, Breakeven, Halving) visibles.',
                rewelcome_f3_title: 'BTC Scenarios interactifs',
                rewelcome_f3_desc: "Nouveau graphique de profit avec hover, comparaison côte-à-côte, chips quick-pick $30k–$250k.",
                rewelcome_btn: 'Jeter un œil',
                manual_entry_btc: 'Prix BTC (USD)', manual_entry_btc_hint: 'Forcer un prix BTC pour des simulations what-if',
                manual_entry_gmt: 'Prix GMT (USD)', manual_entry_gmt_hint: 'Forcer un prix GMT pour des simulations what-if',
                manual_entry_close: 'Fermer', manual_entry_apply: 'Appliquer et fermer', manual_entry_reset: '↺ Réinitialiser',
                cal_week: 'Semaine', cal_average: 'Moyenne', cal_day: 'jour', cal_week_short: 'sem',
                cal_empty: 'Synchronise tes données GoMining pour voir ton calendrier des rewards.', cal_empty_cta: "Installer l'extension pour auto-sync",
                goal_month_est: 'mois estimé', goal_above: "au-dessus de l'objectif", goal_missing: 'manquants',
                import_invalid: 'Fichier invalide.', import_confirm: 'Importer le backup du',
                import_overwrite: 'Ceci va écraser tes données actuelles.',
                import_success: 'Import réussi ! La page va se recharger.', import_error: 'Erreur de lecture du fichier',
                tx_fill_date_amount: 'Remplis la date et le montant.', tx_gmt_unavailable: 'Prix GMT non disponible. Rafraîchis les données.',
                tx_no_transactions: 'Aucune transaction', tx_no_transactions_hint: "Utilise le formulaire d'ajout d'investissement ci-dessus pour commencer à suivre ton portfolio.", tx_no_match: 'Aucune transaction ne correspond à ton filtre.',
                tx_category: 'Catégorie', tx_delete_confirm: 'Supprimer cette transaction ?',
                proj_3months: '3 mois', proj_6months: '6 mois', proj_1year: '1 an', proj_annualized_roi: 'ROI annualisé'
            }
        };

        let currentLang = localStorage.getItem('gomining_lang') || 'en';

        // Helper: get translated string by key
        function t(key, fallback) {
            const dict = TRANSLATIONS[currentLang] || TRANSLATIONS.en;
            return dict[key] || TRANSLATIONS.en[key] || fallback || key;
        }

        function setLang(lang) {
            currentLang = lang;
            localStorage.setItem('gomining_lang', lang);
            document.documentElement.lang = lang;
            document.querySelectorAll('.lang-btn').forEach(b => b.classList.toggle('active', b.dataset.lang === lang));
            document.documentElement.style.setProperty('--best-label', lang === 'fr' ? "'MEILLEUR'" : "'BEST'");
            applyTranslations();
            // Re-run dynamic sections if data is loaded
            if (state.lastCalc && state.btcPrice) {
                calculate();
            }
        }

        function applyTranslations() {
            const dict = TRANSLATIONS[currentLang] || TRANSLATIONS.en;
            document.querySelectorAll('[data-i18n]').forEach(el => {
                const key = el.dataset.i18n;
                if (dict[key]) {
                    if (el.tagName === 'INPUT') el.placeholder = dict[key];
                    else if (el.tagName === 'OPTION') el.textContent = dict[key];
                    else el.innerHTML = dict[key];
                }
            });
            // Infobulles traduisibles. Sans ça, un `title` reste dans la langue
            // où il a été écrit — et une explication qu'on ne peut pas lire ne
            // sert à rien. Séparé de data-i18n parce qu'un élément peut avoir
            // besoin des deux, sur des clés différentes.
            document.querySelectorAll('[data-i18n-title]').forEach(el => {
                const key = el.dataset.i18nTitle;
                if (dict[key]) el.title = dict[key];
            });
        }

        // ===== ONBOARDING =====
        function showOnboarding() {
            if (!localStorage.getItem('gomining_onboarded')) {
                document.getElementById('onboarding').style.display = 'flex';
            }
        }

        function dismissOnboarding() {
            document.getElementById('onboarding').style.display = 'none';
            localStorage.setItem('gomining_onboarded', '1');
        }

        // ===== REDESIGN WELCOME (returning users only) =====
        const REDESIGN_KEY = 'gms_redesign_seen_v2';
        function showRedesignWelcome() {
            // Only fires for users who already onboarded (existing users) and
            // haven't seen the new-design welcome yet.
            if (!localStorage.getItem('gomining_onboarded')) return;
            if (localStorage.getItem(REDESIGN_KEY)) return;
            const el = document.getElementById('redesign-welcome');
            if (el) el.style.display = 'flex';
        }
        function dismissRedesignWelcome() {
            const el = document.getElementById('redesign-welcome');
            if (el) el.style.display = 'none';
            try { localStorage.setItem(REDESIGN_KEY, '1'); } catch(_) {}
        }

        function showExtensionGuide() {
            // Redessiner à l'ouverture : la couverture a pu changer depuis le
            // dernier rendu, et c'est le moment où l'utilisateur la lit.
            try { renderScanChecklist(); } catch (e) {}
            document.getElementById('extension-guide').style.display = 'flex';
            document.getElementById('onboarding').style.display = 'none';
        }

        // ===== EMPTY STATE =====
        function updateEmptyState() {
            const el = document.getElementById('empty-state');
            if (!el) return;
            const hasData = state.btcPrice > 0 && state.lastCalc;
            el.style.display = hasData ? 'none' : 'block';
        }

        // ===== PERSISTANCE, ÉCHEC COMPRIS =====
        //
        // Trente-deux appels à setItem, avalés en silence — dont un dont le
        // commentaire nommait la panne : « quota exceeded — ignore ». Quand ça
        // échoue, l'historique cesse de grandir et l'indicateur de fraîcheur
        // accuse l'extension ou GoMining. L'utilisateur ne peut pas savoir.
        //
        // Le volume n'est pas le coupable probable : un jour stocké fait 22
        // scalaires, soit ~500 octets, donc une année tient dans 180 Ko. Un
        // échec vient plutôt d'une navigation privée ou d'un stockage bloqué.
        // Raison de plus pour ne pas amputer les données de l'utilisateur en
        // réaction : on le DIT, on ne coupe rien.
        let storageFailure = null;

        function persist(key, value) {
            try {
                localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
                return true;
            } catch (e) {
                const quota = e && (e.name === 'QuotaExceededError'
                    || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' || e.code === 22);
                storageFailure = { key, quota: !!quota, message: e && e.message };
                renderStorageWarning();
                return false;
            }
        }

        function renderStorageWarning() {
            const el = document.getElementById('storage-warning');
            if (!el) return;
            if (!storageFailure) { el.hidden = true; return; }
            el.hidden = false;
            el.className = 'price-origin price-origin--warn';
            el.textContent = storageFailure.quota
                ? t('sw_quota', 'This browser\'s storage is full, so your reward history has stopped saving. Nothing already saved was deleted. Clear site data for another site, or export your history.')
                : t('sw_blocked', 'This browser is blocking local storage, so your reward history and portfolio will not survive a reload. Private browsing usually causes this.');
        }

        // ===== ORIGINE DES PRIX =====
        const PRICE_CACHE_KEY = 'gms_price_cache';

        // Dit d'où vient chaque prix, et le dit fort quand c'est inventé.
        // Trois états, et ils ne se valent pas :
        //   live      Binance ou CoinGecko ont répondu — rien à signaler
        //   cached    dernier prix connu, avec son âge : utilisable, à savoir
        //   fallback  valeur écrite dans le code : les chiffres dérivés ne
        //             veulent RIEN dire, et il faut le dire sans détour
        function renderPriceOrigin() {
            const el = document.getElementById('price-origin');
            if (!el) return;
            const o = state.priceOrigin;
            if (!o) { el.hidden = true; return; }

            const invented = o.btc === 'fallback' || o.gmt === 'fallback';
            const stale    = o.btc === 'cached' || o.gmt === 'cached';

            if (!invented && !stale && o.mempool) { el.hidden = true; return; }
            el.hidden = false;
            el.className = 'price-origin ' + (invented ? 'price-origin--bad' : 'price-origin--warn');

            const bits = [];
            if (invented) {
                const which = [o.btc === 'fallback' ? 'BTC' : null,
                               o.gmt === 'fallback' ? 'GMT' : null].filter(Boolean).join(' & ');
                bits.push(`${t('po_invented_1', 'No price feed reached — the')} ${which} ${
                    t('po_invented_2', 'price below is a placeholder written into the app, not a market price. Every figure derived from it is meaningless until a feed responds.')}`);
            } else if (stale) {
                const h = o.ageMs ? Math.round(o.ageMs / 3600000) : null;
                bits.push(`${t('po_cached', 'Live prices unreachable — using the last price this browser saw')}${
                    h !== null ? ` (${h < 1 ? t('po_under_hour', 'under an hour old') : h + ' h'})` : ''}.`);
            }
            if (!o.mempool) {
                bits.push(t('po_no_mempool', 'Network difficulty is unavailable, so Pool Reward falls back to your last synced value.'));
            }
            el.textContent = bits.join(' ');
        }

        // ===== INPUT VALIDATION =====
        function validateInputs() {
            const rules = {
                'hashrate': { min: 0.001, max: 10000 },
                // 12 W/TH est le plancher réel (table de prix GoMining : aucune
                // ligne 12→11). Cette règle RÉÉCRIT la valeur, elle ne la refuse
                // pas — à 15 elle écrasait donc en silence les fermes les plus
                // efficaces, +25 % de coût électrique sur le calcul.
                'efficiency': { min: 12, max: 50 },
                'elec-cost': { min: 0.01, max: 1 },
                'sat-per-th': { min: 1, max: 1000 },
                'gmt-prepaid': { min: 0, max: 100000 },
                'gmt-locked': { min: 0, max: 1000000 }
            };
            Object.keys(rules).forEach(id => {
                const el = document.getElementById(id);
                if (!el) return;
                const val = parseFloat(el.value);
                const r = rules[id];
                if (isNaN(val) || val < r.min) el.value = r.min;
                if (val > r.max) el.value = r.max;
            });
        }

        // ===== THEME TOGGLE =====
// ===== DASHBOARD PERSISTENCE =====
        const DASH_CACHE_KEY = 'gomining_dash_cache';

        function saveDashCache() {
            const ids = ['dash-today', 'dash-month', 'dash-miner', 'dash-strategy',
                         'btc-price', 'gmt-price', 'net-hashrate',
                         'dash-profit-day', 'dash-gmt-wallet', 'dash-prepaid-days', 'dash-halving',
                         'dash-breakeven', 'dash-daily-fees'];
            const cache = {};
            ids.forEach(id => {
                const el = document.getElementById(id);
                if (el && el.textContent !== '--') cache[id] = el.textContent;
            });
            cache._time = Date.now();
            cache._btcPrice = state.btcPrice;
            cache._gmtPrice = state.gmtPrice;
            cache._apiGmtPrice = state.apiGmtPrice || null;
            cache._apiBtcPrice = state.apiBtcPrice || null;
            cache._apiSatPerTH = state.apiSatPerTH || null;
            cache._satPerTH = state.satPerTH || null;
            // Save synced wallet values
            const gmtPrepaidEl = document.getElementById('gmt-prepaid');
            const gmtLockedEl = document.getElementById('gmt-locked');
            if (gmtPrepaidEl) cache._gmtPrepaid = parseFloat(gmtPrepaidEl.value) || 0;
            if (gmtLockedEl) cache._gmtLocked = parseFloat(gmtLockedEl.value) || 0;
            localStorage.setItem(DASH_CACHE_KEY, JSON.stringify(cache));
        }

        function loadDashCache() {
            try {
                const cache = JSON.parse(localStorage.getItem(DASH_CACHE_KEY));
                if (!cache || !cache._time) return;
                // Only use if less than 30 min old
                if (Date.now() - cache._time > 30 * 60 * 1000) return;
                Object.keys(cache).forEach(id => {
                    if (id.startsWith('_')) return;
                    const el = document.getElementById(id);
                    if (el && el.textContent === '--') el.textContent = cache[id];
                });
                if (cache._btcPrice) state.btcPrice = cache._btcPrice;
                if (cache._gmtPrice) state.gmtPrice = cache._gmtPrice;
                if (cache._apiGmtPrice) { state.apiGmtPrice = cache._apiGmtPrice; }
                if (cache._apiBtcPrice) { state.apiBtcPrice = cache._apiBtcPrice; }
                if (cache._apiSatPerTH) {
                    state.apiSatPerTH = cache._apiSatPerTH;
                    state.satPerTH = cache._apiSatPerTH;
                    const satEl = document.getElementById('sat-per-th');
                    if (satEl) satEl.value = cache._apiSatPerTH;
                }
                if (cache._satPerTH && !state.satPerTH) state.satPerTH = cache._satPerTH;
                // Restore synced wallet values
                if (cache._gmtPrepaid !== undefined) {
                    const el = document.getElementById('gmt-prepaid');
                    if (el) el.value = cache._gmtPrepaid;
                }
                if (cache._gmtLocked !== undefined) {
                    const el = document.getElementById('gmt-locked');
                    if (el) el.value = cache._gmtLocked;
                }
            } catch(e) {}
        }

        // ===== NOTIFICATIONS =====
        let notificationsEnabled = ('Notification' in window && Notification.permission === 'granted');

        function requestNotifications() {
            if ('Notification' in window && Notification.permission !== 'granted') {
                Notification.requestPermission().then(p => {
                    notificationsEnabled = (p === 'granted');
                    document.getElementById('notif-btn')?.classList.toggle('active', notificationsEnabled);
                });
            }
        }

        function sendNotification(title, body) {
            if (!notificationsEnabled || document.hasFocus()) return;
            try { new Notification(title, { body, icon: 'icon.svg' }); } catch(e) {}
        }

        // ===== PRICE ALERTS =====
        function checkPriceAlerts() {
            if (!state.btcPrice || !state.gmtPrice) return;
            const alerts = [];

            const btcHigh = parseFloat(document.getElementById('alert-btc-high')?.value);
            const btcLow = parseFloat(document.getElementById('alert-btc-low')?.value);
            const gmtHigh = parseFloat(document.getElementById('alert-gmt-high')?.value);
            const gmtLow = parseFloat(document.getElementById('alert-gmt-low')?.value);

            if (btcHigh && state.btcPrice > btcHigh) alerts.push(`BTC > ${formatUSD(btcHigh)} (${formatUSD(state.btcPrice)})`);
            if (btcLow && state.btcPrice < btcLow) alerts.push(`BTC < ${formatUSD(btcLow)} (${formatUSD(state.btcPrice)})`);
            if (gmtHigh && state.gmtPrice > gmtHigh) alerts.push(`GMT > $${gmtHigh} ($${state.gmtPrice.toFixed(4)})`);
            if (gmtLow && state.gmtPrice < gmtLow) alerts.push(`GMT < $${gmtLow} ($${state.gmtPrice.toFixed(4)})`);

            const statusEl = document.getElementById('alert-status');
            if (alerts.length > 0) {
                statusEl.innerHTML = alerts.map(a => `<span style="color:var(--red);font-weight:600;">⚠ ${a}</span>`).join('<br>');
                alerts.forEach(a => sendNotification(t('notif_price_alert'), a));
            } else {
                statusEl.textContent = t('alerts_none');
            }

            // Update current prices in alerts tab
            const btcCur = document.getElementById('alert-btc-current');
            const gmtCur = document.getElementById('alert-gmt-current');
            if (btcCur) btcCur.textContent = formatUSD(state.btcPrice);
            if (gmtCur) gmtCur.textContent = '$' + state.gmtPrice.toFixed(4);
        }

        // ===== PORTFOLIO (Transaction-based) =====
        const TX_KEY = 'gomining_transactions';
        function getCatMeta() {
            return {
                // Seule catégorie qui compte comme CAPITAL. Toutes les autres sont
                // des emplois d'argent : un mineur payé avec du GMT miné n'est pas
                // un investissement, il a déjà été compté comme gain le jour où il
                // a été miné. Les additionner gonflait le dénominateur du ROI.
                deposit: { label: t('cat_deposit_label'), icon: '💵' },
                nft:     { label: t('cat_nft_label'), icon: '⛏' },
                upgrade: { label: t('cat_upgrade_label'), icon: '⬆' },
                'upgrade-wth': { label: t('cat_upgrade_wth_label'), icon: '⚡' },
                lock:    { label: t('cat_lock_label'), icon: '🔒' },
                staking: { label: t('cat_staking_label'), icon: '💎' },
                other:   { label: t('cat_other_label'), icon: '📦' }
            };
        }
        const CAT_META = getCatMeta();

        function loadTransactions() {
            try { return JSON.parse(localStorage.getItem(TX_KEY)) || []; } catch(e) { return []; }
        }

        function saveTransactions(txs) {
            localStorage.setItem(TX_KEY, JSON.stringify(txs));
        }

        // Show/hide TH field based on category
        function updateTxThVisibility() {
            const val = document.getElementById('tx-category').value;
            document.getElementById('tx-th-group').style.display = (val === 'nft' || val === 'upgrade') ? 'flex' : 'none';
        }
        document.getElementById('tx-category').addEventListener('change', updateTxThVisibility);
        updateTxThVisibility(); // Init on load

        document.getElementById('staking-gmt-weekly')?.addEventListener('change', () => { updatePortfolio(); saveSettings(); });

        // Preview conversion GMT → USD
        function updateTxPreview() {
            const cur = document.getElementById('tx-currency').value;
            const raw = parseFloat(document.getElementById('tx-amount').value) || 0;
            const preview = document.getElementById('tx-preview');
            if (cur === 'gmt' && raw > 0 && state.gmtPrice) {
                preview.textContent = `= ${formatUSD(raw * state.gmtPrice)} (GMT @ $${state.gmtPrice.toFixed(4)})`;
            } else {
                preview.textContent = '';
            }
        }
        document.getElementById('tx-amount')?.addEventListener('input', updateTxPreview);

        // Transaction history filter chips — proxy through the hidden <select>
        // so the existing updatePortfolio() logic works unchanged.
        window.setPortTxCat = function (btn) {
            document.querySelectorAll('.port-tx-chip').forEach(c => c.classList.remove('active'));
            btn.classList.add('active');
            const sel = document.getElementById('tx-filter-cat');
            if (sel) {
                sel.value = btn.dataset.cat;
                if (typeof updatePortfolio === 'function') updatePortfolio();
            }
        };

        // Quick date setter for the Add Investment form
        // dayOffset: 0 = today, -1 = yesterday, etc.
        window.setTxDate = function (dayOffset) {
            const d = new Date();
            d.setDate(d.getDate() + dayOffset);
            const iso = d.toISOString().substring(0, 10);
            const el = document.getElementById('tx-date');
            if (el) el.value = iso;
        };
        // Auto-fill today's date when the Portfolio tab is first viewed
        // (only if the user hasn't picked a date yet).
        document.addEventListener('DOMContentLoaded', () => {
            const el = document.getElementById('tx-date');
            if (el && !el.value) setTxDate(0);
        });

        function addTransaction() {
            const date = document.getElementById('tx-date').value;
            const cat = document.getElementById('tx-category').value;
            const rawAmount = parseFloat(document.getElementById('tx-amount').value);
            const currency = document.getElementById('tx-currency').value;
            const note = document.getElementById('tx-note').value.trim();
            const thAdded = parseFloat(document.getElementById('tx-th').value) || 0;

            if (!date || !rawAmount || rawAmount <= 0) {
                alert(t('tx_fill_date_amount'));
                return;
            }

            // Convertir GMT en USD si nécessaire
            let amountUsd = rawAmount;
            let gmtAmount = null;
            if (currency === 'gmt') {
                if (!state.gmtPrice) { alert(t('tx_gmt_unavailable')); return; }
                amountUsd = rawAmount * state.gmtPrice;
                gmtAmount = rawAmount;
            }

            const txs = loadTransactions();
            const tx = { id: Date.now(), date, category: cat, amount: amountUsd, note };
            if (gmtAmount !== null) { tx.gmtAmount = gmtAmount; tx.gmtPrice = state.gmtPrice; }
            if (thAdded > 0) tx.th = thAdded;
            txs.push(tx);
            txs.sort((a, b) => a.date.localeCompare(b.date));
            saveTransactions(txs);
            if (typeof toast === 'function') toast('Transaction added', 'success', 2200);

            // Note: we no longer auto-bump the simulator hashrate here.
            // The extension auto-syncs the live hashrate from GoMining, so
            // adding it manually would double-count after the next sync.
            // The `tx.th` value is preserved on the transaction for audit /
            // portfolio breakdown only.

            // Reset form
            document.getElementById('tx-amount').value = '';
            document.getElementById('tx-note').value = '';
            document.getElementById('tx-th').value = '';
            document.getElementById('tx-currency').value = 'usd';
            document.getElementById('tx-preview').textContent = '';

            updatePortfolio();
        }

        function deleteTransaction(id) {
            const all = loadTransactions();
            const removed = all.find(t => t.id === id);
            const txs = all.filter(t => t.id !== id);
            saveTransactions(txs);
            updatePortfolio();
            // Toast with undo — gives the user a 6s grace window to revert
            if (removed && typeof toast === 'function') {
                const container = document.getElementById('toast-container') || (() => {
                    const c = document.createElement('div');
                    c.id = 'toast-container';
                    c.className = 'toast-container';
                    document.body.appendChild(c);
                    return c;
                })();
                const el = document.createElement('div');
                el.className = 'toast toast--info';
                el.innerHTML = `
                    <span class="toast-icon">↺</span>
                    <span class="toast-msg">Transaction deleted</span>
                    <button class="toast-undo" type="button">Undo</button>
                    <button class="toast-close" aria-label="Dismiss">×</button>
                `;
                const dismiss = () => { el.classList.add('toast--leave'); setTimeout(() => el.remove(), 220); };
                el.querySelector('.toast-close').addEventListener('click', dismiss);
                el.querySelector('.toast-undo').addEventListener('click', () => {
                    const list = loadTransactions();
                    list.push(removed);
                    list.sort((a, b) => a.date.localeCompare(b.date));
                    saveTransactions(list);
                    updatePortfolio();
                    dismiss();
                    if (typeof toast === 'function') toast('Transaction restored', 'success', 2000);
                });
                container.appendChild(el);
                setTimeout(dismiss, 6000);
            }
        }

        function updatePortfolio() {
            const txs = loadTransactions();

            // Totals per category
            const totals = {};
            let capital = 0;   // argent venu de l'extérieur — le seul dénominateur légitime
            let spent = 0;     // emplois : achats, upgrades, lock… peu importe la source
            Object.keys(CAT_META).forEach(k => totals[k] = 0);
            txs.forEach(t => {
                totals[t.category] = (totals[t.category] || 0) + t.amount;
                if (t.category === 'deposit') capital += t.amount; else spent += t.amount;
            });
            // Repli pour les portefeuilles saisis avant l'existence de la catégorie
            // « dépôt » : on prend la somme des achats, faute de mieux, et on le dit.
            // Le relevé de transactions fait foi quand il est disponible : il
            // connaît les dépôts réels, y compris ceux que l'utilisateur a
            // oubliés. Chez Jérémie il donne ~23 700 GMT là où sa saisie
            // manuelle disait l'équivalent de 4 150 $ — presque la moitié.
            const led = state.capital;
            const ledgerGmt = led && led.gmtEquivalent;
            let capitalSource = 'none';
            if (ledgerGmt && (state.gmtPrice || 0) > 0) {
                capital = ledgerGmt * state.gmtPrice;
                capitalSource = 'ledger';
            } else if (capital > 0) {
                capitalSource = 'deposits';       // lignes « Dépôt » saisies à la main
            } else if (spent > 0) {
                capital = spent;                  // repli : somme des achats
                capitalSource = 'fallback';
            } else if (led && Object.keys(led.unvalued || {}).length > 0) {
                capitalSource = 'unvalued';       // dépôts vus, mais aucun taux honnête
            }
            const capitalIsFallback = capitalSource === 'fallback';
            const invested = capital;

            // Days since first activity — earliest of (first transaction) and (first synced reward day).
            // For users without manual transactions, falls back to reward history so the metric
            // still reflects their real mining tenure (up to MAX_HISTORY_DAYS the extension captured).
            const txDates = txs.map(t => new Date(t.date).getTime()).filter(n => !isNaN(n));
            const txFirstMs = txDates.length > 0 ? Math.min(...txDates) : null;
            const rhFirstMs = (state.rewardHistory && state.rewardHistory.length > 0)
                ? new Date(state.rewardHistory[0].date + 'T00:00:00').getTime()
                : null;
            const candidates = [txFirstMs, rhFirstMs].filter(n => n !== null && !isNaN(n));
            const firstDate = candidates.length > 0 ? new Date(Math.min(...candidates)) : new Date();
            const days = Math.max(1, Math.round((new Date() - firstDate) / 86400000));

            // Gains cumulés — priorité aux totaux À VIE de GoMining.
            //
            // L'ancien calcul sommait notre propre journal de performance, qui ne
            // couvre que les jours où le site a été ouvert et repart de zéro à
            // chaque invalidation de version : il affichait $27 là où le vrai
            // cumul est de $704. Les totaux de GoMining sont exhaustifs et
            // incluent les revenus Miner Wars, que le simulateur ne modélise pas.
            let currentDailyUsd = 0;
            if (state.lastCalc) {
                const c = state.lastCalc;
                const r = calcDailyReward(c.hashrate, c.efficiency, c.elecCost, c.discount, state.btcPrice, c.satPerTH);
                if (r) currentDailyUsd = r.netUsd;
            }

            let cumUsd = 0;
            let cumSource = 'none';
            if (state.lifetimeIncome?.btc > 0 && state.btcPrice) {
                cumUsd = state.lifetimeIncome.btc * state.btcPrice;
                cumSource = 'lifetime';
            } else {
                const perf = loadPerformance();
                perf.forEach(p => { cumUsd += p.actual?.valueUsd || 0; });
                if (cumUsd > 0) cumSource = 'perf';
                if (cumUsd === 0 && currentDailyUsd > 0) { cumUsd = currentDailyUsd * days; cumSource = 'estimate'; }
            }

            // === P&L : modèle « frontière » ===
            //
            // L'ancien calcul faisait `pnl = cumUsd - invested`, soit les revenus
            // de minage moins le capital — en ignorant complètement le fait que
            // les mineurs sont toujours détenus. D'où un P&L de −3 204 $ et un ROI
            // de −77 % affichés à côté d'un actif de 12 664 $, trois chiffres qui
            // ne pouvaient pas coexister.
            //
            // On ne compte donc que ce qui franchit la frontière du compte : le
            // capital entré d'un côté, la valeur détenue plus ce qui est sorti de
            // l'autre. Et surtout on n'additionne PAS les revenus cumulés à la
            // valeur de l'actif : les gains réinvestis sont déjà DANS l'actif sous
            // forme de TH, les compter deux fois était l'erreur inverse.
            const gmtP = state.gmtPrice || 0;
            const thNow = parseFloat(document.getElementById('hashrate')?.value) || 0;
            const thCost = parseFloat(document.getElementById('cost-per-th-upgrade')?.value) || 12.34;
            const lockedGmt = parseFloat(document.getElementById('gmt-locked')?.value) || 0;
            // Soldes liquides : ils étaient absents du calcul alors que
            // l'extension les fournit déjà. Négligeable pour une ferme mûre,
            // mais pas pour quelqu'un qui vient de vendre un mineur et dont
            // le produit dort encore en solde.
            const liquidGmt = parseFloat(document.getElementById('gmt-prepaid')?.value) || 0;
            const liquidBtc = state.btcWalletBalance || 0;
            const gp = gmtP;
            // Valeur de REMPLACEMENT, pas cote de marché : les TH sont valorisés
            // au taux d'upgrade in-app, c'est-à-dire au prix du neuf. C'est un
            // plafond — la revente sur le marché secondaire se fait sous ce prix,
            // frais compris. Le libellé le dit maintenant explicitement.
            const assetValue = thNow * thCost
                             + (lockedGmt + liquidGmt) * gp
                             + liquidBtc * (state.btcPrice || 0);
            // Sorties externes, détectées par l'ORDRE de retrait — un marqueur fiable
            // quel que soit le libellé du type, y compris pour un type qu'on n'a
            // jamais rencontré. Restait codé à zéro faute de savoir le lire : tout
            // utilisateur ayant retiré voyait donc son profit sous-estimé d'autant.
            const withdrawn = (state.capital?.externalWithdrawals > 0 && gmtP)
                ? state.capital.externalWithdrawals * gmtP
                : 0;

            const pnl = assetValue + withdrawn - capital;
            // Convention demandée : 100 % = investissement intégralement récupéré.
            // En dessous de 100 %, la mise n'est pas encore revenue ; au-dessus,
            // c'est du profit. Plus lisible qu'un ROI centré sur zéro pour une
            // position que l'on détient toujours.
            const recovery = capital > 0 ? ((assetValue + withdrawn) / capital * 100) : null;
            // Moyenne quotidienne : sur les 7 DERNIERS jours mesurés, pas depuis le
            // début.
            //
            // Une moyenne à vie décrit un passé qu'on a quitté. Jérémie est resté à
            // 16 TH près de la moitié de son ancienneté : diviser son cumul par 370
            // jours donne un chiffre qui ne dit rien de ce que sa ferme rapporte
            // aujourd'hui — et c'est précisément la question que pose ce KPI.
            //
            // On prend donc les jours complets les plus récents de l'historique
            // réel, au plus 7, et on annonce combien on en a trouvé : après cinq
            // semaines en Miner Wars, il n'y a qu'un seul jour solo récent, et le
            // dire vaut mieux que de faire passer un jour pour une semaine.
            const AVG_WINDOW_DAYS = 7;
            const recentDays = (state.rewardHistory || [])
                .filter(d => d && d.date && !d.partial && d.valueBtc > 0)
                .sort((a, b) => String(b.date).localeCompare(String(a.date)))
                .slice(0, AVG_WINDOW_DAYS);
            let dailyAvg = 0;
            let avgCount = recentDays.length;
            if (avgCount > 0) {
                const sum = recentDays.reduce((acc, d) =>
                    acc + d.valueBtc * (d.btcPrice || state.btcPrice || 0), 0);
                dailyAvg = sum / avgCount;
            } else if (currentDailyUsd > 0) {
                dailyAvg = currentDailyUsd;   // aucun jour mesuré : le rythme calculé
            }

            // KPIs
            document.getElementById('port-total-invested').textContent =
                capital > 0 ? formatUSD(capital) : '--';
            document.getElementById('port-cumulative').textContent = formatUSD(cumUsd);
            const cumSub = document.getElementById('port-cumulative-sub');
            if (cumSub) {
                // Dire d'où vient le chiffre : un cumul « à vie » et une estimation
                // à partir du rythme actuel ne se lisent pas de la même façon.
                const mw = state.lifetimeIncome?.minerWarsBtc;
                cumSub.textContent =
                      cumSource === 'lifetime' ? (mw > 0
                          ? t('port_cum_lifetime_mw').replace('{mw}', formatUSD(mw * state.btcPrice))
                          : t('port_cum_lifetime'))
                    : cumSource === 'perf'     ? t('port_cum_measured')
                    : cumSource === 'estimate' ? t('port_cum_estimate')
                    : '';
                cumSub.style.display = cumSub.textContent ? '' : 'none';
            }

            const pnlEl = document.getElementById('port-pnl');
            const roiEl = document.getElementById('port-roi');
            if (capital > 0) {
                pnlEl.textContent = (pnl >= 0 ? '+' : '') + formatUSD(pnl);
                pnlEl.className = 'value ' + (pnl >= 0 ? 'positive' : 'negative');
                roiEl.textContent = recovery.toFixed(0) + '%';
                roiEl.className = 'value ' + (recovery >= 100 ? 'positive' : 'negative');
            } else {
                // Mieux vaut ne rien afficher qu'un chiffre faux : sans capital
                // connu, aucun P&L n'a de sens.
                pnlEl.textContent = '--';
                pnlEl.className = 'value';
                roiEl.textContent = '--';
                roiEl.className = 'value';
            }
            const capNote = document.getElementById('port-capital-note');
            if (capNote) {
                capNote.textContent =
                      capitalSource === 'ledger'   ? t('port_capital_ledger').replace('{gmt}', Math.round(ledgerGmt).toLocaleString())
                    : capitalSource === 'fallback' ? t('port_capital_fallback')
                    : capitalSource === 'unvalued' ? t('port_capital_unvalued')
                    : capitalSource === 'none'     ? t('port_need_deposit')
                    : '';
                capNote.style.color = capitalSource === 'ledger' ? 'var(--text-dim)' : 'var(--warn, #e0a342)';
                capNote.style.display = capNote.textContent ? '' : 'none';
            }

            const cptEl = document.getElementById('port-cost-per-th');
            if (cptEl) {
                cptEl.textContent = (capital > 0 && thNow > 0)
                    ? formatUSD(capital / thNow) : '--';
            }

            document.getElementById('port-days').textContent = days + 'j';
            // Le rythme seul ne dit pas s'il est bon : $9,74 par jour est excellent
            // sur $7 800 de capital, médiocre sur $80 000. On annualise donc ce
            // rythme et on le rapporte au capital externe — le même dénominateur
            // que « Récupéré », pour que les deux se lisent ensemble.
            const avgRoiPct = (capital > 0 && dailyAvg > 0) ? (dailyAvg * 365 / capital * 100) : null;
            const avgEl = document.getElementById('port-daily-avg');
            avgEl.textContent = formatUSD(dailyAvg);
            if (avgRoiPct !== null) {
                const span = document.createElement('span');
                span.className = 'port-kpi-annot';
                span.textContent = ' (' + avgRoiPct.toFixed(0) + t('port_pct_year') + ')';
                avgEl.appendChild(span);
            }
            const avgSub = document.getElementById('port-daily-avg-sub');
            if (avgSub) {
                avgSub.textContent = avgCount > 0
                    ? t('port_avg_window').replace('{n}', avgCount)
                    : t('port_avg_calc');
                avgSub.style.display = '';
            }

            // Note: totalDailyUsd calculated below after staking calc

            // Revenus staking veGMT (valeur réelle saisie par l'utilisateur)
            const stakingGmtWeekly = parseFloat(document.getElementById('staking-gmt-weekly')?.value) || 0;
            const stakingDailyGmt = stakingGmtWeekly / 7;
            const stakingDailyUsd = stakingDailyGmt * (state.gmtPrice || 0);
            const totalDailyUsd = currentDailyUsd + stakingDailyUsd;

            // Payback — gain ACTUEL (mining + staking)
            const remaining = invested - cumUsd;
            const payEl = document.getElementById('port-payback');
            if (remaining <= 0) {
                payEl.textContent = t('port_paid_back');
                payEl.style.color = 'var(--green)';
            } else if (totalDailyUsd > 0) {
                const daysLeft = Math.ceil(remaining / totalDailyUsd);
                const years = Math.floor(daysLeft / 365);
                const daysRem = daysLeft % 365;
                payEl.textContent = years > 0 ? `${years} ${t('years')} ${t('and')} ${daysRem}${t('d_suffix')}` : `${daysLeft}${t('d_suffix')}`;
                payEl.style.color = 'var(--accent2)';
            } else {
                payEl.textContent = 'N/A';
            }

            // Valeur d'actif — déjà calculée plus haut pour le P&L, on ne la
            // recalcule pas : deux formules pour un même chiffre finissent
            // toujours par diverger.
            document.getElementById('port-asset-value').textContent = formatUSD(assetValue);
            const assetSub = document.getElementById('port-asset-sub');
            if (assetSub) {
                // Dire de quoi le total est fait, et à quel prix le TH est valorisé.
                // Un utilisateur qui voit son actif baisser doit pouvoir constater
                // que ce sont ses TH qui n'ont pas bougé et le prix qui a changé.
                const parts = [];
                if (thNow > 0) parts.push(`${thNow.toFixed(2)} TH × ${formatUSD(thCost)}`);
                const bal = (lockedGmt + liquidGmt) * gmtP + liquidBtc * (state.btcPrice || 0);
                if (bal > 0.01) parts.push(`+ ${formatUSD(bal)} ${t('port_asset_balances')}`);
                assetSub.textContent = parts.join(' ');
                assetSub.style.display = parts.length ? '' : 'none';
            }

            // veGMT : afficher ce qui était capté sans être montré.
            const stk = state.staking;
            const vf = document.getElementById('vegmt-facts');
            if (vf) {
                const hasStk = !!(stk && (stk.gmtLocked || stk.gmtRewardCumulative));
                vf.hidden = !hasStk;
                if (hasStk) {
                    const earned = stk.gmtRewardCumulative || 0;
                    document.getElementById('vegmt-earned').textContent =
                        earned > 0 ? `${earned.toFixed(2)} GMT (${formatUSD(earned * gmtP)})` : '--';
                    document.getElementById('vegmt-locked').textContent =
                        stk.gmtLocked ? `${stk.gmtLocked} GMT (${formatUSD(stk.gmtLocked * gmtP)})` : '--';
                    const dte = stk.daysToExpire || 0;
                    document.getElementById('vegmt-expires').textContent = dte > 0
                        ? (dte >= 365
                            ? `${(dte / 365).toFixed(1)} ${t('years')}`
                            : `${Math.round(dte)}${t('d_suffix')}`)
                        : '--';

                    // Rendement annuel du GMT verrouillé. Toutes les entrées
                    // étaient captées — votes, yearlyIncomePerVote, gmtLocked —
                    // et seul le gain hebdomadaire était affiché. Sans un taux,
                    // impossible de comparer « verrouiller du GMT » à « acheter
                    // du TH » ou à « baisser le W/TH » : c'est la quatrième
                    // branche de la décision, et elle était muette.
                    const yEl = document.getElementById('vegmt-yield');
                    if (yEl) {
                        const annualGmt = stk.weeklyGmtReward
                            ? stk.weeklyGmtReward * 52
                            : (stk.votes && stk.yearlyIncomePerVote ? stk.votes * stk.yearlyIncomePerVote : null);
                        const pct = (annualGmt && stk.gmtLocked > 0)
                            ? (annualGmt / stk.gmtLocked) * 100 : null;
                        yEl.textContent = pct === null
                            ? '--'
                            : `${pct.toFixed(1)}% · ${annualGmt.toFixed(1)} GMT/${t('eff_year', 'yr')} (${formatUSD(annualGmt * gmtP)})`;
                    }
                }
            }

            // Breakdown par catégorie
            //
            // Le relevé de transactions fait foi quand il est là : il connaît le
            // type de chaque mouvement (`fromType`), donc la ventilation se remplit
            // sans une seule saisie. Les lignes saisies à la main ne sont PAS
            // additionnées par-dessus — ce serait compter deux fois les mêmes achats.
            // Elles restent visibles dans la table des transactions, et reprennent
            // la main si aucun relevé n'a été capté.
            const ledgerCats = state.capital?.byCategory;
            const bdFromLedger = !!ledgerCats && Object.keys(ledgerCats).length > 0;

            // Le dépôt est de l'argent qui ENTRE, les autres catégories de l'argent
            // qui SORT. Les additionner pour en faire un dénominateur commun n'a
            // aucun sens : ça faisait peser le dépôt « 50 % » d'un total qui ne
            // représentait rien. On rapporte donc chaque dépense au total DÉPENSÉ,
            // et le dépôt à rien du tout — c'est le capital, pas une part de gâteau.
            const bdSpendTotal = bdFromLedger
                ? Object.entries(ledgerCats)
                    .filter(([cat]) => cat !== 'deposit')
                    .reduce((a, [, c]) => a + (c.gmt || 0), 0) * gmtP
                : Object.entries(totals)
                    .filter(([cat]) => cat !== 'deposit')
                    .reduce((a, [, v]) => a + (v || 0), 0);

            const bdCatMeta = getCatMeta();
            let bdHtml = '<div class="live-data" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr));">';
            Object.keys(bdCatMeta).forEach(cat => {
                const meta = bdCatMeta[cat];
                const led = bdFromLedger ? ledgerCats[cat] : null;
                const val = bdFromLedger ? (led ? led.gmt * gmtP : 0) : (totals[cat] || 0);
                const count = bdFromLedger
                    ? (led ? led.txCount : 0)
                    : txs.filter(t => t.category === cat).length;
                // Pas de pourcentage sur le dépôt : il n'est pas une part d'un
                // ensemble, c'est le capital dont tout le reste est issu.
                const pctLabel = (cat === 'deposit' || bdSpendTotal <= 0)
                    ? ''
                    : (val / bdSpendTotal * 100).toFixed(0) + '% · ';
                bdHtml += `<div class="live-card" style="text-align:center;">
                    <div style="font-size:1.5em;margin-bottom:4px;">${meta.icon}</div>
                    <div class="label">${meta.label}</div>
                    <div style="font-size:1.2em;font-weight:700;margin-top:4px;">${formatUSD(val)}</div>
                    <div style="font-size:var(--fs-note,0.75rem);color:var(--text-dim);">${pctLabel}${count} tx</div>
                </div>`;
            });
            bdHtml += '</div>';
            // Dire d'où vient la ventilation : « depuis tes transactions GoMining »
            // et « depuis tes saisies » ne s'interprètent pas pareil.
            // Diagnostic visible : dire ce que le site a réellement en mémoire.
            // Sans ça, « d'après tes saisies » ne distingue pas « aucun relevé
            // capté » de « relevé capté mais trop ancien pour être ventilé », et
            // on cherche à l'aveugle.
            const unknown = state.capital?.unknownTypes || {};
            const unknownList = Object.keys(unknown);
            const capDiag = state.capital
                ? ` (${state.capital.txCount || 0} tx${bdFromLedger ? '' : ', ' + t('port_bd_no_cats')})`
                  + (unknownList.length > 0
                      ? ` · ${t('port_bd_unknown').replace('{types}', unknownList.join(', '))}`
                      : '')
                : '';
            bdHtml += `<p style="margin:12px 0 0;font-size:0.74em;color:var(--text-dim);">${
                (bdFromLedger ? t('port_bd_ledger') : t('port_bd_manual')) + capDiag}</p>`;
            document.getElementById('port-breakdown').innerHTML = bdHtml;

            // Projection (mining + staking)
            let projHtml = '';
            if (totalDailyUsd > 0) {
                const m3 = totalDailyUsd * 90, m6 = totalDailyUsd * 180, m12 = totalDailyUsd * 365;
                projHtml = `<div class="live-data" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr));">
                    <div class="live-card"><div class="label">${t('proj_3months')}</div><div class="value positive" style="font-size:1.2em;">+${formatUSD(m3)}</div></div>
                    <div class="live-card"><div class="label">${t('proj_6months')}</div><div class="value positive" style="font-size:1.2em;">+${formatUSD(m6)}</div></div>
                    <div class="live-card"><div class="label">${t('proj_1year')}</div><div class="value positive" style="font-size:1.2em;">+${formatUSD(m12)}</div></div>
                    <div class="live-card"><div class="label">${t('proj_annualized_roi')}</div><div class="value positive" style="font-size:1.2em;">${invested > 0 ? (m12 / invested * 100).toFixed(1) : 0}%</div></div>
                </div>
                <div style="font-size:0.75em;color:var(--text-dim);margin-top:8px;">
                    Mining: ${formatUSD(currentDailyUsd)}/${t('cal_day')} (${hashrate} TH)${stakingDailyUsd > 0 ? ` + Staking: ${formatUSD(stakingDailyUsd)}/${t('cal_day')} (${stakingGmtWeekly.toFixed(2)} GMT/${t('cal_week_short')})` : ''} = <strong>${formatUSD(totalDailyUsd)}/${t('cal_day')}</strong>
                </div>`;
            }
            document.getElementById('port-projection').innerHTML = projHtml;

            // Transaction table with filters
            const filterCat = document.getElementById('tx-filter-cat')?.value || 'all';
            const filterSearch = (document.getElementById('tx-filter-search')?.value || '').toLowerCase();

            // Les mouvements du relevé GoMining rejoignent la table, en lecture
            // seule. Ils ne sont ni supprimables ni modifiables : ce sont un miroir
            // de GoMining, les effacer n'aurait aucun sens puisqu'ils reviendraient
            // à la synchro suivante. Les lignes saisies à la main restent
            // modifiables et se distinguent visuellement.
            const ledgerTxs = (state.capital?.transactions || []).map(x => ({
                date: x.date,
                category: x.category,
                amount: (x.gmt != null && gmtP) ? x.gmt * gmtP : 0,
                gmtAmount: x.gmt != null ? x.gmt : null,
                note: (x.gmt == null && x.currency)
                    ? `${x.amount.toFixed(4)} ${x.currency}` : '',
                auto: true,
                _id: x.id,
            }));
            const allTxs = [...txs, ...ledgerTxs]
                .sort((a, b) => String(b.date).localeCompare(String(a.date)));
            let filteredTxs = allTxs;
            if (filterCat !== 'all') filteredTxs = filteredTxs.filter(tx => tx.category === filterCat);
            if (filterSearch) filteredTxs = filteredTxs.filter(tx => (tx.note || '').toLowerCase().includes(filterSearch) || (tx.category || '').toLowerCase().includes(filterSearch));

            let tHtml = '';
            const catMeta = getCatMeta();
            if (allTxs.length === 0) {
                tHtml = `<div style="text-align:center;padding:32px 20px;color:var(--text-dim);">
                    <div style="font-size:2.2em;margin-bottom:10px;opacity:0.6;">📒</div>
                    <div style="margin-bottom:6px;font-weight:600;color:var(--text);">${t('tx_no_transactions')}</div>
                    <div style="font-size:0.88em;">${t('tx_no_transactions_hint') || 'Use the Add Investment form above to start tracking your portfolio.'}</div>
                </div>`;
            } else if (filteredTxs.length === 0) {
                tHtml = `<div style="text-align:center;padding:24px 20px;color:var(--text-dim);">
                    <div style="font-size:1.6em;margin-bottom:8px;opacity:0.6;">🔍</div>
                    <div>${t('tx_no_match') || 'No transactions match your filter.'}</div>
                </div>`;
            } else {
                tHtml = `<table><thead><tr><th>Date</th><th>${t('tx_category')}</th><th>${t('lbl_amount')}</th><th>TH</th><th>${t('lbl_note')}</th><th></th></tr></thead><tbody>`;
                filteredTxs.forEach(tx => {
                    const meta = catMeta[tx.category] || { icon: '?', label: tx.category };
                    tHtml += `<tr${tx.auto ? ' class="tx-auto"' : ''}>
                        <td>${tx.date}</td>
                        <td>${meta.icon} ${meta.label}${tx.auto ? ` <span class="tx-auto-badge">${t('tx_auto')}</span>` : ''}</td>
                        <td style="font-weight:700;">${formatUSD(tx.amount)}${tx.gmtAmount ? `<div style="font-size:var(--fs-note,0.75rem);color:var(--purple);">${tx.gmtAmount.toFixed(1)} GMT</div>` : ''}</td>
                        <td style="color:var(--green);font-weight:600;">${tx.th ? '+' + tx.th + ' TH' : ''}</td>
                        <td style="color:var(--text-dim);font-size:0.85em;">${tx.note || ''}</td>
                        <td>${tx.auto ? '' : `<button type="button" aria-label="Delete transaction" title="Delete transaction" style="background:transparent;border:none;cursor:pointer;color:var(--red);font-size:0.9em;padding:4px 6px;" onclick="deleteTransaction(${tx.id})">✕</button>`}</td>
                    </tr>`;
                });
                tHtml += '</tbody></table>';
                // Distinguer les deux origines dans le compte : sinon on ne sait
                // plus ce qui vient de GoMining et ce qu'on a saisi soi-même.
                const nAuto = allTxs.filter(x => x.auto).length;
                const nManual = allTxs.length - nAuto;
                tHtml += `<div style="font-size:0.75em;color:var(--text-dim);margin-top:6px;">${
                    filteredTxs.length} / ${allTxs.length} ${t('tx_count_label')}${
                    nAuto > 0 ? ` · ${nAuto} ${t('tx_from_gomining')}${nManual > 0 ? `, ${nManual} ${t('tx_manual')}` : ''}` : ''}</div>`;
            }
            document.getElementById('port-transactions').innerHTML = tHtml;
        }

        // ===== GUIDE DE SCAN =====
        //
        // Les chemins sont ceux réellement observés dans les captures
        // (`dom.page`). Ceux qu'on n'a jamais vus ne sont PAS liés : envoyer
        // quelqu'un sur une URL devinée est pire que de ne pas l'envoyer.
        const SCAN_TARGETS = [
            { key: 'miners',       path: '/nft-miners',
              name: 'scan_p_miners',  unlocks: 'scan_u_miners' },
            { key: 'rewards',      path: '/nft-rewards/solo',
              name: 'scan_p_rewards', unlocks: 'scan_u_rewards' },
            { key: 'transactions', path: '/finance/wallets/virtual/overview/transactions',
              name: 'scan_p_tx',      unlocks: 'scan_u_tx' },
            // Chemin observé : /lock/ve-my-lock/VIRTUAL_GMT/view/<uuid de la position>.
            // Non liable : l'UUID est propre à chaque utilisateur. On nomme donc le
            // chemin de navigation, ce qui suffit à s'y rendre.
            { key: 'staking',      path: null,
              name: 'scan_p_lock',    unlocks: 'scan_u_lock' },
            { key: 'homePage',     path: '/',
              name: 'scan_p_home',    unlocks: 'scan_u_home' },
        ];

        // Ce que le SITE possède réellement, indépendamment de ce que l'extension
        // a encore en cache.
        //
        // `coverage` seul mesurait la mauvaise chose : l'extension purge à 24 h,
        // alors que le site persiste l'historique de récompenses, le capital et le
        // staking. Un utilisateur voyait donc « Rewards non capté » alors que son
        // calendrier était rempli — la liste contredisait l'écran d'à côté.
        //
        // Une automatisation est débloquée dès que le site peut l'afficher. On fait
        // donc l'UNION des deux, et un élément coché ne se décoche jamais parce
        // qu'un cache a expiré.
        function siteCoverage() {
            const cap = state.capital || {};
            return {
                miners:       (parseFloat(document.getElementById('hashrate')?.value) || 0) > 0,
                rewards:      (state.rewardHistory || []).length > 0,
                transactions: (cap.transactions || []).length > 0 || !!cap.gmtEquivalent,
                wallet:       (parseFloat(document.getElementById('gmt-prepaid')?.value) || 0) > 0
                              || (state.btcWalletBalance || 0) > 0,
                staking:      !!(state.staking && (state.staking.gmtLocked || state.staking.votes)),
                bonusMiner:   !!state.bonusMinerPower,
                homePage:     !!(state.apiGmtPrice || state.apiBtcPrice),
                discount:     (parseFloat(document.getElementById('discount')?.value) || 0) > 0,
            };
        }

        function renderScanChecklist() {
            const list = document.getElementById('scan-list');
            if (!list) return;
            const ext = state.coverage || {};
            const own = siteCoverage();
            const cov = {};
            for (const k of new Set([...Object.keys(ext), ...Object.keys(own)])) {
                cov[k] = ext[k] === true || own[k] === true;
            }
            const hasAny = Object.values(cov).some(Boolean) || Object.keys(ext).length > 0;
            list.textContent = '';

            for (const target of SCAN_TARGETS) {
                const done = cov[target.key] === true;
                const li = document.createElement('li');
                li.className = 'scan-item' + (done ? ' done' : '') + (hasAny ? '' : ' unknown');

                const mark = document.createElement('span');
                mark.className = 'scan-mark';
                // Sans extension connectée on ne prétend pas savoir : un rond vide
                // ne veut pas dire « pas fait », il veut dire « on ne sait pas ».
                mark.textContent = !hasAny ? '·' : (done ? '✓' : '○');
                li.appendChild(mark);

                const body = document.createElement('div');
                const title = target.path
                    ? Object.assign(document.createElement('a'), {
                        href: 'https://app.gomining.com' + target.path,
                        target: '_blank', rel: 'noopener',
                        className: 'scan-page', textContent: t(target.name) })
                    : Object.assign(document.createElement('span'),
                        { className: 'scan-page', textContent: t(target.name) });
                body.appendChild(title);
                const sub = document.createElement('div');
                sub.className = 'scan-unlocks';
                sub.textContent = t(target.unlocks);
                body.appendChild(sub);
                li.appendChild(body);
                list.appendChild(li);
            }

            const note = document.createElement('li');
            note.className = 'scan-note';
            note.textContent = hasAny ? t('scan_note_live') : t('scan_note_none');
            list.appendChild(note);
        }

// ===== INIT =====
        loadFeeMode();
        loadSettings();
        loadDashCache(); // After loadSettings so API prices override saved values
        calcTotalDiscount();
        setLang(currentLang);
        showOnboarding();
        showRedesignWelcome();
        // Apply persisted gainPeriod (active button state) on boot
        if (typeof setGainPeriod === 'function' && gainPeriod) setGainPeriod(gainPeriod);

        // ===== WEEKLY BACKUP REMINDER =====
        // Once every 7 days, nudge users to export their portfolio data so
        // a browser cache wipe doesn't lose history. Only fires if the user
        // has at least 5 transactions worth protecting.
        try {
            const REMIND_KEY = 'gms_last_export_reminder';
            const last = parseInt(localStorage.getItem(REMIND_KEY) || '0');
            const week = 7 * 24 * 3600 * 1000;
            const txCount = JSON.parse(localStorage.getItem(TX_KEY) || '[]').length;
            if (txCount >= 5 && Date.now() - last > week) {
                setTimeout(() => {
                    if (typeof toast !== 'function') return;
                    const c = document.getElementById('toast-container') || (() => {
                        const d = document.createElement('div');
                        d.id = 'toast-container'; d.className = 'toast-container';
                        document.body.appendChild(d); return d;
                    })();
                    const el = document.createElement('div');
                    el.className = 'toast toast--info';
                    el.innerHTML = `
                        <span class="toast-icon">↓</span>
                        <span class="toast-msg">Time to back up your portfolio (${txCount} transactions)</span>
                        <button class="toast-undo" type="button">Export</button>
                        <button class="toast-close" aria-label="Dismiss">×</button>
                    `;
                    const dismiss = () => { el.classList.add('toast--leave'); setTimeout(() => el.remove(), 220); };
                    el.querySelector('.toast-close').addEventListener('click', dismiss);
                    el.querySelector('.toast-undo').addEventListener('click', () => {
                        exportAllData();
                        dismiss();
                    });
                    c.appendChild(el);
                    localStorage.setItem(REMIND_KEY, String(Date.now()));
                    setTimeout(dismiss, 12_000);
                }, 5000); // Wait 5s after page load so it's not jarring
            }
        } catch(_) {}

        // Apply URL hash → switch to the matching tab on page load
        try {
            const hash = (location.hash || '').replace('#', '');
            const VALID_TABS = ['dashboard', 'mining', 'scenarios', 'strategy', 'efficiency', 'portfolio'];
            if (VALID_TABS.includes(hash)) switchTab(hash);
        } catch(_) {}
        // Browser back/forward → switch tabs accordingly
        window.addEventListener('hashchange', () => {
            const h = (location.hash || '').replace('#', '');
            if (h && document.getElementById('tab-' + h)) switchTab(h);
        });

        // ===== PRINT — set today's date as data attr so the print stylesheet
        //          can include it in the page header
        window.addEventListener('beforeprint', () => {
            const today = new Date().toLocaleDateString();
            document.querySelectorAll('.main-content, .mw-main').forEach(el => {
                el.setAttribute('data-print-date', today);
            });
        });

        // ===== CLICK-TO-COPY =====
        // Double-click any element with the .copyable class to copy its text.
        document.addEventListener('dblclick', (e) => {
            const el = e.target.closest('.copyable');
            if (!el) return;
            const txt = (el.textContent || '').trim();
            if (!txt || txt === '—' || txt === '--') return;
            (navigator.clipboard?.writeText
                ? navigator.clipboard.writeText(txt)
                : Promise.reject()
            ).then(
                () => typeof toast === 'function' && toast('Copied: ' + txt, 'success', 1800),
                () => {}
            );
        });

        // ===== GLOBAL ERROR HANDLER =====
        // Quietly logs runtime errors and surfaces a generic toast so users
        // know something went wrong (rather than the page silently breaking).
        // Throttled to one toast per minute to avoid spam loops.
        let _lastErrorToast = 0;
        window.addEventListener('error', (e) => {
            if (Date.now() - _lastErrorToast < 60_000) return;
            _lastErrorToast = Date.now();
            console.error('[GMSim] Runtime error:', e.error || e.message, e.filename, e.lineno);
            if (typeof toast === 'function') {
                toast('Something went wrong. The page might still work — please refresh if it doesn\'t.', 'error', 5000);
            }
        });
        window.addEventListener('unhandledrejection', (e) => {
            if (Date.now() - _lastErrorToast < 60_000) return;
            _lastErrorToast = Date.now();
            console.error('[GMSim] Unhandled promise rejection:', e.reason);
            // Promise rejections are often network failures (price fetch, etc.)
            // — don't toast these, they're noisy.
        });

        // ===== TOAST NOTIFICATIONS =====
        // Usage: toast('Message', 'success'|'error'|'info', durationMs)
        window.toast = function (msg, type = 'info', duration = 3500) {
            let container = document.getElementById('toast-container');
            if (!container) {
                container = document.createElement('div');
                container.id = 'toast-container';
                container.className = 'toast-container';
                document.body.appendChild(container);
            }
            const icons = { success: '✓', error: '!', info: 'i' };
            const el = document.createElement('div');
            el.className = 'toast toast--' + type;
            el.innerHTML = `
                <span class="toast-icon">${icons[type] || icons.info}</span>
                <span class="toast-msg"></span>
                <button class="toast-close" aria-label="Dismiss">×</button>
            `;
            el.querySelector('.toast-msg').textContent = msg;
            const dismiss = () => {
                el.classList.add('toast--leave');
                setTimeout(() => el.remove(), 220);
            };
            el.querySelector('.toast-close').addEventListener('click', dismiss);
            container.appendChild(el);
            if (duration > 0) setTimeout(dismiss, duration);
        };

        // ===== KEYBOARD SHORTCUTS =====
        // 1 → Dashboard · 2 → Scenarios · 3 → Strategy Lab · 4 → Portfolio
        // ? → help · Esc → close any open modal
        // Ignored when the user is typing in an input/textarea/contenteditable.
        document.addEventListener('keydown', (e) => {
            if (e.metaKey || e.ctrlKey || e.altKey) return;
            const tag = (e.target.tagName || '').toUpperCase();
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable) return;

            const map = { '1': 'dashboard', '2': 'scenarios', '3': 'strategy', '4': 'portfolio' };
            if (map[e.key]) {
                e.preventDefault();
                if (typeof switchTab === 'function') switchTab(map[e.key]);
            } else if (e.key === '?') {
                e.preventDefault();
                const el = document.getElementById('kbd-help');
                if (el) el.style.display = el.style.display === 'flex' ? 'none' : 'flex';
            } else if (e.key === 'Escape') {
                ['onboarding', 'redesign-welcome', 'extension-guide', 'manual-entry-modal', 'kbd-help'].forEach(id => {
                    const el = document.getElementById(id);
                    if (el && getComputedStyle(el).display !== 'none') el.style.display = 'none';
                });
            }
        });
        fetchLiveData();
        initStrategyLab();
        initTabKeyboard();
        if (typeof initEfficiencyCalc === 'function') initEfficiencyCalc();

        // Service worker. L'ancien code désinscrivait tout, séquelle d'un
        // mauvais cache : la PWA était installable et sans hors-ligne.
        // sw.js sert le HTML depuis le réseau en priorité — le cache n'entre
        // en jeu que hors-ligne — donc le mauvais cache ne peut pas revenir.
        if ('serviceWorker' in navigator) {
            window.addEventListener('load', () => {
                navigator.serviceWorker.register('sw.js').then(reg => {
                    // Une nouvelle version prend effet au prochain chargement,
                    // jamais en cours de session : remplacer les scripts sous
                    // les pieds d'un calcul en train de tourner ne se voit pas
                    // venir et ne se reproduit pas.
                    reg.addEventListener('updatefound', () => {
                        const w = reg.installing;
                        if (w) w.addEventListener('statechange', () => {
                            if (w.state === 'installed' && navigator.serviceWorker.controller) {
                                console.info('[GMSim] update ready — will apply on next load');
                            }
                        });
                    });
                }).catch(e => console.warn('[GMSim] SW registration failed:', e && e.message));
            });
        }

        // Init transaction date to today
        document.getElementById('tx-date').value = new Date().toISOString().substring(0, 10);

        // Load persisted reward history before first sync
        state.rewardHistory = loadRewardHistory();
        state.capital = loadCapital();   // survit à la purge 24 h de l'extension
        try { state.lifetimeIncome = JSON.parse(localStorage.getItem('gms_lifetime_income')) || null; } catch (e) {}
        try { state.coverage = JSON.parse(localStorage.getItem('gms_coverage')) || null; } catch (e) {}
        try { state.staking = JSON.parse(localStorage.getItem('gms_staking')) || null; } catch (e) {}
        try { state.upgradeRateUsd = JSON.parse(localStorage.getItem('gms_upgrade_rate')) || 0; } catch (e) {}
        if (state.rewardHistory.length > 0) {
            document.getElementById('dash-history-section').style.display = 'block';
            showDashboardCalendar(state.rewardHistory);
            // Recompute PR from yesterday's complete day to override any stale
            // dashboard cache value (would otherwise persist a partial-day PR
            // until the next extension sync).
            const lastComplete = getLastCompleteRewardDay(state.rewardHistory);
            if (lastComplete && lastComplete.poolReward && lastComplete.power) {
                const fresh = Math.round(lastComplete.poolReward / lastComplete.power * 1e8);
                state.satPerTH = fresh;
                state.apiSatPerTH = fresh;
                const satEl = document.getElementById('sat-per-th');
                if (satEl) satEl.value = fresh;
                const netHashEl = document.getElementById('net-hashrate');
                if (netHashEl) netHashEl.textContent = fresh + ' PR';
            }
        }

        // Check for auto-sync data
        checkAutoSync();
        setInterval(checkAutoSync, 15000);

        // Rafraîchissement auto toutes les 5 minutes
        setInterval(fetchLiveData, 60 * 1000);

        // Save dashboard cache periodically
        setInterval(saveDashCache, 60000);

        // Investment tracker auto-update
    