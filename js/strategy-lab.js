// =============================================================
//  strategy-lab.js — Strategy Lab tab logic
// =============================================================
//
//  Day-by-day reinvestment plan over 7/14/30 days (daily mode) or
//  month-by-month projection over 1-6 months (monthly mode).
//  Each "slot" picks: 'btc' (collect), 'gmt' (reinvest GMT), or
//  'th' (buy more TH — compounds power for the next day).
//
//  Loaded as a regular <script> from index.html so the function
//  declarations remain global. Depends on these globals defined
//  by the inline app script in index.html:
//    - state               (global state object)
//    - t(key)              (translation lookup)
//    - formatUSD(n)        (USD formatter)
//    - calcDailyReward(...)         (math)
//    - getLastCompleteRewardDay(...) (yesterday's complete entry)
//
//  initStrategyLab() is called once at page boot from the inline
//  script. Functions named cycleStrategyDay/cycleStrategyMonthSlot/
//  smartFillStrategy stay global because they're invoked from
//  inline onclick handlers in the markup.
// =============================================================

let strategyDays = [];      // array of 'btc' | 'gmt' | 'th' (daily mode)
let strategyPeriod = 7;
// Monthly mode state — Darun-inspired pattern editor.
// Each editable month has 4 weekly slots; the pattern repeats over 6 months.
let strategyMode = 'daily';        // 'daily' | 'monthly'
let strategyMonthlyEditCount = 1;  // 1..6 editable months
let strategyMonthly = [['btc', 'btc', 'th', 'th']];  // [month][weekSlot]
const STRATEGY_TH_BONUS = 0.05;
const STRATEGY_MONTHLY_TOTAL = 6;  // 6-month projection
const STRATEGY_SLOTS_PER_MONTH = 4; // 4 weeks per month

function initStrategyLab() {
    // Mode selector
    document.querySelectorAll('#strategy-mode-selector .period-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            strategyMode = btn.dataset.mode;
            document.querySelectorAll('#strategy-mode-selector .period-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            // Toggle period vs months selector visibility + label
            const dailySel = document.getElementById('strategy-period-selector');
            const monthlySel = document.getElementById('strategy-monthly-selector');
            const label = document.getElementById('strategy-period-label');
            const stepTitle = document.getElementById('strategy-step2-title');
            const stepSub   = document.getElementById('strategy-step2-sub');
            if (strategyMode === 'monthly') {
                dailySel.style.display = 'none';
                monthlySel.style.display = 'flex';
                if (label) label.textContent = t('strategy_monthly_label') || 'Editable months — fewer than 6 = pattern repeats to fill the projection';
                if (stepTitle) stepTitle.textContent = t('strategy_step2_title_weekly') || 'Tune week-by-week';
                if (stepSub)   stepSub.textContent   = t('strategy_step2_sub_weekly')   || 'Click any cell to cycle through BTC / GMT / TH for that week.';
            } else {
                dailySel.style.display = 'flex';
                monthlySel.style.display = 'none';
                if (label) label.textContent = t('strategy_period') || 'Period';
                if (stepTitle) stepTitle.textContent = t('strategy_step2_title') || 'Tune day-by-day';
                if (stepSub)   stepSub.textContent   = t('strategy_step2_sub')   || 'Click any cell to cycle through BTC / GMT / TH for that day.';
            }
            rebuildStrategyGrid();
        });
    });
    // Daily period selector
    document.querySelectorAll('#strategy-period-selector .period-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const p = parseInt(btn.dataset.period);
            strategyPeriod = p;
            document.querySelectorAll('#strategy-period-selector .period-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            rebuildStrategyGrid();
        });
    });
    // Monthly editable-count selector
    document.querySelectorAll('#strategy-monthly-selector .period-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const m = parseInt(btn.dataset.months);
            strategyMonthlyEditCount = m;
            // Resize strategyMonthly: keep existing months, default new ones to defaultMonth()
            while (strategyMonthly.length < m) strategyMonthly.push(['btc', 'btc', 'th', 'th']);
            strategyMonthly = strategyMonthly.slice(0, m);
            document.querySelectorAll('#strategy-monthly-selector .period-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            rebuildStrategyGrid();
        });
    });
    // Quick fill — only buttons with data-fill (excludes smart-fill buttons that use onclick="smartFillStrategy(...)")
    document.querySelectorAll('.quick-fill-btn[data-fill]').forEach(btn => {
        btn.addEventListener('click', () => fillStrategyAll(btn.dataset.fill));
    });
    // Run button
    document.getElementById('strategy-run-btn').addEventListener('click', runStrategySimulation);
    rebuildStrategyGrid();
    updateStrategyPriceHints();
}

