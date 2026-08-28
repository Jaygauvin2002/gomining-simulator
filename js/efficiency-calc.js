// =============================================================
//  efficiency-calc.js — Energy Efficiency Calculator tab
// =============================================================
//
//  Answers the question GoMining's own upgrade screen does not:
//  an efficiency upgrade shows its benefit every single day and its
//  cost exactly once, so intuition never puts the two side by side.
//  Dropping a 696 TH farm from 15 to 12 W/TH saves $2.33/day — and
//  costs $5,582. That is 6.6 years, and nobody works that out by hand.
//
//  The output is deliberately an ANNUAL RETURN, not a pass/fail
//  verdict: 15 %/yr is not "bad", it is simply worse than the 407 %/yr
//  the first band pays. Where a return on hashrate is known, the two
//  are compared directly — spend the next dollar on watts or on TH?
//
//  Loaded as a regular <script> from index.html. Depends on globals
//  from the inline app script:
//    - state          (global state object)
//    - t(key, fb)     (translation lookup)
//    - formatUSD(n)   (USD formatter)
//
//  initEfficiencyCalc() is called once at boot. Handlers stay global
//  because the markup wires them with inline onclick.
// =============================================================

// Prix d'upgrade GoMining, en USD par TH et par palier de 1 W/TH,
// indexés par le W/TH de DÉPART. Relevés sur l'écran « Energy
// efficiency prices » le 2026-08-28. Fixes en USD : ils ne bougent
// que quand GoMining reprice, pas avec le GMT.
//
// À remplacer par la valeur servie par l'API dès qu'on l'aura captée —
// une table codée en dur est exactement l'erreur qu'on vient de
// corriger sur le prix du TH, figé à 12,34 $ pendant des mois.
const EFF_BANDS = [
    { minFrom: 36, maxFrom: 50, usdPerTh: 0.10 },
    { minFrom: 29, maxFrom: 35, usdPerTh: 0.50 },
    { minFrom: 21, maxFrom: 28, usdPerTh: 1.00 },
    { minFrom: 16, maxFrom: 20, usdPerTh: 1.10 },
    { minFrom: 13, maxFrom: 15, usdPerTh: 2.67 },
];

// 12 W/TH est le plancher réel : la table n'a aucune ligne 12→11.
const EFF_FLOOR = 12;
const EFF_CEIL  = 50;
const HOURS_PER_DAY = 24;
const DAYS_PER_YEAR = 365;

// ---------------------------------------------------------------
//  Math — pure, no DOM. Mirrored by extension/tests/efficiency-calc.test.mjs
// ---------------------------------------------------------------

// Prix d'un seul palier partant de `fromWth`. null hors table.
function effStepPrice(fromWth) {
    const w = Math.round(Number(fromWth));
    if (!isFinite(w)) return null;
    for (const b of EFF_BANDS) {
        if (w >= b.minFrom && w <= b.maxFrom) return b.usdPerTh;
    }
    return null;
}

// Coût cumulé en USD par TH pour descendre de `fromWth` à `toWth`.
// Retourne null si la course sort de la table (garantit qu'on ne
// facture jamais un palier dont on ne connaît pas le prix).
function effCostPerTh(fromWth, toWth) {
    const from = Math.round(Number(fromWth));
    const to   = Math.round(Number(toWth));
    if (!isFinite(from) || !isFinite(to)) return null;
    if (to >= from) return 0;                       // pas d'upgrade
    if (to < EFF_FLOOR || from > EFF_CEIL) return null;
    let total = 0;
    for (let w = from; w > to; w--) {
        const p = effStepPrice(w);
        if (p === null) return null;
        total += p;
    }
    return total;
}

// Coût quotidien d'électricité d'une ferme, remise appliquée.
function effDailyElecCost(th, wth, elecRateKwh, discountPct) {
    const mult = 1 - (Number(discountPct) || 0) / 100;
    return (Number(th) || 0) * (Number(wth) || 0) * HOURS_PER_DAY / 1000
           * (Number(elecRateKwh) || 0) * mult;
}

