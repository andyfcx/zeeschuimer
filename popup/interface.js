/**
 * The interface opens the item database itself instead of going through the
 * background context; Chrome's service worker cannot hand out references to
 * its objects the way Firefox's background page can.
 */
const db = new Dexie('zeeschuimer-items');
db.version(1).stores({
    items: "++id, item_id, nav_index, source_platform",
    uploads: "++id",
    nav: "++id, tab_id, session",
    settings: "key"
});

// module metadata (name, domain), requested from the background context
var platform_modules = null;

// whether the parsed .csv/.json download buttons are offered; on by default
var parse_export_enabled = true;

// number of capture toggles being written to storage right now; while a write
// is in flight the switches are left alone, so they do not flip back and forth
var toggle_writes_pending = 0;

var have_4cat = false;
var xhr;
var is_uploading = false;
const downloadUrls = new Map();

/**
 * StreamSaver init
 * Unused for now - see documentation for the download_blob function.
 */
/*var fileStream;
var writer;
var encode = TextEncoder.prototype.encode.bind(new TextEncoder);

streamSaver.mitm = 'mitm.html';
// Abort the download stream when leaving the page
window.isSecureContext && window.addEventListener('beforeunload', evt => {
    writer.abort()
    writer = undefined;
    fileStream = undefined;
})*/

/**
 * Create DOM element
 *
 * Convenience function because we can't use innerHTML very well in an
 * extension context.
 *
 * @param tag  Tag of element
 * @param attributes  Element attributes
 * @param content  Text content of attribute
 * @param prepend_icon  Font awesome icon ID to prepend to content
 * @returns {*}
 */
function createElement(tag, attributes={}, content=undefined, prepend_icon=undefined) {
    let element = document.createElement(tag);
    for(let attribute in attributes) {
        element.setAttribute(attribute, attributes[attribute]);
    }
    if (content && typeof(content) === 'object' && 'tagName' in content) {
        element.appendChild(content);
    } else if(content !== undefined) {
        element.textContent = content;
    }

    if(prepend_icon) {
        const icon_element = document.createElement('i');
        icon_element.classList.add('fa')
        icon_element.classList.add('fa-' + prepend_icon);
        element.textContent = ' ' + element.textContent;
        element.prepend(icon_element);
    }

    return element;
}

/**
 * Get URL of 4CAT instance to connect to
 *
 * This is stored in the LocalStorage.
 *
 * @param e
 * @returns {Promise<*>}
 */
async function get_4cat_url(e) {
    let url = await browser.storage.local.get(['4cat-url']);
    if (url['4cat-url']) {
        url = url['4cat-url'];
    } else {
        url = '';
    }

    return url;
}

/**
 * Set URL of 4CAT instance to connect to
 *
 * This is stored in the LocalStorage.
 *
 * @param e
 * @returns {Promise<void>}
 */
async function set_4cat_url(e) {
    if(e !== true && !e.target.matches('#fourcat-url')) {
        return;
    }

    let url;
    if(e !== true) {
        url = document.querySelector('#fourcat-url').value;
        if(url.length > 0) {
            if (url.indexOf('://') === -1) {
                url = 'http://' + url;
            }
            url = url.split('/').slice(0, 3).join('/');
        }
        await browser.storage.local.set({'4cat-url': url});
    } else {
        url = await browser.storage.local.get(['4cat-url']);
        if(url['4cat-url']) {
            url = url['4cat-url'];
        } else {
            url = '';
        }
    }

    have_4cat = (url && url.length > 0);
}

/**
 * Manage availability of interface buttons
 *
 * Some buttons are only available when a 4CAT URL has been provided, or when
 * items have been collected, etc. This function is called periodically to
 * enable or disable buttons accordingly.
 */
