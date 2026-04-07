/**
 * Zeeschuimer — Firefox adapter (Manifest V2)
 *
 * Extends the global `zeeschuimer` with Firefox-specific capabilities:
 *   - Request interception via browser.webRequest.filterResponseData
 *   - Session initialization and browser icon sync via browserAction
 *   - Popup tab open/focus handling
 *
 * Requires (loaded before this file via manifest background.scripts):
 *   inc/dexie.js, inc/he.js
 *   js/lib.js, js/database.js, js/registry.js, js/pipeline.js, js/navigation.js
 *   modules/*.js
 */
Object.assign(zeeschuimer, {

    /**
     * Initialise session counter and start icon-sync interval.
     */
    init: async function () {
        let session = await db.settings.get("session");
        if (!session) {
            session = {"key": "session", "value": 0};
            await db.settings.add(session);
        }

        session["value"] += 1;
        this.session = session["value"];
        await db.settings.update("session", session);
        await db.nav.where("session").notEqual(this.session).delete();

        // Keep browser icon in sync with whether any capture is enabled
        setInterval(async function () {
            let enabled = [];
            for (const module in zeeschuimer.modules) {
                const enabled_key = 'zs-enabled-' + module;
                const is_enabled = await browser.storage.local.get(enabled_key);
                if (is_enabled.hasOwnProperty(enabled_key) && !!parseInt(is_enabled[enabled_key])) {
                    enabled.push(module);
                }
            }
            const path = enabled.length > 0
                ? 'images/zeeschuimer-icon-active.png'
                : 'images/zeeschuimer-icon-inactive.png';
            browser.browserAction.setIcon({path: path});
        }, 500);
    },

    /**
     * Firefox webRequest listener.
     * Intercepts every HTTPS main_frame and xmlhttprequest, buffers the full
     * response body, then passes it to parse_request for all eligible modules.
     */
    listener: function (details) {
        let filter = browser.webRequest.filterResponseData(details.requestId);
        let decoder = new TextDecoder("utf-8");
        let full_response = '';

        const document_url = details.url;
        const origin_url = details.hasOwnProperty("originUrl") && details.originUrl
            ? details.originUrl
            : document_url;

        const document_source_domain = document_url.split('://').pop().split('/')[0].replace(/^www\./, '').toLowerCase();
        const possible_source_domains = [
            document_source_domain,
            origin_url.split('://').pop().split('/')[0].replace(/^www\./, '').toLowerCase()
        ];

        // Pre-filter to modules whose domain matches this request
        const eligible_modules = Object.fromEntries(
            Object.entries(zeeschuimer.modules).filter(entry =>
                possible_source_domains.some(domain => domain.endsWith(entry[1]["domain"].toLowerCase()))
            )
        );

        filter.ondata = event => {
            full_response += decoder.decode(event.data, {stream: true});
            filter.write(event.data);
        };

        filter.onstop = async (event) => {
            // Further filter to modules that are also enabled in storage
            let enabled_modules = [];
            for (const module_id in eligible_modules) {
                const key = 'zs-enabled-' + module_id;
                let stored = await browser.storage.local.get(key);
                if (stored.hasOwnProperty(key) && !!parseInt(stored[key])) {
                    enabled_modules.push(module_id);
                }
            }
            await zeeschuimer.parse_request(full_response, origin_url, document_url, details.tabId, enabled_modules);
            filter.disconnect();
            full_response = '';
        };

        return {};
    },

    /**
     * Return the open popup tab if one exists, otherwise false.
     */
    has_tab: async function () {
        const tabs = await browser.tabs.query({});
        const full_url = browser.runtime.getURL('popup/interface.html');
        const tab = tabs.find(t => t.url === full_url);
        return tab || false;
    }
});

// Boot
zeeschuimer.init();

browser.webRequest.onBeforeRequest.addListener(
    zeeschuimer.listener,
    {urls: ["https://*/*"], types: ["main_frame", "xmlhttprequest"]},
    ["blocking"]
);

browser.webNavigation.onCommitted.addListener(zeeschuimer.nav_handler);

browser.browserAction.onClicked.addListener(async () => {
    let tab = await zeeschuimer.has_tab();
    if (!tab) {
        browser.tabs.create({url: 'popup/interface.html'});
    } else if (!tab.active) {
        browser.tabs.update(tab.id, {active: true});
    }
});