// Le calcul complet d'un upgrade. Tout est dérivé, rien n'est supposé.
//
// `netPerThFn` est optionnel : une fonction W/TH → profit net USD par TH et par
// jour. Fournie, elle remplace le simple écart d'électricité par le vrai gain
// sous protection de déficit — GoMining évalue une fois par jour au moment du
// paiement et ferme la ferme si elle est négative, tous frais arrêtés. Le
// résultat d'une journée est donc max(0, net), et l'upgrade d'une ferme en
// pause ne réduit pas une facture : il restaure un revenu entier.
//
// Ce n'est pas une branche parallèle mais une généralisation : quand les deux
// états sont rentables, net = PR − C1(w) − C2, donc net(cible) − net(actuel)
// vaut exactement C1(actuel) − C1(cible), soit l'écart d'électricité. Même
// réponse dans le cas normal, bonne réponse dans le cas en pause.
function effEvaluate({ th, fromWth, toWth, elecRateKwh, discountPct, netPerThFn }) {
    const costPerTh = effCostPerTh(fromWth, toWth);
    if (costPerTh === null) return null;

    const thNum       = Number(th) || 0;
    const totalCost   = costPerTh * thNum;
    const dailyBefore = effDailyElecCost(th, fromWth, elecRateKwh, discountPct);
    const dailyAfter  = effDailyElecCost(th, toWth,   elecRateKwh, discountPct);

    let dailySaving = dailyBefore - dailyAfter;
    let paused = false;
    if (typeof netPerThFn === 'function') {
        const nFrom = netPerThFn(Math.round(Number(fromWth)));
        const nTo   = netPerThFn(Math.round(Number(toWth)));
        if (isFinite(nFrom) && isFinite(nTo)) {
            dailySaving = (Math.max(0, nTo) - Math.max(0, nFrom)) * thNum;
            paused = nFrom <= 0;
        }
    }
    const yearSaving  = dailySaving * DAYS_PER_YEAR;

    // La remise réduit l'économie SANS réduire le prix de l'upgrade
    // (confirmé : le montant facturé est exactement prix × TH). Elle
    // allonge donc le retour, contre-intuitivement.
    return {
        costPerTh, totalCost, dailyBefore, dailyAfter, dailySaving, yearSaving,
        // true = la ferme est en pause au W/TH de départ, donc l'écart
        // d'électricité affiché ne s'applique qu'après le redémarrage.
        paused,
        // Le retour ne dépend pas de la taille de la ferme : coût et
        // économie montent tous deux par TH. On ne peut pas « essayer petit ».
        paybackYears: dailySaving > 0 ? totalCost / yearSaving : null,
        annualReturnPct: costPerTh > 0 ? (yearSaving / totalCost) * 100 : null,
        wattsSaved: Math.round(fromWth) - Math.round(toWth),
    };
}

// Les paliers traversés en descendant, un segment par bande de prix.
// C'est la vue « où s'arrêter » : on descend tant que le rendement
// marginal du segment reste bon, on s'arrête quand il tombe.
function effLadder({ th, fromWth, elecRateKwh, discountPct, netPerThFn, floor = EFF_FLOOR }) {
    const start = Math.round(Number(fromWth));
    if (!isFinite(start) || start <= floor) return [];
    const rows = [];
    let w = Math.min(start, EFF_CEIL);
    let guard = 0;
    while (w > floor && guard++ < 64) {
        const price = effStepPrice(w);
        if (price === null) break;
        // Descendre tant que le prix du palier ne change pas.
        let end = w;
        while (end > floor && effStepPrice(end) === price) end--;
        const seg = effEvaluate({ th, fromWth: w, toWth: end, elecRateKwh, discountPct, netPerThFn });
        if (!seg) break;
        rows.push({ fromWth: w, toWth: end, stepPrice: price, steps: w - end, ...seg });
        w = end;
    }
    return rows;
}

// ---------------------------------------------------------------
//  UI
// ---------------------------------------------------------------

let effInputsTouched = { th: false, from: false, elec: false, disc: false };

function effReadNum(id, fallback) {
    const el = document.getElementById(id);
    const v = el ? parseFloat(el.value) : NaN;
    return isFinite(v) ? v : fallback;
}

