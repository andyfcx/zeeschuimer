/**
 * zs-parser
 *
 * JavaScript port of the zs-parser tool, which reduces raw Zeeschuimer items
 * to a flat, analysis-ready table. Field names, field order and value
 * formatting mirror the Python implementation (src/zs_parser/tools.py) so
 * exports made here and with the CLI can be used interchangeably.
 *
 * Exposes `zs_parser` in the global scope.
 */
(function (global) {
    /**
     * Parse an integer, ignoring thousand separators
     *
     * Mirrors safe_int(): anything unparseable becomes 0.
     */
    function safe_int(value) {
        if (typeof value === "string") {
            value = value.replace(/,/g, "");
        }
        const parsed = parseInt(value, 10);
        return isNaN(parsed) ? 0 : parsed;
    }

    /**
     * Format a UNIX timestamp as '%Y-%m-%d %H:%M:%S' in local time
     *
     * Python's datetime.fromtimestamp() is local time, so this is too.
     */
    function format_timestamp(timestamp) {
        const date = new Date(safe_int(timestamp) * 1000);
        if (isNaN(date.getTime())) {
            return "Unknown";
        }
        const pad = (number) => String(number).padStart(2, "0");
        return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) + " " +
            pad(date.getHours()) + ":" + pad(date.getMinutes()) + ":" + pad(date.getSeconds());
    }

    /**
     * Collect all values of a key, anywhere in a nested object or array
     *
     * The equivalent of the JSONPath expression `$..key`.
     *
     * @param object  Object to search
     * @param key  Key to look for
     * @returns {Array}  All values found, in document order
     */
    function deep_find(object, key) {
        const results = [];

        function search(value) {
            if (!value || typeof value !== "object") {
                return;
            }
            if (Array.isArray(value)) {
                value.forEach(search);
                return;
            }
            for (const property of Object.keys(value)) {
                if (property === key) {
                    results.push(value[property]);
                }
                search(value[property]);
            }
        }

        search(object);
        return results;
    }

    /**
     * Follow a path of keys from a given value
     *
     * Arrays encountered along the way are traversed, so a path may resolve to
     * more than one value.
     *
     * @param value  Value to start from
     * @param path  Array of keys to follow
     * @returns {Array}  All values the path resolves to
     */
    function walk_path(value, path) {
        let current = [value];
        for (const key of path) {
            const next = [];
            for (const item of current) {
                if (!item || typeof item !== "object") {
                    continue;
                }
                if (Array.isArray(item)) {
                    item.forEach(entry => {
                        if (entry && typeof entry === "object" && entry[key] !== undefined) {
                            next.push(entry[key]);
                        }
                    });
                } else if (item[key] !== undefined) {
                    next.push(item[key]);
                }
            }
            current = next;
        }
        return current.filter(item => item !== undefined && item !== null);
    }

    /**
     * Collect all values matching `$..key.rest.of.path`
     */
    function deep_find_path(object, key, path) {
        let results = [];
        for (const match of deep_find(object, key)) {
            results = results.concat(walk_path(match, path));
        }
        return results;
    }

    /**
     * Remove items with a duplicate value for the given key
     *
     * The first item with a given value is kept.
     */
    function remove_duplicates_by_key(items, key) {
        const seen = new Set();
        const result = [];
        for (const item of items) {
            const value = item[key];
            if (!seen.has(value)) {
                seen.add(value);
                result.push(item);
            }
        }
        return result;
    }

    /**
     * Determine the post ID of a Facebook item
     *
     * Zeeschuimer's Facebook module stores the (base64-decoded) story ID, e.g.
     * 'Story:12345' or 'S:_I67890:12345'; the numerical post ID is the last
     * segment. If the captured data has an explicit post_id, that is used.
     */
    function facebook_post_id(item, data) {
        if (data.post_id) {
            return String(data.post_id);
        }

        let id = item.item_id || data.id || "";
        id = String(id);
        if (id.indexOf(":") !== -1) {
            id = id.split(":").pop();
        }
        return id;
    }

    /**
     * Parse Facebook items
     *
     * Mirrors fb_parser().
     *
     * @param items  Array of Zeeschuimer items
     * @param log  Optional callback for status messages
     * @returns {Array}  Array of flat objects, deduplicated by post ID
     */
    function fb_parser(items, log) {
        const result_data = [];

        for (const item of items) {
            const data = item.data || {};

            const post_url = [...new Set(deep_find(data, "wwwURL").filter(Boolean))];

            const creation_times = deep_find_path(data, "story", ["creation_time"]).map(safe_int).filter(Boolean);
            const creation_time = creation_times.length ? format_timestamp(Math.min(...creation_times)) : "Unknown";

            let attachment_urls = [];
            for (const attachments of deep_find(data, "attachments")) {
                attachment_urls = attachment_urls.concat(deep_find(attachments, "url"));
            }
            const attachments = [...new Set(attachment_urls.filter(Boolean))];

            const texts = walk_path(data.comet_sections, ["content", "story", "message", "text"]);
            const text = texts.length ? texts[0] : "";

            const reaction_edges = deep_find_path(data, "comet_ufi_summary_and_actions_renderer",
                ["feedback", "top_reactions", "edges"]).filter(edges => Array.isArray(edges));
            let reactions = [];
            let total_reaction_count = 0;
            if (reaction_edges.length) {
                reactions = reaction_edges[0].map(edge => ({
                    [edge && edge.node ? edge.node.localized_name : ""]: safe_int(edge ? edge.reaction_count : 0)
                }));
                total_reaction_count = reaction_edges[0].reduce((total, edge) => total + safe_int(edge ? edge.reaction_count : 0), 0);
            }

            const comment_counts = deep_find_path(data, "comments_count_summary_renderer",
                ["feedback", "comment_rendering_instance", "comments", "total_count"]);
            const comment_count = comment_counts.length ? safe_int(comment_counts[0]) : 0;

            const share_counts = deep_find(data, "i18n_share_count");
            const share_count = share_counts.length ? safe_int(share_counts[0]) : 0;

            result_data.push({
                post_id: facebook_post_id(item, data),
                post_url: post_url,
                creation_time: creation_time,
                attachments: attachments,
                text: text,
                total_reaction_count: total_reaction_count,
                reactions: reactions,
                comment_count: comment_count,
                share_count: share_count
            });
        }

        return deduplicate(result_data, log);
    }

    /**
     * Parse TikTok items
     *
     * Mirrors tk_parser().
     *
     * @param items  Array of Zeeschuimer items
     * @param log  Optional callback for status messages
     * @returns {Array}  Array of flat objects, deduplicated by post ID
     */
    function tk_parser(items, log) {
        const result_data = [];

        for (const item of items) {
            const data = item.data || {};
            const video = data.video || {};
            const author = data.author || {};
            const stats = data.stats || {};

            const attachments = [];
            if (video.playAddr) {
                attachments.push(video.playAddr);
            }
            if (video.cover) {
                attachments.push(video.cover);
            }

            result_data.push({
                post_id: data.id,
                post_url: item.source_platform_url,
                creation_time: format_timestamp(data.createTime || 0),
                attachments: attachments,
                text: data.desc || "",
                author_name: author.nickname || "",
                author_id: author.uniqueId || "",
                like_count: safe_int(stats.diggCount || 0),
                comment_count: safe_int(stats.commentCount || 0),
                share_count: safe_int(stats.shareCount || 0),
                play_count: safe_int(stats.playCount || 0)
            });
        }

        return deduplicate(result_data, log);
    }

    /**
     * Deduplicate parsed rows by post ID, logging both counts
     */
    function deduplicate(rows, log) {
        const report = typeof log === "function" ? log : () => {};
        report("Original Data count: " + rows.length);
        const deduplicated = remove_duplicates_by_key(rows, "post_id");
        report("Deduplicated Data count: " + deduplicated.length);
        return deduplicated;
    }

    /**
     * Parse items, using the parser matching their platform
     *
     * Mirrors general_parser(): unknown platforms fall back to the Facebook
     * parser.
     *
     * @param items  Array of Zeeschuimer items
     * @param log  Optional callback for status messages
     * @returns {Array}  Array of flat objects
     */
    function general_parser(items, log) {
        const report = typeof log === "function" ? log : () => {};
        if (!items || !items.length) {
            return [];
        }

        const source_platform = String(items[0].source_platform || "").toLowerCase();

        if (source_platform.indexOf("facebook") !== -1) {
            report("Using Facebook parser for platform: " + items[0].source_platform);
            return fb_parser(items, report);
        } else if (source_platform.indexOf("tiktok") !== -1) {
            report("Using TikTok parser for platform: " + items[0].source_platform);
            return tk_parser(items, report);
        }

        report("Unknown platform: " + items[0].source_platform + ", falling back to Facebook parser");
        return fb_parser(items, report);
    }

    /**
     * Flatten a single value for CSV output
     *
     * Lists are joined with '; '; reactions are rendered as 'name:count'.
     */
    function flatten_value(key, value) {
        if (Array.isArray(value)) {
            if (key === "reactions") {
                return value.map(reaction => {
                    const name = Object.keys(reaction)[0];
                    return name + ":" + reaction[name];
                }).join("; ");
            }
            return value.map(entry => String(entry)).join("; ");
        }
        return value === null || value === undefined ? "" : String(value);
    }

    /**
     * Render parsed rows as CSV
     *
     * Mirrors write_csv_output(); a byte order mark is prepended so that
     * spreadsheet software reads the file as UTF-8.
     *
     * @param rows  Array of flat objects
     * @returns {string}  CSV data
     */
    function to_csv(rows) {
        if (!rows || !rows.length) {
            return "";
        }

        const headers = Object.keys(rows[0]);
        const escape = (value) => {
            const string = String(value);
            return /[",\r\n]/.test(string) ? '"' + string.replace(/"/g, '""') + '"' : string;
        };

        const lines = [headers.map(escape).join(",")];
        for (const row of rows) {
            lines.push(headers.map(header => escape(flatten_value(header, row[header]))).join(","));
        }

        return "﻿" + lines.join("\r\n") + "\r\n";
    }

    /**
     * Render parsed rows as indented JSON
     *
     * @param rows  Array of flat objects
     * @returns {string}  JSON data
     */
    function to_json(rows) {
        return JSON.stringify(rows, null, 2);
    }

    global.zs_parser = {
        safe_int: safe_int,
        format_timestamp: format_timestamp,
        deep_find: deep_find,
        deep_find_path: deep_find_path,
        walk_path: walk_path,
        remove_duplicates_by_key: remove_duplicates_by_key,
        fb_parser: fb_parser,
        tk_parser: tk_parser,
        general_parser: general_parser,
        to_csv: to_csv,
        to_json: to_json
    };
})(typeof self !== 'undefined' ? self : this);