function activate_buttons() {
    document.querySelectorAll("td button").forEach(button => {
        let current = button.disabled;
        let items = parseInt(button.parentNode.parentNode.querySelector('.num-items').innerText);
        let new_status = current;

        if(button.classList.contains('upload-to-4cat') && !is_uploading) {
            new_status = !(items > 0 && have_4cat);
            if(new_status && !have_4cat) {
                button.classList.add('tooltippable');
                button.setAttribute('title', 'Configure a 4CAT URL to enable uploading to 4CAT');
            } else {
                button.classList.remove('tooltippable');
                button.setAttribute('title', '');
            }

        } else if(button.classList.contains('download-ndjson') || button.classList.contains('parsed-export') || button.classList.contains('reset')) {
            new_status = !(items > 0);
        }

        if(new_status !== current) {
            button.disabled = new_status;
        }
    });
}

/**
 * Toggle data capture for a platform
 *
 * Callback; platform depends on the button this callback is called through.
 *
 * @param e
 * @returns {Promise<void>}
 */
async function toggle_listening(e) {
    let platform = e.target.getAttribute('name');
    let updated = e.target.checked ? 1 : 0;
    e.target.parentNode.parentNode.parentNode.parentNode.setAttribute('data-enabled', updated);

    toggle_writes_pending += 1;
    try {
        await browser.storage.local.set({[platform]: String(updated)});

        // make sure it was really stored: a switch that says capture is on
        // while it is not would be worse than an error message
        const stored = await browser.storage.local.get([platform]);
        if(!stored.hasOwnProperty(platform) || parseInt(stored[platform]) !== updated) {
            throw new Error('the browser did not store the setting');
        }
    } catch (error) {
        e.target.checked = !updated;
        e.target.parentNode.parentNode.parentNode.parentNode.setAttribute('data-enabled', updated ? 0 : 1);
        alert('Could not ' + (updated ? 'enable' : 'disable') + ' capture for ' + platform + ': ' + error);
    } finally {
        toggle_writes_pending -= 1;
    }
}


/**
 * Update favicon depending on whether capture is enabled
 */
function update_icon() {
    const any_enabled = Array.from(document.querySelectorAll('#item-table .toggle-switch input')).filter(item => item.checked);
    const path = any_enabled.length > 0 ? '/images/zeeschuimer-icon-active.png' : '/images/zeeschuimer-icon-inactive.png';
    document.querySelector('link[rel~=icon]').setAttribute('href', path);
}

/**
 * Load module metadata from the background context
 *
 * The interface needs to know which platforms exist and what they are called.
 * In Chrome the background context is a service worker that may be asleep, in
 * which case sending it a message wakes it up; if that fails the interface
 * tries again on its next update.
 *
 * @returns {Promise<Object|null>}  Module metadata, or null if unavailable
 */
async function load_platform_modules() {
    try {
        const modules = await browser.runtime.sendMessage({type: 'zeeschuimer-modules'});
        return (modules && Object.keys(modules).length > 0) ? modules : null;
    } catch (e) {
        return null;
    }
}

/**
 * Initialise the 'parsed data' switch
 *
 * When on, each platform gets buttons to download its items as a parsed file
 * instead of as raw NDJSON. This is on unless it has been switched off before.
 *
 * @returns {Promise<void>}
 */
async function init_parse_export() {
    const stored = await browser.storage.local.get('zs-parse-export');
    parse_export_enabled = !stored.hasOwnProperty('zs-parse-export') || !!parseInt(stored['zs-parse-export']);

    const checkbox = document.querySelector('#zs-parse-export');
    checkbox.checked = parse_export_enabled;
    checkbox.addEventListener('change', toggle_parse_export);
    document.body.setAttribute('data-parse-export', parse_export_enabled ? '1' : '0');
}

/**
 * Toggle availability of the parsed download buttons
 *
 * @param e
 * @returns {Promise<void>}
 */
async function toggle_parse_export(e) {
    parse_export_enabled = !!e.target.checked;
    document.body.setAttribute('data-parse-export', parse_export_enabled ? '1' : '0');
    await browser.storage.local.set({'zs-parse-export': parse_export_enabled ? '1' : '0'});
}

