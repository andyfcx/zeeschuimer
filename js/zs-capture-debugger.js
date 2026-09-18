/**
 * Response capture via the DevTools protocol
 *
 * Firefox can read response bodies straight from the request with
 * webRequest.filterResponseData(); Chrome has no equivalent API. Reading them
 * in the page instead is not an option either: a content script injected into
 * the page's own context is subject to the page's content security policy, and
 * the platforms Zeeschuimer supports (Facebook in particular) do not allow
 * extension scripts.
 *
 * What is left is the same protocol the developer tools use. This attaches to
 * tabs showing a platform that capture is enabled for, and reads the bodies of
 * the documents and API responses they load. Chrome shows a notification bar
 * in tabs this is active in, and the developer tools cannot be used in a tab
 * while it is.
 *
 * Only used on Chrome; on Firefox this file does nothing.
 */
(function (global) {
    const browser = global.browser;

    if (global.zs_can_filter_responses) {
        // Firefox reads response bodies from the request itself
        return;
    }

    if (!browser || !browser.debugger) {
        // without the debugging permission there is no way to read a response
        // body in Chrome at all, so say so rather than capture nothing quietly
        zeeschuimer.capture_stats.mechanism = 'nothing: the debugging permission is missing';
        zeeschuimer.capture_stats.last_error = 'Remove Zeeschuimer in chrome://extensions and load it again to ' +
            'grant the debugging permission it needs to capture.';
        return;
    }

    const protocol_version = '1.3';

    // the request types worth reading: the document itself, and the API calls
    // a platform makes while browsing it
    const capture_types = ['Document', 'XHR', 'Fetch'];

    // tabs we are attached to, and the responses we are waiting for per tab
    const attached_tabs = new Set();
    const pending_responses = new Map();

    function response_key(tab_id, request_id) {
        return tab_id + ':' + request_id;
    }

    function update_stats() {
        zeeschuimer.capture_stats.attached_tabs = attached_tabs.size;
    }

    /**
     * Forget the responses we were waiting for in a tab
     * @param tab_id  Tab ID
     */
    function forget_tab(tab_id) {
        for (const key of Array.from(pending_responses.keys())) {
            if (key.indexOf(tab_id + ':') === 0) {
                pending_responses.delete(key);
            }
        }
    }

    /**
     * Start capturing in a tab
     * @param tab_id  Tab ID
     * @returns {Promise<void>}
     */
    async function attach(tab_id) {
        if (attached_tabs.has(tab_id)) {
            return;
        }

        // added before attaching so that two events for the same tab arriving
        // in quick succession do not both attach
        attached_tabs.add(tab_id);
        update_stats();

        try {
            await browser.debugger.attach({tabId: tab_id}, protocol_version);
        } catch (error) {
            const message = String(error && error.message ? error.message : error);
            if (message.indexOf('Another debugger') === -1 && message.indexOf('already attached') === -1) {
                // the tab has its developer tools open, or is not debuggable
                attached_tabs.delete(tab_id);
                update_stats();
                zeeschuimer.capture_stats.last_error = message;
                return;
            }
            // we are attached already, from before the background context
            // restarted; carry on and make sure events are still coming in
        }

        try {
            await browser.debugger.sendCommand({tabId: tab_id}, 'Network.enable');
            zeeschuimer.capture_stats.last_error = null;
        } catch (error) {
            attached_tabs.delete(tab_id);
            update_stats();
            zeeschuimer.capture_stats.last_error = String(error && error.message ? error.message : error);
        }
    }

    /**
     * Stop capturing in a tab
     * @param tab_id  Tab ID
     * @returns {Promise<void>}
     */
    async function detach(tab_id) {
        if (!attached_tabs.has(tab_id)) {
            return;
        }

        attached_tabs.delete(tab_id);
        forget_tab(tab_id);
        update_stats();

        try {
            await browser.debugger.detach({tabId: tab_id});
        } catch (e) {
            // already gone
        }
    }

    /**
     * Attach to or detach from a tab, depending on what it is showing
     *
     * @param tab_id  Tab ID
     * @param url  URL the tab is showing or navigating to
     * @returns {Promise<void>}
     */
    async function sync_tab(tab_id, url) {
        if (typeof tab_id !== 'number' || !url || url.indexOf('http') !== 0) {
            return;
        }

        try {
            await global.zeeschuimer_ready;
            const enabled_modules = await zeeschuimer.get_enabled_modules(url, url);

            if (enabled_modules.length > 0) {
                await attach(tab_id);
            } else {
                await detach(tab_id);
            }
        } catch (error) {
            zeeschuimer.capture_stats.last_error = 'Could not start capturing in a tab: ' +
                String(error && error.message ? error.message : error);
        }
    }

    /**
     * Go through all open tabs
     *
     * Called when capture is switched on or off for a platform, and when the
     * background context (re)starts.
     *
     * @returns {Promise<void>}
     */
    async function sync_all_tabs() {
        let tabs;
        try {
            tabs = await browser.tabs.query({});
        } catch (e) {
            return;
        }

        for (const tab of tabs) {
            await sync_tab(tab.id, tab.url);
        }
    }

    /**
     * Get the response body from a getResponseBody result
     * @param result  Result of the Network.getResponseBody command
     * @returns {string}
     */
    function decode_body(result) {
        if (!result || !result.body) {
            return '';
        }

        if (!result.base64Encoded) {
            return result.body;
        }

        const bytes = Uint8Array.from(atob(result.body), character => character.charCodeAt(0));
        return new TextDecoder('utf-8').decode(bytes);
    }

    browser.debugger.onEvent.addListener(async function (source, method, params) {
        const tab_id = source.tabId;
        if (typeof tab_id !== 'number' || !attached_tabs.has(tab_id) || !params) {
            return;
        }

        if (method === 'Network.responseReceived') {
            if (capture_types.indexOf(params.type) === -1) {
                return;
            }
            pending_responses.set(response_key(tab_id, params.requestId), params.response ? params.response.url : null);
            return;
        }

        if (method === 'Network.loadingFailed') {
            pending_responses.delete(response_key(tab_id, params.requestId));
            return;
        }

        if (method !== 'Network.loadingFinished') {
            return;
        }

        const key = response_key(tab_id, params.requestId);
        if (!pending_responses.has(key)) {
            return;
        }

        const document_url = pending_responses.get(key);
        pending_responses.delete(key);
        if (!document_url) {
            return;
        }

        let body;
        try {
            const result = await browser.debugger.sendCommand({tabId: tab_id}, 'Network.getResponseBody',
                {requestId: params.requestId});
            body = decode_body(result);
        } catch (e) {
            // the body is no longer available, e.g. because it was evicted
            return;
        }

        if (!body) {
            return;
        }

        // the URL of the page the response was loaded for, which is what the
        // modules match on
        let origin_url = document_url;
        try {
            const tab = await browser.tabs.get(tab_id);
            origin_url = tab.url || document_url;
        } catch (e) {
            // tab is gone; fall back to the response's own URL
        }

        try {
            await zeeschuimer.handle_capture(body, document_url, origin_url, tab_id);
        } catch (error) {
            zeeschuimer.capture_stats.last_error = 'Could not process a captured response: ' +
                String(error && error.message ? error.message : error);
        }
    });

    browser.debugger.onDetach.addListener(function (source, reason) {
        if (typeof source.tabId !== 'number') {
            return;
        }

        attached_tabs.delete(source.tabId);
        forget_tab(source.tabId);
        update_stats();

        if (reason && reason !== 'target_closed') {
            zeeschuimer.capture_stats.last_error = 'Capture was interrupted in a tab (' + reason + '). ' +
                'Close the developer tools in that tab and reload the page to resume.';
        }
    });

    browser.tabs.onRemoved.addListener(function (tab_id) {
        attached_tabs.delete(tab_id);
        forget_tab(tab_id);
        update_stats();
    });

    browser.tabs.onUpdated.addListener(function (tab_id, change_info, tab) {
        if (change_info.url || change_info.status === 'loading') {
            sync_tab(tab_id, tab ? tab.url : change_info.url);
        }
    });

    // attaching here, before the request is made, is what makes it possible to
    // capture the document of a page that is being opened
    browser.webNavigation.onBeforeNavigate.addListener(function (details) {
        if (details.frameId === 0) {
            sync_tab(details.tabId, details.url);
        }
    });

    browser.storage.onChanged.addListener(function (changes, area) {
        if (area === 'local' && Object.keys(changes).some(key => key.indexOf('zs-enabled-') === 0)) {
            sync_all_tabs();
        }
    });

    global.zeeschuimer_ready.then(sync_all_tabs);
})(typeof self !== 'undefined' ? self : this);
