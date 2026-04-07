/**
 * Zeeschuimer request parsing pipeline
 * Extends the global `zeeschuimer` with parse_request and related state.
 *
 * Requires (loaded before this file):
 *   database.js  → db
 *   registry.js  → zeeschuimer
 *
 * Uses browser.tabs.get() — must be the Firefox `browser` API or the
 * Chrome polyfill defined in the Chrome adapter's background.js.
 */
Object.assign(globalThis.zeeschuimer, {
    session: null,
    tab_url_map: {},

    /**
     * Parse a captured HTTP response and store any extracted items.
     *
     * @param response        Full response body text
     * @param origin_url      URL of the page that initiated the request
     * @param document_url    URL of the captured resource
     * @param tabId           Browser tab ID
     * @param enabled_modules Array of module IDs that are both eligible and enabled
     */
    parse_request: async function (response, origin_url, document_url, tabId, enabled_modules) {
        if (!origin_url) {
            origin_url = document_url;
        }

        // Track what URL was previously loaded in this tab
        let old_url = '';
        if (tabId in this.tab_url_map) {
            old_url = this.tab_url_map[tabId];
        }

        try {
            // Get the actual tab URL (may differ from the reported request URL)
            let tab = await browser.tabs.get(tabId);
            origin_url = tab.url;
        } catch (Error) {
            tabId = -1;
        }

        // If the tab URL changed without triggering a webNavigation event, bump nav index
        if (old_url && origin_url !== old_url) {
            await zeeschuimer.nav_handler(tabId);
        }

        this.tab_url_map[tabId] = origin_url;

        // Derive a deduplication key from session + tab + navigation index
        let nav_index = await db.nav.where({"tab_id": tabId, "session": this.session}).first();
        if (!nav_index) {
            nav_index = {"tab_id": tabId, "session": this.session, "index": 0};
            await db.nav.add(nav_index);
        }
        nav_index = nav_index.session + ":" + nav_index.tab_id + ":" + nav_index.index;

        for (let module_id in this.modules) {
            if (!enabled_modules.includes(module_id)) {
                continue;
            }

            let item_list = this.modules[module_id].callback(response, origin_url, document_url);
            if (item_list && item_list.length > 0) {
                await Promise.all(item_list.map(async (item) => {
                    if (!item) return;

                    let item_id = item["id"];
                    let exists = await db.items.where({"item_id": item_id, "nav_index": nav_index}).first();

                    if (!exists) {
                        await db.items.add({
                            "nav_index": nav_index,
                            "item_id": item_id,
                            "timestamp_collected": Date.now(),
                            "source_platform": module_id,
                            "source_platform_url": origin_url,
                            "source_url": document_url,
                            "user_agent": typeof navigator !== 'undefined' ? navigator.userAgent : '',
                            "data": item
                        });
                    }
                }));

                return;
            }
        }
    }
});
