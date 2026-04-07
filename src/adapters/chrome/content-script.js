/**
 * Zeeschuimer content script — Chrome (Manifest V3)
 *
 * Runs in the ISOLATED world.  Listens for ZS_CAPTURED messages posted by
 * page-hook.js (MAIN world) and forwards them to the service worker via
 * chrome.runtime.sendMessage.
 */
window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data.type !== 'ZS_CAPTURED') {
        return;
    }
    chrome.runtime.sendMessage({
        type: 'ZS_CAPTURED',
        responseText: event.data.responseText,
        url: event.data.url,
        documentUrl: event.data.documentUrl
    });
});
