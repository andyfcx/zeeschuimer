/**
 * Zeeschuimer database initialization
 * Uses Dexie.js (IndexedDB wrapper). Works in Firefox background scripts
 * and Chrome MV3 service workers — both support IndexedDB.
 *
 * Assigns to globalThis so it is accessible as the bare name `db` in all
 * subsequent scripts regardless of whether the global is `window` or `self`.
 */
globalThis.db = new Dexie('zeeschuimer-items');
globalThis.db.version(1).stores({
    items: "++id, item_id, nav_index, source_platform",
    uploads: "++id",
    nav: "++id, tab_id, session",
    settings: "key"
});