/**
 * Show what capture is doing
 *
 * Only relevant where capture runs through the debugger API (i.e. in Chrome):
 * it shows how many tabs are being captured from and what has been captured,
 * which is otherwise impossible to tell apart from a platform simply not
 * sending any items.
 *
 * @returns {Promise<void>}
 */
async function update_capture_status() {
    const container = document.querySelector('#capture-status');
    if(!container) {
        return;
    }

    if(zs_can_filter_responses) {
        container.setAttribute('aria-hidden', 'true');
        return;
    }

    let stats;
    try {
        stats = await browser.runtime.sendMessage({type: 'zeeschuimer-capture-stats'});
    } catch (e) {
        return;
    }

    if(!stats) {
        return;
    }

    const shorten = (url) => {
        const without_protocol = String(url).split('://').pop();
        return without_protocol.length > 60 ? without_protocol.slice(0, 60) + '\u2026' : without_protocol;
    };

    let text = 'Capturing with ' + (stats.mechanism || 'an unknown mechanism') + ': ' +
        stats.attached_tabs + ' tab(s) attached, ' + stats.responses + ' response(s) seen, ' +
        stats.responses_matched + ' from enabled platforms, ' + stats.items + ' item(s) stored';
    const last_url = stats.last_match_url || stats.last_url;
    if(last_url) {
        text += ' \u2014 last: ' + shorten(last_url);
    }
    if(stats.last_error) {
        text += ' \u2014 ' + stats.last_error;
    }

    const stored_toggles = stats.stored_toggles ? Object.keys(stats.stored_toggles)
        .map(key => key.replace('zs-enabled-', '') + '=' + stats.stored_toggles[key]) : [];

    const details = [
        'stored switches: ' + (stored_toggles.length ? stored_toggles.join(', ') : 'none'),
        'enabled: ' + (stats.enabled_modules && stats.enabled_modules.length ? stats.enabled_modules.join(', ') : 'none'),
        'capturable tabs: ' + (stats.capturable_tabs && stats.capturable_tabs.length ? stats.capturable_tabs.join(', ') : 'none'),
        'session: ' + stats.session
    ];
    if(stats.init_error) {
        details.push('start-up error: ' + stats.init_error);
    }
    if(stats.tabs_error) {
        details.push('tab error: ' + stats.tabs_error);
    }
    if(stats.storage_error) {
        details.push('storage error: ' + stats.storage_error);
    }

    // the details are only worth showing when something is off: an error, or
    // a platform that capture is enabled for without a tab being captured
    const enabled_count = stats.enabled_modules ? stats.enabled_modules.length : 0;
    const looks_idle = enabled_count > 0 && stats.attached_tabs === 0;
    const has_error = !!(stats.last_error || stats.init_error || stats.tabs_error || stats.storage_error);

    container.innerText = (looks_idle || has_error) ? text + '\n' + details.join(' \u2014 ') : text;
    container.setAttribute('aria-hidden', 'false');
}

/**
 * Get Zeeschuimer stats
 *
 * Loads the amount of items collected, etc. This function is called
 * periodically to keep the numbers in the interface updated as items are
 * coming in.
 *
 * @returns {Promise<void>}
 */
