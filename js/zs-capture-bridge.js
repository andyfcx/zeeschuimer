/**
 * Response capture (content script context)
 *
 * Relays responses captured by js/zs-capture-main.js in the page context to
 * the background context, which parses them with the Zeeschuimer modules. Also
 * sends the page's own HTML, which is what the modules that read data embedded
 * in the document (TikTok, RedNote, ...) need, and which cannot be captured by
 * wrapping fetch().
 *
 * Only used on Chrome; on Firefox the background context reads responses
 * itself, without any content script.
 */
(function () {
    const api = typeof browser !== 'undefined' ? browser : chrome;
    let capture_enabled = false;
    let document_sent_for = null;

    window.addEventListener('message', function (event) {
        if (event.source !== window || !event.data || event.data.type !== 'zeeschuimer-capture-data') {
            return;
        }

        send_capture(event.data.url, event.data.body);
    });

    /**
     * Send a captured response to the background context
     *
     * @param url  URL the response was loaded from
     * @param body  Response body
     */
    function send_capture(url, body) {
        try {
            api.runtime.sendMessage({
                type: 'zeeschuimer-capture',
                url: url,
                body: body,
                origin_url: window.location.href
            }, function () {
                // reading lastError keeps Chrome from logging 'unchecked
                // runtime.lastError' when the background context is asleep
                void api.runtime.lastError;
            });
        } catch (e) {
            // extension context invalidated, e.g. after an update or reload
        }
    }

    /**
     * Send the page's own HTML, once per page
     *
     * This stands in for the 'main_frame' request Firefox captures. The
     * serialised DOM is not byte for byte identical to the response body, but
     * the JSON embedded in script tags, which is what the modules look for, is
     * preserved.
     */
    function send_document() {
        if (!capture_enabled || document_sent_for === window.location.href) {
            return;
        }

        if (document.readyState === 'loading') {
            window.addEventListener('DOMContentLoaded', send_document, {once: true});
            return;
        }

        document_sent_for = window.location.href;
        send_capture(window.location.href, '<!DOCTYPE html>\n' + document.documentElement.outerHTML);
    }

    /**
     * Tell the page context whether to capture at all
     *
     * Capture stays off while no Zeeschuimer module for this page is enabled,
     * so that browsing is not slowed down for nothing. Toggles in the
     * interface are picked up on the next check.
     */
    function refresh_state() {
        try {
            api.runtime.sendMessage({
                type: 'zeeschuimer-capture-enabled',
                url: window.location.href
            }, function (enabled) {
                if (api.runtime.lastError) {
                    return;
                }

                capture_enabled = !!enabled;
                window.postMessage({type: 'zeeschuimer-capture-state', enabled: capture_enabled}, '*');
                send_document();
            });
        } catch (e) {
            // extension context invalidated
        }
    }

    refresh_state();
    setInterval(refresh_state, 5000);
})();