// Les entrées viennent du dashboard — donc de l'extension — sauf si
// l'utilisateur les a modifiées ici pour explorer un scénario.
function effSyncFromFarm() {
    const set = (id, val, touchedKey) => {
        const el = document.getElementById(id);
        if (!el || effInputsTouched[touchedKey]) return;
        if (val !== null && val !== undefined && isFinite(val)) el.value = val;
    };
    set('eff-th',   effReadNum('hashrate', null),  'th');
    set('eff-elec', effReadNum('elec-cost', null), 'elec');
    set('eff-disc', effReadNum('discount', null),  'disc');

    const farmWth = effReadNum('efficiency', null);
    if (farmWth !== null && !effInputsTouched.from) {
        const el = document.getElementById('eff-from');
        if (el) el.value = Math.round(farmWth);
        // Cible par défaut : le plancher. Proposer « un cran plus bas » donnait
        // un point de départ arbitraire (15→14, 1 861 $ pour 1 W/TH) ; montrer
        // la course complète pose la vraie question, et l'échelle dit où
        // s'arrêter en dessous.
        const tgt = document.getElementById('eff-to');
        if (tgt && !isFinite(parseFloat(tgt.value))) tgt.value = EFF_FLOOR;
    }
}

function effVerdict(annualReturnPct, hashrateReturnPct) {
    // Pas de seuil inventé : on compare au rendement de l'alternative
    // réelle — acheter du hashrate — quand on le connaît.
    if (annualReturnPct === null) return { cls: 'eff-v-none', label: '—' };
    if (hashrateReturnPct !== null && isFinite(hashrateReturnPct)) {
        if (annualReturnPct >= hashrateReturnPct * 2)
            return { cls: 'eff-v-great', label: t('eff_v_great', 'far better than buying TH') };
        if (annualReturnPct >= hashrateReturnPct)
            return { cls: 'eff-v-good',  label: t('eff_v_good', 'better than buying TH') };
        // 0,85 et non 0,6 : à 0,6, un rendement inférieur d'un tiers passait
        // pour « équivalent ». « À peu près pareil » doit vouloir dire à 15 % près.
        if (annualReturnPct >= hashrateReturnPct * 0.85)
            return { cls: 'eff-v-close', label: t('eff_v_close', 'about the same as buying TH') };
        return { cls: 'eff-v-poor', label: t('eff_v_poor', 'worse than buying TH') };
    }
    if (annualReturnPct >= 100) return { cls: 'eff-v-great', label: t('eff_v_fast',  'pays back fast') };
    if (annualReturnPct >= 40)  return { cls: 'eff-v-good',  label: t('eff_v_solid', 'solid return') };
    if (annualReturnPct >= 20)  return { cls: 'eff-v-close', label: t('eff_v_slow',  'slow return') };
    return { cls: 'eff-v-poor', label: t('eff_v_verylow', 'very low return') };
}

// Les entrées nécessaires pour appeler calcDailyReward, ou null si l'app
// n'est pas chargée. Partagé par le rendement du hashrate et le seuil de
// rentabilité — deux questions, une seule lecture.
function effFarmInputs() {
    if (typeof calcDailyReward !== 'function' || typeof state === 'undefined') return null;
    const wth  = effReadNum('efficiency', null);
    const elec = effReadNum('elec-cost', null);
    const disc = effReadNum('discount', 0);
    let satPerTH = effReadNum('sat-per-th', null);
    if (!satPerTH || !isFinite(satPerTH)) satPerTH = state.satPerTH;
    if (!wth || !elec || !satPerTH || !state.btcPrice) return null;
    return { wth, elec, disc, satPerTH, btcPrice: state.btcPrice };
}

