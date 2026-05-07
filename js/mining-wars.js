/* =========================================================
   mining-wars.js
   Logic for /mining-wars.html — Mining mode vs Miner Wars
   comparison + Spell Bot setup.

   Math model lifted from index.html calcDailyReward, with the
   user's Part-4 corrections folded in:
     * Clan leader = 5% of GMT WON (not spent) by members
     * Service button (in MW) = base PPS × 100 score injection
   ========================================================= */

const SERVICE_FEE_TH_USD = 0.0089;   // GoMining service cost ($/TH/day)

const $ = sel => document.querySelector(sel);

/* ===========================================================
   LIVE DATA from the GoMining extension
   ===========================================================
   The extension's extractor.js writes a snapshot of the user's
   GoMining account to chrome.storage.local under "gominingAutoSync".
   The sync-bridge content script (running on this page too) mirrors
   that into window.localStorage["gomining_autosync"]. We listen for
   it here and auto-fill the Setup inputs + show a live banner.

   Falls back gracefully when no extension is installed — defaults +
   league presets keep working unchanged.
   =========================================================== */
const LIVE_KEY    = "gomining_autosync";
const HIST_KEY    = "mw_history_v1";
const HIST_MAX_DAYS = 30;

let liveData = { available:false, capturedAt:null };

