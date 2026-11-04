/**
 * Live Self-Test — one connected bot line ("tester") plays a scripted voter to another connected line
 * ("target"), waits for each real reply, and records a transcript with pass/fail checks.
 *
 * Loop safety:
 *   - Outside a run, messages between our own lines are ignored by everyone (route() -> 'ignore_own'),
 *     so two bot lines can never talk to each other by accident.
 *   - During a run, ONLY the target line treats ONLY the tester line as a normal voter (route() -> 'voter');
 *     the tester line never runs its brain on the target's replies (route() -> 'capture': recorded, then dropped).
 *   - The tester's voter record is reset to a clean, consented, self-test-flagged voter at the start and
 *     removed afterwards, so CRM stats and proactive follow-ups are never touched.
 */
const fs = require('fs');
const path = require('path');
const replyQuality = require('./reply_quality.js');
const brain = require('./reply_brain.js');

const DEFAULT_SCRIPT = [
    { text: 'Ram ram' },
    // (no personal name here: a name would correctly trigger the voter-list privacy flow instead of chat)
    { text: 'main ward 5 Sihali Khurd se hu', expectRef: ['ward 5', '96'] },
    { text: 'hamare ward me sadak tooti padi hai, kab banegi?', expectAny: ['sadak', 'road', 'note', 'priority'] },
    { text: 'Abhay singh ne pani ke liye kya kiya?', expectAny: ['paani', 'pani', 'jal', 'nal', 'jjm', 'borewell', 'tank'] },
    { text: 'aur aage kya karenge?', expectAny: ['sankalp', 'prathmikta', 'karenge', 'banwane'] },
    { text: 'hmm soch ke batayenge' },
    { text: 'meri sadak wali baat yaad hai?', expectRef: ['sadak', 'ward 5', 'road'] },
    { text: 'theek hai pakka vote denge, ghar ke 4 vote', expectRef: ['4', 'ghar', 'dhanyavad'] }
];

const BANNED_EXTRA = /(₹|रुपये|रुपए|लाख|करोड़|\blakh\b|crore|budget|बजट|\d+\s*\+?\s*(काम|संकल्प|sankalp|works)\b|पर्ची भेज दी|parchi bhej di)/i;

const digits = s => String(s || '').split('@')[0].split(':')[0].replace(/\D/g, '');

function normalizeScript(script) {
    if (!script) return DEFAULT_SCRIPT.map(s => ({ ...s }));
    const arr = Array.isArray(script) ? script : String(script).split(/\r?\n/);
    const out = [];
    for (const raw of arr) {
        if (!raw) continue;
        if (typeof raw === 'object') { if (raw.text && String(raw.text).trim()) out.push({ text: String(raw.text).trim().slice(0, 500), expectRef: raw.expectRef || null, expectAny: raw.expectAny || null }); continue; }
        // "message || ref1, ref2"  -> expectRef
        const [msg, refs] = String(raw).split('||');
        if (!msg || !msg.trim()) continue;
        out.push({ text: msg.trim().slice(0, 500), expectRef: refs ? refs.split(',').map(x => x.trim().toLowerCase()).filter(Boolean) : null });
    }
    return out.slice(0, 20);
}

class LiveSelfTest {
    /**
     * @param {object} o { getSessions: () => [{id,status,sock}], lineContacts: {id:{waid}}, userMemory,
     *                     sendText: async (sock, jid, text) => any, resultsDir, now, sleep, log }
     */
    constructor(o) {
        this.getSessions = o.getSessions;
        this.lineContacts = o.lineContacts || {};
        this.userMemory = o.userMemory;
        this.sendText = o.sendText || ((sock, jid, text) => sock.sendMessage(jid, { text }));
        this.resultsDir = o.resultsDir || path.join(__dirname, 'self_test_runs');
        this.now = o.now || (() => Date.now());
        this.sleep = o.sleep || (ms => new Promise(r => setTimeout(r, ms)));
        this.log = o.log || console;
        this.run = null;       // active or last run
        this.pending = null;   // waiting for reply
        this.history = [];     // summaries of finished runs (this process)
    }

