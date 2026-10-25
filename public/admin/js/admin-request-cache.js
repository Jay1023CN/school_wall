(function(root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory;
    else root.createAdminRequestCache = factory;
}(typeof window !== 'undefined' ? window : this, function(options) {
    'use strict';
    options = options || {};
    var now = options.now || Date.now;
    var ttl = options.ttl || 15000;
    var entries = new Map();
    var scope = null;
    var generation = 0;

    function clear() {
        generation++;
        entries.clear();
    }

    async function request(url, settings, send) {
        settings = settings || {};
        if (scope !== settings.scope) {
            scope = settings.scope;
            clear();
        }
        var method = String(settings.method || 'GET').toUpperCase();
        if (method !== 'GET' && method !== 'HEAD') {
            clear();
            try { return await send(); }
            finally { clear(); }
        }
        if (settings.skipCache || !/^\/api\/admin\/(?:stats|badges|posts|users|songs)(?:\?|$)/.test(url)) return send();
        var existing = entries.get(url);
        if (existing && (existing.pending || existing.expiresAt > now())) {
            return (await existing.promise).clone();
        }
        entries.delete(url);
        while (entries.size >= 32) entries.delete(entries.keys().next().value);
        var version = generation;
        var entry = { pending: true, expiresAt: 0, promise: null };
        entry.promise = (async function() {
            try {
                var response = await send();
                var payload = response && response.ok ? await response.clone().json().catch(function() { return null; }) : null;
                if (!payload || payload.code !== 200 || version !== generation) {
                    if (entries.get(url) === entry) entries.delete(url);
                } else {
                    entry.pending = false;
                    entry.expiresAt = now() + ttl;
                }
                return response;
            } catch (error) {
                if (entries.get(url) === entry) entries.delete(url);
                throw error;
            }
        }());
        entries.set(url, entry);
        return (await entry.promise).clone();
    }

    return { request: request, clear: clear };
}));
