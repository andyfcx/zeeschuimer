/**
 * Chrome MV3 popup compatibility shim
 *
 * In Firefox, interface.js uses browser.extension.getBackgroundPage() to
 * access the background page's `db` and `zeeschuimer` globals directly.
 * Chrome MV3 has no background page, so this shim recreates the expected
 * `background` object and a minimal `browser` namespace.
 *
 * Load order in interface-chrome.html:
 *   1. ../inc/dexie.js          (provides Dexie)
 *   2. background-chrome.js     (this file — provides `background` + `browser`)
 *   3. interface.js             (unchanged — calls browser.extension.getBackgroundPage())
 */

// Re-open the same IndexedDB database that the service worker uses
const _zsDb = new Dexie('zeeschuimer-items');
_zsDb.version(1).stores({
    items:    "++id, item_id, nav_index, source_platform",
    uploads:  "++id",
    nav:      "++id, tab_id, session",
    settings: "key"
});

// Build the background-like object interface.js expects
const background = {
    db: _zsDb,
    browser: {
        storage: {
            local: chrome.storage.local
        },
        downloads: chrome.downloads,
        runtime:   chrome.runtime,
        extension: {
            getBackgroundPage: () => background
        }
    },
    zeeschuimer: {
        modules: {}   // populated below from service worker's stored module list
    }
};

// The service worker stores module metadata in local storage under 'zs-module-list'
// (set during init() in src/adapters/chrome/background.js)
chrome.storage.local.get('zs-module-list').then(result => {
    if (result && result['zs-module-list']) {
        background.zeeschuimer.modules = result['zs-module-list'];
    }
});

// Polyfill the global `browser` namespace so calls like
// browser.downloads.download() and browser.downloads.onChanged work
if (typeof browser === 'undefined') {
    window.browser = background.browser;
}
