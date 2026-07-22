// Watches a BTC address for new incoming transactions and pings Telegram.
// Runs in GitHub Actions on a cron; dedup state persisted via actions/cache.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const ADDR = process.env.ADDR;
const TG_TOKEN = process.env.TG_TOKEN;
const TG_CHAT = process.env.TG_CHAT;
const HAD_CACHE = process.env.HAD_CACHE === 'true'; // false on the very first run
const STATE = 'seen.json';

async function tg(text) {
  if (!TG_TOKEN || !TG_CHAT) {
    console.log('[no Telegram creds — would send]\n' + text);
    return;
  }
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: TG_CHAT,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });
  if (!r.ok) throw new Error('Telegram send failed: ' + r.status + ' ' + (await r.text()));
}

// mempool.space returns the most recent txs (confirmed + mempool), newest first.
const res = await fetch(`https://mempool.space/api/address/${ADDR}/txs`);
if (!res.ok) throw new Error('mempool.space API ' + res.status);
const txs = await res.json();

let seen = [];
if (existsSync(STATE)) {
  try { seen = JSON.parse(readFileSync(STATE, 'utf8')); } catch {}
}
const seenSet = new Set(seen);

// Only txs that actually pay TO our address (ignore any spends from it).
const incoming = txs.filter(tx => tx.vout.some(o => o.scriptpubkey_address === ADDR));

if (!HAD_CACHE) {
  // First-ever run: record existing history as "seen" WITHOUT alerting, so we
  // don't spam the entire past. Real-time alerting starts from the next run.
  const all = incoming.map(t => t.txid);
  writeFileSync(STATE, JSON.stringify(all));
  console.log(`Bootstrap: recorded ${all.length} existing tx(s), no alerts sent.`);
  process.exit(0);
}

const fresh = incoming.filter(t => !seenSet.has(t.txid));

// Fetch the current BTC/USD price once (only if we have something to report).
let usdPrice = null;
if (fresh.length) {
  try {
    const pr = await fetch('https://mempool.space/api/v1/prices');
    if (pr.ok) {
      const pj = await pr.json();
      if (typeof pj.USD === 'number') usdPrice = pj.USD;
    }
  } catch { /* price is best-effort; alert still fires without it */ }
}

// Oldest-first so alerts arrive in chronological order.
for (const tx of fresh.reverse()) {
  const sats = tx.vout
    .filter(o => o.scriptpubkey_address === ADDR)
    .reduce((s, o) => s + o.value, 0);
  const btc = (sats / 1e8).toFixed(8);
  const usd = usdPrice != null
    ? ' · ≈ $' + (sats / 1e8 * usdPrice).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' USD'
    : '';
  const status = tx.status?.confirmed ? '✅ confirmed' : '⏳ unconfirmed (in mempool)';
  await tg(
    `🟢 <b>New BTC donation</b>\n` +
    `<b>${btc} BTC</b>${usd}\n` +
    `${sats.toLocaleString('en-US')} sats · ${status}\n` +
    `https://mempool.space/tx/${tx.txid}`
  );
  seenSet.add(tx.txid);
}
writeFileSync(STATE, JSON.stringify([...seenSet]));
console.log(`Checked ${incoming.length} incoming tx(s); ${fresh.length} new; alerts sent.`);
