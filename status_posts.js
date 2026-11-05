/**
 * 📢 WhatsApp Status posts (6 Nov 2026): 3–4 posts a day from a line, chosen and started by the operator.
 *
 * Baileys: sock.sendMessage('status@broadcast', { image|video: {url}, caption } | { text }, { statusJidList, backgroundColor, font })
 * Only people in statusJidList can see the post, and WhatsApp shows a status only to people who have saved
 * the line's number too — that is why the line contact card goes out with the first bulk message.
 *
 *   - media: Media Bank images/videos only, retired posters refused (media_policy) — at post time and when scheduling
 *   - audience: the line's saved contacts (contacts_db line = this line) + imported contacts (any "📥" tag, or one tag),
 *     STOP / opted-out excluded, the line's own number added so it also shows under "My status"
 *   - TEST lines (canada): the audience is forced to our own line numbers only, whatever the request says
 *   - schedules: up to 4 a day per line, HH:MM IST, posted once per day each (missed by > 45 min → skipped, not late)
 *   - state in status_posts.json (gitignored): schedules + the last 40 posts (key kept so a post can be deleted)
 */
const fs = require('fs');
const path = require('path');

const MAX_PER_DAY = 4;
const LATE_MS = 45 * 60e3;
const IST_MS = 5.5 * 3600e3;
const COLORS = ['#1b5e20', '#b71c1c', '#e65100', '#0d47a1', '#4a148c', '#004d40'];
const IMG = /\.(jpe?g|png|webp)$/i, VID = /\.(mp4|3gp|mov|m4v)$/i;

function istDate(ms) { return new Date(ms + IST_MS).toISOString().slice(0, 10); }
function istHM(ms) { return new Date(ms + IST_MS).toISOString().slice(11, 16); }
function istAt(date, hm) { const [y, m, d] = date.split('-').map(Number); const [h, mi] = hm.split(':').map(Number); return Date.UTC(y, m - 1, d, h, mi) - IST_MS; }
function cleanText(s, n) { return String(s || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, n); }

class StatusPoster {
    /**
     * @param {object} o
     * @param {string} o.stateFile
     * @param {string} o.mediaDir
     * @param {() => Array} o.getSessions
     * @param {(lineId, {tag}) => string[]} o.audienceFor   phones (91XXXXXXXXXX) for a real post
     * @param {() => string[]} o.ownNumbers                    our own line numbers (digits)
     * @param {(lineId) => string|null} o.ownNumberOf          a line's own number (digits)
     * @param {string[]} [o.testLines]                         lines that may only post to our own numbers
     */
    constructor(o) {
        this.stateFile = o.stateFile;
        this.mediaDir = o.mediaDir;
        this.getSessions = o.getSessions;
        this.audienceFor = o.audienceFor || (() => []);
        this.ownNumbers = o.ownNumbers || (() => []);
        this.ownNumberOf = o.ownNumberOf || (() => null);
        this.testLines = o.testLines || ['canada'];
        this.now = o.now || (() => Date.now());
        this.log = o.logger || console;
        this.policy = o.policy || require('./media_policy.js');
        this.state = { schedules: [], history: [] };
        this.busy = false;
        this.load();
    }

