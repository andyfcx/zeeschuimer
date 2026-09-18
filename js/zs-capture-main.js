/**
 * Response capture (page context)
 *
 * Firefox lets an extension read response bodies from the background context
 * with webRequest.filterResponseData(); Chrome has no such API. This script is
 * therefore injected into the page itself (the 'MAIN' world) on Chrome, where
 * it wraps fetch() and XMLHttpRequest to get at the same data.
 *
 * Because page context scripts have no access to the extension APIs, captured
 * responses are posted to the window, where js/zs-capture-bridge.js picks them
 * up and forwards them to the background context.
 */
(function () {
    const marker = '__zeeschuimer_capture__';
    if (window[marker]) {
        return;
    }
    window[marker] = true;

    // responses larger than this are skipped; they are never the API responses
    // we are after, and they would be expensive to copy between contexts
    const max_size = 16 * 1024 * 1024;

    // null while the background context has not told us yet whether any module
    // is enabled for this page; captures made before that are buffered
    let capture_enabled = null;
    let buffer = [];
    let buffered_size = 0;
    const max_buffered = 200;
    const max_buffered_size = 32 * 1024 * 1024;

    window.addEventListener('message', function (event) {
        if (event.source !== window || !event.data) {
            return;
        }

        if (event.data.type === 'zeeschuimer-capture-ping') {
            window.postMessage({type: 'zeeschuimer-capture-pong'}, '*');
            return;
        }

        if (event.data.type !== 'zeeschuimer-capture-state') {
            return;
        }

        capture_enabled = !!event.data.enabled;
        const buffered = buffer;
        buffer = [];
        buffered_size = 0;
        if (capture_enabled) {
            buffered.forEach(capture => relay(capture.url, capture.body));
        }
    });

    /**
     * Pass a captured response on to the content script
     *
     * @param url  URL the response was loaded from
     * @param body  Response body
     */
    function relay(url, body) {
        if (!body || typeof body !== 'string' || body.length > max_size) {
            return;
        }

        let absolute_url;
        try {
            absolute_url = new URL(url, window.location.href).href;
        } catch (e) {
            absolute_url = String(url);
        }

        if (capture_enabled === null) {
            if (buffer.length < max_buffered && buffered_size + body.length <= max_buffered_size) {
                buffer.push({url: absolute_url, body: body});
                buffered_size += body.length;
            }
            return;
        }

        if (!capture_enabled) {
            return;
        }

        window.postMessage({type: 'zeeschuimer-capture-data', url: absolute_url, body: body}, '*');
    }

    const original_fetch = window.fetch;
    if (typeof original_fetch === 'function') {
        window.fetch = function (...args) {
            const response_promise = original_fetch.apply(this, args);

            response_promise.then(response => {
                if (capture_enabled === false || !response) {
                    return;
                }

                // the response is cloned so that reading it here does not
                // consume the body the page itself is waiting for
                try {
                    const request_url = response.url || (typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url));
                    response.clone().text().then(body => relay(request_url, body)).catch(() => {});
                } catch (e) {
                    // response body not readable, e.g. an opaque response
                }
            }).catch(() => {});

            return response_promise;
        };
    }

    const original_open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        this[marker + 'url'] = url;

        if (!this[marker + 'hooked']) {
            this[marker + 'hooked'] = true;
            this.addEventListener('load', function () {
                if (capture_enabled === false) {
                    return;
                }

                try {
                    // responseText is only available for these response types
                    if (this.responseType && this.responseType !== 'text') {
                        return;
                    }
                    relay(this.responseURL || this[marker + 'url'], this.responseText);
                } catch (e) {
                    // response body not readable
                }
            });
        }

        return original_open.call(this, method, url, ...rest);
    };
})();