function rebuildStrategyGrid() {
    const grid = document.getElementById('strategy-day-grid');
    const labelMap = { btc: 'BTC', gmt: 'GMT', th: 'TH' };
    const valid = ['btc', 'gmt', 'th'];

    if (strategyMode === 'monthly') {
        // Monthly grid: render exactly strategyMonthlyEditCount months.
        // Each row = one month with 4 weekly slots, all editable.
        // Projection length matches the user's selection (no repeating pattern).
        let html = '';
        for (let m = 0; m < strategyMonthlyEditCount; m++) {
            if (!strategyMonthly[m]) strategyMonthly[m] = ['btc', 'btc', 'th', 'th'];
            const monthArr = strategyMonthly[m];
            for (let s = 0; s < STRATEGY_SLOTS_PER_MONTH; s++) {
                if (!valid.includes(monthArr[s])) monthArr[s] = 'btc';
            }
            const rowLabel = `${t('strategy_month_label') || 'MONTH'} ${m + 1}`;
            html += `<div style="display:grid;grid-template-columns:80px repeat(4,1fr);gap:6px;align-items:stretch;">`;
            html += `<div style="display:flex;align-items:center;justify-content:flex-start;font-size:0.75em;font-weight:700;color:var(--text-dim);letter-spacing:0.5px;text-transform:uppercase;">${rowLabel}</div>`;
            for (let s = 0; s < STRATEGY_SLOTS_PER_MONTH; s++) {
                const strat = monthArr[s];
                const lbl = labelMap[strat] || 'BTC';
                html += `<div class="day-cell" data-strat="${strat}" onclick="cycleStrategyMonthSlot(${m},${s})">
                    <div class="day-num">W${s + 1}</div>
                    <div class="day-strat">${lbl}</div>
                </div>`;
            }
            html += `</div>`;
        }
        grid.innerHTML = html;
        return;
    }

    // Daily mode (original): per-day picker, weekly rows
    while (strategyDays.length < strategyPeriod) strategyDays.push('btc');
    for (let i = 0; i < strategyDays.length; i++) {
        if (!valid.includes(strategyDays[i])) strategyDays[i] = 'btc';
    }
    strategyDays = strategyDays.slice(0, strategyPeriod);

    const weekLabel = t('strategy_week') || 'Week';
    let html = '';
    for (let weekStart = 0; weekStart < strategyPeriod; weekStart += 7) {
        const weekNum = Math.floor(weekStart / 7) + 1;
        html += `<div style="display:grid;grid-template-columns:60px repeat(7,1fr);gap:6px;align-items:stretch;">`;
        html += `<div style="display:flex;align-items:center;justify-content:flex-start;font-size:0.75em;font-weight:700;color:var(--text-dim);letter-spacing:0.5px;text-transform:uppercase;">${weekLabel} ${weekNum}</div>`;
        for (let col = 0; col < 7; col++) {
            const i = weekStart + col;
            if (i >= strategyPeriod) {
                html += `<div></div>`;
            } else {
                const strat = strategyDays[i] || 'btc';
                const label = labelMap[strat] || 'BTC';
                html += `<div class="day-cell" data-strat="${strat}" data-day="${i}" onclick="cycleStrategyDay(${i})">
                    <div class="day-num">D${i + 1}</div>
                    <div class="day-strat">${label}</div>
                </div>`;
            }
        }
        html += `</div>`;
    }
    grid.innerHTML = html;
}

function cycleStrategyDay(i) {
    const order = ['btc', 'gmt', 'th'];
    const idx = order.indexOf(strategyDays[i]);
    strategyDays[i] = order[(idx + 1) % 3];
    rebuildStrategyGrid();
}

function cycleStrategyMonthSlot(monthIdx, slotIdx) {
    const order = ['btc', 'gmt', 'th'];
    const cur = strategyMonthly[monthIdx][slotIdx];
    strategyMonthly[monthIdx][slotIdx] = order[(order.indexOf(cur) + 1) % 3];
    rebuildStrategyGrid();
}

function fillStrategyAll(strat) {
    if (strategyMode === 'monthly') {
        strategyMonthly = strategyMonthly.map(() => Array(STRATEGY_SLOTS_PER_MONTH).fill(strat));
    } else {
        for (let i = 0; i < strategyPeriod; i++) strategyDays[i] = strat;
    }
    rebuildStrategyGrid();
}

