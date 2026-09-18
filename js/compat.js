/**
 * Cross-browser compatibility shim
 *
 * Firefox exposes the promise-based `browser` namespace; Chrome only has
 * `chrome` (which is promise-based as well since Chrome 88 for the APIs used
 * here). This makes `browser` available everywhere, and normalises the
 * browser action API, which is called `browserAction` in manifest v2 and
 * `action` in manifest v3.
 *
 * Loaded first in both the background context and the extension's own pages.
 */
(function (global) {
    if (typeof global.browser === 'undefined' && typeof global.chrome !== 'undefined') {
        global.browser = global.chrome;
    }

    const api = global.browser;

    // browserAction (mv2, Firefox) versus action (mv3, Chrome)
    global.zs_action = api && (api.action || api.browserAction);

    // Firefox can read response bodies straight from the request; Chrome
    // cannot, and uses content scripts to capture them instead.
    global.zs_can_filter_responses = !!(api && api.webRequest && api.webRequest.filterResponseData);
})(typeof self !== 'undefined' ? self : this);