// Le W/TH le moins efficace auquel la ferme tourne encore en positif.
//
// GoMining applique une protection de déficit : une ferme qui minerait à
// perte est mise en pause et repart quand elle redevient rentable. Donc au-delà
// de ce seuil la ferme ne perd pas d'argent — elle ne gagne RIEN, et parler
// d'« économie d'électricité » n'a plus de sens puisqu'elle n'en consomme pas.
// La vraie question devient : quel W/TH faut-il atteindre pour qu'elle reparte.
//
// Balayage entier de 12 à 50 : 39 appels, imperceptible, et robuste même si
// la formule cesse d'être monotone (halving, changement de barème).
function effBreakevenWth() {
    const f = effFarmInputs();
    if (!f) return null;
    let best = null;
    for (let w = EFF_FLOOR; w <= EFF_CEIL; w++) {
        const r = calcDailyReward(1, w, f.elec, f.disc, f.btcPrice, f.satPerTH);
        if (r && isFinite(r.netUsd) && r.netUsd > 0) best = w;
    }
    return best;   // null = déficitaire même à 12 W/TH : le problème est ailleurs
}

// Profit net USD par TH et par jour, à un W/TH donné. Retourne null si l'app
// n'est pas chargée — auquel cas le calculateur retombe sur l'écart
// d'électricité, qui reste juste tant que la ferme tourne.
function effNetPerThFn() {
    const f = effFarmInputs();
    if (!f) return null;
    return function (w) {
        const r = calcDailyReward(1, w, f.elec, f.disc, f.btcPrice, f.satPerTH);
        return (r && isFinite(r.netUsd)) ? r.netUsd : NaN;
    };
}

// → { pct, status } avec status 'ok' | 'unprofitable' | 'unknown'.
// Rendement annuel d'un dollar mis en hashrate plutôt qu'en watts. C'est la
// seule comparaison honnête : les deux dépenses sortent de la même poche.
//
// Dérivé du profit net réel d'UN TH via calcDailyReward, avec le PR et le prix
// du TH de l'utilisateur. Rien n'est inventé : sans PR connu ni prix du TH on
// renvoie null et l'écran dit pourquoi plutôt que d'afficher un chiffre faux.
//
// On prend netUsd, donc AVANT la commission de conversion en GMT — le cas du
// joueur qui encaisse en BTC. Ça surestime légèrement le rendement du hashrate,
// donc ça rend la recommandation d'upgrade prudente au lieu de flatteuse.
function effHashrateReturn() {
    const f = effFarmInputs();
    if (!f) return { pct: null, status: 'unknown' };

    const one = calcDailyReward(1, f.wth, f.elec, f.disc, f.btcPrice, f.satPerTH);
    if (!one || !isFinite(one.netUsd)) return { pct: null, status: 'unknown' };

    // Distinguer « on ne sait pas » de « ça perd de l'argent ». À 45 W/TH le
    // coût électrique dépasse la récompense : un TH de plus est déficitaire.
    // Renvoyer null dans ce cas faisait dire à l'écran « données non chargées »
    // alors qu'elles l'étaient — et c'est exactement chez ces utilisateurs, ceux
    // qui ont le plus besoin de baisser leur W/TH, que le message mentait.
    if (one.netUsd <= 0) return { pct: null, status: 'unprofitable' };

    const thPrice = (typeof upgradeRate === 'function') ? upgradeRate() : null;
    if (!thPrice || !isFinite(thPrice) || thPrice <= 0)
        return { pct: null, status: 'unknown' };
    return { pct: (one.netUsd * DAYS_PER_YEAR / thPrice) * 100, status: 'ok' };
}

function effFmtYears(y) {
    if (y === null || !isFinite(y)) return '—';
    if (y < 1) return Math.round(y * DAYS_PER_YEAR) + ' ' + t('eff_days', 'days');
    return y.toFixed(1) + ' ' + t('eff_years', 'yr');
}

