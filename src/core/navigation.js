/**
 * Zeeschuimer navigation tracking
 * Extends the global `zeeschuimer` with nav_handler.
 *
 * Increasing the nav index per tab allows parse_request to detect when
 * the user navigates to a new page and avoid re-storing items already
 * captured in the previous page view.
 *
 * Requires (loaded before this file):
 *   database.js → db
 *   registry.js → zeeschuimer (with .session)
 */
Object.assign(globalThis.zeeschuimer, {
    /**
     * Increment the navigation index for a tab.
     * Called on webNavigation.onCommitted events and on implicit URL changes.
     *
     * @param tabId  Tab ID (number) or a webNavigation event object with .tabId
     */
    nav_handler: async function (tabId) {
        if (tabId.hasOwnProperty("tabId")) {
            tabId = tabId.tabId;
        }

        let nav = await db.nav.where({"session": this.session, "tab_id": tabId});
        if (!nav) {
            nav = {"session": this.session, "tab_id": tabId, "index": 0};
            await db.nav.add(nav);
        }

        await db.nav.where({"session": this.session, "tab_id": tabId}).modify({"index": nav["index"] + 1});
    }
});
