/**
 * Broadcast Engine — safe bulk sending across multiple Baileys WhatsApp lines.
 *
 * Anti-ban design:
 *   - Indian numbers normalised to 91XXXXXXXXXX, deduped, invalid ones skipped
 *   - sock.onWhatsApp() checked before each send; non-WhatsApp numbers skipped
 *   - random delay (default 20-60s) between sends on each line
 *   - per-line hourly (default 60) and daily (default 250) caps, shared across campaigns
 *   - spintax {नमस्ते|राम राम} so no two messages are byte-identical, {name} placeholder
 *   - "typing…" presence before every send
 *   - line auto-paused after 3 consecutive errors or on disconnect
 *   - round-robin across connected lines
 *   - quiet hours (default 21:00-08:00 IST) — no sends at night
 *   - state persisted to broadcast_state.json after every change; restart resumes, never double-sends
 *   - opt-outs (STOP / बंद / रुको …) are permanent and checked at send time
 */
const fs = require('fs');
const path = require('path');

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.webp'];
const VIDEO_EXT = ['.mp4', '.3gp', '.mov', '.m4v'];
const DOC_EXT = ['.pdf'];
const mediaTypeOf = ext => IMAGE_EXT.includes(ext) ? 'image' : VIDEO_EXT.includes(ext) ? 'video' : DOC_EXT.includes(ext) ? 'document' : null;

const DEFAULT_CAPS = {
    hourlyCap: 60,
    dailyCap: 250,
    minDelaySec: 20,
    maxDelaySec: 60,
    quietStartHour: 21, // IST, inclusive
    quietEndHour: 8     // IST, exclusive. Set start === end to disable quiet hours
};
const LIMITS = { hourlyCap: [1, 200], dailyCap: [1, 1000], minDelaySec: [10, 600], maxDelaySec: [10, 1800] };
const MAX_CONSECUTIVE_ERRORS = 3;
const RECONNECT_STABLE_MS = 2 * 60 * 1000;
const MAX_CHECK_ATTEMPTS = 3;

const contactUtils = require('./contact_utils.js');
const normalizePhone = contactUtils.normalizeIndianPhone;

function spin(text, rng = Math.random) {
    let out = String(text || '');
    const re = /\{([^{}]*\|[^{}]*)\}/;
    let guard = 0;
    while (re.test(out) && guard++ < 500) {
        out = out.replace(re, (_, inner) => {
            const opts = inner.split('|');
            return opts[Math.floor(rng() * opts.length)];
        });
    }
    return out;
}

function renderMessage(template, recipient, rng = Math.random, nameFallback = 'भाई जी') {
    const name = (recipient && recipient.name && String(recipient.name).trim()) || nameFallback;
    return spin(template, rng).replace(/\{\s*(name|naam|नाम)\s*\}/gi, name).trim();
}

function dedupeAndValidate(rows, isBlocked = () => null) {
    const seen = new Set();
    const valid = [];
    const invalid = [];
    const blocked = [];
    let duplicates = 0;
    for (const r of rows) {
        const phone = normalizePhone(r.phone);
        if (!phone) { invalid.push(String(r.phone || '').slice(0, 40)); continue; }
        if (seen.has(phone)) { duplicates++; continue; }
        seen.add(phone);
        const rec = { phone, name: String(r.name || '').trim().slice(0, 60), ward: r.ward ? String(r.ward).trim().slice(0, 10) : '', village: String(r.village || '').trim().slice(0, 40) };
        const reason = isBlocked(phone);
        if (reason) { blocked.push({ ...rec, reason }); continue; }
        valid.push(rec);
    }
    return { valid, invalid, duplicates, blocked };
}