function loadLiveData() {
  try {
    const raw = window.localStorage.getItem(LIVE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    liveData = { ...parsed, available:true, capturedAt: Date.now() };
    autofillFromLive(parsed);
    appendHistory(parsed);
    showLiveBanner(parsed);
    return true;
  } catch (e) { console.warn("loadLiveData failed:", e); return false; }
}

function autofillFromLive(d) {
  const lived = [];   // ids of fields populated from extension data this pass
  // setLive: write to the input UNLESS the user has manually edited it.
  // Manual edits set data-manual="1" via wireManualOverride() at boot.
  // Pass {force:true} to override even manual edits (used for the bot's
  // probability table where the user expects the live numbers).
  const setLive = (id, val, opts) => {
    if (val === undefined || val === null) return;
    const el = document.getElementById(id);
    if (!el) return;
    if (!opts?.force && el.dataset.manual === "1") return;
    el.value = val;
    el.dataset.live = "1";
    lived.push(id);
  };
  // ===== From the SOLO-MINING extractor (do not touch — solo path is sacred) =====
  if (d.miner?.power)            setLive("in-th",  d.miner.power.toFixed(2));
  if (d.miner?.energyEfficiency) setLive("in-eff", d.miner.energyEfficiency.toFixed(2));
  if (d.prices?.btcPrice)        setLive("in-btc", Math.round(d.prices.btcPrice));
  if (d.prices?.gmtPrice)        setLive("in-gmt", (+d.prices.gmtPrice).toFixed(4));
  if (d.discount?.streak     !== undefined) setLive("in-disc-service", d.discount.streak);
  if (d.discount?.miningMode !== undefined) setLive("in-disc-mining",  d.discount.miningMode);
  if (d.discount?.vip        !== undefined) setLive("in-disc-vip",     d.discount.vip);
  if (d.discount?.token      !== undefined) setLive("in-disc-token",   d.discount.token);

  // From the new MW extractor — prefer the HAR-precise live.* shape when present,
  // fall back to the legacy clan/league/you buckets otherwise.
  const w  = d.wars || {};
  const lv = w.live || {};
  // Provenance helper: unwrap {value,...} or pass through plain values.
  const v  = (x) => (x && typeof x === 'object' && 'value' in x) ? x.value : x;

  // === User base TH + W/TH (MW values are AUTHORITATIVE — overwrite solo) ===
  // Solo extractor sums all NFTs incl. staking miners; MW reports your
  // ACTIVE clan-eligible TH only, which is what the calculator wants.
  const userTh   = v(lv.user?.baseTh);
  const userWth  = v(lv.user?.wPerTh);
  if (userTh)  setLive("in-th",  (+userTh).toFixed(2));
  if (userWth) setLive("in-eff", (+userWth).toFixed(2));

  // === League average W/TH + total power (CRITICAL — from leaderboard endpoint) ===
  const leagueTotalTh = v(lv.league?.totalPowerTh) ?? w.league?.totalTh;
  const leagueAvgWth  = v(lv.league?.averageWPerTh) ?? w.league?.avgWth;
  if (leagueTotalTh) setLive("in-league-size", Math.round(leagueTotalTh));
  if (leagueAvgWth)  setLive("in-league-wth",  (+leagueAvgWth).toFixed(2));

  // === Legacy you.basePps fallback (no equivalent in HAR yet) ===
  if (w.you?.basePps) setLive("in-pps", Math.round(w.you.basePps));

  // === Clan-fed inputs (from /api/nft-game/clan/get-by-id) ===
  // in-clan-gmt = sum of GMT spent on boosts by clan members this cycle
  // (proxy for "clan member GMT spend" used in clan-leader royalty calc).
  // We don't have per-cycle spend directly, but we have cumulative ability
  // usage per member with prices — multiply.
  const members = v(lv.clan?.members);
  const abilityCatalog = w.abilities || (v(lv.boosts?.abilityCatalog) || []);
  if (Array.isArray(members) && Array.isArray(abilityCatalog) && abilityCatalog.length) {
    const priceById = {};
    for (const a of abilityCatalog) priceById[a.id] = +a.priceInGMT || 0;
    let totalGmtSpent = 0;
    for (const m of members) {
      for (const u of (m.usedNftGameAbilities || [])) {
        totalGmtSpent += (priceById[u.nftGameAbilityId] || 0) * (u.count || 0);
      }
    }
    if (totalGmtSpent > 0) setLive("in-member-gmt", Math.round(totalGmtSpent));
  }
  // Your own boost spend this cycle
  const myAbilities = v(lv.boosts?.usedAbilitiesByUser);
  if (Array.isArray(myAbilities) && Array.isArray(abilityCatalog) && abilityCatalog.length) {
    const priceById = {};
    for (const a of abilityCatalog) priceById[a.id] = +a.priceInGMT || 0;
    let mySpend = 0;
    for (const u of myAbilities) {
      mySpend += (priceById[u.nftGameAbilityId] || 0) * (u.count || 0);
    }
    if (mySpend > 0) setLive("in-boost-spend", Math.round(mySpend));
  }
  // Are you the clan owner? (5% royalty toggle)
  const isOwner = v(lv.user?.isClanOwner);
  if (isOwner !== undefined && isOwner !== null) {
    const cb = document.getElementById("in-is-leader");
    if (cb && cb.dataset.manual !== "1") {
      cb.checked = !!isOwner;
      cb.dataset.live = "1";
      lived.push("in-is-leader");
    }
  }

  // === Auto-select league button ===
  // Prefer the HAR league name (e.g. "dune-18") -> normalize to family.
  const leagueName = (v(lv.league?.leagueName) || w.league?.name || w.league?.id || "").toString().toLowerCase();
  const match = ["dune","horizon","eclipse","odyssey"].find(x => leagueName.includes(x));
  if (match) document.querySelector(`.league-btn[data-league="${match}"]`)?.click();

  // === Live probability table from /api/nft-game/league/index ===
  // Use the actual roundMultiplierConfig for THIS league instead of guessed
  // FREQ_DEFAULTS — the spell bot frequency row now reflects real chances.
  const multConfig = v(lv.league?.roundMultiplierConfig) || w.roundMultConfig;
  const maxMult = v(lv.league?.maxMultiplier) ||
    (Array.isArray(multConfig) ? multConfig.reduce((m,x) => Math.max(m, x.v||0), 0) : null);
  if (Array.isArray(multConfig) && maxMult) {
    rebuildBotForLeague(maxMult, multConfig);
  }

  // === Win chance + rank for the dashboard ===
  // round.myClanRound.winChance is a probability per round. Display it.
  let vitalsAny = false;
  const myCR = v(lv.round?.myClanRound);
  if (myCR && myCR.winChance != null) {
    const el = document.getElementById("kpi-winchance");
    if (el) { el.textContent = (myCR.winChance * 100).toFixed(2) + "%"; vitalsAny = true; }
  }
  if (lv.clan?.rank && v(lv.clan.rank) != null) {
    const el = document.getElementById("kpi-clanrank");
    if (el) { el.textContent = "#" + v(lv.clan.rank); vitalsAny = true; }
  }
  if (lv.user?.rank && v(lv.user.rank) != null) {
    const el = document.getElementById("kpi-userrank");
    if (el) { el.textContent = "#" + v(lv.user.rank); vitalsAny = true; }
  }
  // Bot balance — useful for "can I afford this week's strategy?"
  if (lv.boosts?.botBalanceGmt && v(lv.boosts.botBalanceGmt) != null) {
    const el = document.getElementById("kpi-botbalance");
    if (el) { el.textContent = (+v(lv.boosts.botBalanceGmt)).toFixed(2) + " GMT"; vitalsAny = true; }
  }
  if (vitalsAny) {
    const card = document.getElementById("mw-vitals-card");
    if (card) card.style.display = "";
  }

  // The cycle projection (if we have round timing) is the source of truth
  // for expected gross. It blends statistical baseline with observed data.
  const cyc = projectCycle();
  if (cyc.available && cyc.projectionBtc > 0) {
    setLive("in-war-gross", cyc.projectionBtc.toFixed(8));
  } else {
    // Fallback to historical 7-day rolling avg if no cycle timing yet
    const proj = projectFromHistory();
    if (proj.confidence !== "no-data" && proj.confidence !== "weak") {
      setLive("in-war-gross", proj.expectedWeeklyBtc.toFixed(8));
      if (proj.expectedWeeklyGmt > 0) setLive("in-war-gmt", Math.round(proj.expectedWeeklyGmt));
    }
  }

  // mark every captured field with the "🔌 live" tag
  markFieldsAsLive(lived);
  updateDashboard();
  updateCycleCard();
}

function showLiveBanner(d) {
  const el = document.getElementById("live-banner");
  if (!el) return;
  const w  = d.wars || {};
  const lv = w.live || {};
  const _v = (x) => (x && typeof x === 'object' && 'value' in x) ? x.value : x;
  const hasHar  = !!(_v(lv.league?.btcRewardFund) || _v(lv.league?.totalPowerTh) ||
                    _v(lv.user?.baseTh) || _v(lv.clan?.totalBaseTh) || _v(lv.round?.myClanRound));
  const hasWars = hasHar || !!(w.clan?.totalTh || w.recentBlocks?.length);
  const proj = projectFromHistory();
  // "synced" = when this page actually loaded the snapshot (now), not when
  // the extension extracted it. The "8d ago" banner was misleading users.
  const syncedTs = Date.now();
  // Diagnostic: which live MW fields actually landed?
  const diag = [];
  if (_v(lv.user?.baseTh))           diag.push(`TH=${(+_v(lv.user.baseTh)).toFixed(2)}`);
  if (_v(lv.clan?.totalBaseTh))      diag.push(`clan=${(+_v(lv.clan.totalBaseTh)).toFixed(0)}TH`);
  if (_v(lv.league?.totalPowerTh))   diag.push(`league=${(+_v(lv.league.totalPowerTh)).toFixed(0)}TH`);
  if (_v(lv.league?.btcRewardFund))  diag.push(`fund=${(+_v(lv.league.btcRewardFund)).toFixed(5)}`);
  if (_v(lv.round?.myClanRound))     diag.push("round✓");
  if (_v(lv.boosts?.botBalanceGmt))  diag.push(`bot=${(+_v(lv.boosts.botBalanceGmt)).toFixed(1)}GMT`);

  el.style.display = "block";
  el.innerHTML = `
    <div class="live-dot"></div>
    <div class="live-text">
      <strong>Live data connected</strong>
      <span> · ${hasWars ? "Mining Wars + solo" : "Solo mining only"} · synced ${fmtAgo(syncedTs)}${d.timestamp ? ` · captured ${fmtAgo(d.timestamp)}` : ""}</span>
      ${diag.length ? `<span class="live-proj">MW: ${diag.join(" · ")}</span>` : ""}
      ${proj.confidence !== "no-data"
        ? `<span class="live-proj">Projection: <strong>${proj.expectedWeeklyBtc.toFixed(6)} BTC/wk</strong> from last 7 d (${proj.confidence})</span>`
        : (!hasWars ? `<span class="live-proj">Browse Mining Wars in app.gomining.com to start collecting block history.</span>` : "")}
    </div>`;
}
function fmtAgo(ts) {
  const d = typeof ts === "string" ? new Date(ts).getTime() : +ts;
  const s = Math.max(0, Math.floor((Date.now() - d) / 1000));
  if (s < 60)    return s + "s ago";
  if (s < 3600)  return Math.floor(s/60) + "m ago";
  if (s < 86400) return Math.floor(s/3600) + "h ago";
  return Math.floor(s/86400) + "d ago";
}

/* ----- Rolling 30-day history of MW snapshots ----- */
function loadHistory() {
  try { return JSON.parse(window.localStorage.getItem(HIST_KEY) || "[]"); }
  catch { return []; }
}
function appendHistory(snap) {
  if (!snap?.wars) return;
  const hist = loadHistory();
  hist.push({
    capturedAt: Date.now(),
    yourTh:     snap.miner?.power || null,
    clan:       snap.wars.clan || null,
    league:     snap.wars.league || null,
    blocks:     snap.wars.recentBlocks || [],
    personal:   snap.wars.recentPersonal || [],
  });
  // dedupe — keep one per hour to avoid bloat
  const byHour = new Map();
  hist.forEach(s => {
    const k = Math.floor(s.capturedAt / 3600_000);
    byHour.set(k, s);   // newer wins
  });
  const cutoff = Date.now() - HIST_MAX_DAYS * 86400_000;
  const pruned = Array.from(byHour.values()).filter(s => s.capturedAt > cutoff);
  window.localStorage.setItem(HIST_KEY, JSON.stringify(pruned));
}

/* ----- Backtracking projection -----
 * Simple rule: what you ACTUALLY earned in the last 7 days is the best
 * estimate of what you'll earn this week. Don't double-scale by clan or
 * league size shifts — that risks inflating the projection.
 *
 * If clan size or your TH changed materially mid-week, the user can
 * manually adjust. We just report the raw observed numbers.
 */
function projectFromHistory() {
  const hist = loadHistory();
  if (!hist.length) return { expectedWeeklyBtc:0, expectedWeeklyGmt:0, confidence:"no-data", samples:0 };

  const cutoff = Date.now() - 7 * 86400_000;
  const seenBlocks = new Map(), seenPersonal = new Map();

  hist.forEach(s => {
    (s.blocks || []).forEach(b => {
      const t = +new Date(b.ts || 0) || 0;
      if (t > cutoff && b.btc) seenBlocks.set(`${t}-${b.btc}`, { ...b, snap:s });
    });
    (s.personal || []).forEach(b => {
      const t = +new Date(b.ts || 0) || 0;
      if (t > cutoff && b.gmt) seenPersonal.set(`${t}-${b.gmt}`, b);
    });
  });

  // BTC: each clan win × your-share-at-time-of-win.
  // No further scaling — the observed share already reflects clan size.
  let btcShare = 0;
  for (const b of seenBlocks.values()) {
    const yourTh = b.snap?.yourTh || 0;
    const clanTh = b.snap?.clan?.totalTh || 1;
    btcShare += (+b.btc || 0) * (yourTh / clanTh);
  }
  let gmt = 0;
  for (const b of seenPersonal.values()) gmt += (+b.gmt || 0);

  const samples = seenBlocks.size + seenPersonal.size;
  const confidence = samples >= 10 ? "strong" : samples >= 3 ? "medium" : samples > 0 ? "weak" : "no-data";

  return {
    expectedWeeklyBtc: btcShare,
    expectedWeeklyGmt: gmt,
    confidence,
    samples,
  };
}
function avgField(hist, path) {
  const parts = path.split(".");
  const vals = hist.map(s => parts.reduce((o,k) => (o ? o[k] : null), s)).filter(v => v != null);
  return vals.length ? vals.reduce((a,b)=>a+b,0) / vals.length : null;
}

/* Listen for new snapshots from the extension.
 * Three channels because of how localStorage / Chrome extensions interact:
 *   1) Cross-tab StorageEvent — fires when ANOTHER tab writes the key.
 *   2) Custom 'gomining-autosync' event — sync-bridge dispatches this on
 *      document so SAME-window writes are caught (StorageEvent does not
 *      fire in the window that wrote).
 *   3) Polling fallback every 5s — handles the case where the bridge is
 *      from an older extension version that doesn't emit the custom event.
 */
window.addEventListener("storage", e => {
  if (e.key === LIVE_KEY) loadLiveData();
});
document.addEventListener("gomining-autosync", () => loadLiveData());

let _lastLiveJson = null;
setInterval(() => {
  try {
    const cur = window.localStorage.getItem(LIVE_KEY);
    if (cur && cur !== _lastLiveJson) {
      _lastLiveJson = cur;
      loadLiveData();
    }
  } catch {}
}, 5000);

/* ===========================================================
   CYCLE-BLENDED PROJECTION
   ===========================================================
   Day 1 of a cycle: nothing observed yet → use statistical baseline
     (your fair share of the league prize fund).
   Day 2-7: blend observed rate with statistical baseline.
     Weight shifts from 0% observed → 100% observed as the cycle ends.

   This is what the user described: "the longer the cycle moves on,
   the more accurate the cycle-end projection."
   =========================================================== */
function projectCycle() {
  const w = liveData.wars || {};
  const c = w.cycle || {};
  const sofar = w.cycleSoFar || {};
  const startMs = parseTs(c.startAt);
  const endMs   = parseTs(c.endAt);
  if (!startMs || !endMs || endMs <= startMs) {
    return { available:false };
  }
  const now = Date.now();
  const totalMs     = endMs - startMs;
  const elapsedMs   = Math.max(0, Math.min(totalMs, now - startMs));
  const remainingMs = Math.max(0, totalMs - elapsedMs);
  const totalDays     = totalMs     / 86400_000;
  const elapsedDays   = elapsedMs   / 86400_000;
  const remainingDays = remainingMs / 86400_000;
  const alpha = totalDays > 0 ? elapsedDays / totalDays : 0;

  // ---- Statistical baseline (no data needed) ----
  const p = read();
  const fairShareBtc = p.leagueSizeTh > 0 && (w.league?.prizeFundBtc || 0) > 0
    ? (p.th / p.leagueSizeTh) * w.league.prizeFundBtc
    : 0;

  // ---- Observed rate so far (USD or BTC accumulated for YOU) ----
  // If yourBtcWon is reported directly, use it. Otherwise derive from clan-share.
  let yourBtcSoFar = sofar.yourBtcWon || 0;
  if (!yourBtcSoFar && sofar.clanBtcWon && w.clan?.totalTh > 0) {
    yourBtcSoFar = sofar.clanBtcWon * (p.th / w.clan.totalTh);
  }
  const ratePerDayBtc = elapsedDays > 0 ? yourBtcSoFar / elapsedDays : 0;
  const observedFullCycleBtc = yourBtcSoFar + (ratePerDayBtc * remainingDays);

  // ---- Blend (alpha = how much of the cycle has elapsed) ----
  const projectionBtc = alpha * observedFullCycleBtc + (1 - alpha) * fairShareBtc;

  // ---- Variance band: ±5% league size, ±15% clan score swing ----
  // Combined worst/best multiplier ~= [0.85, 1.20]
  const lowBtc  = projectionBtc * 0.85;
  const highBtc = projectionBtc * 1.20;

  return {
    available:true,
    elapsedDays, remainingDays, totalDays, alpha,
    fairShareBtc, observedFullCycleBtc, projectionBtc,
    lowBtc, highBtc,
    yourBtcSoFar, ratePerDayBtc,
    clanBlocksWon: sofar.clanBlocksWon || 0,
    clanBtcWon: sofar.clanBtcWon || 0,
    confidence:
      alpha < 0.15 ? "stat-only"     :   // < ~1 day
      alpha < 0.45 ? "early-data"    :   // 1-3 days
      alpha < 0.80 ? "well-observed" :   // 3-5.5 days
                     "near-final",       // > 5.5 days
  };
}
function parseTs(v) {
  if (!v) return null;
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
  const d = new Date(v).getTime();
  return Number.isFinite(d) ? d : null;
}

/* When live data lands, mark fields as "captured from extension" so the
 * user knows they shouldn't normally edit them. They CAN still edit if
 * they want to experiment. */
function updateCycleCard() {
  const card = document.getElementById("cycle-card");
  if (!card) return;
  const cyc = projectCycle();
  if (!cyc.available) {
    card.style.display = "none";
    return;
  }
  card.style.display = "block";
  const p = read();
  const w = liveData.wars || {};

  const pct = Math.min(100, cyc.alpha * 100);
  const yourBtcSoFarUsd  = cyc.yourBtcSoFar * p.btcUsd;
  const projUsd          = cyc.projectionBtc * p.btcUsd;
  const lowUsd           = cyc.lowBtc        * p.btcUsd;
  const highUsd          = cyc.highBtc       * p.btcUsd;

  const confLabel = {
    "stat-only":     "Day 1 — using statistical baseline only",
    "early-data":    "Early in cycle — limited live data",
    "well-observed": "Mid-cycle — projection blending well",
    "near-final":    "Cycle nearly complete — high confidence",
  }[cyc.confidence];

  const clanShareSoFar = w.clan?.totalTh > 0 && cyc.clanBtcWon > 0
    ? `${(cyc.yourBtcSoFar / cyc.clanBtcWon * 100).toFixed(2)}% of clan winnings`
    : "—";

  card.innerHTML = `
    <div class="card-title">⏱️ Cycle in progress</div>
    <div class="card-desc">As the week progresses, observed data replaces the statistical baseline. <strong>${confLabel}.</strong></div>
    <div class="cycle-bar">
      <div class="cycle-bar-fill" style="width:${pct.toFixed(1)}%"></div>
      <div class="cycle-bar-label">${cyc.elapsedDays.toFixed(1)} / ${cyc.totalDays.toFixed(1)} days · ${pct.toFixed(0)}%</div>
    </div>
    <div class="cycle-grid">
      <div class="cycle-cell">
        <div class="cyc-l">Clan blocks won so far</div>
        <div class="cyc-v">${cyc.clanBlocksWon}</div>
        <div class="cyc-s">${cyc.clanBtcWon ? cyc.clanBtcWon.toFixed(6) + " BTC clan total" : ""}</div>
      </div>
      <div class="cycle-cell">
        <div class="cyc-l">Your share so far</div>
        <div class="cyc-v">${cyc.yourBtcSoFar.toFixed(6)} BTC</div>
        <div class="cyc-s">≈ ${fmtUsd(yourBtcSoFarUsd)} · ${clanShareSoFar}</div>
      </div>
      <div class="cycle-cell">
        <div class="cyc-l">Cycle-end projection</div>
        <div class="cyc-v" style="color:var(--green)">${fmtUsd(projUsd)}</div>
        <div class="cyc-s">${cyc.projectionBtc.toFixed(6)} BTC · range ${fmtUsd(lowUsd)} – ${fmtUsd(highUsd)}</div>
      </div>
      <div class="cycle-cell">
        <div class="cyc-l">Statistical baseline</div>
        <div class="cyc-v">${fmtUsd(cyc.fairShareBtc * p.btcUsd)}</div>
        <div class="cyc-s">If you won fair-share of league prize</div>
      </div>
    </div>
    <div class="cycle-explainer">
      <strong>${(cyc.alpha * 100).toFixed(0)}%</strong> observed +
      <strong>${((1 - cyc.alpha) * 100).toFixed(0)}%</strong> statistical.
      Variance band reflects ±5% league size and ±15% clan-score swing.
    </div>`;
}

function markFieldsAsLive(fields) {
  fields.forEach(id => {
    const el = document.getElementById(id);
    if (el && !el.dataset.liveMarked) {
      el.dataset.liveMarked = "1";
      el.classList.add("from-ext");
      const lbl = el.closest(".price-input")?.querySelector("label");
      if (lbl && !lbl.querySelector(".ext-tag")) {
        lbl.insertAdjacentHTML("beforeend", ' <span class="ext-tag" title="Captured live from the extension">🔌 live</span>');
      }
    }
  });
}

/* ---------- Spell catalog & bot rules ---------- */
const SPELLS = {
  rocket:  { label:"Rocket",  costs:[1,10,100], icon:"🚀" },
  echo:    { label:"Echo",    costs:[1,10,100], icon:"📡" },
  focus:   { label:"Focus",   costs:[1,10,100], icon:"🎯" },
  instant: { label:"Instant", costs:[1,10,100], icon:"⚡" },
  turbo:   { label:"Turbo",   costs:[10],       icon:"🔥" },
  shield:  { label:"Shield",  costs:[100],      icon:"🛡" },
  // service button is FREE (you only get 1/day inside MW)
  service: { label:"Service", costs:[0],        icon:"🛠" },
};
// Block multipliers per league. Dune caps at ×32, Horizon ×64,
// Eclipse ×128, Odyssey ×256. These cascade: each higher league
// includes every multiplier below it plus its own ceiling.
function tiersFor(maxMult) {
  const all = [1, 2, 4, 8, 16, 32, 64, 128, 256];
  return all.filter(m => m <= maxMult);
}
let currentLeague = null;        // "dune" | "horizon" | "eclipse" | "odyssey" | null
let MULT_TIERS = [1, 2, 4, 8, 16, 32];     // Dune-default until user picks
let botRules = MULT_TIERS.map(m => ({ mult:m, picks:{} }));

function rebuildBotForLeague(maxMult, multConfig) {
  MULT_TIERS = tiersFor(maxMult);
  // preserve existing picks where the multiplier still applies, drop others
  const oldByMult = Object.fromEntries(botRules.map(r => [r.mult, r.picks]));
  botRules = MULT_TIERS.map(m => ({ mult:m, picks: oldByMult[m] || {} }));
  // If we got a live probability table from the extension, derive expected
  // blocks/week per tier from p × (rounds/week). Rounds are ~3 min apart, so
  // ~3360 rounds/week. Anything the user manually edited stays put.
  if (Array.isArray(multConfig) && multConfig.length) {
    const ROUNDS_PER_WEEK = 60 * 24 * 7 / 3; // ~3360
    const fromLive = {};
    for (const row of multConfig) {
      if (row && row.v != null && row.p != null) fromLive[row.v] = +row.p * ROUNDS_PER_WEEK;
    }
    // Only fill in tiers the user hasn't customized (perTierFreq overrides).
    for (const m of MULT_TIERS) {
      if (perTierFreq[m] === undefined && fromLive[m] !== undefined) {
        perTierFreq[m] = +fromLive[m].toFixed(2);
      }
    }
  }
  renderFreqRow();
  renderBot();
}

// Per-tier expected blocks/week — keyed by multiplier number.
// Defaults reflect that low multipliers happen often, big ones rare.
const FREQ_DEFAULTS = { 1:10, 2:4, 4:2, 8:1, 16:0.5, 32:0.2, 64:0.1, 128:0.05, 256:0.02 };
let perTierFreq = {};
function renderFreqRow() {
  const row = $("#bot-freq-row");
  if (!row) return;
  row.innerHTML = "";
  MULT_TIERS.forEach(m => {
    const cur = perTierFreq[m] ?? FREQ_DEFAULTS[m] ?? 1;
    const wrap = document.createElement("div");
    wrap.className = "price-input";
    wrap.innerHTML = `
      <label>×${m}</label>
      <input type="number" data-mult="${m}" value="${cur}" step="0.1" min="0">`;
    wrap.querySelector("input").addEventListener("input", e => {
      perTierFreq[m] = +e.target.value || 0;
      renderBot();
      updateDashboard();
    });
    row.appendChild(wrap);
    perTierFreq[m] = cur;
  });
}

function preset(kind) {
  if (kind === "clear") {
    botRules.forEach(r => r.picks = {});
  } else if (kind === "conservative") {
    botRules.forEach(r => {
      r.picks = {};
      if (r.mult >= 2 && r.mult <= 4)  r.picks.service = 1;
      if (r.mult >= 8 && r.mult <= 16) { r.picks.rocket = 1;  r.picks.echo = 1;  r.picks.service = 1; }
      if (r.mult >= 32)                { r.picks.rocket = 10; r.picks.echo = 10; r.picks.instant = 10; r.picks.service = 1; }
    });
  } else if (kind === "aggressive") {
    botRules.forEach(r => {
      r.picks = {};
      if (r.mult >= 2 && r.mult <= 4) { r.picks.rocket = 1;   r.picks.service = 1; }
      if (r.mult >= 8 && r.mult <= 16){ r.picks.rocket = 10;  r.picks.echo = 10;  r.picks.instant = 10;  r.picks.turbo = 10; r.picks.service = 1; }
      if (r.mult >= 32)               { r.picks.rocket = 100; r.picks.echo = 100; r.picks.focus = 100;
                                        r.picks.instant = 100; r.picks.turbo = 10; r.picks.shield = 100; r.picks.service = 1; }
    });
  }
  renderBot();
}

function renderBot() {
  const body = $("#bot-rules-body");
  body.innerHTML = "";

  const blocksDefault = +$("#bot-blocks-per-tier").value || 1;
  const edgeRate      = +$("#bot-edge-rate").value || 1;
  const gmtUsd        = +$("#in-gmt").value || 0;

  let weekGmtTotal = 0, weekPrizeUsd = 0;

  botRules.forEach((rule, idx) => {
    const tr = document.createElement("tr");
    let rowCost = 0;
    let cells = `<td class="bot-multcell"><strong>×${rule.mult}</strong></td>`;
    Object.keys(SPELLS).forEach(key => {
      const s = SPELLS[key];
      const cur = rule.picks[key] || 0;
      const opts = ['<option value="0">off</option>']
        .concat(s.costs.map(c => `<option value="${c}" ${cur===c?"selected":""}>${c} GMT${key==="service"?" (free)":""}</option>`))
        .join("");
      if (key === "service") {
        cells += `<td><label class="service-toggle"><input type="checkbox" data-rule="${idx}" data-key="service" ${cur?"checked":""}> use</label></td>`;
      } else {
        cells += `<td><select data-rule="${idx}" data-key="${key}">${opts}</select></td>`;
      }
      rowCost += +cur || 0;
    });
    const blocksThisTier = perTierFreq[rule.mult] ?? blocksDefault;
    weekGmtTotal += rowCost * blocksThisTier;
    cells += `<td style="text-align:right;font-weight:700">${rowCost.toLocaleString()} GMT</td>`;

    // verdict per row
    const rowCostUsd  = rowCost * gmtUsd;
    const rowPrizeUsd = rowCostUsd * edgeRate;
    weekPrizeUsd += rowPrizeUsd * blocksThisTier;
    const net = rowPrizeUsd - rowCostUsd;
    let verdict = "";
    if (rowCost === 0)         verdict = '<span style="color:var(--text-mute)">no boost</span>';
    else if (net > 0)          verdict = `<span style="color:var(--green);font-weight:700">+$${net.toFixed(2)}</span>`;
    else if (net < 0)          verdict = `<span style="color:var(--red);font-weight:700">-$${Math.abs(net).toFixed(2)} ⚠</span>`;
    else                       verdict = '<span style="color:var(--text-dim)">break even</span>';
    cells += `<td style="text-align:right">${verdict}</td>`;
    tr.innerHTML = cells;
    body.appendChild(tr);
  });

  // wire selectors
  body.querySelectorAll("select").forEach(sel => {
    sel.addEventListener("change", e => {
      const ri = +e.target.dataset.rule, key = e.target.dataset.key;
      const v  = +e.target.value;
      if (v) botRules[ri].picks[key] = v;
      else delete botRules[ri].picks[key];
      renderBot();
    });
  });
  body.querySelectorAll("input[type=checkbox]").forEach(cb => {
    cb.addEventListener("change", e => {
      const ri = +e.target.dataset.rule;
      if (e.target.checked) botRules[ri].picks.service = 1;
      else delete botRules[ri].picks.service;
      renderBot();
    });
  });

  // headline numbers
  $("#bot-week-cost").textContent     = weekGmtTotal.toLocaleString() + " GMT";
  $("#bot-week-cost-usd").textContent = "≈ " + fmtUsd(weekGmtTotal * gmtUsd) + " / week";
  $("#bot-week-prize").textContent    = fmtUsd(weekPrizeUsd);
  const edge = weekPrizeUsd - weekGmtTotal * gmtUsd;
  $("#bot-week-edge").textContent     = fmtUsd(edge);
  $("#bot-week-edge").style.color     = edge >= 0 ? "var(--green)" : "var(--red)";
  $("#bot-week-edge-sub").textContent = edge >= 0
    ? "Net positive at the assumed conversion rate"
    : "⚠ Bot loses money at this rate — lower spell tier or stop boosting low multipliers";
}

function exportBotConfig() {
  const cfg = {
    note: "Generated by gmsim.ca / Mining Wars · paste into your spell-bot",
    generatedAt: new Date().toISOString(),
    rules: botRules.map(r => ({ multiplier: r.mult, fire: r.picks })),
  };
  const json = JSON.stringify(cfg, null, 2);
  navigator.clipboard?.writeText(json).then(() => {
    const btn = document.getElementById("bot-export");
    const orig = btn.textContent;
    btn.textContent = "✓ copied to clipboard";
    setTimeout(() => btn.textContent = orig, 1800);
  }).catch(() => alert(json));
}

/* ---------- Mining vs Miner Wars comparison ---------- */
function read() {
  return {
    th:        +$("#in-th").value || 0,
    eff:       +$("#in-eff").value || 15,
    btcUsd:    +$("#in-btc").value || 0,
    netEh:     +$("#in-net").value || 1,
    blockBtc:  +$("#in-block").value || 3.125,
    elecKwh:   +$("#in-elec").value || 0.05,
    discService: (+$("#in-disc-service").value || 0) / 100,
    discMining:  (+$("#in-disc-mining").value  || 0) / 100,
    discVip:     (+$("#in-disc-vip").value     || 0) / 100,
    discToken:   (+$("#in-disc-token").value   || 0) / 100,
    leagueWth: +$("#in-league-wth").value || 19,
    leagueSizeTh: +$("#in-league-size").value || 0,
    warGross:  +$("#in-war-gross").value || 0,
    warGmt:    +$("#in-war-gmt").value || 0,
    gmtUsd:    +$("#in-gmt").value || 0,
    // ---- new explicit inputs (default-safe) ----
    eligibleMiningDays: +$("#in-elig-mining")?.value || 7,
    eligibleWarDays:    +$("#in-elig-wars")?.value   || 7,
    boostSpendGmt:      +$("#in-boost-spend")?.value || 0,
    isLeader:           !!$("#in-is-leader")?.checked,
    memberGmtTotal:     +$("#in-member-gmt")?.value  || 0,
  };
}

function fmtUsd(n)  { return (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString(undefined,{maximumFractionDigits:2}); }
function fmtBtc(n)  { return (n < 0 ? "" : "") + n.toFixed(8); }

/* ============ DASHBOARD live KPIs + snapshot ============ */
function updateSnapshot(p) {
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set("sv-th",    fmtNumLocal(p.th, 1) + " TH/s");
  set("sv-eff",   p.eff + " W/TH");
  set("sv-elec",  "$" + p.elecKwh.toFixed(2) + " /kWh");
  set("sv-btc",   "$" + p.btcUsd.toLocaleString());
  set("sv-gmt",   "$" + p.gmtUsd.toFixed(4));
  set("sv-net",   p.netEh + " EH/s · " + p.blockBtc + " BTC/blk");
  const stack = (p.discService + p.discMining + p.discVip + p.discToken) * 100;
  set("sv-disc",  stack.toFixed(2) + "% (M) · " +
                  ((p.discService + p.discVip + p.discToken) * 100).toFixed(2) + "% (W)");
  set("sv-gross", p.warGross.toFixed(6) + " BTC ($" + (p.warGross * p.btcUsd).toFixed(0) + ")");
}
function fmtNumLocal(n, p=0) { return Number(n).toLocaleString(undefined, {maximumFractionDigits:p}); }

function updateDashboard() {
  const out = simulate();
  const m = out.mining, w = out.wars, p = out.p;
  updateSnapshot(p);
  updateCycleCard();

  const mEl = document.getElementById("kpi-mining");
  const wEl = document.getElementById("kpi-wars");
  const winEl = document.getElementById("kpi-winner");
  const botEl = document.getElementById("kpi-bot");

  if (mEl) {
    mEl.querySelector(".val").textContent = fmtUsd(m.netUsd);
    mEl.classList.toggle("green", m.netUsd >= 0);
    mEl.classList.toggle("red", m.netUsd < 0);
    mEl.querySelector(".sub").textContent = fmtBtc(m.netBtc) + " BTC · all 4 discounts";
  }
  if (wEl) {
    wEl.querySelector(".val").textContent = fmtUsd(w.netUsd);
    wEl.classList.toggle("green", w.netUsd >= 0);
    wEl.classList.toggle("red", w.netUsd < 0);
    wEl.querySelector(".sub").textContent =
      `Excess tax: -${fmtUsd(w.feesExcess)} · Retention ${w.retention.toFixed(1)}%`;
  }
  if (winEl) {
    const diff = w.netUsd - m.netUsd;
    const winner = m.netUsd >= w.netUsd ? "Mining mode" : "Miner Wars";
    const v = winEl.querySelector(".val");
    v.textContent = winner;
    winEl.classList.remove("green", "red", "purple", "accent");
    winEl.classList.add(winner === "Mining mode" ? "green" : "purple");
    document.getElementById("kpi-winner-diff").textContent =
      (diff >= 0 ? "+" : "-") + fmtUsd(Math.abs(diff));
  }
  if (botEl) {
    // re-run a lightweight version of the bot edge calc
    const blocksDefault = +($("#bot-blocks-per-tier")?.value) || 1;
    const edgeRate      = +($("#bot-edge-rate")?.value) || 1;
    const gmtUsd        = +$("#in-gmt").value || 0;
    let weekGmt = 0, weekPrize = 0;
    botRules.forEach(rule => {
      const blocks = perTierFreq[rule.mult] ?? blocksDefault;
      const cost = Object.values(rule.picks).reduce((a, b) => a + (+b || 0), 0);
      weekGmt   += cost * blocks;
      weekPrize += cost * gmtUsd * edgeRate * blocks;
    });
    const edge = weekPrize - weekGmt * gmtUsd;
    botEl.querySelector(".val").textContent = fmtUsd(edge);
    botEl.classList.remove("green", "red", "dim");
    if (edge > 0) botEl.classList.add("green");
    else if (edge < 0) botEl.classList.add("red");
    else botEl.classList.add("dim");
    botEl.querySelector(".sub").textContent =
      weekGmt > 0
        ? `Spends ${weekGmt.toLocaleString()} GMT/wk for ~${fmtUsd(weekPrize)} return`
        : "No bot rules set yet — configure in Spell Bot tab";
  }
}

/* ============ Variance scenarios (Compare tab) ============
 * Reuses the canonical runMW() with a warGross override so all fees,
 * GMT, leader royalty, and boost spend stay consistent.
 */
function renderVariance(out) {
  const el = document.getElementById("variance-grid");
  if (!el) return;
  document.getElementById("variance-card").style.display = "block";
  const baseGross = out.p.warGross;
  const scenarios = [
    { label:"BAD LUCK · 0.5×", mul:0.5, cls:"bad",   note:"Half of expected wins" },
    { label:"AVERAGE · 1.0×",  mul:1.0, cls:"avg",   note:"Your expected gross" },
    { label:"LUCKY · 3.0×",    mul:3.0, cls:"lucky", note:"Heavy block-win streak" },
  ];
  el.innerHTML = scenarios.map(s => {
    const r = runMW({ warGross: baseGross * s.mul });
    const beatSolo = r.wars.netUsd > r.mining.netUsd;
    const diff = r.wars.netUsd - r.mining.netUsd;
    return `
      <div class="variance-card ${s.cls}">
        <span class="luck">${s.label}</span>
        <div class="vc-net ${r.wars.netUsd >= 0 ? "green" : "red"}">${fmtUsd(r.wars.netUsd)}</div>
        <div class="vc-sub">${s.note} · ${beatSolo ? "✅ beats solo" : "❌ solo wins"}</div>
        <div class="vc-row"><span class="l">Gross BTC</span><span class="r">${fmtBtc(r.wars.grossBtc)}</span></div>
        <div class="vc-row"><span class="l">Excess tax</span><span class="r">-${fmtUsd(r.wars.excessFee)}</span></div>
        <div class="vc-row"><span class="l">Boost cost</span><span class="r">-${fmtUsd(r.wars.boostSpendUsd)}</span></div>
        <div class="vc-row"><span class="l">vs Mining</span><span class="r ${diff >= 0 ? "green" : "red"}">${(diff >= 0 ? "+" : "")}${fmtUsd(diff)}</span></div>
      </div>`;
  }).join("");
}

/* ============ Break-even calculator (Compare tab) ============
 * Numerical solve: find the warGross that makes wars.netUsd == mining.netUsd
 * Uses a coarse-then-fine binary search on top of runMW(). Slower than the
 * old algebra, but stays correct as we add GMT/royalty/boost terms.
 */
function renderBreakeven(out) {
  document.getElementById("breakeven-card").style.display = "block";
  const target = out.mining.netUsd;
  const valueAt = btc => runMW({ warGross: btc }).wars.netUsd - target;

  // Bracket: low = 0, high = whatever overshoots target
  let lo = 0, hi = Math.max(0.01, out.p.warGross * 4 || 0.05);
  let guard = 0;
  while (valueAt(hi) < 0 && guard++ < 50) hi *= 2;
  // Binary search
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (valueAt(mid) < 0) lo = mid; else hi = mid;
  }
  const beBtc = (lo + hi) / 2;
  const beUsd = beBtc * out.p.btcUsd;
  const regime = beBtc > out.mining.ceilingForWars ? "above ceiling" : "below ceiling";
  const yourGap = out.p.warGross - beBtc;
  const gapPct = beBtc > 0 ? (yourGap / beBtc) * 100 : 0;

  document.getElementById("breakeven-row").innerHTML = `
    <div class="be-block">
      <div class="be-lbl">Break-even gross BTC / week</div>
      <div class="be-val">${fmtBtc(beBtc)}</div>
      <div class="be-sub">≈ ${fmtUsd(beUsd)} · regime: <strong>${regime}</strong> · includes GMT, royalty &amp; boost cost</div>
    </div>
    <div class="be-block">
      <div class="be-lbl">Your gap to break-even</div>
      <div class="be-val ${yourGap >= 0 ? "green" : "red"}">${(yourGap >= 0 ? "+" : "")}${fmtBtc(yourGap)}</div>
      <div class="be-sub">${
        yourGap >= 0
        ? `You're <strong>${gapPct.toFixed(1)}%</strong> above break-even — Wars is profitable at your expected gross.`
        : `You need <strong>${Math.abs(gapPct).toFixed(1)}%</strong> more weekly gross BTC for Wars to beat solo.`
      }</div>
    </div>`;
}

// =================================================================
//  CANONICAL CALCULATION — single source of truth.
//  Every card (Dashboard, Compare, Variance, Break-even) calls this
//  function with optional overrides. Don't duplicate fee math anywhere.
// =================================================================
function runMW(overrides) {
  overrides = overrides || {};
  const p = read();
  const warGross           = overrides.warGross           ?? p.warGross;
  const warGmt             = overrides.warGmt             ?? p.warGmt;
  const eligibleMiningDays = overrides.eligibleMiningDays ?? p.eligibleMiningDays;
  const eligibleWarDays    = overrides.eligibleWarDays    ?? p.eligibleWarDays;
  const boostSpendGmt      = overrides.boostSpendGmt      ?? p.boostSpendGmt;

  const networkTh = p.netEh * 1_000_000;

  // ---------- Mining mode (eligible days, full discount stack) ----------
  const grossPerDayBtc = (p.th / networkTh) * 144 * p.blockBtc;
  const elecPerDayUsd  = (p.elecKwh * 24 * p.eff * p.th) / 1000;
  const servPerDayUsd  = SERVICE_FEE_TH_USD * p.th;
  const miningDisc     = p.discService + p.discMining + p.discVip + p.discToken;
  const maintPerDayUsd = (elecPerDayUsd + servPerDayUsd) * (1 - miningDisc);
  const maintPerDayBtc = p.btcUsd > 0 ? maintPerDayUsd / p.btcUsd : 0;
  const miningNetBtc   = (grossPerDayBtc - maintPerDayBtc) * eligibleMiningDays;
  const miningNetUsd   = miningNetBtc * p.btcUsd;
  const miningGrossUsd = grossPerDayBtc * eligibleMiningDays * p.btcUsd;
  const miningMaintUsd = maintPerDayUsd * eligibleMiningDays;

  // Solo ceiling for excess-fee math = same Mining-mode net for the WAR period
  const soloCeilingBtcForWars = (grossPerDayBtc - maintPerDayBtc) * eligibleWarDays;

  // ---------- Miner Wars ----------
  // Mining-mode bonus does NOT apply in MW. Service streak still does.
  const warsDisc        = p.discService + p.discVip + p.discToken;
  const warsBaseFeesUsd = (elecPerDayUsd + servPerDayUsd) * (1 - warsDisc) * eligibleWarDays;

  const excessBtc = Math.max(0, warGross - soloCeilingBtcForWars);
  const excessUsd = excessBtc * p.btcUsd;
  const leagueElecPerDay = (p.elecKwh * 24 * p.leagueWth * p.th) / 1000;
  const leagueRatio      = (leagueElecPerDay + servPerDayUsd) / (elecPerDayUsd + servPerDayUsd);
  const excessFeeUsd     = excessUsd * (leagueRatio - 1) * (1 - warsDisc);

  const warBtcGrossUsd  = warGross * p.btcUsd;
  const personalGmtUsd  = warGmt * p.gmtUsd;
  const leaderRoyaltyUsd = p.isLeader ? (p.memberGmtTotal * 0.05 * p.gmtUsd) : 0;
  const boostSpendUsd    = boostSpendGmt * p.gmtUsd;

  const warNetUsd = warBtcGrossUsd
                  + personalGmtUsd
                  + leaderRoyaltyUsd
                  - warsBaseFeesUsd
                  - excessFeeUsd
                  - boostSpendUsd;
  const warNetBtc = p.btcUsd > 0 ? warNetUsd / p.btcUsd : 0;

  // BTC-only retention (kept distinct from net-of-everything)
  const btcRetention = warBtcGrossUsd > 0
    ? ((warBtcGrossUsd - warsBaseFeesUsd - excessFeeUsd) / warBtcGrossUsd) * 100
    : 0;

  return {
    p, overrides,
    mining: {
      gross: miningGrossUsd,
      maint: miningMaintUsd,
      netBtc: miningNetBtc,
      netUsd: miningNetUsd,
      ceilingBtc: miningNetBtc,                  // solo ceiling for the same period
      ceilingForWars: soloCeilingBtcForWars,     // ceiling adjusted for war days
    },
    wars: {
      grossBtc: warGross,
      grossUsd: warBtcGrossUsd,
      personalGmt: warGmt,
      personalGmtUsd,
      leaderRoyaltyUsd,
      boostSpendUsd,
      feesBase: warsBaseFeesUsd,
      excessBtc, excessFee: excessFeeUsd, leagueRatio,
      netBtc: warNetBtc,
      netUsd: warNetUsd,
      retention: btcRetention,
    },
  };
}
// Back-compat alias — old callers keep working.
function simulate() { return runMW(); }

function render(out) {
  $("#results-empty").style.display = "none";
  $("#results-content").style.display = "block";

  const m = out.mining, w = out.wars, p = out.p;
  $("#mining-net").textContent = fmtUsd(m.netUsd);
  $("#mining-net").className   = "mode-net " + (m.netUsd >= 0 ? "green" : "red");
  $("#mining-sub").textContent = fmtBtc(m.netBtc) + " BTC / week";
  $("#mining-gross").textContent   = fmtUsd(m.gross);
  $("#mining-maint").textContent   = "-" + fmtUsd(m.maint);
  $("#mining-btc").textContent     = fmtBtc(m.netBtc);
  $("#mining-ceiling").textContent = fmtBtc(m.ceilingBtc) + " BTC";

  $("#wars-net").textContent = fmtUsd(w.netUsd);
  $("#wars-net").className   = "mode-net " + (w.netUsd >= 0 ? "green" : "red");
  $("#wars-sub").textContent = fmtBtc(w.netBtc) + " BTC equivalent / week";
  $("#wars-gross").textContent      = fmtUsd(w.grossUsd);
  $("#wars-gmt").textContent        = w.personalGmtUsd > 0 ? "+" + fmtUsd(w.personalGmtUsd) : "—";
  $("#wars-fees-base").textContent  = "-" + fmtUsd(w.feesBase);
  $("#wars-fees-excess").textContent= "-" + fmtUsd(w.excessFee);
  $("#wars-retention").textContent  = w.retention.toFixed(1) + "% (BTC-only)";

  // verdict + winner ribbon
  const diff = w.netUsd - m.netUsd;
  $("#card-mining").classList.toggle("winner", m.netUsd >= w.netUsd);
  $("#card-wars").classList.toggle("winner", w.netUsd > m.netUsd);
  const tagMining = $("#card-mining").querySelector(".winner-tag");
  const tagWars   = $("#card-wars").querySelector(".winner-tag");
  if (tagMining) tagMining.remove();
  if (tagWars) tagWars.remove();
  const winnerCard = m.netUsd >= w.netUsd ? "card-mining" : "card-wars";
  const tag = document.createElement("div");
  tag.className = "winner-tag";
  tag.textContent = "WINNER";
  $("#" + winnerCard).appendChild(tag);

  const v = $("#verdict");
  v.classList.remove("mining","wars");
  if (m.netUsd >= w.netUsd) {
    v.classList.add("mining");
    $("#verdict-title").textContent = `Mining mode wins by ${fmtUsd(Math.abs(diff))}/week`;
    $("#verdict-text").textContent  = w.feesExcess > 0
      ? `The league's avg ${p.leagueWth} W/TH excess-fee tax (${fmtUsd(w.feesExcess)}) eats more than your clan-share advantage. Stay solo.`
      : "Your expected clan share doesn't beat your predictable solo earnings. Stay solo.";
  } else {
    v.classList.add("wars");
    $("#verdict-title").textContent = `Miner Wars wins by ${fmtUsd(Math.abs(diff))}/week`;
    $("#verdict-text").textContent  = `Your expected clan share is high enough to beat solo even after the league fee markup. Worth playing — but confirm your gross estimate is realistic.`;
  }

  // detail table — every line of the war net build
  $("#detail-table").innerHTML = `
    <tr><td class="lbl">Eligible mining days / war days</td><td>${p.eligibleMiningDays} / ${p.eligibleWarDays}</td></tr>
    <tr><td class="lbl">Your hashrate / W/TH</td><td>${p.th.toLocaleString()} TH/s · ${p.eff} W/TH (league avg ${p.leagueWth})</td></tr>
    <tr><td class="lbl">League fee multiplier on excess</td><td>${(w.leagueRatio).toFixed(3)}× (×${((w.leagueRatio-1)*100).toFixed(1)}% markup)</td></tr>
    <tr><td class="lbl">Mining-mode discount stack</td><td>${((p.discService+p.discMining+p.discVip+p.discToken)*100).toFixed(2)}%</td></tr>
    <tr><td class="lbl">Miner-Wars discount stack</td><td>${((p.discService+p.discVip+p.discToken)*100).toFixed(2)}% <span style="color:var(--text-mute)">(no Mining-mode bonus)</span></td></tr>
    <tr><td class="lbl">+ BTC clan share gross</td><td class="green">+${fmtUsd(w.grossUsd)}</td></tr>
    <tr><td class="lbl">+ Personal GMT</td><td class="green">+${fmtUsd(w.personalGmtUsd)}</td></tr>
    <tr><td class="lbl">+ Clan-leader 5% royalty</td><td class="green">+${fmtUsd(w.leaderRoyaltyUsd)}</td></tr>
    <tr><td class="lbl">− Normal maintenance (war days)</td><td class="red">-${fmtUsd(w.feesBase)}</td></tr>
    <tr><td class="lbl">− Excess-fee tax on overage</td><td class="red">-${fmtUsd(w.excessFee)} (excess BTC: ${fmtBtc(w.excessBtc)})</td></tr>
    <tr><td class="lbl">− Boost / spell spend</td><td class="red">-${fmtUsd(w.boostSpendUsd)}</td></tr>
    <tr class="total"><td>Net difference (Wars − Mining)</td><td class="${diff >= 0 ? 'green' : 'red'}">${fmtUsd(diff)}/week (${diff>=0?"+":""}${(diff*52).toLocaleString(undefined,{maximumFractionDigits:0})} /year)</td></tr>
  `;

  // variance + break-even
  renderVariance(out);
  renderBreakeven(out);
}