    identitiesFor(sessionId) {
        const ids = new Set();
        const c = this.lineContacts[sessionId];
        if (c && c.waid) ids.add(digits(c.waid));
        const s = (this.getSessions() || []).find(x => x.id === sessionId);
        const u = s && s.sock && s.sock.user;
        if (u) { if (u.id) ids.add(digits(u.id)); if (u.lid) ids.add(digits(u.lid)); if (u.phoneNumber) ids.add(digits(u.phoneNumber)); }
        ids.delete('');
        return ids;
    }

    ownLineOf(senderIds) {
        const list = (senderIds || []).map(digits).filter(Boolean);
        for (const s of this.getSessions() || []) {
            const ids = this.identitiesFor(s.id);
            if (list.some(x => ids.has(x))) return s.id;
        }
        return null;
    }

    isActive() { return !!(this.run && this.run.status === 'running'); }

    /**
     * Routing decision for an incoming (not fromMe) message on `sessionId` from `senderIds`.
     * @returns {'voter'|'capture'|'ignore_own'|null}
     */
    route(sessionId, senderIds) {
        const fromLine = this.ownLineOf(senderIds);
        if (!fromLine) return null;
        if (this.isActive()) {
            if (sessionId === this.run.targetLine && fromLine === this.run.testerLine) return 'voter';
            if (sessionId === this.run.testerLine && fromLine === this.run.targetLine) return 'capture';
        }
        return 'ignore_own';
    }

    /** Make the tester's record on the target side a clean, consented, flagged voter (once per run per key). */
    prepareRecord(phone) {
        if (!this.isActive() || !phone || !this.userMemory) return null;
        const key = this.userMemory.cleanPhone(phone);
        if (!this.run.preparedKeys.includes(key)) {
            delete this.userMemory.users[key];
            this.run.preparedKeys.push(key);
        }
        const u = this.userMemory.getUser(key);
        Object.assign(u, { consented: true, consentStatus: 'ACCEPTED', autoPilot: true, contactCardSent: true, selfTest: this.run.id, assignedLine: this.run.targetLine, broadcastOptOut: false, languagePreference: 'auto', name: u.name || '' });
        return u;
    }

    capture(sessionId, text) {
        if (!this.isActive() || sessionId !== this.run.testerLine || !this.pending) return false;
        const t = String(text || '').trim() || '[non-text message]';
        this.pending.replies.push({ text: t, at: this.now() });
        if (!this.pending.firstAt) this.pending.firstAt = this.now();
        this.pending.lastAt = this.now();
        return true;
    }

    status() {
        const r = this.run;
        return r ? { id: r.id, status: r.status, testerLine: r.testerLine, targetLine: r.targetLine, startedAt: r.startedAt, endedAt: r.endedAt, turn: r.turns.length, total: r.script.length, passed: r.passed, failed: r.failed, error: r.error || null, turns: r.turns } : { status: 'idle' };
    }

