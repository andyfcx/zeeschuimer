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
    let page_script_present = false;

    window.addEventListener('message', function (event) {
        if (event.source !== window || !event.data) {
            return;
        }

        if (event.data.type === 'zeeschuimer-capture-pong') {
            page_script_present = true;
            return;
        }

        if (event.data.type === 'zeeschuimer-capture-data') {
            send_capture(event.data.url, event.data.body);
        }
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
     * Make sure the page context script is running
     *
     * It is normally injected by the browser, as declared in the manifest, but
     * that can fail (for example when a site's content security policy
     * interferes), in which case it is injected as a script tag here instead.
     * The page context answers a ping to say it is there.
     */
    function ensure_page_script() {
        window.postMessage({type: 'zeeschuimer-capture-ping'}, '*');

        setTimeout(function () {
            if (page_script_present) {
                return;
            }

            try {
                const script = document.createElement('script');
                script.src = api.runtime.getURL('js/zs-capture-main.js');
                script.addEventListener('load', function () {
                    script.remove();
                    window.postMessage({type: 'zeeschuimer-capture-ping'}, '*');
                    window.postMessage({type: 'zeeschuimer-capture-state', enabled: capture_enabled}, '*');
                });
                (document.head || document.documentElement).appendChild(script);
            } catch (e) {
                console.warn('Zeeschuimer could not install its capture script in this page: ' + e);
            }
        }, 1000);
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
     * so that browsing is not slowed down for nothing.
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

    ensure_page_script();
    refresh_state();

    // toggling capture in the interface takes effect immediately; the interval
    // is a backstop in case a storage event is missed
    if (api.storage && api.storage.onChanged) {
        api.storage.onChanged.addListener(function (changes, area) {
            if (area === 'local' && Object.keys(changes).some(key => key.indexOf('zs-enabled-') === 0)) {
                refresh_state();
            }
        });
    }
    setInterval(refresh_state, 15000);
})();
