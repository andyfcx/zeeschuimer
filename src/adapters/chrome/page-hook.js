/**
 * Zeeschuimer page hook — Chrome (Manifest V3)
 *
 * Injected into the page's MAIN world via content_scripts in manifest.json
 * (run_at: document_start, world: MAIN).  Intercepts fetch and XHR calls
 * made by the page and posts captured responses to the ISOLATED content
 * script via window.postMessage.
 *
 * Note: chrome.runtime is NOT available here (MAIN world).  All data is
 * forwarded via postMessage; content-script.js bridges it to the service
 * worker.
 */
(function () {
    function shouldCapture(url) {
        return typeof url === 'string' && url.startsWith('https://');
    }

    function postCapture(responseText, url) {
        window.postMessage({
            type: 'ZS_CAPTURED',
            responseText: responseText,
            url: url,
            documentUrl: window.location.href
        }, window.location.origin || '*');
    }

    // ------------------------------------------------------------------
    // Hook window.fetch
    // ------------------------------------------------------------------
    const _originalFetch = window.fetch;
    window.fetch = async function (...args) {
        const response = await _originalFetch.apply(this, args);
        const url = typeof args[0] === 'string'
            ? args[0]
            : (args[0] instanceof Request ? args[0].url : '');
        if (shouldCapture(url)) {
            response.clone().text()
                .then(text => postCapture(text, url))
                .catch(() => {});
        }
        return response;
    };

    // ------------------------------------------------------------------
    // Hook XMLHttpRequest
    // ------------------------------------------------------------------
    const _OriginalXHR = window.XMLHttpRequest;

    window.XMLHttpRequest = function () {
        const xhr = new _OriginalXHR();
        let _url = '';

        const _originalOpen = xhr.open;
        xhr.open = function (method, url) {
            _url = url;
            return _originalOpen.apply(xhr, arguments);
        };

        xhr.addEventListener('load', function () {
            if (shouldCapture(_url) && (xhr.responseType === '' || xhr.responseType === 'text')) {
                postCapture(xhr.responseText, _url);
            }
        });

        return xhr;
    };

    window.XMLHttpRequest.prototype = _OriginalXHR.prototype;
})();