function updateEfficiencyCalc() {
    effSyncFromFarm();

    const th     = effReadNum('eff-th', 0);
    const from   = Math.round(effReadNum('eff-from', 15));
    const to     = Math.round(effReadNum('eff-to', 12));
    const elec   = effReadNum('eff-elec', 0.05);
    const disc   = effReadNum('eff-disc', 0);
    const hr     = effHashrateReturn();
    const hrRet  = hr.pct;

    const netPerThFn = effNetPerThFn();
    const out = document.getElementById('eff-result');
    const r = effEvaluate({ th, fromWth: from, toWth: to, elecRateKwh: elec, discountPct: disc, netPerThFn });

    if (out) {
        if (!r || r.wattsSaved <= 0) {
            out.innerHTML = `<p class="eff-empty">${
                t('eff_pick_lower', 'Pick a target below your current efficiency to see what it costs and what it pays back.')
            }</p>`;
        } else {
            const v = effVerdict(r.annualReturnPct, hrRet);
            out.innerHTML = `
              <div class="eff-headline">
                <span class="eff-headline-from">${from} W/TH</span>
                <span class="eff-headline-arrow">→</span>
                <span class="eff-headline-to">${to} W/TH</span>
                <span class="eff-headline-note">${r.wattsSaved} W/TH ${t('eff_saved', 'saved')}</span>
              </div>
              <div class="eff-kpis">
                <div class="eff-kpi">
                  <span class="eff-kpi-label">${t('eff_k_cost', 'Upgrade cost')}</span>
                  <span class="eff-kpi-value">${formatUSD(r.totalCost)}</span>
                  <span class="eff-kpi-sub">${th.toLocaleString()} TH × ${formatUSD(r.costPerTh)}/TH</span>
                </div>
                <div class="eff-kpi">
                  <span class="eff-kpi-label">${r.paused
                      ? t('eff_k_restored', 'Income restored')
                      : t('eff_k_saving', 'Electricity saved')}</span>
                  <span class="eff-kpi-value eff-pos">${formatUSD(r.dailySaving)}<span class="eff-kpi-unit">/${t('eff_day', 'day')}</span></span>
                  <span class="eff-kpi-sub">${r.paused
                      ? t('eff_k_restored_sub', 'farm currently paused — earns nothing today')
                      : formatUSD(r.dailyBefore) + ' → ' + formatUSD(r.dailyAfter)} · ${formatUSD(r.yearSaving)}/${t('eff_year', 'yr')}</span>
                </div>
                <div class="eff-kpi">
                  <span class="eff-kpi-label">${t('eff_k_payback', 'Payback')}</span>
                  <span class="eff-kpi-value">${effFmtYears(r.paybackYears)}</span>
                  <span class="eff-kpi-sub">${t('eff_k_payback_sub', 'independent of farm size')}</span>
                </div>
                <div class="eff-kpi">
                  <span class="eff-kpi-label">${t('eff_k_return', 'Annual return')}</span>
                  <span class="eff-kpi-value">${r.annualReturnPct === null ? '—' : r.annualReturnPct.toFixed(0) + '%'}</span>
                  <span class="eff-kpi-sub ${v.cls}">${v.label}</span>
                </div>
              </div>`;
        }
    }

    // Comparaison honnête : le dollar suivant, en watts ou en TH ?
    const cmp = document.getElementById('eff-compare');
    if (cmp) {
        if (hr.status === 'ok') {
            cmp.innerHTML = `${t('eff_cmp_label', 'For comparison, a dollar spent on more hashrate returns')}
               <strong>${hr.pct.toFixed(0)}%</strong> ${t('eff_cmp_per_year', 'per year')}.`;
        } else if (hr.status === 'unprofitable') {
            // Pas « tu perds de l'argent » : GoMining met la ferme en pause,
            // donc elle ne gagne rien. Et si elle est en pause, elle ne
            // consomme pas — l'économie d'électricité affichée plus haut ne
            // s'applique qu'une fois la ferme repartie. Le dire, ne pas le taire.
            const be = effBreakevenWth();
            const th = effReadNum('eff-th', 0);
            const cur = Math.round(effReadNum('eff-from', 0));
            const cost = (be !== null && cur > be) ? effCostPerTh(cur, be) : null;
            const reach = (be === null)
                ? t('eff_cmp_paused_nofix', 'It does not turn profitable at any efficiency down to 12 W/TH — check your electricity rate and Pool Reward before spending anything.')
                : cost === null
                    ? ''
                    : `${t('eff_cmp_paused_reach', 'It needs to reach')} <strong>${be} W/TH</strong>${t('eff_cmp_paused_costs', ' to run again, which costs ')}<strong>${formatUSD(cost * th)}</strong>.`;
            cmp.innerHTML = `<span class="eff-v-poor">${t('eff_cmp_paused',
                 'GoMining pauses a farm that would mine at a loss and restarts it when it turns profitable again. At this efficiency the farm earns nothing rather than losing money — so the electricity saving above only applies once it is running.')}</span> ${reach}`;
        } else {
            cmp.innerHTML = `<span class="eff-compare-missing">${t('eff_cmp_missing',
                 'Buying-hashrate return is unknown until your farm data is loaded — scan your GoMining pages to compare the two.')}</span>`;
        }
    }

    // L'échelle : où s'arrêter.
    const ladderBody = document.getElementById('eff-ladder-body');
    if (ladderBody) {
        const rows = effLadder({ th, fromWth: from, elecRateKwh: elec, discountPct: disc, netPerThFn });
        if (!rows.length) {
            ladderBody.innerHTML = `<tr><td colspan="5" class="eff-empty">${
                t('eff_at_floor', 'You are at 12 W/TH — the floor. There is nothing left to upgrade.')
            }</td></tr>`;
        } else {
            let cumCost = 0, cumSaving = 0;
            ladderBody.innerHTML = rows.map(row => {
                cumCost   += row.totalCost;
                cumSaving += row.dailySaving;
                const v = effVerdict(row.annualReturnPct, hrRet);
                const isTarget = row.toWth >= to;
                return `<tr class="${isTarget ? 'eff-row-in' : 'eff-row-out'}">
                  <td class="eff-td-step"><b>${row.fromWth} → ${row.toWth}</b>
                      <span class="eff-td-sub">${row.steps} × ${formatUSD(row.stepPrice)}/TH</span></td>
                  <td>${formatUSD(row.totalCost)}<span class="eff-td-sub">${formatUSD(cumCost)} ${t('eff_cum', 'cumulative')}</span></td>
                  <td class="eff-pos">${formatUSD(row.dailySaving)}<span class="eff-td-sub">${formatUSD(cumSaving)} ${t('eff_cum', 'cumulative')}</span></td>
                  <td>${effFmtYears(row.paybackYears)}</td>
                  <td class="eff-td-ret"><b>${row.annualReturnPct.toFixed(0)}%</b>
                      <span class="eff-td-sub ${v.cls}">${v.label}</span></td>
                </tr>`;
            }).join('');
        }
    }
}

