/**
 * Zeeschuimer — Chrome adapter (Manifest V3, service worker)
 *
 * All paths in importScripts() are relative to this file's location in the
 * BUILD OUTPUT (build/chrome/js/background.js), not the source tree.
 *
 * Build with:  bash scripts/build-chrome.sh
 */

// ---------------------------------------------------------------------------
// Minimal browser API polyfill for Chrome MV3
// Maps browser.* calls used by core modules to chrome.* equivalents.
// ---------------------------------------------------------------------------
globalThis.browser = {
    storage: {
        local: chrome.storage.local
    },
    tabs: {
        get: (tabId) => chrome.tabs.get(tabId),
        query: (queryInfo) => chrome.tabs.query(queryInfo),
        create: (props) => chrome.tabs.create(props),
        update: (tabId, props) => chrome.tabs.update(tabId, props),
    },
    runtime: chrome.runtime,
};

// ---------------------------------------------------------------------------
// Load dependencies and shared core (paths relative to build/chrome/js/)
// ---------------------------------------------------------------------------
importScripts('../inc/dexie.js', '../inc/he.js');
importScripts('lib.js', 'database.js', 'registry.js', 'pipeline.js', 'navigation.js');

// Load platform modules
importScripts(
    '../modules/tiktok.js',
    '../modules/tiktok-comments.js',
    '../modules/instagram.js',
    '../modules/linkedin.js',
    '../modules/9gag.js',
    '../modules/imgur.js',
    '../modules/twitter.js',
    '../modules/douyin.js',
    '../modules/gab.js',
    '../modules/truth.js',
    '../modules/threads.js',
    '../modules/facebook.js',
    '../modules/pinterest.js',
    '../modules/rednote.js',
    '../modules/rednote-comments.js'
);

// ---------------------------------------------------------------------------
// Chrome-specific initialization
// ---------------------------------------------------------------------------
async function init() {
    let session = await db.settings.get("session");
    if (!session) {
        session = {"key": "session", "value": 0};
        await db.settings.add(session);
    }
    session["value"] += 1;
    zeeschuimer.session = session["value"];
    await db.settings.update("session", session);
    await db.nav.where("session").notEqual(zeeschuimer.session).delete();

    // Persist module metadata to local storage so the popup can read it
    // (popup cannot call getBackgroundPage() in MV3)
    const moduleList = {};
    for (const id in zeeschuimer.modules) {
        moduleList[id] = {
            name: zeeschuimer.modules[id].name,
            domain: zeeschuimer.modules[id].domain
        };
    }
    await chrome.storage.local.set({'zs-module-list': moduleList});

    // Sync action icon with enabled-capture state
    setInterval(async function () {
        let enabled = [];
        for (const module in zeeschuimer.modules) {
            const key = 'zs-enabled-' + module;
            const stored = await chrome.storage.local.get(key);
            if (stored.hasOwnProperty(key) && !!parseInt(stored[key])) {
                enabled.push(module);
            }
        }
        const path = enabled.length > 0
            ? 'images/zeeschuimer-icon-active.png'
            : 'images/zeeschuimer-icon-inactive.png';
        chrome.action.setIcon({path: path});
    }, 2000);
}

// ---------------------------------------------------------------------------
// Handle data captured by the page hook via content script message passing
// ---------------------------------------------------------------------------
async function handle_capture(message, sender) {
    const tabId = sender.tab ? sender.tab.id : -1;

    const document_url = message.url;
    const origin_url = message.documentUrl || document_url;

    const document_source_domain = document_url.split('://').pop().split('/')[0].replace(/^www\./, '').toLowerCase();
    const possible_source_domains = [
        document_source_domain,
        origin_url.split('://').pop().split('/')[0].replace(/^www\./, '').toLowerCase()
    ];

    const eligible_modules = Object.fromEntries(
        Object.entries(zeeschuimer.modules).filter(([, mod]) =>
            possible_source_domains.some(domain => domain.endsWith(mod.domain.toLowerCase()))
        )
    );

    const enabled_modules = [];
    for (const module_id in eligible_modules) {
        const key = 'zs-enabled-' + module_id;
        const stored = await chrome.storage.local.get(key);
        if (stored.hasOwnProperty(key) && !!parseInt(stored[key])) {
            enabled_modules.push(module_id);
        }
    }

    if (enabled_modules.length > 0) {
        await zeeschuimer.parse_request(message.responseText, origin_url, document_url, tabId, enabled_modules);
    }
}

// ---------------------------------------------------------------------------
// Check if popup tab is already open
// ---------------------------------------------------------------------------
async function has_tab() {
    const tabs = await chrome.tabs.query({});
    const full_url = chrome.runtime.getURL('popup/interface-chrome.html');
    return tabs.find(t => t.url === full_url) || false;
}

// ---------------------------------------------------------------------------
// Event listeners
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender) => {
    if (message.type === 'ZS_CAPTURED') {
        handle_capture(message, sender);
    }
    // Return false = no async sendResponse needed
    return false;
});

chrome.webNavigation.onCommitted.addListener(zeeschuimer.nav_handler);

chrome.action.onClicked.addListener(async () => {
    const tab = await has_tab();
    if (!tab) {
        chrome.tabs.create({url: 'popup/interface-chrome.html'});
    } else if (!tab.active) {
        chrome.tabs.update(tab.id, {active: true});
    }
});

chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);

// Also init immediately — service workers may be woken by other events
init().catch(console.error);