async function get_stats() {
    if(!platform_modules) {
        // the background context may not have started yet, in which case we
        // simply try again on the next update
        platform_modules = await load_platform_modules();
        if(!platform_modules) {
            return;
        }
    }

    let response = [];
    let platform_map = [];
    Object.keys(platform_modules).forEach(function(platform) { platform_map[platform] = platform_modules[platform].name; });
    for(let module in platform_modules) {
        response[module] = await db.items.where("source_platform").equals(module).count();
    }

    for (let platform in response) {
        let row_id = "stats-" + platform.replace(/[^a-zA-Z0-9]/g, "");
        let new_num_items = parseInt(response[platform]);
        if(!document.querySelector("#" + row_id)) {
            let toggle_field = 'zs-enabled-' + platform;
            let enabled = await browser.storage.local.get([toggle_field])
            enabled = enabled.hasOwnProperty(toggle_field) && !!parseInt(enabled[toggle_field]);
            let row = createElement("tr", {"id": row_id, 'data-enabled': enabled ? '1' : '0'});

            // checkbox stuff
            let checker = createElement("label", {"for": toggle_field});
            checker.appendChild(createElement('input', {"id": toggle_field, "name": toggle_field, "type": "checkbox"}))
            checker.appendChild(createElement('span', {"class": "toggle"}));
            if(enabled) { checker.firstChild.setAttribute('checked', 'checked'); }
            checker.addEventListener('change', toggle_listening);

            row.appendChild(createElement("td", {'class': 'platform-icon'}, createElement('img', {'src': '/images/platform-icons/' + platform.split('.')[0].split('-')[0] + '.png', 'alt': ''})));
            row.appendChild(createElement("td", {}, createElement('div', {'class': 'toggle-switch'}, checker)));
            row.appendChild(createElement("td", {}, createElement('a', {'href': 'https://' + platform_modules[platform]['domain']}, platform_map[platform])));
            row.appendChild(createElement("td", {"class": "num-items"}, new Intl.NumberFormat().format(response[platform])));

            let actions = createElement("td");
            let clear_button = createElement("button", {"data-platform": platform, "class": "reset"}, "Delete");
            let download_button = createElement("button", {
                "data-platform": platform,
                "class": "download-ndjson"
            }, ".ndjson");
            let fourcat_button = createElement("button", {
                "data-platform": platform,
                "class": "upload-to-4cat",
            }, "to 4CAT");

            let parsed_csv_button = createElement("button", {
                "data-platform": platform,
                "class": "download-parsed-csv parsed-export tooltippable",
                "title": "Download the collected items as a parsed, flattened CSV file"
            }, "parsed .csv");
            let parsed_json_button = createElement("button", {
                "data-platform": platform,
                "class": "download-parsed-json parsed-export tooltippable",
                "title": "Download the collected items as a parsed, flattened JSON file"
            }, "parsed .json");

            actions.appendChild(clear_button);
            actions.appendChild(download_button);
            actions.appendChild(parsed_csv_button);
            actions.appendChild(parsed_json_button);
            actions.appendChild(fourcat_button);

            row.appendChild(actions);
            document.querySelector("#item-table tbody").appendChild(row);
        } else {
            if(new_num_items !== parseInt(document.querySelector("#" + row_id + " .num-items").innerText)) {
                document.querySelector("#" + row_id + " .num-items").innerText = new Intl.NumberFormat().format(new_num_items);
            }

            if(!toggle_writes_pending) {
                // the switch shows what is stored, not what it was set to at
                // some point: a setting that did not get stored must not look
                // like capture is enabled
                let toggle_field = 'zs-enabled-' + platform;
                let stored = await browser.storage.local.get([toggle_field]);
                let enabled = stored.hasOwnProperty(toggle_field) && !!parseInt(stored[toggle_field]);
                let checkbox = document.getElementById(toggle_field);
                if(checkbox && checkbox.checked !== enabled) {
                    checkbox.checked = enabled;
                }
                document.querySelector("#" + row_id).setAttribute('data-enabled', enabled ? '1' : '0');
            }
        }
    }

    let uploads = await db.uploads.orderBy("id").reverse().limit(10);
    let num_uploads = parseInt(await db.uploads.orderBy("id").limit(10).count());

    if(num_uploads > 0 && !document.querySelector('#clear-history')) {
        document.querySelector('#upload-table').parentNode.appendChild(createElement('button', {id: 'clear-history'}, 'Clear history'));
    } else if (num_uploads === 0 && !document.querySelector('#upload-table .empty-table-notice')) {
        document.querySelector('#upload-table tbody').appendChild(createElement('tr', {class: 'empty-table-notice'},
            createElement('td', {colspan: 4}, 'No datasets uploaded so far.')));
    }

    await uploads.each(upload => {
        let row_id = "upload-" + upload.id;
        if(!document.querySelector("#" + row_id)) {
            if(document.querySelector('#upload-table .empty-table-notice')) {
                document.querySelector('#upload-table .empty-table-notice').remove();
            }
            let row = createElement("tr", {"id": row_id});
            row.appendChild(createElement("td", {}, platform_modules[upload.platform]["name"]));
            row.appendChild(createElement("td", {}, new Intl.NumberFormat().format(upload.items)));
            row.appendChild(createElement("td", {}, (new Date(upload.timestamp)).toLocaleString('en-us', {
                weekday: "long",
                year: "numeric",
                month: "short",
                day: "numeric"
            })));
            row.appendChild(createElement("td", {}, createElement("a", {"href": upload.url, "target": "_blank"}, upload.url.split("/")[2])));
            document.querySelector("#upload-table tbody").append(row);
        }
    });

    set_4cat_url(true);
    await update_capture_status();
    activate_buttons();
    update_icon();
    init_tooltips();
}

