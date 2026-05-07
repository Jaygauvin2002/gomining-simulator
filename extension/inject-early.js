// inject-early.js — runs at `document_start`, before any page script.
//
// Purpose: inject the network interceptor as early as possible so that
// the page's initial fetches AND WebSocket connections are captured
// from the very first request. extractor.js runs at `document_idle`,
// which is far too late for SPAs that load all their data on init.
//
// Also installs a small buffer (`window.__gmMsgBuffer`) that collects
// intercepted messages while extractor.js isn't yet listening. extractor
// drains the buffer on startup, then takes over.

(function () {
    if (window.__gmEarlyInjected) return;
    window.__gmEarlyInjected = true;

    // Buffer messages until extractor.js attaches its listener
    window.__gmMsgBuffer = [];
    window.addEventListener('message', function bufferEarly(event) {
        try {
            if (event.source !== window) return;
            const t = event.data && event.data.type;
            if (t !== 'GOMINING_FETCH' && t !== 'GOMINING_XHR' &&
                t !== 'GOMINING_WS' && t !== 'GOMINING_SSE') return;
            if (!window.__gmMsgBuffer) return; // extractor took over → stop buffering
            window.__gmMsgBuffer.push(event.data);
        } catch (_) {}
    });

    // Inject the interceptor into the page's main world so it can hook
    // window.fetch / XMLHttpRequest / WebSocket / EventSource.
    try {
        const script = document.createElement('script');
        script.src = chrome.runtime.getURL('interceptor.js');
        (document.head || document.documentElement).appendChild(script);
        script.onload = () => script.remove();
    } catch (e) {
        try { console.warn('[GoMining Extractor] early-inject failed:', e); } catch (_) {}
    }
})();