function effOnInput(which) {
    effInputsTouched[which] = true;
    updateEfficiencyCalc();
}

// Cliquer une ligne de l'échelle fixe la cible : la table devient
// l'outil de décision au lieu d'un simple tableau de référence.
function effSetTarget(wth) {
    const el = document.getElementById('eff-to');
    if (!el) return;
    el.value = wth;
    updateEfficiencyCalc();
}

function effResetToFarm() {
    effInputsTouched = { th: false, from: false, elec: false, disc: false };
    const tgt = document.getElementById('eff-to');
    if (tgt) tgt.value = '';
    effSyncFromFarm();
    const el = document.getElementById('eff-to');
    if (el && !el.value) el.value = EFF_FLOOR;
    updateEfficiencyCalc();
}

function initEfficiencyCalc() {
    ['eff-th', 'eff-from', 'eff-to', 'eff-elec', 'eff-disc'].forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        const key = id === 'eff-th' ? 'th' : id === 'eff-from' ? 'from'
                  : id === 'eff-elec' ? 'elec' : id === 'eff-disc' ? 'disc' : null;
        el.addEventListener('input', () => { if (key) effInputsTouched[key] = true; updateEfficiencyCalc(); });
    });
    const ladder = document.getElementById('eff-ladder-body');
    if (ladder) {
        ladder.addEventListener('click', e => {
            const tr = e.target.closest('tr');
            if (!tr) return;
            const m = tr.querySelector('.eff-td-step b')?.textContent?.match(/→\s*(\d+)/);
            if (m) effSetTarget(Number(m[1]));
        });
    }
    updateEfficiencyCalc();
}
