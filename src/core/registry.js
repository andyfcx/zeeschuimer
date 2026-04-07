/**
 * Zeeschuimer module registry
 * Provides the global `zeeschuimer` object with `register_module`.
 * Platform modules call zeeschuimer.register_module() to register themselves.
 *
 * pipeline.js and navigation.js extend this object with additional methods.
 */
globalThis.zeeschuimer = {
    modules: {},

    /**
     * Register a Zeeschuimer platform module
     * @param name        Display name
     * @param domain      Primary domain (e.g. "tiktok.com")
     * @param callback    Function(responseText, originUrl, documentUrl) → Array of items
     * @param module_id   Optional module ID; defaults to domain
     */
    register_module: function (name, domain, callback, module_id = null) {
        if (!module_id) {
            module_id = domain;
        }
        this.modules[module_id] = {
            name: name,
            domain: domain,
            callback: callback
        };
    }
};