/**
 * Handle button clicks
 *
 * Since buttons are created dynamically, the buttons don't have individual
 * listeners but this function listens to incoming events and dispatches
 * accordingly.
 *
 * @param event
 * @returns {Promise<void>}
 */
async function button_handler(event) {
    let status = document.getElementById('upload-status');

    if (event.target.matches('.reset')) {
        let platform = event.target.getAttribute('data-platform');
        await db.items.where("source_platform").equals(platform).delete();

    } else if (event.target.matches('.reset-all')) {
        await db.items.clear();

    } else if (event.target.matches('.download-ndjson')) {
        let platform = event.target.getAttribute('data-platform');
        event.target.classList.add('loading');

        //let blob = await download_blob(platform, export_filename(platform, '', 'ndjson'));
        let blob = await get_blob(platform);
        await download_file(blob, export_filename(platform, '', 'ndjson'));

        event.target.classList.remove('loading');

    } else if (event.target.matches('.download-parsed-csv') || event.target.matches('.download-parsed-json')) {
        let platform = event.target.getAttribute('data-platform');
        let format = event.target.matches('.download-parsed-csv') ? 'csv' : 'json';
        event.target.classList.add('loading');

        try {
            let blob = await get_parsed_blob(platform, format);
            await download_file(blob, export_filename(platform, 'parsed', format));
        } catch (e) {
            document.querySelector('#parse-status').innerText = 'Could not parse items: ' + e;
        }

        event.target.classList.remove('loading');

    } else if (event.target.matches('.upload-to-4cat')) {
        let platform = event.target.getAttribute('data-platform');
        status.innerText = 'Creating data file for uploading...';
        is_uploading = true;
        let blob = await get_blob(platform);

        document.querySelectorAll('.upload-to-4cat').forEach(x => x.setAttribute('disabled', true));

        xhr = new XMLHttpRequest();
        xhr.aborted = false;
        let upload_url = await get_4cat_url();

        xhr.open("POST", upload_url + "/api/import-dataset/", true);
        xhr.setRequestHeader("X-Zeeschuimer-Platform", platform)
        xhr.onloadstart = function () {
            status.innerText = 'Starting upload...';
        }
        xhr.upload.onprogress = function (event) {
            let pct = event.total === 0 ? '???' : Math.round(event.loaded / event.total * 100);
            status.innerHTML = '';
            status.appendChild(createElement('p', {}, pct + '% uploaded'));
            status.appendChild(createElement('button', {id: 'cancel-upload'}, 'Cancel upload'));
        }
        xhr.onreadystatechange = function() {
            let response = xhr.responseText.replace(/\n/g, '');
            if(xhr.readyState === xhr.DONE) {
                if(xhr.status === 200) {
                    status.innerText = 'File uploaded. Waiting for processing to finish.'
                    if (xhr.responseURL.indexOf('/login/') >= 0) {
                        is_uploading = false;
                        status.innerText = 'You are not logged in to this 4CAT server! Open it in a separate tab, log in and try again.'
                        return;
                    }

                    try {
                        response = JSON.parse(response);
                    } catch (e) {
                        is_uploading = false;
                        status.innerText = 'Error during upload: malformed response from 4CAT server.';
                        return;
                    }
                    upload_poll.init(response);
                } else if(xhr.status === 429) {
                    status.innerText = '4CAT server refused upload, too soon after previous one. Try again in a minute.'
                } else if(xhr.status === 403) {
                    status.innerText = 'Could not log in to 4CAT server. Make sure to log in to 4CAT in this browser.';
                } else if(xhr.status === 404 && xhr.responseText.indexOf('Unknown platform or source format') >= 0) {
                    status.innerText = 'The 4CAT server does not accept ' + platform + ' datasets. The 4CAT ' +
                        'administrator may need to enable the data source or upgrade 4CAT.';
                } else if(xhr.status === 0) {
                    if(!xhr.aborted) {
                        status.innerText = 'Could not connect to 4CAT server. Is the URL correct?';
                    }
                } else {
                    status.innerText = 'Error ' + xhr.status + ' ' + xhr.statusText + ' during upload. Is the URL correct?';
                }

                is_uploading = false;
            }
        }
        xhr.send(blob);

    } else if(event.target.matches('#clear-history')) {
        await db.uploads.clear();
        document.querySelector('#clear-history').remove();
        document.querySelectorAll("#upload-table tbody tr").forEach(x => x.remove());

    } else if(event.target.matches('#cancel-upload')) {
        xhr.abort();
        xhr.aborted = true;
        status.innerHTML = '';

    } else if(event.target.matches('#import-button')) {
        if(!confirm('Importing data will remove all items currently stored. Are you sure?')) {
            return;
        }

        await db.items.clear();

        event.target.setAttribute('disabled', 'disabled');
        let file = document.querySelector('#ndjson-file').files[0];
        let reader = new FileReader();
        reader.readAsText(file);
        reader.addEventListener('load', async function (e) {
            let imported_items = 0;
            let skipped = 0;
            let jsons = reader.result.split("\n");
            for(let index in jsons) {
                let raw_json = jsons[index];
                if (!raw_json) {
                    continue;
                }

                try {
                    let imported = JSON.parse(raw_json);

                    // is this original format or 4CAT-ified? in the latter case, convert back
                    if ('__import_meta' in imported) {
                        let reformatted_import = imported['__import_meta'];
                        reformatted_import['data'] = {};
                        for (const field in imported) {
                            if(field === '__import_meta') {
                                continue;
                            }
                            reformatted_import['data'][field] = imported[field];
                        }
                        imported = reformatted_import;
                    }

                    await db.items.add(imported);
                    imported_items += 1;
                } catch (e) {
                    skipped += 1;
                    console.log('Skipping invalid JSON string: (' + e + ') ' + raw_json);
                }
            }

            if(skipped) {
                alert('Imported ' + imported_items + ' item(s), ' + skipped + ' skipped.');
            } else {
                alert('Imported ' + imported_items + ' item(s).');
            }
        });

        reader.addEventListener('loadend', function(e) {
            event.target.removeAttribute('disabled');
        });

    } else if (event.target.matches('#toggle-advanced-mode')) {
        let section = document.querySelector('#advanced-mode');
        let is_hidden = section.getAttribute('aria-hidden') == 'true';
        if(is_hidden) {
            section.setAttribute('aria-hidden', 'false');
            event.target.innerText = 'Hide advanced options';
        } else {
            section.setAttribute('aria-hidden', 'true');
            event.target.innerText = 'Show advanced options';
        }

        event.stopPropagation();
        return false;
    }

    get_stats();
}

