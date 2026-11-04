/**
 * Outbound settings (owner rule, 4 Nov 2026: "dont send any ping message other than our dashboard").
 *
 *   proactiveOutbound  default OFF. When OFF the bot never starts a conversation on its own: no planner follow-ups,
 *                      no persuasion nudges, no consent reminders, no timer-driven sends, no admin WhatsApp pings.
 *                      Only replies to incoming messages and sends the operator triggers from the dashboard go out.
 *   quietHours         default ON. Bulk Send pauses 21:00-08:00 IST. Replies are never blocked by it.
 *
 * Stored in outbound_settings.json (gitignored, so a dashboard toggle never dirties the VM's git tree).
 * Env PROACTIVE_OUTBOUND=on / BULK_QUIET_HOURS=off only change the defaults; the dashboard value wins once set.
 */
const fs = require('fs');
const path = require('path');

const FILE = process.env.OUTBOUND_SETTINGS_PATH || path.join(__dirname, 'outbound_settings.json');
function defaults() {
    return {
        proactiveOutbound: String(process.env.PROACTIVE_OUTBOUND || '').toLowerCase() === 'on',
        quietHours: String(process.env.BULK_QUIET_HOURS || '').toLowerCase() !== 'off'
    };
}
let cache = null;
function load() {
    if (cache) return cache;
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch (e) { saved = {}; }
    const d = defaults();
    cache = {
        proactiveOutbound: typeof saved.proactiveOutbound === 'boolean' ? saved.proactiveOutbound : d.proactiveOutbound,
        quietHours: typeof saved.quietHours === 'boolean' ? saved.quietHours : d.quietHours,
        updatedAt: saved.updatedAt || null
    };
    return cache;
}
function get() { return { ...load() }; }
function set(changes = {}) {
    const cur = load();
    const next = { ...cur };
    if (typeof changes.proactiveOutbound === 'boolean') next.proactiveOutbound = changes.proactiveOutbound;
    if (typeof changes.quietHours === 'boolean') next.quietHours = changes.quietHours;
    next.updatedAt = new Date().toISOString();
    try { fs.writeFileSync(FILE, JSON.stringify(next, null, 2) + '\n', 'utf8'); } catch (e) {}
    cache = next;
    return get();
}
function proactiveEnabled() { return load().proactiveOutbound === true; }
function quietHoursEnabled() { return load().quietHours !== false; }
function _reset() { cache = null; }
module.exports = { FILE, get, set, proactiveEnabled, quietHoursEnabled, _reset };
