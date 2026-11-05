/**
 * Scheduled Bulk Campaigns — quiet, spread-out sends for 100-200 people inside a time window.
 *
 * Operator-triggered only (the bot never starts a conversation on its own): the operator picks the audience,
 * a window (e.g. morning 08:00-11:00 or evening 17:00-20:00 IST), a few message variants and posters.
 *
 *   - every recipient gets its own random time inside the window (no same-minute burst)
 *   - per line, consecutive sends are at least a random 20-90 s apart (configurable)
 *   - message text AND poster rotate per recipient (balanced shuffle) + spintax {a|b} + {name}
 *   - recipients spread across the selected connected lines; sticky line for people who already talk to one
 *   - shares the Bulk Send engine's per-line hourly/daily caps (broadcast_state.json lineStats)
 *   - STOP / opt-out / declined checked at plan time AND at send time; विरोधी skipped unless chosen
 *   - state in scheduled_campaigns.json after every change: a restart resumes; a message that was mid-send is
 *     never resent (marked skipped: interrupted)
 *   - quiet hours OFF by default (owner: don't worry about day/night); can be turned on per campaign
 *   - test campaigns may ONLY target our own line numbers (for live verification)
 */
const fs = require('fs');
const path = require('path');
const { renderMessage, dedupeAndValidate, mediaTypeOf, inQuietHours, istDateKey } = require('./broadcast_engine.js');
const contactUtils = require('./contact_utils.js');

const IST_MS = 5.5 * 3600 * 1000;
const DEFAULTS = { minGapSec: 20, maxGapSec: 90, hourlyCap: 60, dailyCap: 250, graceMin: 60 };
const MAX_RECIPIENTS = 500;
const PRESETS = { morning: [8, 11], evening: [17, 20], dopahar: [13, 16] };

/** "2026-11-05T08:00" (IST wall clock) -> epoch ms. Also accepts full ISO with zone. */
function parseIst(v) {
    if (v === undefined || v === null || v === '') return null;
    if (typeof v === 'number') return v;
    const s = String(v).trim();
    if (/[zZ]|[+-]\d\d:?\d\d$/.test(s)) { const t = Date.parse(s); return Number.isFinite(t) ? t : null; }
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (!m) return null;
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) - IST_MS;
}
function istDateOf(ms) { return istDateKey(ms); }
function istLabel(ms) { if (!ms) return ''; const d = new Date(ms + IST_MS); return d.toISOString().slice(0, 16).replace('T', ' ') + ' IST'; }
function windowFromHours(date, startHour, endHour) {
    const [y, mo, d] = String(date).split('-').map(Number);
    const base = Date.UTC(y, mo - 1, d) - IST_MS;
    return { start: base + Math.round(startHour * 3600e3), end: base + Math.round(endHour * 3600e3) };
}