    start({ testerLine, targetLine, script, replyTimeoutMs = 60000, settleMs = 5000, gapMs = 4000 } = {}) {
        if (this.isActive()) throw new Error('A self-test is already running');
        if (!testerLine || !targetLine || testerLine === targetLine) throw new Error('Pick two different lines (tester and target)');
        const sessions = this.getSessions() || [];
        const tester = sessions.find(s => s.id === testerLine), target = sessions.find(s => s.id === targetLine);
        if (!tester || tester.status !== 'CONNECTED' || !tester.sock) throw new Error(`Tester line ${testerLine} is not connected`);
        if (!target || target.status !== 'CONNECTED' || !target.sock) throw new Error(`Target line ${targetLine} is not connected`);
        const targetIds = [...this.identitiesFor(targetLine)];
        const targetNumber = (this.lineContacts[targetLine] && digits(this.lineContacts[targetLine].waid)) || targetIds[0];
        if (!targetNumber) throw new Error('Could not resolve the target line number');
        const steps = normalizeScript(script);
        if (!steps.length) throw new Error('Script is empty');
        const id = 'st_' + new Date(this.now()).toISOString().replace(/[-:T]/g, '').slice(0, 14) + '_' + Math.random().toString(36).slice(2, 6);
        this.run = { id, status: 'running', testerLine, targetLine, targetJid: targetNumber + '@s.whatsapp.net', script: steps, turns: [], startedAt: new Date(this.now()).toISOString(), endedAt: null, passed: 0, failed: 0, preparedKeys: [], config: { replyTimeoutMs, settleMs, gapMs } };
        // pre-reset the tester's phone record (target side sees it under this key unless WhatsApp uses a LID)
        for (const k of this.identitiesFor(testerLine)) if (k.length >= 10) this.prepareRecord(k);
        this._loop().catch(e => { this.run.status = 'error'; this.run.error = e.message; this._finish(); });
        return this.status();
    }

    stop() {
        if (!this.isActive()) return this.status();
        this.run.status = 'stopped';
        if (this.pending && this.pending.wake) this.pending.wake();
        return this.status();
    }

    async _waitForReply(timeoutMs, settleMs) {
        const started = this.now();
        while (this.isActive()) {
            const p = this.pending;
            const t = this.now();
            if (p.firstAt && t - p.lastAt >= settleMs) return;
            if (p.firstAt && t - p.firstAt >= 15000) return; // multi-bubble cap
            if (!p.firstAt && t - started >= timeoutMs) return;
            await new Promise(r => { p.wake = r; setTimeout(r, 250); });
        }
    }

    async _loop() {
        const r = this.run;
        const { replyTimeoutMs, settleMs, gapMs } = r.config;
        for (let i = 0; i < r.script.length && this.isActive(); i++) {
            const step = r.script[i];
            const tester = (this.getSessions() || []).find(s => s.id === r.testerLine);
            if (!tester || tester.status !== 'CONNECTED' || !tester.sock) throw new Error('Tester line disconnected');
            this.pending = { replies: [], firstAt: null, lastAt: null };
            const sentAt = this.now();
            await this.sendText(tester.sock, r.targetJid, step.text);
            await this._waitForReply(replyTimeoutMs, settleMs);
            const p = this.pending;
            this.pending = null;
            const turn = { n: i + 1, voter: step.text, replies: p.replies.map(x => x.text), latencyMs: p.firstAt ? p.firstAt - sentAt : null, expectRef: step.expectRef || null, expectAny: step.expectAny || null };
            turn.checks = this._check(turn, r.turns);
            turn.pass = Object.values(turn.checks).every(v => v !== false);
            if (turn.pass) r.passed++; else r.failed++;
            r.turns.push(turn);
            if (i < r.script.length - 1) await this.sleep(gapMs);
        }
        if (r.status === 'running') r.status = r.failed ? 'failed' : 'passed';
        this._finish();
    }

    _check(turn, previous) {
        const text = turn.replies.join('\n');
        const low = text.toLowerCase();
        const checks = {};
        checks.repliedWithin60s = turn.latencyMs !== null && turn.latencyMs <= 60000;
        checks.noBannedClaims = !!text && !(brain.BANNED.test(text) || brain.SARPANCH_CLAIM.test(text) || BANNED_EXTRA.test(text));
        const prevReplies = previous.flatMap(t => t.replies);
        checks.noRepeat = !!text && !prevReplies.some(p => {
            const a = replyQuality.normalize(p), b = replyQuality.normalize(text);
            return a === b || replyQuality.similarity(a, b) >= 0.78;
        });
        if (turn.expectRef && turn.expectRef.length) checks.referencesEarlierContext = turn.expectRef.some(x => low.includes(String(x).toLowerCase()));
        if (turn.expectAny && turn.expectAny.length) checks.onTopic = turn.expectAny.some(x => low.includes(String(x).toLowerCase()));
        return checks;
    }

