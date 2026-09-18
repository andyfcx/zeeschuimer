self.db = new Dexie('zeeschuimer-items');
self.db.version(1).stores({
    items: "++id, item_id, nav_index, source_platform",
    uploads: "++id",
    nav: "++id, tab_id, session",
    settings: "key"
});

self.zeeschuimer = {
    modules: {},
    session: null,
    tab_url_map: {},

    // diagnostics, reset whenever the background context starts
    capture_stats: {
        responses: 0,
        responses_matched: 0,
        items: 0,
        last_url: null,
        last_match_url: null,
        attached_tabs: 0,
        last_error: null
    },

    /**
     * Register Zeeschuimer module
     * @param name  Module identifier
     * @param domain  Module primary domain name
     * @param callback  Function to parse request content with, returning an Array of extracted items
     * @param module_id  Module ID; if not given, use domain name as module ID. Use this if multiple modules read from
     *                   the same domain.
     */
    register_module: function (name, domain, callback, module_id=null) {
        if(!module_id) {
            module_id = domain;
        }
        this.modules[module_id] = {
            name: name,
            domain: domain,
            callback: callback
        };
    },

    /**
     * Initialise Zeeschuimer
     * Called on browser session start; increases session index to aid in deduplicating extracted items.
     */
    init: async function () {
        let session;
        session = await db.settings.get("session");
        if (!session) {
            session = {"key": "session", "value": 0};
            await db.settings.add(session);
        }

        session["value"] += 1;
        this.session = session["value"];
        await db.settings.update("session", session);
        await db.nav.where("session").notEqual(this.session).delete();

        // synchronise browser icon with whether capture is enabled or not
        await this.update_icon();
    },

    /**
     * Set the browser icon depending on whether any module is enabled
     */
    update_icon: async function () {
        let enabled = [];
        for (const module_id in this.modules) {
            if (await this.module_is_enabled(module_id)) {
                enabled.push(module_id);
            }
        }

        const path = enabled.length > 0 ? 'images/zeeschuimer-icon-active.png' : 'images/zeeschuimer-icon-inactive.png';
        try {
            await zs_action.setIcon({path: path});
        } catch (e) {
            // the icon is cosmetic; never let it break capturing
        }
    },

    /**
     * Check whether capture is enabled for a given module
     * @param module_id  Module ID
     * @returns {Promise<boolean>}
     */
    module_is_enabled: async function (module_id) {
        const enabled_key = 'zs-enabled-' + module_id;
        const enabled = await browser.storage.local.get(enabled_key);
        return enabled.hasOwnProperty(enabled_key) && !!parseInt(enabled[enabled_key]);
    },

    /**
     * Determine which modules should parse a given request
     *
     * A module is eligible if it listens on the domain of either the captured
     * URL or the URL of the page it was requested from, and if capture is
     * enabled for it.
     *
     * @param document_url  URL of the captured content
     * @param origin_url  URL of the page the content was requested from
     * @returns {Promise<Array>}  List of module IDs
     */
    get_enabled_modules: async function (document_url, origin_url) {
        if (!origin_url) {
            origin_url = document_url;
        }

        const domain_of = (url) => String(url).split('://').pop().split('/')[0].replace(/^www\./, '').toLowerCase();
        const possible_source_domains = [domain_of(document_url), domain_of(origin_url)];

        let enabled_modules = [];
        for (const module_id in this.modules) {
            const domain = this.modules[module_id]['domain'].toLowerCase();
            if (!possible_source_domains.some((source_domain) => source_domain.endsWith(domain))) {
                continue;
            }

            if (await this.module_is_enabled(module_id)) {
                enabled_modules.push(module_id);
            }
        }

        return enabled_modules;
    },

    /**
     * Request listener
     * Filters HTTP requests and passes the content to the parser
     * @param details  Request details
     */
    listener: function (details) {
        let filter = browser.webRequest.filterResponseData(details.requestId);
        let decoder = new TextDecoder("utf-8");
        let full_response = '';

        const document_url = details.url;
        const origin_url = details.hasOwnProperty("originUrl") && details.originUrl ? details.originUrl : document_url;

        filter.ondata = event => {
            let str = decoder.decode(event.data, {stream: true});
            full_response += str;
            filter.write(event.data);
        }

        filter.onstop = async (event) => {
            // pass the document to all eligible modules that are also enabled
            await zeeschuimer.handle_capture(full_response, document_url, origin_url, details.tabId);
            filter.disconnect();
            full_response = '';
        }

        return {};
    },

    /**
     * Handle a captured response
     *
     * Shared by every capture mechanism: it checks which modules want the
     * response, keeps the diagnostics up to date and hands the response to the
     * parser.
     *
     * @param body  Content of the response
     * @param document_url  URL the response was loaded from
     * @param origin_url  URL of the page the response was requested from
     * @param tab_id  ID of the tab the response was captured in
     * @returns {Promise<Object>}  What was done with the response
     */
    handle_capture: async function (body, document_url, origin_url, tab_id) {
        this.capture_stats.responses += 1;
        this.capture_stats.last_url = document_url;

        await self.zeeschuimer_ready;
        const enabled_modules = await this.get_enabled_modules(document_url, origin_url);
        if (enabled_modules.length === 0) {
            return {captured: false, items: 0};
        }

        this.capture_stats.responses_matched += 1;
        this.capture_stats.last_match_url = document_url;

        const items = await this.parse_request(body, origin_url, document_url, tab_id, enabled_modules);
        return {captured: true, items: items};
    },

    /**
     * Parse captured request
     * @param response  Content of the request
     * @param origin_url  URL of the *page* the data was requested from
     * @param document_url  URL of the content that was captured
     * @param tabId  ID of the tab in which the request was captured
     * @param enabled_modules  List of IDs of enabled modules
     */
    parse_request: async function (response, origin_url, document_url, tabId, enabled_modules) {
        if (!origin_url) {
            origin_url = document_url;
        }

        // what url was loaded in the tab the previous time?
        let old_url = '';
        if (tabId in this.tab_url_map) {
            old_url = this.tab_url_map[tabId];
        }

        try {
            // get the *actual url* of the tab, not the url that the request
            // reports, which may be wrong
            let tab = await browser.tabs.get(tabId);
            origin_url = tab.url;
        } catch (Error) {
            tabId = -1;
            // invalid tab id, use provided originUrl
        }

        // sometimes the tab URL changes without triggering a webNavigation
        // event! so check if the URL changes, and then increase the nav
        // index *as if* an event had triggered if it does
        if (old_url && origin_url !== old_url) {
            await zeeschuimer.nav_handler(tabId);
        }

        this.tab_url_map[tabId] = origin_url;

        // get the navigation index for the tab
        // if any of the processed items already exist for this combination of
        // navigation index and tab ID, it is ignored as a duplicate
        let nav_index = await db.nav.where({"tab_id": tabId, "session": this.session}).first();
        if (!nav_index) {
            nav_index = {"tab_id": tabId, "session": this.session, "index": 0};
            await db.nav.add(nav_index);
        }
        nav_index = nav_index.session + ":" + nav_index.tab_id + ":" + nav_index.index;

        let item_list = [];
        let stored_items = 0;
        for (let module_id in this.modules) {
            if(!enabled_modules.includes(module_id)) {
                continue
            }

            item_list = this.modules[module_id].callback(response, origin_url, document_url);
            if (item_list && item_list.length > 0) {
                await Promise.all(item_list.map(async (item) => {
                    if (!item) {
                        return;
                    }

                    let item_id = item["id"];
                    let exists = await db.items.where({"item_id": item_id, "nav_index": nav_index}).first();

                    if (!exists) {
                        stored_items += 1;
                        await db.items.add({
                            "nav_index": nav_index,
                            "item_id": item_id,
                            "timestamp_collected": Date.now(),
                            "source_platform": module_id,
                            "source_platform_url": origin_url,
                            "source_url": document_url,
                            "user_agent": navigator.userAgent,
                            "data": item
                        });
                    }
                }));

                this.capture_stats.items += stored_items;
                return stored_items;
            }
        }

        return 0;
    },

    /**
     * Check if extension tab is open or not
     * @returns {Promise<boolean>}
     */
    has_tab: async function () {
        const tabs = await browser.tabs.query({});
        const full_url = browser.runtime.getURL('popup/interface.html');
        const zeeschuimer_tab = tabs.filter((tab) => {
            return (tab.url === full_url);
        });
        return zeeschuimer_tab[0] || false;
    },

    /**
     * Callback for browser navigation
     * Increases the nav_index for a given tab to aid in deduplication of captured items
     * @param details  Navigation event details, or a tab ID
     */
    nav_handler: async function (details) {
        let tab_id = details;
        if (details && typeof details === "object") {
            if (details.hasOwnProperty("frameId") && details.frameId !== 0) {
                // only navigation of the tab itself; a page's iframes committing
                // would otherwise keep increasing the index, which would make
                // deduplication of captured items less effective
                return;
            }
            tab_id = details.tabId;
        }

        if (typeof tab_id !== "number") {
            return;
        }

        // as an event callback this function is not called on the zeeschuimer
        // object, so the session is read from it explicitly
        await self.zeeschuimer_ready;
        const session = zeeschuimer.session;

        const nav = await db.nav.where({"session": session, "tab_id": tab_id}).first();
        if (!nav) {
            await db.nav.add({"session": session, "tab_id": tab_id, "index": 0});
            return;
        }

        await db.nav.where({"session": session, "tab_id": tab_id}).modify({"index": nav["index"] + 1});
    }
}