// Auto-fill X days of GMT mining first (to build up GMT for fees), then switch to target.
// Computes minimum X such that GMT earned in X days ≥ fees for all N days.
// Math: X * grossGmt ≥ N * feesGmt  →  X = ceil(N * feesGmt / grossGmt)
function smartFillStrategy(target, source = 'gmt') {
    const cfg = getStrategyBaseConfig();
    const outEl = document.getElementById('strategy-smart-output');

    if (!cfg.hashrate || !cfg.satPerTH || !state.btcPrice || !state.gmtPrice) {
        outEl.textContent = t('alert_calc_first') || 'Please calculate first in the Simulator tab.';
        outEl.style.color = 'var(--red)';
        return;
    }

    // Use override prices if set
    const btcOverride = parseFloat(document.getElementById('strategy-btc-override').value);
    const gmtOverride = parseFloat(document.getElementById('strategy-gmt-override').value);
    const btcPrice = !isNaN(btcOverride) && btcOverride > 0 ? btcOverride : state.btcPrice;
    const gmtPrice = !isNaN(gmtOverride) && gmtOverride > 0 ? gmtOverride : state.gmtPrice;

    const savedGmt = state.gmtPrice;
    state.gmtPrice = gmtPrice;
    const r = calcDailyReward(cfg.hashrate, cfg.efficiency, cfg.elecCost, cfg.discount, btcPrice, cfg.satPerTH);
    state.gmtPrice = savedGmt;

    // Source-aware: cover fees with whichever currency is being mined first
    const grossSource = source === 'btc' ? r?.grossBtc : r?.grossGmt;
    const feesSource  = source === 'btc' ? r?.feesBtc  : r?.feesGmt;

    if (!r || !grossSource || grossSource <= 0 || !feesSource || feesSource <= 0) {
        outEl.textContent = t('strategy_smart_impossible');
        outEl.style.color = 'var(--red)';
        return;
    }

    // Source mining is unprofitable if grossSource ≤ feesSource
    if (grossSource <= feesSource) {
        outEl.textContent = t('strategy_smart_impossible');
        outEl.style.color = 'var(--red)';
        return;
    }

    // Smart-fill works at the day level for both modes.
    // Daily mode: N = strategyPeriod (7/14/30 days)
    // Monthly mode: N = editCount × 4 × 7 days. X is rounded UP to the
    // next 7-day boundary so it lines up with the weekly slot grid.
    let N, X;
    if (strategyMode === 'monthly') {
        N = strategyMonthlyEditCount * STRATEGY_SLOTS_PER_MONTH * 7;
        const xDays = Math.ceil((N * feesSource) / grossSource);
        X = Math.ceil(xDays / 7) * 7;
    } else {
        N = strategyPeriod;
        X = Math.ceil((N * feesSource) / grossSource);
    }

    if (X >= N) {
        outEl.innerHTML = `<span style="color:var(--accent);">${t('strategy_smart_impossible')}</span> (${t('strategy_period_short') || 'period too short'}: ${N} ${t('days')}, ${X} ${t('days')} ${t('strategy_needed') || 'needed'})`;
        fillStrategyAll(source);
        rebuildStrategyGrid();
        return;
    }

    // Apply: in daily mode write to strategyDays directly.
    // In monthly mode, convert the day cutoff to weekly slots and update
    // strategyMonthly. We only modify EDITABLE months (others repeat).
    if (strategyMode === 'monthly') {
        const xSlots = X / 7; // weekly slots filled with source
        let placed = 0;
        for (let m = 0; m < strategyMonthlyEditCount; m++) {
            if (!strategyMonthly[m]) strategyMonthly[m] = ['btc', 'btc', 'th', 'th'];
            for (let s = 0; s < STRATEGY_SLOTS_PER_MONTH; s++) {
                strategyMonthly[m][s] = (placed < xSlots) ? source : target;
                placed++;
            }
        }
    } else {
        for (let i = 0; i < N; i++) {
            strategyDays[i] = i < X ? source : target;
        }
    }
    rebuildStrategyGrid();

    const Y = N - X;
    const targetLabel = target.toUpperCase();
    const sourceLabel = source.toUpperCase();
    outEl.innerHTML = `
        <span class="strat-smart-check">✓</span>
        <span class="strat-smart-step">
            <strong>${X}</strong> ${X === 1 ? 'day' : 'days'} mining
            <span class="strat-smart-pill strat-smart-pill--${source}">${sourceLabel}</span>
            to cover fees
        </span>
        <span class="strat-smart-arrow">→</span>
        <span class="strat-smart-step">
            then <strong>${Y}</strong> ${Y === 1 ? 'day' : 'days'} on
            <span class="strat-smart-pill strat-smart-pill--${target}">${targetLabel}</span>
        </span>
    `;
    outEl.style.color = '';
}