/**
 * Upload status poller
 */
const upload_poll = {
    /**
     * Start polling for upload status
     *
     * Connects to the 4CAT API at the configured URL to check status of a
     * dataset that has been uploaded and is now being processed.
     *
     * @param response
     * @returns {Promise<void>}
     */
    init: async function(response) {
        let upload_url = await get_4cat_url();
        let poll_url = upload_url + '/api/check-query/?key=' + response["key"];
        let status = document.getElementById('upload-status');
        let xhr = new XMLHttpRequest();
        xhr.open("GET", poll_url, true);
        xhr.onreadystatechange = function () {
            if (xhr.readyState === xhr.DONE) {
                return;
            }

            if (xhr.status !== 200) {
                status.innerText = 'Error while checking for upload status.'
                return;
            }

            let json_response = xhr.responseText.replace(/\n/g, '');
            let progress;
            try {
                progress = JSON.parse(json_response);
            } catch (SyntaxError) {
                status.innerText = 'Error during upload: malformed response from 4CAT server.';
                return;
            }

            if (!progress["done"]) {
                status.innerText = 'Processing upload: ' + progress["status"];
                setTimeout(() => upload_poll.init(response), 1000);
            } else {
                status.innerHTML = '';
                status.appendChild(createElement("span", {},"Upload completed! "));
                status.appendChild(createElement("a", {"href": progress["url"], "target": "_blank"}, "View dataset."));
                upload_poll.add_dataset(progress);

                document.querySelectorAll('.upload-to-4cat').forEach(x => x.removeAttribute('disabled'))
                is_uploading = false;
            }
        }
        xhr.send();
    },

    /**
     * Add dataset to Zeeschuimer history
     *
     * @param progress
     * @returns {Promise<void>}
     */
    add_dataset: async function(progress) {
        await db.uploads.add({
            timestamp: (new Date()).getTime(),
            url: progress["url"],
            platform: progress["datasource"],
            items: progress["rows"]
        });
    }
}