    load() {
        try { if (this.stateFile && fs.existsSync(this.stateFile)) this.state = { schedules: [], history: [], ...JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) }; }
        catch (e) { this.log.error('[Status] bad state, starting fresh:', e.message); }
    }
    save() {
        if (!this.stateFile) return;
        const tmp = this.stateFile + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(this.state, null, 1), 'utf8');
        fs.renameSync(tmp, this.stateFile);
    }

    /** Media Bank file → {file, type}. Throws for retired / missing / unsupported. */
    checkMedia(file) {
        if (!file) return null;
        const base = path.basename(String(file));
        if (base !== String(file) || base.startsWith('.')) throw new Error('Invalid media file name');
        this.policy.assertSendable(base);
        const type = IMG.test(base) ? 'image' : VID.test(base) ? 'video' : null;
        if (!type) throw new Error('Status can only be an image or a video: ' + base);
        if (!fs.existsSync(path.join(this.mediaDir, base))) throw new Error('Media file not found: ' + base);
        return { file: base, type };
    }

    isTestLine(lineId) { return this.testLines.includes(lineId); }

    /** Who can see it: phones → jids. Test lines and test posts: own numbers only. */
    audience(lineId, { tag = '', testOnly = false } = {}) {
        const own = (this.ownNumbers() || []).map(p => String(p).replace(/\D/g, '')).filter(Boolean);
        let phones;
        if (testOnly || this.isTestLine(lineId)) phones = own.slice();
        else phones = (this.audienceFor(lineId, { tag }) || []).map(p => String(p).replace(/\D/g, '')).filter(Boolean);
        const self = this.ownNumberOf(lineId);
        if (self) phones.push(String(self).replace(/\D/g, ''));
        const uniq = [...new Set(phones)].filter(p => p.length >= 10);
        return uniq.map(p => p + '@s.whatsapp.net');
    }

    validate(b = {}) {
        const errors = [];
        const lineId = String(b.lineId || b.line || '');
        const sess = (this.getSessions() || []).find(s => s.id === lineId);
        if (!sess) errors.push('Unknown line: ' + lineId);
        let media = null;
        try { media = this.checkMedia(b.mediaFile); } catch (e) { errors.push(e.message); }
        const caption = cleanText(b.caption, 700);
        const text = cleanText(b.text, 700);
        if (!media && !text) errors.push('Pick a poster / video, or write a text status');
        return { errors, lineId, sess, media, caption, text };
    }

    /** Post now. Returns { ok, id, msgId, recipients, error? } */
    async post(b = {}, { scheduleId = null } = {}) {
        const v = this.validate(b);
        if (v.errors.length) return { ok: false, status: 400, error: v.errors.join('; ') };
        if (!v.sess.sock || v.sess.status !== 'CONNECTED') return { ok: false, status: 503, error: `Line ${v.lineId} is not connected` };
        const testOnly = b.testOnly === true || b.testOnly === 'true';
        const jids = this.audience(v.lineId, { tag: b.tag || '', testOnly });
        if (!jids.length) return { ok: false, status: 400, error: 'Nobody to show it to (no saved / imported contacts for this line)' };
        let content, opts = { statusJidList: jids };
        if (v.media) {
            const p = path.join(this.mediaDir, v.media.file);
            content = v.media.type === 'video' ? { video: { url: p }, caption: v.caption } : { image: { url: p }, caption: v.caption };
        } else {
            content = { text: v.text };
            opts.backgroundColor = /^#[0-9a-f]{6}$/i.test(b.backgroundColor || '') ? b.backgroundColor : COLORS[Math.floor(this.now() / 60000) % COLORS.length];
            opts.font = Number.isInteger(Number(b.font)) ? Math.max(0, Math.min(5, Number(b.font))) : 1;
        }
        const rec = { id: 'stp_' + this.now().toString(36), at: new Date(this.now()).toISOString(), atIST: istDate(this.now()) + ' ' + istHM(this.now()) + ' IST', lineId: v.lineId, mediaFile: v.media ? v.media.file : '', caption: v.caption || v.text, kind: v.media ? v.media.type : 'text', recipients: jids.length, test: testOnly || this.isTestLine(v.lineId), scheduleId, ok: false, msgId: '', error: '' };
        try {
            const sent = await v.sess.sock.sendMessage('status@broadcast', content, opts);
            rec.ok = !!(sent && sent.key && sent.key.id);
            rec.msgId = (sent && sent.key && sent.key.id) || '';
            rec.key = sent && sent.key ? { remoteJid: sent.key.remoteJid, fromMe: true, id: sent.key.id } : null;
            rec.jids = jids.slice(0, 1500); // kept for delete
            if (!rec.ok) rec.error = 'no message id returned';
        } catch (e) { rec.error = String(e.message || e).slice(0, 200); }
        this.state.history.unshift(rec);
        this.state.history = this.state.history.slice(0, 40);
        this.save();
        this.log.log(`[Status] ${rec.ok ? 'posted' : 'FAILED'} ${rec.kind} on ${rec.lineId} → ${rec.recipients} viewers ${rec.msgId || rec.error}`);
        const { jids: _j, key: _k, ...pub } = rec;
        return rec.ok ? { ok: true, status: 200, post: pub } : { ok: false, status: 502, error: rec.error, post: pub };
    }

    async remove(postId) {
        const rec = this.state.history.find(h => h.id === postId);
        if (!rec || !rec.key) return { ok: false, status: 404, error: 'No such status post' };
        const sess = (this.getSessions() || []).find(s => s.id === rec.lineId);
        if (!sess || !sess.sock || sess.status !== 'CONNECTED') return { ok: false, status: 503, error: 'Line not connected' };
        try {
            await sess.sock.sendMessage('status@broadcast', { delete: rec.key }, { statusJidList: rec.jids || [] });
            rec.deletedAt = new Date(this.now()).toISOString();
            this.save();
            return { ok: true, status: 200 };
        } catch (e) { return { ok: false, status: 502, error: e.message }; }
    }

    // ---------- schedules ----------
    addSchedule(b = {}) {
        const v = this.validate(b);
        const time = String(b.time || '').trim();
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) v.errors.push('Time must be HH:MM (IST)');
        const date = b.date && /^\d{4}-\d{2}-\d{2}$/.test(b.date) ? b.date : '';
        const repeatDaily = !date;
        if (!v.errors.length) {
            const sameDay = this.state.schedules.filter(s => s.enabled && s.lineId === v.lineId && (s.repeatDaily || !date || s.date === date));
            if (sameDay.length >= MAX_PER_DAY) v.errors.push(`At most ${MAX_PER_DAY} status posts a day per line — remove one first`);
        }
        if (v.errors.length) return { ok: false, status: 400, error: v.errors.join('; ') };
        const s = { id: 'sts_' + this.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36), lineId: v.lineId, time, date, repeatDaily, mediaFile: v.media ? v.media.file : '', caption: v.caption, text: v.text, tag: cleanText(b.tag, 40), testOnly: b.testOnly === true || b.testOnly === 'true', enabled: true, createdAt: new Date(this.now()).toISOString(), by: cleanText(b.by, 40), lastRunDate: '', lastResult: '' };
        this.state.schedules.push(s);
        this.save();
        return { ok: true, status: 200, schedule: s };
    }
    removeSchedule(id) {
        const n = this.state.schedules.length;
        this.state.schedules = this.state.schedules.filter(s => s.id !== id);
        if (n === this.state.schedules.length) return { ok: false, status: 404, error: 'No such schedule' };
        this.save();
        return { ok: true, status: 200 };
    }
    setEnabled(id, on) { const s = this.state.schedules.find(x => x.id === id); if (!s) return { ok: false, status: 404, error: 'No such schedule' }; s.enabled = !!on; this.save(); return { ok: true, status: 200, schedule: s }; }

    /** Due schedules (pure; used by tick + tests). */
    due(now = this.now()) {
        const today = istDate(now);
        return this.state.schedules.filter(s => {
            if (!s.enabled || s.lastRunDate === today) return false;
            if (!s.repeatDaily && s.date !== today) return false;
            const at = istAt(today, s.time);
            return now >= at && now - at <= LATE_MS;
        });
    }

    async tick() {
        if (this.busy) return [];
        this.busy = true;
        const out = [];
        try {
            const now = this.now();
            const today = istDate(now);
            for (const s of this.state.schedules) {
                if (!s.enabled || s.lastRunDate === today) continue;
                if (!s.repeatDaily && s.date !== today) continue;
                const at = istAt(today, s.time);
                if (now > at + LATE_MS) { s.lastRunDate = today; s.lastResult = 'skipped: missed by > 45 min (server down / line offline)'; this.save(); continue; }
            }
            for (const s of this.due(now)) {
                s.lastRunDate = today; // mark first: a crash mid-post never posts twice
                this.save();
                const r = await this.post({ lineId: s.lineId, mediaFile: s.mediaFile, caption: s.caption, text: s.text, tag: s.tag, testOnly: s.testOnly }, { scheduleId: s.id });
                s.lastResult = r.ok ? `posted ${r.post.atIST} → ${r.post.recipients} viewers` : `failed: ${r.error}`;
                if (!r.ok && r.status === 503) s.lastRunDate = ''; // line offline: retry on the next tick inside the 45-min window
                this.save();
                out.push(r);
            }
            // once a one-off date has passed, drop it
            this.state.schedules = this.state.schedules.filter(s => s.repeatDaily || !s.date || s.date >= today);
        } finally { this.busy = false; }
        return out;
    }
    start(ms = 30000) { if (this.timer) return; this.timer = setInterval(() => this.tick().catch(e => this.log.error('[Status] tick:', e.message)), ms); if (this.timer.unref) this.timer.unref(); }
    stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

    view() {
        return {
            schedules: this.state.schedules.slice().sort((a, b) => (a.lineId + a.time).localeCompare(b.lineId + b.time)),
            history: this.state.history.map(({ jids, key, ...h }) => h),
            maxPerDay: MAX_PER_DAY, testLines: this.testLines
        };
    }
}

module.exports = { StatusPoster, istAt, istDate, MAX_PER_DAY, LATE_MS };