/* ============ Boost ROI break-even (Tools tab) ============ */
function updateRoiMax() {
  const prize = +$("#in-prize-usd").value || 0;
  const lift  = +$("#in-prob-lift").value || 0;
  // Expected gain at spend S = prize * lift * S - S = S * (prize*lift - 1)
  // Positive ROI requires prize*lift > 1. Max useful S = where p(S) caps at ~1
  // (i.e. additional spend gives no extra probability). Heuristic:
  // max useful spend = 1 / lift  (after which p≈100%)
  const breakEven = lift > 0 ? 1 / lift : 0;
  // But you also shouldn't spend more than the prize itself for break-even at p=1.
  const maxSensible = Math.min(prize, breakEven);
  const out = $("#out-roi-max");
  const sub = $("#out-roi-sub");
  if (!out) return;
  if (lift <= 0 || prize <= 0) {
    out.textContent = "—";
    sub.textContent = "Set both inputs above";
    return;
  }
  out.textContent = fmtUsd(maxSensible);
  if (prize * lift < 1) {
    sub.textContent = `⚠ Lift × prize = ${(prize*lift).toFixed(2)} < 1 → boosting is unprofitable in expectation`;
  } else {
    sub.textContent = `Each $1 lifts win prob by ${(lift*100).toFixed(1)}%. Don't exceed ${fmtUsd(maxSensible)} on this block.`;
  }
}