function updateStrategyPriceHints() {
    const btcInput = document.getElementById('strategy-btc-override');
    const gmtInput = document.getElementById('strategy-gmt-override');
    const costInput = document.getElementById('strategy-cost-per-th');
    const btcEl = document.getElementById('strategy-btc-current');
    const gmtEl = document.getElementById('strategy-gmt-current');
    const costEl = document.getElementById('strategy-cost-current');

    // Auto-fill BTC price (only if user hasn't manually edited)
    if (btcInput && state.btcPrice && !btcInput.dataset.userEdited) {
        btcInput.value = Math.round(state.btcPrice);
    }
    if (gmtInput && state.gmtPrice && !gmtInput.dataset.userEdited) {
        gmtInput.value = state.gmtPrice.toFixed(4);
    }
    // Cost per TH: $12.34 is the confirmed GoMining upgrade rate.
    // Sync field detection is unreliable (returns wrong values), so we keep the hardcoded default.

    // Hints showing the auto-filled value
    if (btcEl && state.btcPrice) btcEl.textContent = `${t('strategy_auto')}: $${Math.round(state.btcPrice).toLocaleString()}`;
    if (gmtEl && state.gmtPrice) gmtEl.textContent = `${t('strategy_auto')}: $${state.gmtPrice.toFixed(4)}`;
    if (costEl) costEl.textContent = t('strategy_cost_per_th_hint');
}

function getStrategyBaseConfig() {
    // Prefer the LAST COMPLETE DAY (yesterday) from rewardHistory — matches the
    // Validation table source-of-truth and avoids the partial-day-PR distortion.
    const latest = getLastCompleteRewardDay(state.rewardHistory);

    if (latest && latest.power && latest.poolReward && latest.totalDiscount !== undefined) {
        // Strategy: use form's hashrate (TOTAL power across all NFTs from /nft/get-my)
        // and latest's per-TH ratio (poolReward / latest.power) — this works correctly
        // regardless of how many NFTs the user has, because the per-TH rate is the same.
        const formHashrate = parseFloat(document.getElementById('hashrate').value) || latest.power;
        // Use form's discount (already adjusted for fee mode via calcTotalDiscount)
        const formDiscount = parseFloat(document.getElementById('discount').value) || 0;
        return {
            hashrate: formHashrate,
            efficiency: 15, // GoMining standard for level-up miners
            elecCost: 0.05,  // GoMining standard rate
            discount: formDiscount,
            satPerTH: Math.round(latest.poolReward / latest.power * 1e8),
            source: 'rewardHistory',
            sourceDate: latest.date
        };
    }

    // Fallback: form values
    const hashrate = parseFloat(document.getElementById('hashrate').value);
    const efficiency = parseFloat(document.getElementById('efficiency').value);
    const elecCost = parseFloat(document.getElementById('elec-cost').value);
    const discount = parseFloat(document.getElementById('discount').value) || 0;
    const satPerTH = parseFloat(document.getElementById('sat-per-th').value);
    return { hashrate, efficiency, elecCost, discount, satPerTH, source: 'form' };
}

// Build the per-day strategy sequence based on the active mode.
// Daily mode: strategyDays as-is (length = strategyPeriod, 7/14/30).
// Monthly mode: expand strategyMonthly to a sequence of length
// editCount × 4 × 7 days. Each weekly slot expands to 7 days.
function buildStrategyDaySequence() {
    if (strategyMode === 'monthly') {
        const seq = [];
        for (let m = 0; m < strategyMonthlyEditCount; m++) {
            const monthArr = strategyMonthly[m] || ['btc', 'btc', 'th', 'th'];
            for (let w = 0; w < STRATEGY_SLOTS_PER_MONTH; w++) {
                const strat = monthArr[w];
                for (let d = 0; d < 7; d++) seq.push(strat);
            }
        }
        return seq;
    }
    return strategyDays.slice(0, strategyPeriod);
}

