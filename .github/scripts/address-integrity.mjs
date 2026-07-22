// Fetches the live donation page and verifies the BTC address hasn't changed.
// If it differs from the expected value (or can't be found), pings Telegram —
// this is a tamper/defacement alarm for the donation address.
const EXPECTED = process.env.EXPECTED;
const PAGE_URL = process.env.PAGE_URL;
const TG_TOKEN = process.env.TG_TOKEN;
const TG_CHAT = process.env.TG_CHAT;

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

// Cache-bust so we read the freshly deployed page, not a CDN copy.
const url = PAGE_URL + (PAGE_URL.includes('?') ? '&' : '?') + 'cb=' + Date.now();
const res = await fetch(url, { headers: { 'cache-control': 'no-cache' } });
if (!res.ok) {
  await tg(`⚠️ <b>Address monitor</b>: could not fetch ${PAGE_URL} (HTTP ${res.status}).`);
  process.exit(1);
}
const html = await res.text();

const m = html.match(/BTC_ADDRESS\s*=\s*["']([^"']+)["']/);
if (!m) {
  await tg(
    `⚠️ <b>Address monitor</b>: BTC_ADDRESS not found on ${PAGE_URL}.\n` +
    `Page structure may have changed — verify the donation address manually.`
  );
  process.exit(1);
}

const found = m[1];
if (found !== EXPECTED) {
  await tg(
    `🚨 <b>DONATION ADDRESS CHANGED</b> 🚨\n` +
    `Expected: <code>${EXPECTED}</code>\n` +
    `Found:    <code>${found}</code>\n` +
    `Page: ${PAGE_URL}\n` +
    `Possible site tampering — investigate immediately.`
  );
  process.exit(1);
}

console.log('Address OK:', found);