/* ============ Maintenance discount estimator (Tools tab) ============ */
function updateDiscount() {
  const days = +$("#in-prepaid-days").value || 0;
  let pct;
  if (days < 18)         pct = 0;
  else if (days >= 360)  pct = 20;
  else                   pct = Math.round((days - 18) / (360 - 18) * 20);
  const out = $("#out-discount");
  const sub = $("#out-discount-sub");
  if (!out) return;
  out.textContent = pct + "%";
  if (days < 18)         sub.textContent = "Prepaid <18 days → no discount yet. Lock more GMT.";
  else if (days >= 360)  sub.textContent = "Maxed at 20% discount cap.";
  else                   sub.textContent = `+${pct}% off your maintenance fees this period.`;
}

/* ---------- Bonus tools (live) ---------- */
function updateBoost() {
  // Service-button click in MW = 1000× power boost (one click per day).
  const pps = +$("#in-pps").value || 0;
  $("#out-boost").textContent = "+" + (pps * 1000).toLocaleString() + " score";
}
function updateRoyalty() {
  const gmt = +$("#in-clan-gmt").value || 0;
  const cut = gmt * 0.05;
  const gmtUsd = +$("#in-gmt").value || 0;
  $("#out-royalty").textContent = cut.toLocaleString(undefined,{maximumFractionDigits:1}) + " GMT / week";
  $("#out-royalty-sub").textContent = "≈ " + fmtUsd(cut * gmtUsd) + " / week at current GMT price";
}

