/**
 * Instruction mode API (5 Nov 2026). Behind the dashboard login (admin + member). Every call is audit-logged
 * (dashboard_audit.jsonl → Diagnostics "किसने") with who / when / voter / text, plus a messages-feed line.
 *
 *   GET  /api/voter/:phone/instruction            {pending, lastPendingUsed, muted, optedOut, effectiveMode}
 *   POST /api/voter/:phone/instruction/draft      {instruction} -> {ok, draft, refused?, reason?, missingFact?, note?}
 *   POST /api/voter/:phone/instruction/send       {text, instruction?} -> sends from the voter's line (or sim_636)
 *   POST /api/voter/:phone/instruction/pending    {instruction | null}  one-time point for the bot's next reply
 *   POST /api/voter/:phone/mute                   {on}  bot stays silent to this voter; manual sends still work
 */
const im = require('./instruction_mode.js');

function install(app, deps = {}) {
    const { userMemory, getActiveSocket, sendSafeMessage, logMessage, getLLM } = deps;
    const who = req => (req.dashUser ? req.dashUser.username : 'dashboard');
    const allowed = req => !req.dashUser || ['admin', 'member'].includes(req.dashUser.role);
    const llmOf = () => { try { return getLLM ? getLLM() : null; } catch (e) { return null; } };
    const userOf = (req) => {
        const phone = userMemory.cleanPhone(req.params.phone);
        if (!phone || phone.length < 10) return null;
        return userMemory.getUser(phone);
    };
    const feed = (req, u, incoming, reply, status) => { try { logMessage({ session: 'Instruction', phone: u.phone, incoming, reply, by: who(req), status }); } catch (e) {} };
    const guard = (req, res) => {
        if (!allowed(req)) { res.status(403).json({ ok: false, error: 'Admin or member only' }); return null; }
        const u = userOf(req);
        if (!u) { res.status(400).json({ ok: false, error: 'invalid phone' }); return null; }
        return u;
    };

    app.get('/api/voter/:phone/instruction', (req, res) => {
        const u = guard(req, res); if (!u) return;
        res.json({ ok: true, phone: u.phone, ...im.status(u) });
    });

    app.post('/api/voter/:phone/instruction/draft', async (req, res) => {
        const u = guard(req, res); if (!u) return;
        const instruction = String((req.body || {}).instruction || '').trim();
        try {
            const r = await im.draft(u, instruction, { llm: llmOf() });
            req.auditExtra = { instruction: instruction.slice(0, 120), refused: !!r.refused, reason: r.refused ? String(r.reason || '').slice(0, 120) : undefined, draft: r.draft ? r.draft.slice(0, 120) : undefined };
            feed(req, u, '[Instruction] ' + instruction, r.refused ? '[REFUSED] ' + r.reason : (r.draft ? '[DRAFT] ' + r.draft : '[NO DRAFT] ' + (r.note || '')), r.refused ? 'INSTRUCTION_REFUSED' : 'INSTRUCTION_DRAFT');
            res.json({ ...r, ok: !r.refused && r.ok !== false });
        } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
    });

    app.post('/api/voter/:phone/instruction/send', async (req, res) => {
        const u = guard(req, res); if (!u) return;
        const b = req.body || {};
        const text = String(b.text || '').trim();
        req.auditExtra = { instruction: String(b.instruction || '').slice(0, 120) || undefined };
        if (u.broadcastOptOut || u.consentStatus === 'REJECTED') {
            req.auditExtra.refused = true; req.auditExtra.reason = 'stop';
            feed(req, u, '[Instruction send]', '[REFUSED] voter said STOP', 'INSTRUCTION_REFUSED');
            return res.status(409).json({ ok: false, refused: true, reason: 'This number said STOP / declined — the message will not be sent (STOP honoured).' });
        }
        const why = im.checkText(text, u, { allowedText: '', strictBrain: true });
        if (why) {
            req.auditExtra.refused = true; req.auditExtra.reason = why;
            feed(req, u, '[Instruction send]', '[BLOCKED ' + why + '] ' + text, 'INSTRUCTION_REFUSED');
            return res.status(422).json({ ok: false, refused: true, reason: 'Not sent: the text breaks a campaign rule (' + why + '). Edit it and try again.' });
        }
        const lineId = u.assignedLine || 'sim_636';
        const active = getActiveSocket(lineId);
        if (!active) return res.status(503).json({ ok: false, error: 'WhatsApp line not connected: ' + lineId });
        try {
            await sendSafeMessage(active.sock, u.phone + '@s.whatsapp.net', { text });
            userMemory.recordMessage(u.phone, 'bot', text, 'operatorInstruction', active.session.name);
            feed(req, u, '[Instruction send] ' + String(b.instruction || '').slice(0, 120), text, 'DELIVERED');
            res.json({ ok: true, sent: true, line: active.session.id, text });
        } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
    });

    app.post('/api/voter/:phone/instruction/pending', async (req, res) => {
        const u = guard(req, res); if (!u) return;
        const b = req.body || {};
        const instruction = b.instruction == null ? '' : String(b.instruction).trim();
        try {
            if (!instruction) {
                const had = im.clearPending(u); userMemory.save();
                req.auditExtra = { instruction: '(cleared)' };
                feed(req, u, '[Instruction pending cleared]', had ? 'cleared' : 'nothing pending', 'INSTRUCTION_PENDING');
                return res.json({ ok: true, cleared: had, ...im.status(u) });
            }
            if (u.broadcastOptOut || u.consentStatus === 'REJECTED') {
                req.auditExtra = { instruction: instruction.slice(0, 120), refused: true, reason: 'stop' };
                return res.status(409).json({ ok: false, refused: true, reason: 'This number said STOP / declined — the bot will not message them.' });
            }
            const r = await im.setPending(u, instruction, { llm: llmOf(), by: who(req) });
            userMemory.save();
            req.auditExtra = { instruction: instruction.slice(0, 120), refused: !!r.refused, reason: r.ok ? undefined : String(r.reason || '').slice(0, 120) };
            feed(req, u, '[Instruction pending] ' + instruction, r.ok ? '[PENDING] ' + r.pending.line : '[REFUSED] ' + r.reason, r.ok ? 'INSTRUCTION_PENDING' : 'INSTRUCTION_REFUSED');
            res.json({ ...r, ...im.status(u) });
        } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
    });

    app.post('/api/voter/:phone/mute', (req, res) => {
        const u = guard(req, res); if (!u) return;
        const b = req.body || {};
        const on = b.on === true || b.on === 'true' || b.on === 1 || b.on === '1';
        im.setMute(u, on, who(req));
        userMemory.save();
        req.auditExtra = { mute: on ? 'on' : 'off' };
        feed(req, u, '[Mute bot]', on ? 'bot muted for this voter' : 'bot unmuted', 'BOT_MUTE');
        res.json({ ok: true, ...im.status(u) });
    });
}

module.exports = { install };
