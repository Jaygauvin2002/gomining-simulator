// GoMining Sync Bridge — Content script for simulator pages
// Watches chrome.storage for instant updates + polls as a fallback

(function() {
    'use strict';

    const POLL_INTERVAL = 15000;
    const STORAGE_KEY = 'gomining_autosync';

    let pollHandle = null;
    let invalidated = false;

    // Detect if the extension context has been invalidated (e.g. after a
    // reload/upgrade of the unpacked extension). Once invalidated, stop
    // touching chrome.* APIs — the page will pick up the new bridge from
    // the next page load instead of spamming errors.
    function isContextValid() {
        try { return !!(chrome && chrome.runtime && chrome.runtime.id); }
        catch { return false; }
    }
    function markInvalidated(why) {
        if (invalidated) return;
        invalidated = true;
        if (pollHandle) { clearInterval(pollHandle); pollHandle = null; }
        // Quiet, single-line note. No stack-spam in console.
        console.info('[GoMining bridge] context invalidated — reload the page to reconnect (' + (why || 'unknown') + ')');
    }

    function writeToLocalStorage(data) {
        // If the extension reloaded between the chrome.storage.local.get
        // call and this callback, ANY further chrome.* touch throws. We're
        // only doing localStorage here, but the surrounding closure may
        // still hold a stale callback ref — bail early if invalidated.
        if (invalidated || !isContextValid()) { markInvalidated('writeToLocalStorage'); return; }
        try {
            const json = JSON.stringify(data);
            const prev = window.localStorage.getItem(STORAGE_KEY);
            if (json === prev) return;
            window.localStorage.setItem(STORAGE_KEY, json);
            // StorageEvent only fires across tabs/windows, NOT in the window
            // that wrote the value. Dispatch BOTH a synthetic StorageEvent
            // (for any cross-tab style listeners) and a CustomEvent on
            // document so same-window listeners actually receive it.
            try {
                window.dispatchEvent(new StorageEvent('storage', {
                    key: STORAGE_KEY, oldValue: prev, newValue: json,
                    storageArea: window.localStorage
                }));
            } catch {}
            try {
                document.dispatchEvent(new CustomEvent('gomining-autosync', {
                    detail: { key: STORAGE_KEY, json }
                }));
            } catch {}
        } catch (e) { /* never throw out of the bridge */ }
    }

    // Instant sync — a content script can watch chrome.storage directly, so
    // the extractor's write reaches us with no round-trip through a service
    // worker. (The old path went background.js -> chrome.tabs.query({url}) ->
    // sendMessage, but that query needs the "tabs" permission or a host
    // permission we don't hold, so it always failed and the push never
    // arrived — the poll below was doing all the work, up to 15s late.)
    try {
        chrome.storage.onChanged.addListener((changes, area) => {
            if (invalidated || !isContextValid()) return;
            if (area !== 'local' || !changes.gominingAutoSync) return;
            const data = changes.gominingAutoSync.newValue;
            if (data) writeToLocalStorage(data);
        });
    } catch (e) { markInvalidated('storage.onChanged'); }

    // Le simulateur garde un instantané de chaque visite dans son propre
    // localStorage : date, prix du BTC, stratégie optimale du moment. On le
    // recopie dans chrome.storage pour que le panneau injecté sur
    // app.gomining.com puisse dire ce qui a bougé depuis — l'extension n'a
    // aucun autre moyen de savoir quand GMSim a été ouvert pour la dernière fois.
    function mirrorVisitSnapshot() {
        if (invalidated || !isContextValid()) return;
        try {
            const raw = window.localStorage.getItem('gms_last_visit');
            if (!raw) return;
            const snap = JSON.parse(raw);
            if (!snap || !snap.t || !snap.btc) return;
            chrome.storage.local.set({ gmsLastVisit: snap }, function () {
                void chrome.runtime.lastError;
            });
        } catch (e) { /* ne jamais faire tomber le bridge pour ça */ }
    }

    // Poll fallback — guard against invalidated context every tick
    function syncData() {
        if (!isContextValid()) { markInvalidated('isContextValid=false'); return; }
        try {
            chrome.storage.local.get('gominingAutoSync', (result) => {
                if (chrome.runtime.lastError || !result || !result.gominingAutoSync) return;
                writeToLocalStorage(result.gominingAutoSync);
            });
        } catch (e) {
            markInvalidated(e && e.message);
        }
    }

    // Signal to the simulator that the extension is present
    try { document.dispatchEvent(new Event('gomining-bridge-ready')); } catch {}

    // Initial sync + polling fallback
    setTimeout(syncData, 1000);
    pollHandle = setInterval(syncData, POLL_INTERVAL);

    // L'instantané est écrit par le simulateur une fois ses données posées :
    // on le relit un peu plus tard, puis à chaque tour de poll.
    setTimeout(mirrorVisitSnapshot, 8000);
    setInterval(mirrorVisitSnapshot, POLL_INTERVAL);
})();