/* ---------- Wire up ---------- */
// league preset clicks — drives BOTH the comparison math and the spell-bot tiers
function selectLeague(btn) {
  document.querySelectorAll(".league-btn").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  const id      = btn.dataset.league;
  const wth     = +btn.dataset.wth;
  const maxMult = +btn.dataset.maxMult;
  const entry   = btn.dataset.entry || "—";
  currentLeague = id;
  // Only set league avg W/TH (used for excess-fee math).
  // Do NOT auto-overwrite #in-war-gross — league $/TH/week density is just
  // a max ceiling assuming you win at league-average rate, which most
  // miners don't. User must enter their own honest expected gross
  // (last week's actual is the best baseline).
  $("#in-league-wth").value = wth;
  const name = btn.querySelector(".name").textContent.replace(/×\d+ max/i, "").trim();
  $("#li-name").textContent  = name;
  $("#li-mult").textContent  = "×" + maxMult;
  $("#li-entry").textContent = entry;
  updateFairShare();
  rebuildBotForLeague(maxMult);
  updateDashboard();
}
document.querySelectorAll(".league-btn").forEach(btn =>
  btn.addEventListener("click", () => selectLeague(btn)));

function updateFairShare() {
  const th        = +$("#in-th").value || 0;
  const leagueSize= +$("#in-league-size").value || 0;
  const density   = +(document.querySelector(".league-btn.active")?.dataset.density) || 0;
  if (!th || !leagueSize) {
    $("#li-fair").textContent = "—";
    return;
  }
  const fairPct  = (th / leagueSize) * 100;
  const fairUsd  = th * density;
  $("#li-fair").textContent = `${fairPct.toFixed(3)}% of league · ≈ ${fmtUsd(fairUsd)} (before luck/boost variance)`;
}
$("#in-th").addEventListener("input", updateFairShare);
$("#in-league-size").addEventListener("input", updateFairShare);