function runStrategySimulation() {
    const cfg = getStrategyBaseConfig();
    if (!cfg.hashrate || !cfg.satPerTH) {
        alert(t('alert_calc_first') || 'Please calculate first in the Simulator tab');
        return;
    }
    const btcOverride = parseFloat(document.getElementById('strategy-btc-override').value);
    const gmtOverride = parseFloat(document.getElementById('strategy-gmt-override').value);
    const costPerTH = parseFloat(document.getElementById('strategy-cost-per-th').value) || 12;
    // Market TH price: used only for paper-value display of TH-asset gain.
    // Volatile, changes minute-to-minute. Falls back to reinvest cost when blank.
    const marketTHRaw = parseFloat(document.getElementById('strategy-market-th-price')?.value);
    const marketTHPrice = !isNaN(marketTHRaw) && marketTHRaw > 0 ? marketTHRaw : costPerTH;
    const btcPrice = !isNaN(btcOverride) && btcOverride > 0 ? btcOverride : state.btcPrice;
    const gmtPrice = !isNaN(gmtOverride) && gmtOverride > 0 ? gmtOverride : state.gmtPrice;

    if (!btcPrice || !gmtPrice) {
        alert('Missing prices — sync data first or set overrides.');
        return;
    }

    // Save and temporarily override gmtPrice for calcDailyReward (which reads state.gmtPrice)
    const savedGmtPrice = state.gmtPrice;
    state.gmtPrice = gmtPrice;

    // Use the global fee mode toggle from the dashboard:
    // toggle = GMT → cfg.discount includes the token discount (full)
    // toggle = BTC → cfg.discount excludes the token discount (calcTotalDiscount handles this)
    const simDiscount = cfg.discount;

    // Simulation loop — per-day with compounding
    // Day sequence comes from buildStrategyDaySequence() which handles
    // both daily and monthly mode (monthly = 168-day expanded pattern).
    const daySeq = buildStrategyDaySequence();
    const totalDays = daySeq.length;
    let power = cfg.hashrate;
    let totalBtc = 0, totalGmt = 0, totalThGained = 0, totalFeesGmt = 0, totalFeesUsd = 0;
    const dayLog = [];

    for (let i = 0; i < totalDays; i++) {
        const strat = daySeq[i];
        const dayR = calcDailyReward(power, cfg.efficiency, cfg.elecCost, simDiscount, btcPrice, cfg.satPerTH);
        if (!dayR) break;

        let dayBtc = 0, dayGmt = 0, dayTh = 0;
        const dayFeesGmt = dayR.feesGmt;
        const dayFeesUsd = dayFeesGmt * gmtPrice;

        // Display GROSS earnings per mode (fees are tracked separately and subtracted once at the end)
        if (strat === 'btc') {
            dayBtc = dayR.grossBtc;
        } else if (strat === 'gmt') {
            dayGmt = dayR.grossGmt;
        } else if (strat === 'th') {
            // gross USD value of the day's reward, +5% bonus, divided by cost per TH
            dayTh = (dayR.grossUsd * (1 + STRATEGY_TH_BONUS)) / costPerTH;
            power += dayTh; // compound for next day
        }

        totalBtc += dayBtc;
        totalGmt += dayGmt;
        totalThGained += dayTh;
        totalFeesGmt += dayFeesGmt;
        totalFeesUsd += dayFeesUsd;

        dayLog.push({ day: i + 1, strat, power, btc: dayBtc, gmt: dayGmt, th: dayTh, feesGmt: dayFeesGmt });
    }

    // Restore state.gmtPrice
    state.gmtPrice = savedGmtPrice;

    // Build per-day chart samples + grouped aggregate rows from the dayLog.
    // Daily mode aggregates per 7-day week; monthly mode per 28-day month.
    const _feeMode = state.feeMode || 'gmt';
    const samples = [];
    const weekRows = [];
    const groupSize = strategyMode === 'monthly' ? 28 : 7;
    const groupLabel = strategyMode === 'monthly' ? (t('strategy_month_label') || 'Month') : (t('strategy_week') || 'Week');
    // For monthly mode, plan-actions get summarized to 4 weekly slots per month
    // (otherwise the cell would show 28 BTC/GMT/TH tokens).
    const planSlotSize = strategyMode === 'monthly' ? 7 : 1;
    let cumBtc = 0, cumGmt = 0, cumFeesGmt = 0;
    let weekAgg = null;
    for (let i = 0; i < dayLog.length; i++) {
        const d = dayLog[i];
        cumBtc += d.btc;
        cumGmt += d.gmt;
        cumFeesGmt += d.feesGmt;
        const cumFeesBtc = _feeMode === 'btc' ? (cumFeesGmt * gmtPrice / btcPrice) : 0;
        const netBtcAtDay = cumBtc - cumFeesBtc;
        const netGmtAtDay = _feeMode === 'gmt' ? (cumGmt - cumFeesGmt) : cumGmt;
        const portfolio = netBtcAtDay * btcPrice + netGmtAtDay * gmtPrice + d.power * marketTHPrice;
        samples.push({ day: d.day, th: d.power, btcUsd: netBtcAtDay * btcPrice, gmtUsd: netGmtAtDay * gmtPrice, portfolio });

        // Aggregate per period
        if (i % groupSize === 0) {
            if (weekAgg) weekRows.push(weekAgg);
            weekAgg = { label: `${groupLabel} ${Math.floor(i / groupSize) + 1}`, actions: [], grossUsd: 0, feesUsd: 0, thAdded: 0, btcAdded: 0, gmtAdded: 0, endTh: 0, endPortfolio: 0 };
        }
        const dayGrossUsd = d.btc * btcPrice + d.gmt * gmtPrice + d.th * marketTHPrice;
        // Plan column: in monthly mode show one token per weekly slot (4 per month)
        if ((i % groupSize) % planSlotSize === 0) {
            weekAgg.actions.push(d.strat.toUpperCase());
        }
        weekAgg.grossUsd += dayGrossUsd;
        weekAgg.feesUsd += d.feesGmt * gmtPrice;
        weekAgg.thAdded += d.th;
        weekAgg.btcAdded += d.btc;
        weekAgg.gmtAdded += d.gmt;
        weekAgg.endTh = d.power;
        weekAgg.endPortfolio = portfolio;
    }
    if (weekAgg) weekRows.push(weekAgg);

    // Compute final USD value
    // TH gained is an ASSET (funded by the BTC reward of TH-days), not realized cash.
    // Cash profit = liquid earnings (BTC + GMT) − fees. TH is shown separately as a hashrate gain.
    const totalBtcUsd = totalBtc * btcPrice;
    const totalGmtUsd = totalGmt * gmtPrice;
    // Paper value of TH asset uses MARKET price (what you'd realize on resale).
    // Cost basis (reinvest cost) is what produced the TH; market price is what it's worth now.
    const totalThUsd = totalThGained * marketTHPrice;
    const netCashUsd = totalBtcUsd + totalGmtUsd - totalFeesUsd;

    // Per-currency net (deduct fees from whichever currency the user pays them in).
    // Allow negative values: if you mine all-GMT in BTC fee mode, BTC net goes
    // negative (fees deducted with no BTC earned), and vice versa for GMT.
    const feeMode = state.feeMode || 'gmt';
    const totalFeesBtc = feeMode === 'btc' ? totalFeesUsd / btcPrice : 0;
    const netBtc = totalBtc - totalFeesBtc;
    const netGmt = feeMode === 'gmt' ? totalGmt - totalFeesGmt : totalGmt;
    const netBtcUsd = netBtc * btcPrice;
    const netGmtUsd = netGmt * gmtPrice;

    renderStrategyResults({
        period: totalDays,
        periodLabel: strategyMode === 'monthly'
            ? `${strategyMonthlyEditCount} ${strategyMonthlyEditCount === 1 ? (t('strategy_month_singular') || 'month') : (t('strategy_months') || 'months')} · ${strategyMonthlyEditCount * STRATEGY_SLOTS_PER_MONTH} ${t('strategy_weekly_slots') || 'weekly slots'}`
            : `${strategyPeriod} ${t('days') || 'days'}`,
        mode: strategyMode,
        totalBtc, totalGmt, totalThGained, totalFeesGmt, totalFeesBtc,
        netBtc, netGmt, netBtcUsd, netGmtUsd,
        totalBtcUsd, totalGmtUsd, totalThUsd, totalFeesUsd, netCashUsd,
        feeMode,
        finalPower: power, startPower: cfg.hashrate,
        btcPrice, gmtPrice, costPerTH, marketTHPrice,
        hashrate: cfg.hashrate, efficiency: cfg.efficiency, elecCost: cfg.elecCost,
        discount: cfg.discount, satPerTH: cfg.satPerTH,
        source: cfg.source, sourceDate: cfg.sourceDate,
        dayLog, samples, weekRows
    });
}