// initialisation may still be running when the first event comes in, which
// especially happens in Chrome, where the background context is started on
// demand; everything that needs a session index waits for this promise
self.zeeschuimer_ready = zeeschuimer.init();

if (zs_can_filter_responses) {
    // Firefox: read response bodies straight from the request
    browser.webRequest.onBeforeRequest.addListener(
        zeeschuimer.listener, {urls: ["https://*/*"], types: ["main_frame", "xmlhttprequest"]}, ["blocking"]
    );
}

/**
 * Handle messages from the interface
 *
 * The interface uses this to find out which modules exist and, where capture
 * runs through the debugger API, to show what capture is doing.
 *
 * Responses are sent via sendResponse() instead of by returning a promise,
 * because Chrome does not support the latter.
 */
browser.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || !message.type) {
        return false;
    }

    if (message.type === 'zeeschuimer-modules') {
        // module metadata for the interface page
        let modules = {};
        for (const module_id in zeeschuimer.modules) {
            modules[module_id] = {
                name: zeeschuimer.modules[module_id]['name'],
                domain: zeeschuimer.modules[module_id]['domain']
            };
        }
        sendResponse(modules);
        return false;
    }

    if (message.type === 'zeeschuimer-capture-stats') {
        // diagnostics for the interface
        sendResponse(zeeschuimer.capture_stats);
        return false;
    }

    return false;
});

// keep the browser icon in sync with the capture toggles in the interface
browser.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'local') {
        return;
    }
    if (Object.keys(changes).some(key => key.indexOf('zs-enabled-') === 0)) {
        zeeschuimer.update_icon();
    }
});

browser.webNavigation.onCommitted.addListener(
    zeeschuimer.nav_handler
);

zs_action.onClicked.addListener(async () => {
    let tab = await zeeschuimer.has_tab();
    if (!tab) {
        browser.tabs.create({url: 'popup/interface.html'});
    } else if (!tab.active) {
        browser.tabs.update(tab.id, {active: true});
    }
});