$("#btn-run").addEventListener("click", () => render(simulate()));

$("#in-pps").addEventListener("input", updateBoost);
$("#in-clan-gmt").addEventListener("input", updateRoyalty);
$("#in-gmt").addEventListener("input", updateRoyalty);

// Spell Bot wiring
$("#bot-export").addEventListener("click", exportBotConfig);
$("#bot-preset-conserv").addEventListener("click", () => preset("conservative"));
$("#bot-preset-aggro").addEventListener("click",   () => preset("aggressive"));
$("#bot-preset-clear").addEventListener("click",   () => preset("clear"));
$("#bot-edge-rate").addEventListener("input", renderBot);
$("#bot-blocks-per-tier").addEventListener("input", renderBot);
$("#in-gmt").addEventListener("input", renderBot);    // GMT price affects USD math

// ---- sidebar tabs ----
function switchTab(name) {
  document.querySelectorAll(".mw-nav-item").forEach(b =>
    b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".mw-tab").forEach(s =>
    s.classList.toggle("active", s.dataset.tab === name));
  window.scrollTo(0, 0);
}
document.querySelectorAll(".mw-nav-item").forEach(btn =>
  btn.addEventListener("click", () => switchTab(btn.dataset.tab)));

// dashboard "jump to tab" buttons
document.querySelectorAll("[data-jump]").forEach(btn =>
  btn.addEventListener("click", () => switchTab(btn.dataset.jump)));

