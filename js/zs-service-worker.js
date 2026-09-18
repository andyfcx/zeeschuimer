/**
 * Service worker entry point (Chrome, manifest v3)
 *
 * Manifest v3 allows only a single background script, so this loads the same
 * files that manifest.json lists as background scripts for Firefox. Keep the
 * two lists in sync when adding a module.
 */
importScripts(
    '/js/compat.js',
    '/inc/dexie.js',
    '/inc/he.js',
    '/js/lib.js',
    '/js/zs-parser.js',
    '/js/zs-background.js',
    '/modules/tiktok.js',
    '/modules/tiktok-comments.js',
    '/modules/instagram.js',
    '/modules/linkedin.js',
    '/modules/9gag.js',
    '/modules/imgur.js',
    '/modules/twitter.js',
    '/modules/douyin.js',
    '/modules/gab.js',
    '/modules/truth.js',
    '/modules/threads.js',
    '/modules/facebook.js',
    '/modules/pinterest.js',
    '/modules/rednote.js',
    '/modules/rednote-comments.js'
);