function istDateKey(ms) { const d = new Date(ms + IST_OFFSET_MS); return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0'); }
function istHour(ms) { return new Date(ms + IST_OFFSET_MS).getUTCHours(); }
function inQuietHours(ms, caps) {
    const s = caps.quietStartHour, e = caps.quietEndHour;
    if (s === undefined || e === undefined || s === null || e === null || s === e) return false;
    const h = istHour(ms);
    return s < e ? (h >= s && h < e) : (h >= s || h < e);
}

function normalizeCaps(input = {}) {
    const caps = { ...DEFAULT_CAPS };
    const errors = [];
    for (const k of Object.keys(DEFAULT_CAPS)) {
        if (input[k] === undefined || input[k] === null || input[k] === '') continue;
        const n = Number(input[k]);
        if (!Number.isFinite(n)) { errors.push(`${k} must be a number`); continue; }
        caps[k] = Math.round(n);
    }
    for (const [k, [lo, hi]] of Object.entries(LIMITS)) {
        if (caps[k] < lo || caps[k] > hi) errors.push(`${k} must be between ${lo} and ${hi}`);
    }
    for (const k of ['quietStartHour', 'quietEndHour']) {
        if (caps[k] < 0 || caps[k] > 23) errors.push(`${k} must be 0-23`);
    }
    if (caps.maxDelaySec < caps.minDelaySec) errors.push('maxDelaySec must be >= minDelaySec');
    if (caps.hourlyCap > caps.dailyCap) errors.push('hourlyCap cannot exceed dailyCap');
    return { caps, errors };
}

const csvEscape = contactUtils.csvEscape;

// ---------------- Engine ----------------

class BroadcastEngine {
    /**
     * @param {object} opts
     * @param {string} opts.stateFile
     * @param {string} opts.mediaDir
     * @param {() => Array<{id,name,status,sock}>} opts.getSessions
     * @param {() => number} [opts.now]
     * @param {() => number} [opts.random]
     * @param {(ms:number) => Promise} [opts.sleep]
     * @param {(info:object) => void} [opts.onSent]  hook after each successful send (logging/CRM)
     * @param {(phone:string) => string|null} [opts.isBlocked]  consent policy check (e.g. declined outreach)
     */
    constructor(opts) {
        this.stateFile = opts.stateFile;
        this.mediaDir = opts.mediaDir;
        this.getSessions = opts.getSessions;
        this.now = opts.now || (() => Date.now());
        this.random = opts.random || Math.random;
        this.sleep = opts.sleep || (ms => new Promise(r => setTimeout(r, ms)));
        this.onSent = opts.onSent || (() => {});
        // External policy hook (engagement_policy via user memory): returns a skip reason or null
        this.externalBlock = opts.isBlocked || (() => null);
        // Campaign silence period (e.g. 48h before the poll): no bulk campaigning at all while true
        this.isSilenced = opts.isSilenced || (() => false);
        // Dashboard toggle (outbound_settings.json): quiet hours on/off for bulk sends. Default ON. Replies are never affected.
        this.quietHoursEnabled = opts.quietHoursEnabled || (() => true);
        // Sticky lines: a person always continues on the line they already talk to
        this.getAssignedLine = opts.getAssignedLine || (() => null);
        this.log = opts.logger || console;
        this.inFlight = new Set(); // line ids currently sending
        this.ticking = false;
        this.timer = null;
        this.state = { campaigns: {}, activeId: null, optOuts: {}, lineStats: {} };
        this.load();
    }

    // ---------- persistence ----------
    load() {
        try {
            if (fs.existsSync(this.stateFile)) {
                const s = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
                this.state = { campaigns: {}, activeId: null, optOuts: {}, lineStats: {}, ...s };
            }
        } catch (e) {
            this.log.error('[Broadcast] Could not read state, starting fresh:', e.message);
            try { fs.copyFileSync(this.stateFile, this.stateFile + '.corrupt-' + Date.now()); } catch (_) {}
        }
        // Crash recovery: a recipient left in 'sending' may or may not have been delivered.
        // We NEVER resend it (no double-sends) — mark it skipped and let the admin decide.
        let recovered = 0;
        for (const c of Object.values(this.state.campaigns)) {
            for (const r of c.recipients) {
                if (r.status === 'sending' || r.status === 'checking') {
                    if (r.status === 'checking') { r.status = 'pending'; }
                    else { r.status = 'skipped'; r.reason = 'interrupted_during_send_maybe_delivered'; r.at = new Date(this.now()).toISOString(); }
                    recovered++;
                }
            }
        }
        if (recovered) { this.log.warn(`[Broadcast] Recovered ${recovered} in-flight recipients after restart`); this.save(); }
    }

    save() {
        if (!this.stateFile) return;
        const tmp = this.stateFile + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(this.state), 'utf8');
        fs.renameSync(tmp, this.stateFile);
    }

    // ---------- opt-outs ----------
    // Text matching (STOP/बंद/रुको) lives in engagement_policy.js; this keeps a durable list of
    // opted-out numbers that survives user_memory resets and is checked at create AND send time.
    blockReason(phone) {
        if (this.state.optOuts[phone]) return 'opted_out';
        try { return this.externalBlock(phone) || null; } catch (_) { return null; }
    }
    isOptedOut(phone) { const p = normalizePhone(phone) || String(phone || ''); return !!this.state.optOuts[p]; }
    markOptOut(phone, text = '') {
        const p = normalizePhone(phone) || String(phone || '').replace(/[^\d]/g, '');
        if (!p) return false;
        const already = !!this.state.optOuts[p];
        this.state.optOuts[p] = { at: new Date(this.now()).toISOString(), text: String(text).slice(0, 60) };
        for (const c of Object.values(this.state.campaigns)) {
            for (const r of c.recipients) {
                if (r.phone === p && r.status === 'pending') { r.status = 'skipped'; r.reason = 'opted_out'; r.at = new Date(this.now()).toISOString(); }
            }
        }
        this.save();
        return !already;
    }
    removeOptOut(phone) {
        const p = normalizePhone(phone) || String(phone || '');
        if (!this.state.optOuts[p]) return false;
        delete this.state.optOuts[p];
        this.save();
        return true;
    }

    // ---------- media ----------
    resolveMedia(file) {
        if (!file) return null;
        const base = path.basename(String(file));
        if (base !== String(file) || base.startsWith('.')) throw new Error('Invalid media file name');
        const ext = path.extname(base).toLowerCase();
        const type = mediaTypeOf(ext);
        if (!type) throw new Error('Media must be an image (jpg/png/webp), video (mp4/3gp/mov) or PDF');
        require('./media_policy.js').assertSendable(base);
        const full = path.join(this.mediaDir, base);
        if (!fs.existsSync(full)) throw new Error(`Media file not found: ${base}`);
        return { file: base, type, path: full };
    }

    listMedia() {
        try {
            return fs.readdirSync(this.mediaDir).filter(f => {
                const ext = path.extname(f).toLowerCase();
                return !f.startsWith('.') && !!mediaTypeOf(ext);
            }).map(f => {
                const ext = path.extname(f).toLowerCase();
                let size = 0, mtime = 0;
                try { const st = fs.statSync(path.join(this.mediaDir, f)); size = st.size; mtime = st.mtimeMs; } catch (_) {}
                return { file: f, type: mediaTypeOf(ext), size, mtime, url: '/media/' + encodeURIComponent(f), retired: require('./media_policy.js').isRetired(f) };
            }).sort((a, b) => b.mtime - a.mtime);
        } catch (e) { return []; }
    }

    // ---------- lines ----------
    lineStat(id) {
        if (!this.state.lineStats[id]) this.state.lineStats[id] = { sentTimes: [], daily: {}, consecutiveErrors: 0, paused: false, pausedReason: null, nextAt: 0, reconnectedAt: null };
        return this.state.lineStats[id];
    }

    connectedSessions(ids) {
        return (this.getSessions() || []).filter(s => (!ids || ids.includes(s.id)) && s.status === 'CONNECTED' && s.sock);
    }

    lineUsage(id) {
        const st = this.lineStat(id);
        const now = this.now();
        st.sentTimes = st.sentTimes.filter(t => now - t < 3600 * 1000);
        const day = istDateKey(now);
        for (const k of Object.keys(st.daily)) if (k !== day) delete st.daily[k];
        return { hour: st.sentTimes.length, day: st.daily[day] || 0 };
    }

    // ---------- campaign lifecycle ----------
    buildRecipients({ phones, csvText, contacts }) {
        const rows = [
            ...contactUtils.parsePastedContacts(phones),
            ...(csvText ? contactUtils.parseContactCsv(csvText) : []),
            ...(contacts || []).map(c => ({ phone: c.phone, name: c.name, ward: c.ward, village: c.village }))
        ];
        return { totalInput: rows.length, ...dedupeAndValidate(rows, p => this.blockReason(p)) };
    }

    preview(input) {
        const { caps, errors } = normalizeCaps(input.caps || {});
        const built = this.buildRecipients(input);
        const samples = built.valid.slice(0, 3).map(r => ({ phone: r.phone, text: renderMessage(input.message || '', r, this.random) }));
        if (!samples.length && input.message) samples.push({ phone: '91XXXXXXXXXX', text: renderMessage(input.message, { name: '' }, this.random) });
        return {
            totalInput: built.totalInput, valid: built.valid.length, invalid: built.invalid.length, invalidSamples: built.invalid.slice(0, 10),
            duplicates: built.duplicates, optedOut: built.blocked.length, caps, capErrors: errors, samples
        };
    }

    active() {
        const c = this.state.activeId && this.state.campaigns[this.state.activeId];
        return c || null;
    }

    /** Validates and creates a campaign. Returns {ok, status, error?, campaign?}. */
    create(input = {}) {
        const cur = this.active();
        if (cur && (cur.status === 'running' || cur.status === 'paused')) {
            return { ok: false, status: 409, error: `Campaign ${cur.id} is still ${cur.status}. Cancel it or wait for it to finish first.` };
        }
        const message = String(input.message || '').trim();
        let media = null;
        try { media = this.resolveMedia(input.mediaFile); } catch (e) { return { ok: false, status: 400, error: e.message }; }
        if (!message && !media) return { ok: false, status: 400, error: 'Message text (or a media file) is required' };
        if (message.length > 4000) return { ok: false, status: 400, error: 'Message is too long (max 4000 characters)' };
        const { caps, errors } = normalizeCaps(input.caps || {});
        if (errors.length) return { ok: false, status: 400, error: errors.join('; ') };

        const built = this.buildRecipients(input);
        if (!built.valid.length) {
            return { ok: false, status: 400, error: built.totalInput ? 'No valid, new Indian mobile numbers after cleaning (all invalid, duplicate or opted-out)' : 'No recipients given (paste numbers, upload CSV, or choose contacts)', preview: { invalid: built.invalid.length, duplicates: built.duplicates, optedOut: built.blocked.length } };
        }

        const allSessions = this.getSessions() || [];
        let lines = Array.isArray(input.lines) ? input.lines.filter(Boolean) : (input.lines ? String(input.lines).split(',').map(s => s.trim()).filter(Boolean) : []);
        if (!lines.length) lines = allSessions.map(s => s.id);
        const unknown = lines.filter(id => !allSessions.find(s => s.id === id));
        if (unknown.length) return { ok: false, status: 400, error: `Unknown line(s): ${unknown.join(', ')}` };
        if (!this.connectedSessions(lines).length) {
            return { ok: false, status: 503, error: 'no connected lines — none of the selected WhatsApp lines is connected. Scan the QR / link a line first.', code: 'NO_CONNECTED_LINES' };
        }

        const nowIso = new Date(this.now()).toISOString();
        const id = 'bc_' + this.now().toString(36) + Math.floor(this.random() * 1e6).toString(36);
        const recipients = [
            ...built.valid.map(r => ({ ...r, status: 'pending', reason: '', line: '', at: '', checks: 0 })),
            ...built.blocked.map(r => ({ ...r, status: 'skipped', line: '', at: nowIso, checks: 0 }))
        ];
        const campaign = {
            id, createdAt: nowIso, status: 'running', pauseReason: null, message, media: media ? { file: media.file, type: media.type } : null,
            lines, caps, recipients, invalidInputs: built.invalid.length, duplicatesRemoved: built.duplicates, finishedAt: null
        };
        this.state.campaigns[id] = campaign;
        this.state.activeId = id;
        // Clear stale error pauses on selected lines when a new campaign starts
        for (const l of lines) { const st = this.lineStat(l); if (st.pausedReason !== 'disconnected') { st.paused = false; st.pausedReason = null; st.consecutiveErrors = 0; } }
        this.pruneOldCampaigns();
        this.save();
        return { ok: true, status: 200, campaign: this.summary(campaign) };
    }

    pruneOldCampaigns(keep = 10) {
        const ids = Object.keys(this.state.campaigns).sort((a, b) => (this.state.campaigns[a].createdAt < this.state.campaigns[b].createdAt ? 1 : -1));
        for (const id of ids.slice(keep)) if (id !== this.state.activeId) delete this.state.campaigns[id];
    }

    pause(reason = 'manual') {
        const c = this.active();
        if (!c || c.status !== 'running') return { ok: false, status: 409, error: 'No running campaign to pause' };
        c.status = 'paused'; c.pauseReason = reason; this.save();
        return { ok: true, status: 200, campaign: this.summary(c) };
    }

    resume() {
        const c = this.active();
        if (!c || c.status !== 'paused') return { ok: false, status: 409, error: 'No paused campaign to resume' };
        for (const l of c.lines) { const st = this.lineStat(l); if (st.pausedReason !== 'disconnected') { st.paused = false; st.pausedReason = null; st.consecutiveErrors = 0; } }
        if (!this.connectedSessions(c.lines).length) {
            this.save();
            return { ok: false, status: 503, error: 'no connected lines — campaign stays paused until a selected line is connected', code: 'NO_CONNECTED_LINES' };
        }
        c.status = 'running'; c.pauseReason = null; this.save();
        return { ok: true, status: 200, campaign: this.summary(c) };
    }

    cancel() {
        const c = this.active();
        if (!c || (c.status !== 'running' && c.status !== 'paused')) return { ok: false, status: 409, error: 'No active campaign to cancel' };
        const at = new Date(this.now()).toISOString();
        for (const r of c.recipients) if (r.status === 'pending') { r.status = 'skipped'; r.reason = 'cancelled'; r.at = at; }
        c.status = 'cancelled'; c.finishedAt = at; this.save();
        return { ok: true, status: 200, campaign: this.summary(c) };
    }

    // ---------- scheduler ----------
    start(intervalMs = 2000) {
        if (this.timer) return;
        this.timer = setInterval(() => { this.tick().catch(e => this.log.error('[Broadcast] tick error:', e.message)); }, intervalMs);
        if (this.timer.unref) this.timer.unref();
    }
    stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

    /** One scheduling pass. Dispatches at most one send per available line. Returns array of promises (for tests). */
    async tick() {
        if (this.ticking) return [];
        this.ticking = true;
        const jobs = [];
        try {
            const c = this.active();
            if (!c || c.status !== 'running') return [];
            const now = this.now();
            const sessions = this.getSessions() || [];

            if (!c.recipients.some(r => r.status === 'pending' || r.status === 'sending' || r.status === 'checking')) {
                c.status = 'completed'; c.finishedAt = new Date(now).toISOString(); this.save();
                this.log.log(`[Broadcast] Campaign ${c.id} completed`);
                return [];
            }
            if (this.isSilenced(now)) { c.waitingReason = 'silence_period'; return []; }
            if (this.quietHoursEnabled() && inQuietHours(now, c.caps)) { c.waitingReason = 'quiet_hours'; return []; }

            // Update line connection state
            let changed = false;
            for (const id of c.lines) {
                const s = sessions.find(x => x.id === id);
                const st = this.lineStat(id);
                const connected = !!(s && s.status === 'CONNECTED' && s.sock);
                if (!connected) {
                    if (!st.paused) { st.paused = true; st.pausedReason = 'disconnected'; changed = true; this.log.warn(`[Broadcast] Line ${id} disconnected — auto-paused`); }
                    st.reconnectedAt = null;
                } else if (st.paused && st.pausedReason === 'disconnected') {
                    if (!st.reconnectedAt) st.reconnectedAt = now;
                    else if (now - st.reconnectedAt >= RECONNECT_STABLE_MS) { st.paused = false; st.pausedReason = null; st.consecutiveErrors = 0; st.nextAt = now + this.randomDelayMs(c.caps) / 4; changed = true; }
                }
            }

            const errorPaused = c.lines.filter(id => { const st = this.lineStat(id); return st.paused && st.pausedReason !== 'disconnected'; });
            if (errorPaused.length === c.lines.length) {
                c.status = 'paused'; c.pauseReason = 'all selected lines auto-paused after repeated errors'; this.save();
                return [];
            }

            // Round-robin start index
            c.rr = ((c.rr || 0) + 1) % c.lines.length;
            const order = c.lines.slice(c.rr).concat(c.lines.slice(0, c.rr));
            let waiting = null;
            for (const id of order) {
                const st = this.lineStat(id);
                if (st.paused || this.inFlight.has(id)) continue;
                if (now < (st.nextAt || 0)) continue;
                const use = this.lineUsage(id);
                if (use.day >= c.caps.dailyCap) { waiting = 'daily_cap'; continue; }
                if (use.hour >= c.caps.hourlyCap) { waiting = waiting || 'hourly_cap'; continue; }
                const r = c.recipients.find(x => {
                    if (x.status !== 'pending') return false;
                    let assigned = null;
                    try { assigned = this.getAssignedLine(x.phone); } catch (_) {}
                    // assigned to another line of this campaign -> leave it for that line
                    return !assigned || assigned === id || !c.lines.includes(assigned);
                });
                if (!r) continue;
                const sess = sessions.find(x => x.id === id);
                r.status = 'checking'; r.line = id;
                this.inFlight.add(id);
                changed = true;
                jobs.push(this.processRecipient(c, r, sess).finally(() => this.inFlight.delete(id)));
            }
            c.waitingReason = jobs.length ? null : waiting;
            if (changed) this.save();
        } finally {
            this.ticking = false;
        }
        return jobs;
    }

    randomDelayMs(caps) {
        const lo = caps.minDelaySec * 1000, hi = caps.maxDelaySec * 1000;
        return Math.round(lo + this.random() * (hi - lo));
    }

    /** Put a not-yet-sent recipient back in the queue (or mark cancelled). */
    release(c, r) {
        if (c.status === 'cancelled') { r.status = 'skipped'; r.reason = 'cancelled'; r.at = new Date(this.now()).toISOString(); }
        else { r.status = 'pending'; r.line = ''; }
    }

    async processRecipient(c, r, sess) {
        const st = this.lineStat(sess.id);
        const sock = sess.sock;
        const stamp = () => new Date(this.now()).toISOString();
        const lineError = (msg) => {
            st.consecutiveErrors = (st.consecutiveErrors || 0) + 1;
            if (st.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                st.paused = true; st.pausedReason = `errors: ${msg}`.slice(0, 120);
                this.log.warn(`[Broadcast] Line ${sess.id} auto-paused after ${st.consecutiveErrors} consecutive errors (${msg})`);
            }
        };
        try {
            // Re-check opt-out at send time (they may have replied STOP mid-campaign)
            const blocked = this.blockReason(r.phone);
            if (blocked) { r.status = 'skipped'; r.reason = blocked; r.at = stamp(); return; }
            if (c.status !== 'running') { this.release(c, r); return; }

            // 1. Is the number on WhatsApp?
            let jid = `${r.phone}@s.whatsapp.net`;
            try {
                const res = await sock.onWhatsApp(r.phone);
                const hit = Array.isArray(res) ? res[0] : res;
                if (!hit || !hit.exists) {
                    r.status = 'skipped'; r.reason = 'not_on_whatsapp'; r.at = stamp();
                    st.nextAt = this.now() + Math.round(this.randomDelayMs(c.caps) / 6); // small gap between lookups too
                    return;
                }
                if (hit.jid) jid = hit.jid;
            } catch (e) {
                r.checks = (r.checks || 0) + 1;
                lineError('onWhatsApp: ' + e.message);
                if (r.checks >= MAX_CHECK_ATTEMPTS) { r.status = 'failed'; r.reason = 'whatsapp_check_failed: ' + e.message; r.at = stamp(); }
                else { this.release(c, r); }
                st.nextAt = this.now() + this.randomDelayMs(c.caps);
                return;
            }

            const blockedLate = this.blockReason(r.phone);
            if (c.status !== 'running' || blockedLate) {
                if (blockedLate) { r.status = 'skipped'; r.reason = blockedLate; r.at = stamp(); } else { this.release(c, r); }
                return;
            }

            const text = renderMessage(c.message, r, this.random);

            // 2. Typing presence (human-like)
            try {
                await sock.presenceSubscribe?.(jid);
                await sock.sendPresenceUpdate?.('composing', jid);
                const typingMs = Math.min(9000, 1500 + text.length * 40) * (0.7 + this.random() * 0.6);
                await this.sleep(Math.round(typingMs));
                await sock.sendPresenceUpdate?.('paused', jid);
            } catch (_) { /* presence is best-effort */ }

            // 3. Mark as 'sending' and persist BEFORE the network call — guarantees no double send after a crash
            r.status = 'sending'; r.at = stamp();
            this.save();

            let content;
            if (c.media) {
                require('./media_policy.js').assertSendable(c.media.file);
                const mediaPath = path.join(this.mediaDir, c.media.file);
                if (!fs.existsSync(mediaPath)) throw Object.assign(new Error('media file missing: ' + c.media.file), { noLineError: true });
                content = c.media.type === 'video'
                    ? { video: { url: mediaPath }, caption: text }
                    : c.media.type === 'document'
                        ? { document: { url: mediaPath }, mimetype: 'application/pdf', fileName: c.media.file, caption: text }
                        : { image: { url: mediaPath }, caption: text };
            } else {
                content = { text };
            }
            const sent = await sock.sendMessage(jid, content);
            r.status = 'sent'; r.reason = ''; r.at = stamp(); r.msgId = sent?.key?.id || '';
            st.consecutiveErrors = 0;
            st.sentTimes.push(this.now());
            const day = istDateKey(this.now());
            st.daily[day] = (st.daily[day] || 0) + 1;
            st.nextAt = this.now() + this.randomDelayMs(c.caps);
            try { this.onSent({ campaignId: c.id, phone: r.phone, name: r.name, text, line: sess.id, lineName: sess.name, media: c.media, sent }); } catch (_) {}
        } catch (e) {
            r.status = 'failed'; r.reason = String(e.message || e).slice(0, 160); r.at = stamp();
            if (!e.noLineError) lineError(e.message || String(e));
            st.nextAt = this.now() + this.randomDelayMs(c.caps);
        } finally {
            this.save();
        }
    }

    // ---------- reporting ----------
    counts(c) {
        const k = { total: c.recipients.length, sent: 0, failed: 0, skipped: 0, pending: 0, inProgress: 0 };
        for (const r of c.recipients) {
            if (r.status === 'sent') k.sent++;
            else if (r.status === 'failed') k.failed++;
            else if (r.status === 'skipped') k.skipped++;
            else if (r.status === 'pending') k.pending++;
            else k.inProgress++;
        }
        k.remaining = k.pending + k.inProgress;
        return k;
    }

    etaSeconds(c, k) {
        if (!k.remaining || c.status !== 'running') return 0;
        const avgDelay = (c.caps.minDelaySec + c.caps.maxDelaySec) / 2 + 5; // + typing/upload overhead
        const live = this.connectedSessions(c.lines).filter(s => !this.lineStat(s.id).paused).length || 0;
        if (!live) return null;
        const perLinePerHour = Math.min(3600 / avgDelay, c.caps.hourlyCap);
        const perHour = perLinePerHour * live;
        let hours = k.remaining / perHour;
        const perDay = c.caps.dailyCap * live;
        if (k.remaining > perDay) hours += Math.floor(k.remaining / perDay) * 24 * 0.5; // rough: daily cap forces waits
        return Math.round(hours * 3600);
    }

    summary(c, { recent = 0 } = {}) {
        const k = this.counts(c);
        const out = {
            id: c.id, status: c.status, pauseReason: c.pauseReason, waitingReason: c.waitingReason || null, createdAt: c.createdAt, finishedAt: c.finishedAt,
            message: c.message, media: c.media, lines: c.lines, caps: c.caps, counts: k, etaSeconds: this.etaSeconds(c, k),
            invalidInputs: c.invalidInputs, duplicatesRemoved: c.duplicatesRemoved
        };
        if (recent) {
            out.recent = c.recipients.filter(r => r.status !== 'pending').sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, recent)
                .map(r => ({ phone: r.phone, name: r.name, status: r.status, reason: r.reason, line: r.line, at: r.at }));
        }
        return out;
    }

    status() {
        const c = this.active();
        const sessions = this.getSessions() || [];
        const lines = sessions.map(s => {
            const st = this.lineStat(s.id);
            const use = this.lineUsage(s.id);
            return { id: s.id, name: s.name, connected: s.status === 'CONNECTED' && !!s.sock, status: s.status, paused: !!st.paused, pausedReason: st.pausedReason, consecutiveErrors: st.consecutiveErrors || 0, sentLastHour: use.hour, sentToday: use.day, nextSendInSec: Math.max(0, Math.round(((st.nextAt || 0) - this.now()) / 1000)) };
        });
        return {
            campaign: c ? this.summary(c, { recent: 50 }) : null,
            lines,
            connectedLines: lines.filter(l => l.connected).length,
            optOutCount: Object.keys(this.state.optOuts).length,
            quietHoursEnabled: this.quietHoursEnabled(),
            quietHoursNow: this.quietHoursEnabled() && (c ? inQuietHours(this.now(), c.caps) : inQuietHours(this.now(), DEFAULT_CAPS)),
            defaults: DEFAULT_CAPS,
            history: Object.values(this.state.campaigns).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, 10).map(x => ({ id: x.id, status: x.status, createdAt: x.createdAt, counts: this.counts(x) }))
        };
    }

    /** Recipients of a campaign filtered by status and/or reason (for dialer export). */
    campaignRecipients(id, { statuses = null, reasons = null } = {}) {
        const c = id ? this.state.campaigns[id] : (this.active() || this.latest());
        if (!c) return null;
        return c.recipients.filter(r => (!statuses || statuses.includes(r.status)) && (!reasons || reasons.includes(r.reason)));
    }

    latest() {
        const all = Object.values(this.state.campaigns).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
        return all[0] || null;
    }

    resultsCsv(id) {
        const c = id ? this.state.campaigns[id] : (this.active() || this.latest());
        if (!c) return null;
        const head = ['phone', 'name', 'ward', 'village', 'status', 'reason', 'line', 'timestamp'];
        const rows = c.recipients.map(r => [r.phone, r.name, r.ward, r.village, r.status, r.reason, r.line, r.at].map(csvEscape).join(','));
        return '\uFEFF' + head.join(',') + '\n' + rows.join('\n') + '\n';
    }
}

module.exports = {
    mediaTypeOf, IMAGE_EXT, VIDEO_EXT, DOC_EXT,
    BroadcastEngine, normalizePhone, spin, renderMessage, dedupeAndValidate,
    normalizeCaps, inQuietHours, istDateKey, DEFAULT_CAPS
};