/**
 * Get a NDJON dump of items
 *
 * Retuens a Blob with all items in it as JSON files, delimited with newlines.
 * This file can be uploaded to e.g. 4CAT.
 *
 * @param platform
 * @returns {Promise<Blob>}
 */
async function get_blob(platform) {
    let ndjson = [];

    await iterate_items(platform, function(item) {
        ndjson.push(JSON.stringify(item) + "\n");
    });

    return new Blob(ndjson, {type: 'application/x-ndjson'});
}

/**
 * Get a Blob of parsed items
 *
 * Runs the collected items through zs-parser, which reduces them to a flat
 * table of the fields that are most useful for analysis, deduplicated by post
 * ID. The parser's status messages are shown in the interface.
 *
 * @param platform  Platform to export items for
 * @param format  'csv' or 'json'
 * @returns {Promise<Blob>}
 */
async function get_parsed_blob(platform, format) {
    let items = [];
    await iterate_items(platform, function(item) {
        items.push(item);
    });

    let messages = [];
    const rows = zs_parser.general_parser(items, message => messages.push(message));

    const status = document.querySelector('#parse-status');
    if(status) {
        status.innerText = platform + ': ' + messages.join(' \u2022 ');
    }

    if(format === 'csv') {
        return new Blob([zs_parser.to_csv(rows)], {type: 'text/csv;charset=utf-8'});
    }

    return new Blob([zs_parser.to_json(rows)], {type: 'application/json'});
}

/**
 * Download a Blob via the browser's download manager
 *
 * The object URL is revoked once the download has finished, via
 * downloadListener().
 *
 * @param blob  Blob to download
 * @param filename  Name to suggest for the downloaded file
 * @returns {Promise<void>}
 */
async function download_file(blob, filename) {
    const object_url = window.URL.createObjectURL(blob);
    const download_id = await browser.downloads.download({
        url: object_url,
        filename: filename,
        conflictAction: 'uniquify'
    });
    downloadUrls.set(download_id, object_url);
}

/**
 * Build a file name for an export of a given platform's items
 *
 * @param platform  Platform the items were collected from
 * @param suffix  File name suffix, e.g. 'parsed'
 * @param extension  File extension, without leading dot
 * @returns {string}
 */
function export_filename(platform, suffix, extension) {
    const date = (new Date()).toISOString().split(".")[0].replace(/:/g, "");
    return 'zeeschuimer-export-' + platform + '-' + (suffix ? suffix + '-' : '') + date + '.' + extension;
}

/**
 * Use StreamSaver to download a Blob
 *
 * This is advantageous for very large files because the download starts
 * while items are being collected, instead of only after an NDJSON has been
 * created and stored in memory. However, StreamSaver is kind of awkward to
 * use in an extension context, so for now this function is not used.
 *
 * @param platform
 * @param filename
 * @returns {Promise<void>}
 */
