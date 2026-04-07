# Dual-Browser Refactor Summary

## Overview

Refactored Zeeschuimer from a Firefox-only Manifest V2 extension into a dual-browser codebase with shared core logic and separate browser adapters. Firefox behavior is preserved exactly. A Chrome Manifest V3 build is added for internal use.

## New directory structure

```
src/
  core/
    lib.js          shared traverse_data utility
    database.js     Dexie/IndexedDB init (globalThis — works in SW and background page)
    registry.js     zeeschuimer.register_module + modules map
    pipeline.js     parse_request, session state, tab URL tracking
    navigation.js   nav_handler (deduplication via nav index)
  adapters/
    firefox/
      background.js Firefox-specific: filterResponseData listener, browserAction icon sync,
                    popup tab open/focus
    chrome/
      background.js MV3 service worker: importScripts core + modules, browser API polyfill,
                    message handler, action icon sync, stores module list for popup
      page-hook.js  Injected into page MAIN world: hooks window.fetch and XMLHttpRequest,
                    posts ZS_CAPTURED via window.postMessage
      content-script.js ISOLATED world bridge: forwards postMessage → chrome.runtime.sendMessage
  modules/          All 15 platform parsers (same as root modules/)
    instagram.js    Dead-code line removed: dummyDocument used document.implementation
                    which is unavailable in service workers
manifests/
  firefox.json      MV2, updated background.scripts paths
  chrome.json       MV3, service_worker + content_scripts (world: MAIN for page-hook)
scripts/
  build-firefox.sh  Produces build/firefox/
  build-chrome.sh   Produces build/chrome/
popup/
  background-chrome.js  Chrome popup compat shim: re-opens Dexie, reads module metadata
                        from chrome.storage.local, polyfills window.browser
  interface-chrome.html Chrome popup entry point: loads dexie.js + background-chrome.js
                        before interface.js (interface.js itself is unchanged)
```

## Files not modified

- `manifest.json` — original Firefox manifest untouched
- `modules/*.js` — original platform parsers untouched
- `js/zs-background.js`, `js/lib.js` — original background scripts untouched
- `popup/interface.html`, `popup/interface.js` — popup untouched
- `inc/dexie.js`, `inc/he.js` — third-party deps untouched

## How capture works in each browser

### Firefox (MV2)
`browser.webRequest.filterResponseData()` intercepts every HTTPS main_frame and
xmlhttprequest at the network level, buffers the full response, and passes it to
`parse_request` in the background page.

### Chrome (MV3)
`page-hook.js` runs in the page's MAIN world at `document_start` and overrides
`window.fetch` and `window.XMLHttpRequest`. Captured responses are forwarded via
`window.postMessage` → `content-script.js` (ISOLATED world) → `chrome.runtime.sendMessage`
→ service worker, which calls `parse_request`.

Chrome 111+ is required for `world: "MAIN"` in `content_scripts`.

## Feature gaps: Chrome vs Firefox

| Feature | Firefox | Chrome |
|---|---|---|
| Manifest version | V2 | V3 |
| Capture method | filterResponseData (network level) | Page fetch/XHR hook (JS level) |
| Capture completeness | All matching HTTPS responses | Only fetch/XHR after hook injection |
| Background lifetime | Persistent background page | Service worker (may be suspended) |
| Popup → background access | getBackgroundPage() | Dexie re-opened in popup; module list via chrome.storage.local |
| Store publishing | Signed .xpi | Not configured (internal use only) |

## Building

```bash
bash scripts/build-firefox.sh   # → build/firefox/
bash scripts/build-chrome.sh    # → build/chrome/
```

## Loading locally

**Firefox:**
1. `about:debugging` → This Firefox → Load Temporary Add-on → select any file in `build/firefox/`

**Chrome:**
1. `chrome://extensions` → Developer mode → Load unpacked → select `build/chrome/`