    _finish() {
        const r = this.run;
        if (!r) return;
        r.endedAt = new Date(this.now()).toISOString();
        // remove the tester's temporary voter record(s)
        try {
            if (this.userMemory) {
                for (const k of r.preparedKeys) if (this.userMemory.users[k] && this.userMemory.users[k].selfTest) delete this.userMemory.users[k];
                for (const [k, u] of Object.entries(this.userMemory.users)) if (u && u.selfTest === r.id) delete this.userMemory.users[k];
                this.userMemory.save();
            }
        } catch (e) {}
        try {
            fs.mkdirSync(this.resultsDir, { recursive: true });
            fs.writeFileSync(path.join(this.resultsDir, r.id + '.json'), JSON.stringify(this.toJSON(r), null, 2));
            fs.writeFileSync(path.join(this.resultsDir, r.id + '.md'), this.toMarkdown(r));
        } catch (e) { this.log.warn && this.log.warn('[SelfTest] could not save results:', e.message); }
        this.history.unshift({ id: r.id, status: r.status, passed: r.passed, failed: r.failed, startedAt: r.startedAt, testerLine: r.testerLine, targetLine: r.targetLine });
        this.history = this.history.slice(0, 20);
    }

    toJSON(r = this.run) {
        if (!r) return null;
        const { preparedKeys, ...rest } = r;
        return rest;
    }

    toMarkdown(r = this.run) {
        if (!r) return '';
        const lines = [`# Live Self-Test ${r.id}`, '', `- Tester line: **${r.testerLine}** → Target line: **${r.targetLine}**`, `- Started: ${r.startedAt}  Ended: ${r.endedAt || '—'}`, `- Result: **${r.status.toUpperCase()}** — ${r.passed} passed, ${r.failed} failed of ${r.script.length} turns`, ''];
        for (const t of r.turns) {
            lines.push(`## Turn ${t.n} ${t.pass ? '✅' : '❌'}  (${t.latencyMs === null ? 'no reply' : (t.latencyMs / 1000).toFixed(1) + 's'})`);
            lines.push(`**Voter:** ${t.voter}`);
            lines.push(t.replies.length ? t.replies.map(x => `**Bot:** ${x.replace(/\n+/g, ' ')}`).join('\n\n') : '**Bot:** _(no reply)_');
            lines.push('Checks: ' + Object.entries(t.checks).map(([k, v]) => `${v ? '✅' : '❌'} ${k}`).join(' · '));
            lines.push('');
        }
        if (r.error) lines.push(`> Error: ${r.error}`);
        return lines.join('\n');
    }

    listRuns() {
        let files = [];
        try { files = fs.readdirSync(this.resultsDir).filter(f => f.endsWith('.json')).sort().reverse().slice(0, 30); } catch (e) {}
        return files.map(f => {
            try { const j = JSON.parse(fs.readFileSync(path.join(this.resultsDir, f), 'utf8')); return { id: j.id, status: j.status, passed: j.passed, failed: j.failed, startedAt: j.startedAt, testerLine: j.testerLine, targetLine: j.targetLine }; } catch (e) { return null; }
        }).filter(Boolean);
    }

    readRun(id) {
        if (this.run && this.run.id === id) return this.toJSON(this.run);
        if (!/^st_[\w]+$/.test(String(id || ''))) return null;
        try { return JSON.parse(fs.readFileSync(path.join(this.resultsDir, id + '.json'), 'utf8')); } catch (e) { return null; }
    }
}

module.exports = { LiveSelfTest, DEFAULT_SCRIPT, normalizeScript };
