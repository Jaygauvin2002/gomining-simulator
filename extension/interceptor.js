// Ce script est injecté dans la page pour intercepter les requêtes
// fetch / XMLHttpRequest / WebSocket / EventSource (SSE).
// Il tourne dans le contexte de la page (pas du content script).
//
// We hook ALL data channels because GoMining's frontend uses a mix:
// — fetch & XHR for legacy REST endpoints
// — WebSocket for live streams (e.g. realtime mining data)
// — EventSource for server-sent updates
// Without hooking WS, captured request count drops dramatically because
// the actual data flow has moved off REST.

(function () {
    if (window.__gmInterceptorActive) return;
    window.__gmInterceptorActive = true;

    // === fetch ===
    const originalFetch = window.fetch;
    window.fetch = async function (...args) {
        const response = await originalFetch.apply(this, args);
        let url = '';
        try {
            url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
            if (!url && response && response.url) url = response.url;
        } catch (_) {}

        try {
            const clone = response.clone();
            const text = await clone.text();
            window.postMessage({
                type: 'GOMINING_FETCH',
                url: url,
                status: response.status,
                body: text
            }, '*');
        } catch (e) {}

        return response;
    };

    // === XMLHttpRequest ===
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url) {
        this._gmUrl = url;
        this._gmMethod = method;
        return originalOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function () {
        this.addEventListener('load', function () {
            try {
                window.postMessage({
                    type: 'GOMINING_XHR',
                    url: this._gmUrl,
                    status: this.status,
                    body: this.responseText
                }, '*');
            } catch (e) {}
        });
        return originalSend.apply(this, arguments);
    };

    // === WebSocket ===
    // Proxy the constructor so we can hook the `message` event on every
    // new socket. Preserves prototype + static constants so existing
    // code (instanceof / WebSocket.OPEN / etc.) keeps working.
    try {
        const OriginalWS = window.WebSocket;
        if (OriginalWS && !OriginalWS.__gmHooked) {
            const ProxyWS = function (url, protocols) {
                const ws = protocols !== undefined
                    ? new OriginalWS(url, protocols)
                    : new OriginalWS(url);
                try {
                    ws.addEventListener('message', (event) => {
                        try {
                            // Skip binary frames (could be parsed later if needed).
                            if (typeof event.data !== 'string') return;
                            window.postMessage({
                                type: 'GOMINING_WS',
                                url: String(url),
                                body: event.data
                            }, '*');
                        } catch (_) {}
                    });
                } catch (_) {}
                return ws;
            };
            ProxyWS.prototype = OriginalWS.prototype;
            try {
                ProxyWS.OPEN = OriginalWS.OPEN;
                ProxyWS.CLOSED = OriginalWS.CLOSED;
                ProxyWS.CLOSING = OriginalWS.CLOSING;
                ProxyWS.CONNECTING = OriginalWS.CONNECTING;
            } catch (_) {}
            ProxyWS.__gmHooked = true;
            window.WebSocket = ProxyWS;
        }
    } catch (e) {
        try { console.warn('[GoMining Extractor] WebSocket hook failed:', e); } catch (_) {}
    }

    // === EventSource (Server-Sent Events) ===
    try {
        const OriginalES = window.EventSource;
        if (OriginalES && !OriginalES.__gmHooked) {
            const ProxyES = function (url, init) {
                const es = init !== undefined
                    ? new OriginalES(url, init)
                    : new OriginalES(url);
                try {
                    es.addEventListener('message', (event) => {
                        try {
                            window.postMessage({
                                type: 'GOMINING_SSE',
                                url: String(url),
                                body: String(event.data || '')
                            }, '*');
                        } catch (_) {}
                    });
                } catch (_) {}
                return es;
            };
            ProxyES.prototype = OriginalES.prototype;
            ProxyES.__gmHooked = true;
            window.EventSource = ProxyES;
        }
    } catch (e) {}

    try { console.log('[GoMining Extractor] Intercepteur réseau actif (fetch + XHR + WS + SSE)'); } catch (_) {}
})();