function shuffled(n, rng) { const a = [...Array(n).keys()]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
/** Balanced rotation: each variant used ~equally, order randomised. */
function rotation(count, n, rng) { const out = []; while (out.length < count) out.push(...shuffled(n, rng)); return out.slice(0, count); }

/**
 * Pure planner: assigns each recipient a line and a send time.
 * @returns {{ items: object[], overflow: number }}
 */
function planTimes(recipients, { start, end, lines, minGapSec, maxGapSec, rng = Math.random, lineFor = () => null }) {
    const byLine = {};
    const load = Object.fromEntries(lines.map(l => [l, 0]));
    const items = recipients.map(r => {
        let line = r.line && lines.includes(r.line) ? r.line : null;
        if (!line) { const a = lineFor(r.phone); if (a && lines.includes(a)) line = a; }
        if (!line) line = lines.slice().sort((a, b) => load[a] - load[b] || (rng() - 0.5))[0];
        load[line]++;
        return { ...r, line };
    });
    for (const it of items) (byLine[it.line] = byLine[it.line] || []).push(it);
    let overflow = 0;
    const span = Math.max(0, end - start);
    for (const group of Object.values(byLine)) {
        const times = group.map(() => start + Math.floor(rng() * span)).sort((a, b) => a - b);
        let prev = null;
        // shuffle who gets which slot so the order isn't the paste order
        const order = shuffled(group.length, rng);
        times.forEach((t, i) => {
            let at = t;
            if (prev !== null) { const gap = (minGapSec + rng() * (maxGapSec - minGapSec)) * 1000; if (at < prev + gap) at = Math.round(prev + gap); }
            if (at > end) overflow++;
            group[order[i]].dueAt = at;
            prev = at;
        });
    }
    return { items, overflow };
}

class ScheduledCampaigns {
    /**
     * @param {object} o
     * @param {string} o.stateFile
     * @param {string} o.mediaDir
     * @param {() => Array<{id,name,status,sock}>} o.getSessions
     * @param {object} [o.engine]  BroadcastEngine (shared caps + opt-outs)
     * @param {(phone)=>string|null} [o.isBlocked]  external policy (declined/own_line …)
     * @param {(phone)=>boolean} [o.isVirodhi]
     * @param {(phone)=>string|null} [o.ownLineOf]  which of OUR lines this number is (test campaigns)
     * @param {(phone)=>string|null} [o.getAssignedLine]
     * @param {(ms)=>boolean} [o.isSilenced]
     * @param {(info)=>void} [o.onSent]
     */
    constructor(o) {
        this.stateFile = o.stateFile;
        this.mediaDir = o.mediaDir;
        this.getSessions = o.getSessions;
        this.engine = o.engine || null;
        this.isBlocked = o.isBlocked || (() => null);
        this.isVirodhi = o.isVirodhi || (() => false);
        this.ownLineOf = o.ownLineOf || (() => null);
        this.getAssignedLine = o.getAssignedLine || (() => null);
        this.isSilenced = o.isSilenced || (() => false);
        // own-line TEST campaigns wait while a Live Self-Test runs between our lines (never pollute its transcript)
        this.isTestBusy = o.isTestBusy || (() => false);
        this.onSent = o.onSent || (() => {});
        this.now = o.now || (() => Date.now());
        this.random = o.random || Math.random;
        this.sleep = o.sleep || (ms => new Promise(r => setTimeout(r, ms)));
        this.log = o.logger || console;
        this.inFlight = new Set();
        this.lineNextAt = {};
        this.ticking = false;
        this.timer = null;
        this.state = { campaigns: {} };
        this.load();
    }

    load() {
        try { if (this.stateFile && fs.existsSync(this.stateFile)) this.state = { campaigns: {}, ...JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) }; }
        catch (e) { this.log.error('[Scheduled] bad state, starting fresh:', e.message); try { fs.copyFileSync(this.stateFile, this.stateFile + '.corrupt-' + Date.now()); } catch (_) {} }
        let rec = 0;
        for (const c of Object.values(this.state.campaigns)) for (const r of c.items || []) {
            if (r.status === 'sending') { r.status = 'skipped'; r.reason = 'interrupted_during_send_maybe_delivered'; r.at = new Date(this.now()).toISOString(); rec++; }
            else if (r.status === 'checking') { r.status = 'pending'; rec++; }
        }
        if (rec) { this.log.warn(`[Scheduled] recovered ${rec} in-flight items after restart`); this.save(); }
    }
    save() {
        if (!this.stateFile) return;
        const tmp = this.stateFile + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(this.state), 'utf8');
        fs.renameSync(tmp, this.stateFile);
    }

    resolveMedia(file) {
        const base = path.basename(String(file || ''));
        if (!base || base !== String(file) || base.startsWith('.')) throw new Error('Invalid media file name: ' + file);
        const type = mediaTypeOf(path.extname(base).toLowerCase());
        if (!type) throw new Error('Unsupported media type: ' + base);
        require('./media_policy.js').assertSendable(base);
        if (!fs.existsSync(path.join(this.mediaDir, base))) throw new Error('Media file not found: ' + base);
        return { file: base, type };
    }

    blockReason(phone, c) {
        if (this.engine && this.engine.isOptedOut && this.engine.isOptedOut(phone)) return 'opted_out';
        let ext = null;
        try { ext = this.isBlocked(phone) || null; } catch (_) { ext = null; }
        if (ext === 'own_line' && c && c.test) ext = null;
        if (ext) return ext;
        if (c && !c.includeVirodhi) { try { if (this.isVirodhi(phone)) return 'virodhi'; } catch (_) {} }
        return null;
    }

    /** Validate + plan. Returns { errors[], campaign? } without saving. */
    build(input = {}) {
        const errors = [];
        const now = this.now();
        const messages = (Array.isArray(input.messages) ? input.messages : String(input.messages || input.message || '').split(/\n\s*-{3,}\s*\n/))
            .map(s => String(s || '').trim()).filter(Boolean).slice(0, 10);
        const mediaFiles = (Array.isArray(input.mediaFiles) ? input.mediaFiles : (input.mediaFiles ? String(input.mediaFiles).split(',') : (input.mediaFile ? [input.mediaFile] : [])))
            .map(s => String(s).trim()).filter(Boolean).slice(0, 10);
        const media = [];
        for (const f of mediaFiles) { try { media.push(this.resolveMedia(f)); } catch (e) { errors.push(e.message); } }
        if (!messages.length && !media.length) errors.push('At least one message variant or poster is required');
        if (messages.some(m => m.length > 4000)) errors.push('A message variant is too long (max 4000 characters)');

        // window
        let start = parseIst(input.windowStart), end = parseIst(input.windowEnd);
        if (input.preset && PRESETS[input.preset]) { const w = windowFromHours(input.date || istDateOf(now), ...PRESETS[input.preset]); start = w.start; end = w.end; }
        if (input.startInMinutes !== undefined && input.durationMinutes !== undefined) { start = now + Number(input.startInMinutes) * 60e3; end = start + Number(input.durationMinutes) * 60e3; }
        if (!start || !end) errors.push('Pick a time window (start and end)');
        else {
            if (end <= start) errors.push('Window end must be after start');
            if (end < now) errors.push('Window is already over');
            if (end - start > 16 * 3600e3) errors.push('Window can be at most 16 hours');
            if (start < now) start = now + 30e3; // window already open: begin in ~30s
        }
        const minGapSec = Math.max(10, Math.min(600, Number(input.minGapSec) || DEFAULTS.minGapSec));
        const maxGapSec = Math.max(minGapSec, Math.min(1800, Number(input.maxGapSec) || DEFAULTS.maxGapSec));
        const caps = {
            hourlyCap: Math.max(1, Math.min(200, Number(input.hourlyCap) || DEFAULTS.hourlyCap)),
            dailyCap: Math.max(1, Math.min(1000, Number(input.dailyCap) || DEFAULTS.dailyCap))
        };

        // lines
        const sessions = this.getSessions() || [];
        let lines = Array.isArray(input.lines) ? input.lines.filter(Boolean) : (input.lines ? String(input.lines).split(',').map(s => s.trim()).filter(Boolean) : []);
        if (!lines.length) lines = sessions.filter(s => s.status === 'CONNECTED').map(s => s.id);
        const unknown = lines.filter(id => !sessions.find(s => s.id === id));
        if (unknown.length) errors.push('Unknown line(s): ' + unknown.join(', '));
        if (!lines.length) errors.push('No line selected / connected');

        // audience
        const test = input.test === true || input.test === 'true';
        const c0 = { test, includeVirodhi: input.includeVirodhi === true || input.includeVirodhi === 'true' };
        let valid = [], invalid = [], duplicates = 0;
        const blocked = [];
        if (test) {
            const seen = new Set();
            for (const r of (input.recipients || [])) {
                const d = String(r.phone || '').replace(/\D/g, '');
                if (seen.has(d)) { duplicates++; continue; }
                seen.add(d);
                const own = this.ownLineOf(d);
                if (!own) { errors.push(`Test campaigns may only target our own line numbers (${d} is not one)`); continue; }
                if (r.line && r.line === own) { errors.push(`${d} is line ${own} itself — send it from another line`); continue; }
                valid.push({ phone: d, name: String(r.name || 'Test').slice(0, 60), line: r.line || null, ward: '', village: '' });
            }
        } else {
            const rows = [
                ...contactUtils.parsePastedContacts(input.phones || ''),
                ...(input.csvText ? contactUtils.parseContactCsv(input.csvText) : []),
                ...(input.contacts || []).map(c => ({ phone: c.phone, name: c.name, ward: c.ward, village: c.village })),
                ...(input.recipients || []).map(c => ({ phone: c.phone, name: c.name }))
            ];
            const built = dedupeAndValidate(rows, () => null);
            valid = built.valid; invalid = built.invalid; duplicates = built.duplicates;
        }
        valid = valid.filter(r => { const why = this.blockReason(r.phone, c0); if (why) { blocked.push({ ...r, reason: why }); return false; } return true; });
        if (!valid.length) errors.push('No recipients left after cleaning (invalid, duplicate, opted-out or opponents (virodhi))');
        if (valid.length > MAX_RECIPIENTS) errors.push(`Too many recipients (${valid.length}); max ${MAX_RECIPIENTS} per scheduled campaign`);
        if (errors.length) return { errors, counts: { valid: valid.length, invalid: invalid.length, duplicates, blocked: blocked.length } };

        const { items, overflow } = planTimes(valid, { start, end, lines, minGapSec, maxGapSec, rng: this.random, lineFor: p => { try { return this.getAssignedLine(p); } catch (_) { return null; } } });
        const msgRot = messages.length ? rotation(items.length, messages.length, this.random) : [];
        const medRot = media.length ? rotation(items.length, media.length, this.random) : [];
        items.forEach((it, i) => {
            it.msgIdx = messages.length ? msgRot[i] : null;
            it.mediaIdx = media.length ? medRot[i] : null;
            it.status = 'pending'; it.reason = ''; it.at = ''; it.checks = 0;
        });
        const perLine = {};
        for (const it of items) perLine[it.line] = (perLine[it.line] || 0) + 1;
        const campaign = {
            id: 'sc_' + now.toString(36) + Math.floor(this.random() * 1e6).toString(36),
            name: String(input.name || '').slice(0, 80) || (test ? 'Test campaign' : 'Scheduled campaign'),
            createdAt: new Date(now).toISOString(), status: 'scheduled', test, includeVirodhi: c0.includeVirodhi,
            quietHours: input.quietHours === true || input.quietHours === 'true',
            windowStart: start, windowEnd: end, minGapSec, maxGapSec, caps, lines, messages, media,
            source: input.source || 'dashboard', items,
            skippedAtPlan: blocked.map(b => ({ phone: b.phone, reason: b.reason })),
            invalidInputs: invalid.length, duplicatesRemoved: duplicates, overflow, perLine
        };
        return { errors: [], campaign };
    }

    preview(input) {
        const r = this.build(input);
        if (r.errors.length) return { ok: false, errors: r.errors, counts: r.counts };
        const c = r.campaign;
        const samples = c.items.slice().sort((a, b) => a.dueAt - b.dueAt).slice(0, 5).map(it => ({
            phone: it.phone.slice(0, 4) + '…' + it.phone.slice(-3), line: it.line, at: istLabel(it.dueAt),
            text: it.msgIdx !== null ? renderMessage(c.messages[it.msgIdx], it, this.random) : '', media: it.mediaIdx !== null ? c.media[it.mediaIdx].file : null
        }));
        return { ok: true, recipients: c.items.length, skipped: c.skippedAtPlan.length, invalid: c.invalidInputs, duplicates: c.duplicatesRemoved, perLine: c.perLine, overflow: c.overflow, window: [istLabel(c.windowStart), istLabel(c.windowEnd)], samples };
    }

    create(input) {
        const r = this.build(input);
        if (r.errors.length) return { ok: false, status: 400, error: r.errors.join('; '), counts: r.counts };
        this.state.campaigns[r.campaign.id] = r.campaign;
        this.prune();
        this.save();
        this.log.log(`[Scheduled] ${r.campaign.id} planned: ${r.campaign.items.length} recipients ${istLabel(r.campaign.windowStart)} → ${istLabel(r.campaign.windowEnd)}`);
        return { ok: true, status: 200, campaign: this.summary(r.campaign) };
    }

    prune(keep = 30) {
        const ids = Object.keys(this.state.campaigns).sort((a, b) => (this.state.campaigns[a].createdAt < this.state.campaigns[b].createdAt ? 1 : -1));
        for (const id of ids.slice(keep)) { const c = this.state.campaigns[id]; if (['done', 'cancelled'].includes(c.status)) delete this.state.campaigns[id]; }
    }

    get(id) { return this.state.campaigns[id] || null; }
    setStatus(id, action) {
        const c = this.get(id);
        if (!c) return { ok: false, status: 404, error: 'No such campaign' };
        if (action === 'pause') { if (!['scheduled', 'running'].includes(c.status)) return { ok: false, status: 409, error: 'Not active' }; c.prevStatus = c.status; c.status = 'paused'; }
        else if (action === 'resume') { if (c.status !== 'paused') return { ok: false, status: 409, error: 'Not paused' }; c.status = c.prevStatus || 'scheduled'; }
        else if (action === 'cancel') {
            if (['done', 'cancelled'].includes(c.status)) return { ok: false, status: 409, error: 'Already finished' };
            const at = new Date(this.now()).toISOString();
            for (const it of c.items) if (it.status === 'pending') { it.status = 'skipped'; it.reason = 'cancelled'; it.at = at; }
            c.status = 'cancelled'; c.finishedAt = at;
        } else return { ok: false, status: 400, error: 'Unknown action' };
        this.save();
        return { ok: true, status: 200, campaign: this.summary(c) };
    }

    // ---------- scheduler ----------
    start(intervalMs = 3000) {
        if (this.timer) return;
        this.timer = setInterval(() => { this.tick().catch(e => this.log.error('[Scheduled] tick error:', e.message)); }, intervalMs);
        if (this.timer.unref) this.timer.unref();
    }
    stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

    lineUsage(id) {
        if (this.engine && this.engine.lineUsage) return this.engine.lineUsage(id);
        return { hour: 0, day: 0 };
    }
    recordLineSend(id) {
        if (!this.engine || !this.engine.lineStat) return;
        const st = this.engine.lineStat(id);
        st.sentTimes.push(this.now());
        const day = istDateKey(this.now());
        st.daily[day] = (st.daily[day] || 0) + 1;
        // keep the bulk engine from firing on the same line straight after us
        st.nextAt = Math.max(st.nextAt || 0, this.now() + DEFAULTS.minGapSec * 1000);
        try { this.engine.save(); } catch (_) {}
    }

    async tick() {
        if (this.ticking) return [];
        this.ticking = true;
        const jobs = [];
        try {
            const now = this.now();
            const sessions = this.getSessions() || [];
            let changed = false;
            const active = Object.values(this.state.campaigns).filter(c => c.status === 'scheduled' || c.status === 'running');
            for (const c of active) {
                const left = c.items.filter(i => i.status === 'pending' || i.status === 'sending' || i.status === 'checking');
                if (!left.length) { c.status = 'done'; c.finishedAt = new Date(now).toISOString(); changed = true; continue; }
                if (c.status === 'scheduled' && now >= c.windowStart) { c.status = 'running'; changed = true; }
                // window long gone -> the rest is skipped (no surprise sends hours later)
                const graceEnd = c.windowEnd + DEFAULTS.graceMin * 60e3;
                if (now > graceEnd) {
                    for (const it of c.items) if (it.status === 'pending') { it.status = 'skipped'; it.reason = 'window_passed'; it.at = new Date(now).toISOString(); }
                    changed = true; continue;
                }
            }
            const silenced = this.isSilenced(now);
            for (const s of sessions) {
                if (s.status !== 'CONNECTED' || !s.sock) continue;
                if (this.inFlight.has(s.id) || (this.engine && this.engine.inFlight && this.engine.inFlight.has(s.id))) continue;
                if (now < (this.lineNextAt[s.id] || 0)) continue;
                const est = this.engine && this.engine.lineStat ? this.engine.lineStat(s.id) : null;
                if (est && est.paused && est.pausedReason && est.pausedReason !== 'disconnected') continue;
                let pick = null, pickC = null;
                for (const c of active) {
                    if (c.status !== 'running' || !c.lines.includes(s.id)) continue;
                    if (silenced && !c.test) { c.waitingReason = 'silence_period'; continue; }
                    if (c.test && this.isTestBusy()) { c.waitingReason = 'self_test_running'; continue; }
                    if (c.quietHours && inQuietHours(now, { quietStartHour: 21, quietEndHour: 8 })) { c.waitingReason = 'quiet_hours'; continue; }
                    const use = this.lineUsage(s.id);
                    if (use.day >= c.caps.dailyCap) { c.waitingReason = 'daily_cap'; continue; }
                    if (use.hour >= c.caps.hourlyCap) { c.waitingReason = 'hourly_cap'; continue; }
                    for (const it of c.items) {
                        if (it.status !== 'pending' || it.line !== s.id || it.dueAt > now) continue;
                        if (!pick || it.dueAt < pick.dueAt) { pick = it; pickC = c; }
                    }
                }
                if (!pick) continue;
                pick.status = 'checking';
                pickC.waitingReason = null;
                this.inFlight.add(s.id);
                changed = true;
                jobs.push(this.process(pickC, pick, s).finally(() => this.inFlight.delete(s.id)));
            }
            if (changed) this.save();
        } finally { this.ticking = false; }
        return jobs;
    }

    gapMs(c) { return Math.round((c.minGapSec + this.random() * (c.maxGapSec - c.minGapSec)) * 1000); }

    async process(c, it, sess) {
        const sock = sess.sock;
        const stamp = () => new Date(this.now()).toISOString();
        try {
            const why = this.blockReason(it.phone, c);
            if (why) { it.status = 'skipped'; it.reason = why; it.at = stamp(); return; }
            let jid = `${it.phone}@s.whatsapp.net`;
            try {
                const res = await sock.onWhatsApp(it.phone);
                const hit = Array.isArray(res) ? res[0] : res;
                if (!hit || !hit.exists) { it.status = 'skipped'; it.reason = 'not_on_whatsapp'; it.at = stamp(); this.lineNextAt[sess.id] = this.now() + 5000; return; }
                if (hit.jid) jid = hit.jid;
            } catch (e) {
                it.checks = (it.checks || 0) + 1;
                if (it.checks >= 3) { it.status = 'failed'; it.reason = 'whatsapp_check_failed: ' + e.message; it.at = stamp(); }
                else it.status = 'pending';
                this.lineNextAt[sess.id] = this.now() + this.gapMs(c);
                return;
            }
            if (c.status !== 'running') { it.status = c.status === 'cancelled' ? 'skipped' : 'pending'; if (c.status === 'cancelled') { it.reason = 'cancelled'; it.at = stamp(); } return; }
            const text = it.msgIdx !== null && it.msgIdx !== undefined ? renderMessage(c.messages[it.msgIdx], it, this.random) : '';
            const media = it.mediaIdx !== null && it.mediaIdx !== undefined ? c.media[it.mediaIdx] : null;
            try {
                await sock.presenceSubscribe?.(jid);
                await sock.sendPresenceUpdate?.('composing', jid);
                await this.sleep(Math.round(Math.min(8000, 1500 + text.length * 35) * (0.7 + this.random() * 0.6)));
                await sock.sendPresenceUpdate?.('paused', jid);
            } catch (_) {}
            if (c.test && this.isTestBusy()) { it.status = 'pending'; return; } // a self-test started meanwhile
            it.status = 'sending'; it.at = stamp();
            this.save();
            let content;
            if (media) {
                require('./media_policy.js').assertSendable(media.file);
                const p = path.join(this.mediaDir, media.file);
                if (!fs.existsSync(p)) throw new Error('media file missing: ' + media.file);
                content = media.type === 'video' ? { video: { url: p }, caption: text }
                    : media.type === 'document' ? { document: { url: p }, mimetype: 'application/pdf', fileName: media.file, caption: text }
                        : { image: { url: p }, caption: text };
            } else content = { text };
            const sent = await sock.sendMessage(jid, content);
            it.status = 'sent'; it.reason = ''; it.at = stamp(); it.sentAt = this.now(); it.msgId = sent?.key?.id || '';
            this.recordLineSend(sess.id);
            this.lineNextAt[sess.id] = this.now() + this.gapMs(c);
            try { this.onSent({ campaignId: c.id, test: c.test, phone: it.phone, name: it.name, text, line: sess.id, lineName: sess.name, media, sent }); } catch (_) {}
        } catch (e) {
            it.status = 'failed'; it.reason = String(e.message || e).slice(0, 160); it.at = stamp();
            this.lineNextAt[sess.id] = this.now() + this.gapMs(c);
        } finally { this.save(); }
    }

    // ---------- reporting ----------
    counts(c) {
        const k = { total: c.items.length, sent: 0, failed: 0, skipped: 0, pending: 0, inProgress: 0 };
        for (const it of c.items) { if (k[it.status] !== undefined) k[it.status]++; else k.inProgress++; }
        return k;
    }
    summary(c, { items = false } = {}) {
        const out = {
            id: c.id, name: c.name, status: c.status, test: c.test, createdAt: c.createdAt, finishedAt: c.finishedAt || null,
            window: { start: new Date(c.windowStart).toISOString(), end: new Date(c.windowEnd).toISOString(), startIST: istLabel(c.windowStart), endIST: istLabel(c.windowEnd) },
            lines: c.lines, perLine: c.perLine, messages: c.messages.length, media: c.media.map(m => m.file), gapSec: [c.minGapSec, c.maxGapSec],
            includeVirodhi: c.includeVirodhi, quietHours: c.quietHours, waitingReason: c.waitingReason || null, overflow: c.overflow,
            counts: this.counts(c), skippedAtPlan: (c.skippedAtPlan || []).length, source: c.source
        };
        const nextDue = c.items.filter(i => i.status === 'pending').map(i => i.dueAt).sort((a, b) => a - b)[0];
        out.nextDueIST = nextDue ? istLabel(nextDue) : null;
        if (items) out.items = c.items.slice().sort((a, b) => a.dueAt - b.dueAt).map(i => ({ phone: i.phone.slice(0, 4) + '…' + i.phone.slice(-3), name: i.name, line: i.line, dueIST: istLabel(i.dueAt), status: i.status, reason: i.reason, sentIST: i.sentAt ? istLabel(i.sentAt) : '', variant: (i.msgIdx !== null && i.msgIdx !== undefined ? 'T' + (i.msgIdx + 1) : '') + (i.mediaIdx !== null && i.mediaIdx !== undefined ? ' P' + (i.mediaIdx + 1) : '') }));
        return out;
    }
    list() { return Object.values(this.state.campaigns).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).map(c => this.summary(c)); }
}

module.exports = { ScheduledCampaigns, planTimes, rotation, parseIst, windowFromHours, istLabel, PRESETS, DEFAULTS };