function renderStrategyResults(r) {
    const el = document.getElementById('strategy-results');
    const t_ = (k, fb) => t(k) || fb;

    let html = `<div class="section" style="background:var(--bg2);">
        <h3 style="margin:0 0 14px 0;color:var(--a-strategy);">📊 ${t_('strategy_results_label', 'Results')} — ${r.periodLabel || (r.period + ' ' + t_('days', 'days'))}</h3>
        <!-- Row 1: GROSS earnings + fees -->
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-bottom:10px;">
            <div class="strategy-result-card">
                <div class="res-label" data-i18n="strategy_gross_btc">BTC Gross</div>
                <div class="res-value" style="color:var(--accent);">+${r.totalBtc.toFixed(8)}</div>
                <div style="font-size:0.8em;color:var(--text-dim);">≈ ${formatUSD(r.totalBtcUsd)}</div>
            </div>
            <div class="strategy-result-card">
                <div class="res-label" data-i18n="strategy_gross_gmt">GMT Gross</div>
                <div class="res-value" style="color:var(--purple);">+${r.totalGmt.toFixed(2)}</div>
                <div style="font-size:0.8em;color:var(--text-dim);">≈ ${formatUSD(r.totalGmtUsd)}</div>
            </div>
            <div class="strategy-result-card">
                <div class="res-label" data-i18n="strategy_total_th">TH Gained</div>
                <div class="res-value" style="color:var(--green);">+${r.totalThGained.toFixed(2)}</div>
                <div style="font-size:0.8em;color:var(--text-dim);">${r.startPower.toFixed(2)} → ${r.finalPower.toFixed(2)} TH</div>
            </div>
            <div class="strategy-result-card">
                <div class="res-label" data-i18n="strategy_total_fees">Fees Paid</div>
                <div class="res-value" style="color:var(--red);">${r.feeMode === 'btc'
                    ? (r.totalFeesUsd / r.btcPrice).toFixed(8) + ' BTC'
                    : r.totalFeesGmt.toFixed(2) + ' GMT'}</div>
                <div style="font-size:0.8em;color:var(--text-dim);">≈ ${formatUSD(r.totalFeesUsd)}</div>
            </div>
        </div>

        <!-- Row 2: NET totals (after fees) -->
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-bottom:16px;">
            <div class="strategy-result-card" style="border:1px solid var(--border);">
                <div class="res-label" data-i18n="strategy_total_btc_net">Total BTC (net)</div>
                <div class="res-value" style="color:${r.netBtc < 0 ? 'var(--red)' : 'var(--accent)'};">${r.netBtc >= 0 ? '+' : ''}${r.netBtc.toFixed(8)}</div>
                <div style="font-size:0.8em;color:${r.netBtcUsd < 0 ? 'var(--red)' : 'var(--text-dim)'};">≈ ${formatUSD(r.netBtcUsd)}</div>
            </div>
            <div class="strategy-result-card" style="border:1px solid var(--border);">
                <div class="res-label" data-i18n="strategy_total_gmt_net">Total GMT (net)</div>
                <div class="res-value" style="color:${r.netGmt < 0 ? 'var(--red)' : 'var(--purple)'};">${r.netGmt >= 0 ? '+' : ''}${r.netGmt.toFixed(2)}</div>
                <div style="font-size:0.8em;color:${r.netGmtUsd < 0 ? 'var(--red)' : 'var(--text-dim)'};">≈ ${formatUSD(r.netGmtUsd)}</div>
            </div>
            <div class="strategy-result-card" style="border:1px solid var(--border);">
                <div class="res-label" data-i18n="strategy_total_th_net">Total TH (net)</div>
                <div class="res-value" style="color:var(--green);">+${r.totalThGained.toFixed(2)}</div>
                <div style="font-size:0.8em;color:var(--text-dim);">${t('strategy_no_th_fees') || 'no fees on TH'}</div>
            </div>
        </div>
        <div style="border-top:1px solid var(--border);padding-top:14px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:10px;">
            <div>
                <div style="font-size:0.85em;color:var(--text-dim);" data-i18n="strategy_net_cash">Net cash profit (BTC + GMT − fees)</div>
                <div style="font-size:1.6em;font-weight:700;color:${r.netCashUsd >= 0 ? 'var(--green)' : 'var(--red)'};">${formatUSD(r.netCashUsd)}</div>
            </div>
            <div style="text-align:right;">
                <div style="font-size:0.85em;color:var(--text-dim);" data-i18n="strategy_th_gained_label">+ Hashrate gained</div>
                <div style="font-size:1.6em;font-weight:700;color:var(--green);">+${r.totalThGained.toFixed(2)} TH</div>
                <div style="font-size:0.8em;color:var(--text-dim);">${t('strategy_th_paper_value') || 'asset, paper value'} ≈ ${formatUSD(r.totalThUsd)} <span style="opacity:0.75;">(@ $${r.marketTHPrice.toFixed(2)}/TH ${r.marketTHPrice === r.costPerTH ? (t('strategy_th_fallback') || 'fallback to reinvest cost') : (t('strategy_th_market') || 'market')})</span></div>
            </div>
        </div>
        <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border);font-size:0.8em;color:var(--text-dim);line-height:1.7;">
            <div><strong>${t('strategy_inputs_used') || 'Inputs used'}:</strong> ${r.hashrate} TH | ${r.satPerTH} sat/TH | ${(r.discount).toFixed(2)}% discount (Fee mode: ${state.feeMode.toUpperCase()}) | ${r.efficiency} W/TH | $${r.elecCost}/kWh</div>
            <div><span data-i18n="strategy_used_prices">Prices used</span>: BTC $${Math.round(r.btcPrice).toLocaleString()} | GMT $${r.gmtPrice.toFixed(4)} | TH reinvest $${r.costPerTH.toFixed(2)}${r.marketTHPrice !== r.costPerTH ? ` | TH market $${r.marketTHPrice.toFixed(2)}` : ''}</div>
            <div style="margin-top:6px;color:${r.source === 'rewardHistory' ? 'var(--green)' : 'var(--accent)'};font-style:italic;">
                ${r.source === 'rewardHistory'
                    ? `✓ ${t('strategy_source_real') || 'Using real GoMining data from'} ${r.sourceDate} ${t('strategy_source_match') || '— matches the Validation table.'}`
                    : (t('strategy_verify_inputs') || "⚠ Using form values. Update them in the Simulator tab if numbers don't match.")}
            </div>
        </div>
        ${renderStrategyChartAndTable(r)}
    </div>`;
    el.innerHTML = html;
    el.style.display = 'block';
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// Chart + table block — adapted from Darun's reinvestment.html draft.
// Chart: 4 series (hashrate, BTC USD, GMT USD, total portfolio).
// Table: aggregates per 7-day period; if total period <= 7 days the table
// collapses to a single row, which is fine.
function renderStrategyChartAndTable(r) {
    if (!r.samples || r.samples.length < 2) return '';
    const formatGmt = n => (n < 0 ? '-' : '+') + Math.abs(n).toFixed(1);
    const formatBtc = n => (n < 0 ? '-' : '+') + Math.abs(n).toFixed(6);
    // Fees column follows the global Fee Mode toggle (BTC vs GMT)
    const formatFeesByMode = (feesUsd) => {
        if (r.feeMode === 'btc') {
            const feesBtc = feesUsd / r.btcPrice;
            return '-' + feesBtc.toFixed(8) + ' BTC';
        }
        const feesGmt = feesUsd / r.gmtPrice;
        return '-' + feesGmt.toFixed(2) + ' GMT';
    };
    // CSS-driven tooltip (instant) for USD equivalents of coin-denominated cells.
    // Uses the existing .has-tooltip class — wraps the cell text in a span
    // so the ::after pseudo shows immediately on hover.
    const tipTh  = th  => `≈ ${formatUSD(th * r.marketTHPrice)}`;
    const tipBtc = btc => `≈ ${formatUSD(btc * r.btcPrice)}`;
    const tipGmt = gmt => `≈ ${formatUSD(gmt * r.gmtPrice)}`;
    const wrap = (text, tipText) => `<span class="has-tooltip" data-tooltip="${tipText}" style="border-bottom:none;">${text}</span>`;
    const rowsHtml = r.weekRows.map(row => {
        // Net per period = gross USD − fees USD. Goes negative when fees
        // exceed earnings (e.g. all-TH mode where gross is reinvested).
        const netUsd = row.grossUsd - row.feesUsd;
        const netColor = netUsd >= 0 ? 'var(--green)' : 'var(--red)';
        const netStr = (netUsd < 0 ? '-' : '') + formatUSD(Math.abs(netUsd)).replace('$', '$');
        return `
        <tr style="border-top:1px solid var(--border);">
            <td style="padding:10px 8px;"><strong>${row.label}</strong></td>
            <td style="padding:10px 8px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:0.85em;color:var(--text-dim);">${row.actions.join(' → ')}</td>
            <td style="padding:10px 8px;text-align:right;">${formatUSD(row.grossUsd)}</td>
            <td style="padding:10px 8px;text-align:right;color:var(--red);">${wrap(formatFeesByMode(row.feesUsd), '≈ ' + formatUSD(row.feesUsd))}</td>
            <td style="padding:10px 8px;text-align:right;color:${netColor};font-weight:600;">${netStr}</td>
            <td style="padding:10px 8px;text-align:right;color:var(--green);">${row.thAdded > 0 ? wrap('+' + row.thAdded.toFixed(2), tipTh(row.thAdded)) : '—'}</td>
            <td style="padding:10px 8px;text-align:right;color:var(--accent);">${row.btcAdded > 0 ? wrap(formatBtc(row.btcAdded), tipBtc(row.btcAdded)) : '—'}</td>
            <td style="padding:10px 8px;text-align:right;color:var(--purple);">${row.gmtAdded > 0 ? wrap(formatGmt(row.gmtAdded), tipGmt(row.gmtAdded)) : '—'}</td>
            <td style="padding:10px 8px;text-align:right;">${wrap(row.endTh.toFixed(2), tipTh(row.endTh))}</td>
            <td style="padding:10px 8px;text-align:right;">${formatUSD(row.endPortfolio)}</td>
        </tr>`;
    }).join('');

    return `
        <div style="margin-top:18px;padding-top:14px;border-top:1px solid var(--border);">
            <h3 style="margin:0 0 8px;font-size:1em;color:var(--a-strategy);">📋 <span data-i18n="strategy_period_by_period">Period-by-period</span></h3>
            <div style="overflow-x:auto;">
                <table style="width:100%;border-collapse:collapse;font-size:0.85em;">
                    <thead>
                        <tr style="color:var(--text-dim);font-size:0.8em;text-transform:uppercase;letter-spacing:0.5px;">
                            <th style="padding:8px;text-align:left;" data-i18n="strategy_col_period">Period</th>
                            <th style="padding:8px;text-align:left;" data-i18n="strategy_col_plan">Plan</th>
                            <th style="padding:8px;text-align:right;" data-i18n="strategy_col_gross">Gross</th>
                            <th style="padding:8px;text-align:right;" data-i18n="strategy_col_fees">Fees</th>
                            <th style="padding:8px;text-align:right;" data-i18n="strategy_col_net">Net</th>
                            <th style="padding:8px;text-align:right;">+TH</th>
                            <th style="padding:8px;text-align:right;">+BTC</th>
                            <th style="padding:8px;text-align:right;">+GMT</th>
                            <th style="padding:8px;text-align:right;" data-i18n="strategy_col_end_th">End TH/s</th>
                            <th style="padding:8px;text-align:right;" data-i18n="strategy_col_end_portfolio">End portfolio</th>
                        </tr>
                    </thead>
                    <tbody>${rowsHtml}</tbody>
                </table>
            </div>
        </div>`;
}