// ---- live dashboard wiring: any input change updates KPIs ----
const DASH_INPUTS = [
  "#in-th","#in-eff","#in-btc","#in-net","#in-block","#in-elec",
  "#in-disc-service","#in-disc-mining","#in-disc-vip","#in-disc-token",
  "#in-league-wth","#in-league-size","#in-war-gross","#in-war-gmt","#in-gmt",
  "#bot-edge-rate","#bot-blocks-per-tier",
  // new war-week adjustment inputs
  "#in-elig-mining","#in-elig-wars","#in-boost-spend","#in-is-leader","#in-member-gmt",
];
DASH_INPUTS.forEach(sel => {
  const el = document.querySelector(sel);
  if (el) el.addEventListener("input", updateDashboard);
});

// ---- Manual-override flag ----
// Any time a user types/changes a Setup input, flag it as `data-manual=1` so
// future autosyncs from the extension don't clobber their value. Spell-bot
// inputs (#bot-*) are intentionally NOT flagged here — those stay manual by
// design and live data only suggests defaults via rebuildBotForLeague().
const MANUAL_FLAG_INPUTS = [
  "#in-th","#in-eff","#in-btc","#in-net","#in-block","#in-elec",
  "#in-disc-service","#in-disc-mining","#in-disc-vip","#in-disc-token",
  "#in-league-wth","#in-league-size","#in-war-gross","#in-war-gmt","#in-gmt",
  "#in-pps","#in-clan-gmt",
  "#in-elig-mining","#in-elig-wars","#in-boost-spend","#in-is-leader","#in-member-gmt",
];
function flagManual(e) {
  const el = e.target;
  if (!el) return;
  el.dataset.manual = "1";
  el.dataset.live = "";
  // Show a tiny restore button next to the field
  const lab = el.closest(".price-input,.toggle-row,.field");
  if (lab && !lab.querySelector(".reset-live-btn")) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "reset-live-btn";
    btn.textContent = "↻ live";
    btn.title = "Reset this field to the latest live value from the extension";
    btn.addEventListener("click", () => {
      el.dataset.manual = "";
      btn.remove();
      loadLiveData();   // re-pull and re-fill non-manual fields
    });
    lab.appendChild(btn);
  }
}
MANUAL_FLAG_INPUTS.forEach(sel => {
  const el = document.querySelector(sel);
  if (!el) return;
  el.addEventListener("input",  flagManual);
  el.addEventListener("change", flagManual);
});
// league click also refreshes dashboard
document.querySelectorAll(".league-btn").forEach(btn =>
  btn.addEventListener("click", () => setTimeout(updateDashboard, 0)));

// ---- Tools tab: ROI + discount calculators ----
$("#in-prize-usd")?.addEventListener("input", updateRoiMax);
$("#in-prob-lift")?.addEventListener("input", updateRoiMax);
$("#in-prepaid-days")?.addEventListener("input", updateDiscount);

// initial paint
updateBoost();
updateRoyalty();
renderFreqRow();
renderBot();
updateRoiMax();
updateDiscount();
updateDashboard();

// Try to pull live extension data on page load (no-op if extension not installed)
loadLiveData();