async function download_blob(platform, filename) {
    if (!fileStream) {
        fileStream = streamSaver.createWriteStream(filename)
        writer = fileStream.getWriter()
    }

    await iterate_items(platform, function(item) {
        writer.write(encode(JSON.stringify(item) + "\n"));
    });

    await writer.close();
    writer = undefined;
    fileStream = undefined;
}

/**
 * Iterate through all collected items for a given platform
 *
 * A callback function will be called with each item as its only argument. This
 * function iterates over the items in chunks of 500, to avoid issues with
 * large datasets that are too much for the browser to handle in one go.
 *
 * @param platform  Platform to iterate items for
 * @param callback  Callback to call for each item
 * @returns {Promise<void>}
 */
async function iterate_items(platform, callback) {
    let previous;
    while(true) {
        let items;
        // we paginate here in this somewhat roundabout way because firefox
        // crashes if we query everything in one go for large datasets
        if(!previous) {
            items = await db.items
                .orderBy('id')
                .filter(item => item.source_platform === platform)
                .limit(500).toArray();
        } else {
            items = await db.items
                .where('id')
                .aboveOrEqual(previous.id)
                .filter(fastForward(previous, 'id', item => item.source_platform === platform))
                .limit(500).toArray();
        }

        if(!items.length) {
            break;
        }

        items.forEach(item => {
            callback(item);
            previous = item;
        })
    }
}

/**
 * Listen for completed downloads, and if the download that has completed
 * was one of our object URLs, then revoke it.
 * @param delta object representing the changes that caused this event to fire.
 */
function downloadListener(delta) {
    if(delta.state && delta.state.current === "complete") {
        const url = downloadUrls.get(delta.id);
        if(url) {
            window.URL.revokeObjectURL(url);
            downloadUrls.delete(delta.id);
        }
    }
}

/**
 * Helper function for Dexie pagination
 *
 * Used to paginate through results where large result sets may be too much for
 * Firefox to handle.
 *
 * See https://dexie.org/docs/Collection/Collection.offset().
 *
 * @param lastRow  Last seen row (that should not be included)
 * @param idProp  Property to compare between items
 * @param otherCriteria  Other filters, as a function that returns a bool.
 * @returns {(function(*): (*|boolean))|*}
 */
function fastForward(lastRow, idProp, otherCriteria) {
    let fastForwardComplete = false;
    return item => {
        if (fastForwardComplete) return otherCriteria(item);
        if (item[idProp] === lastRow[idProp]) {
            fastForwardComplete = true;
        }
        return false;
    };
}

/**
 * Init!
 */
document.addEventListener('DOMContentLoaded', async function () {
    platform_modules = await load_platform_modules();
    await init_parse_export();

    get_stats();
    setInterval(get_stats, 1000);

    document.addEventListener('click', button_handler);
    document.addEventListener('keyup', set_4cat_url);
    document.addEventListener('change', set_4cat_url);

    const version_container = document.querySelector('.version a');
    const current_version = version_container.innerText;
    const known_version = await browser.storage.local.get('zs-version');
    if(!known_version || current_version !== known_version['zs-version']) {
        const version_alert = createElement('span', {'class': 'popup new-version'}, 'Zeeschuimer has been updated to a new version! You can read the release notes via this link.');
        const ok_button = createElement('button', {'class': 'close-popup'}, 'OK');
        ok_button.addEventListener('click', async function(e) {
            await browser.storage.local.set({'zs-version': current_version});
            document.querySelector('.new-version').remove();
        });
        version_alert.appendChild(ok_button);
        document.querySelector('header').appendChild(version_alert);
    }

    const fourcat_url = await browser.storage.local.get('4cat-url');
    document.querySelector('#fourcat-url').value = fourcat_url['4cat-url'] ? fourcat_url['4cat-url'] : '';

    browser.downloads.onChanged.addListener(downloadListener);
});