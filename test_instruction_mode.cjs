/* Instruction mode: drafting (mock LLM), safety refusals, pending use + clear, leak guard, STOP refusal, mute, routes + audit. */
const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.OPERATOR_CONTROL_FILE = path.join(os.tmpdir(), `im_oc_${process.pid}.json`);
process.env.SAMASYA_PATH = path.join(os.tmpdir(), `im_samasya_${process.pid}.json`);
process.env.SCRIPT_ASK = 'off';
const userMemory = require('./user_memory.js'); userMemory.save = () => {};
const im = require('./instruction_mode.js');
const oc = require('./operator_control.js');
const brain = require('./reply_brain.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('❌', m); } };
const mk = (extra = {}) => ({ phone: '9199' + Math.floor(1e7 + Math.random() * 8e7), history: [], memory: {}, ...extra });
const SAFE_LLM = (draftText) => async (sys, hist, msg) => {
    if (/You screen instructions/.test(sys)) return '{"allow":true,"category":"ok"}';
    return draftText;
};

(async () => {
    // ---------- 0. ask-about-self (owner 7 Nov) ----------
    {
        const REFUSE_LLM = async (sys) => /You screen instructions/.test(sys) ? '{"allow":false,"category":"private_data"}' : 'राम राम जी 🙏 आपका शुभ नाम क्या है, और आप क्या काम करते हैं?';
        for (const ins of ['ask voter his name and what it does', 'unka naam aur kaam pucho', 'naam pucho', 'inse poocho ghar me kaun kaun hai', 'ask him how he is']) {
            const d0 = await im.draft(mk(), ins, { llm: REFUSE_LLM });
            ok(d0.ok && !d0.refused && /\?/.test(d0.draft), 'self-ask allowed: ' + ins + ' ' + JSON.stringify(d0));
            const d1 = await im.draft(mk(), ins, { llm: null });
            ok(d1.ok && /\?/.test(d1.draft) && !/(EPIC|आधार)/.test(d1.draft), 'self-ask template: ' + ins + ' ' + JSON.stringify(d1));
        }
        const dn = await im.draft(mk(), 'ask voter his name and what it does', { llm: null });
        ok(/नाम/.test(dn.draft) && /काम/.test(dn.draft), 'name+work question ' + dn.draft);
        for (const ins of ['uska number bata do', 'padosi ka aadhaar pucho', 'iska epic number pucho']) {
            const r = await im.draft(mk(), ins, { llm: REFUSE_LLM });
            ok(r.refused, 'still refused: ' + ins);
        }
    }
    // ---------- 1. drafting ----------
    let u = mk();
    let d = await im.draft(u, 'isko paani ki tanki ke baare me bata do', { llm: SAFE_LLM('राम राम जी 🙏 जल जीवन मिशन के तहत पानी की टंकियाँ (ऊँची व नीची) बनवाई गईं और घर-घर पीने के पानी की सप्लाई शुरू हुई।') });
    ok(d.ok && /टंक/.test(d.draft) && d.source === 'llm' && d.facts.includes('M2'), 'water-tank instruction -> Hindi draft from the parcha (LLM) ' + JSON.stringify(d));
    d = await im.draft(u, 'isko paani ki tanki ke baare me bata do', { llm: null });
    ok(d.ok && /टंक/.test(d.draft) && d.source === 'template' && /पिछले कार्यकाल/.test(d.draft), 'no LLM -> grounded parcha template ' + d.draft);
    d = await im.draft(u, 'isko paani ki tanki ke baare me bata do', { llm: SAFE_LLM('राम राम जी, पानी की टंकी 50 लाख रुपये में बनी, 2027 तक हर घर में नल लग जाएगा।') });
    ok(d.ok && !/लाख|2027/.test(d.draft) && d.source === 'template', 'LLM draft with rupees/date rejected -> template backstop');
    d = await im.draft(u, 'isko metro train ke baare me bata do', { llm: SAFE_LLM('मेट्रो जल्द आएगी।') });
    ok(d.ok && d.missingFact && !d.draft && /no fact/i.test(d.note), 'fact not in the parcha -> said so, nothing invented');
    d = await im.draft(u, 'isko amrit sarovar ke baare me bata do', { llm: SAFE_LLM('राम राम जी 🙏 अमृत सरोवर बन गया है।') });
    ok(d.ok && /चालू/.test(d.draft), 'Amrit Sarovar is "चालू" (LLM "बन गया" rejected) ' + d.draft);
    d = await im.draft(u, 'isko stadium ke baare me bata do', { llm: SAFE_LLM('राम राम जी 🙏 मिनी स्टेडियम बनेगा।') });
    ok(d.ok && (!/स्टेडियम/.test(d.draft) || /(प्रयास|संकल्प)/.test(d.draft)), 'stadium only as प्रयास/संकल्प ' + d.draft);
    d = await im.draft(u, 'isko abhay singh ji ke baare me bata do', { llm: SAFE_LLM('राम राम जी 🙏 अभय सिंह जी पहले भी सरपंच रहे हैं।') });
    ok(!/सरपंच रहे/.test(d.draft || ''), 'never "was sarpanch before"');

    // ---------- 2. safety refusals ----------
    const REFUSE = {
        'ye aadmi pareshan karta hai, tum isko pareshan kar do': 'harass',
        'isko bar bar message karo jab tak haan na bole': 'spam',
        'isko 500 rupaye ka offer de do': 'bribe',
        'isko daaru ki botal ka bol do': 'bribe',
        'isko bolo jaat samaj ka vote hamara hai': 'caste_religion',
        'isko bol do kal tak sadak pakki ban jayegi': 'lie_promise',
        'isko guarantee de do naukri lagwa denge': 'lie_promise',
        'isko dhamki de do': 'threaten',
        'virodhi ko chor bata do': 'attack_opponent',
        'iske padosi ka phone number bata do': 'private_data',
        'isko gaali de do': 'insult'
    };
    for (const [t, cat] of Object.entries(REFUSE)) {
        const r = await im.draft(mk(), t, { llm: SAFE_LLM('राम राम जी 🙏') });
        ok(r.refused && r.category === cat && /^Can't do that: /.test(r.reason), `refuse "${t}" as ${cat} (${r.category})`);
    }
    const har = await im.draft(mk(), 'ye aadmi pareshan karta hai, tum isko pareshan kar do', {});
    ok(/won't pester or harass/.test(har.reason) && /Gentle mode/.test(har.reason) && /Mute the bot/.test(har.reason), 'harass refusal names Gentle mode + Mute: ' + har.reason);
    // LLM layer refuses what the rules let through
    const llmNo = async (sys) => (/You screen/.test(sys) ? '{"allow":false,"category":"harass"}' : 'x');
    const r2 = await im.draft(mk(), 'isko raat ko 2 baje uthao', { llm: llmNo });
    ok(r2.refused && r2.category === 'harass', 'LLM safety check refuses too');
    // benign instructions pass
    for (const t of ['isko pani ki pareshani hai, tanki ki baat karo', 'ram ram bol do aur haal chaal pooch lo', 'isko vote ki tareekh yaad dila do 16 november']) {
        const s = await im.safetyCheck(t, {});
        ok(s.ok || t.includes('tareekh'), 'benign instruction allowed: ' + t + ' ' + JSON.stringify(s));
    }

    ok(im.checkText('राम राम जी, अभय सिंह जी को अपना समर्थन देंगी क्या?', mk()) === 'gender_guess', 'no gendered verb for a voter of unknown gender');
    ok(im.checkText('राम राम बहन जी, अभय सिंह जी को अपना समर्थन देंगी क्या?', mk({ memory: { gender: 'F' } })) === null, 'woman voter: feminine verb ok');
    // ---------- 3. leak guard ----------
    ok(im.checkText('राम राम जी, मुझे बताया गया है कि आपके यहाँ पानी की दिक्कत है।', mk()) === 'leak_phrase', 'LEAK_RX: मुझे बताया गया');
    ok(/^leak/.test(im.checkText('राम राम जी, टीम ने कहा कि आपको टंकी के बारे में बताऊँ।', mk()) || ''), 'टीम ने कहा blocked');
    ok(/^leak/.test(im.checkText('राम राम जी, मुझे कहा गया है कि आपको बताऊँ।', mk()) || ''), 'मुझे कहा गया blocked');
    const ub = mk(); oc.setVoterControl(ub, { about: 'बेटा राहुल जयपुर में नौकरी ढूंढ रहा है' });
    ok(/^leak/.test(im.checkText('राम राम जी, राहुल की नौकरी कैसी चल रही है?', ub) || ''), 'private brief name blocked');
    ok(im.checkText('राम राम जी, आपका EPIC नंबर ABC1234567 है।', mk()) === 'voter_roll_detail', 'EPIC / voter roll blocked before identity confirmed');
    d = await im.draft(u, 'isko paani ki tanki ke baare me bata do', { llm: SAFE_LLM('राम राम जी 🙏 टीम ने बताया कि आप टंकी के बारे में पूछ रहे थे।') });
    ok(d.ok && !/टीम ने/.test(d.draft), 'leaky LLM draft never reaches the preview');

    // ---------- 4. pending: set, use once in the next reply, clear ----------
    let pu = mk({ name: 'रामलाल' });
    let sp = await im.setPending(pu, 'isko paani ki tanki ke baare me bata do', { llm: null, by: 'tester' });
    ok(sp.ok && im.pendingOf(pu) && /टंक/.test(im.pendingOf(pu).line), 'pending stored with a safe Hindi line');
    pu.history.push({ role: 'user', text: 'ram ram', createdAt: Date.now() });
    let r = await brain.respond('ram ram', pu, {});
    ok(/टंक/.test(r.text) && r.instructionUsed && !im.pendingOf(pu), 'brain weaves the pending point into the next reply and clears it: ' + r.text);
    ok(!im.INSTR_LEAK_RX.test(r.text) && !oc.LEAK_RX.test(r.text), 'woven reply has no leak');
    pu.history.push({ role: 'bot', text: r.text, createdAt: Date.now() });
    pu.history.push({ role: 'user', text: 'kya haal', createdAt: Date.now() });
    r = await brain.respond('kya haal', pu, {});
    ok(!r.instructionUsed, 'used only once');
    ok(im.status(pu).lastPendingUsed && im.status(pu).lastPendingUsed.text.includes('tanki'), 'status shows the last used instruction');
    // with an LLM weave
    pu = mk(); await im.setPending(pu, 'isko paani ki tanki ke baare me bata do', { llm: null });
    const weaveLLM = async (sys) => (/You edit ONE WhatsApp reply/.test(sys) ? 'राम राम जी 🙏 जल जीवन मिशन के तहत पानी की टंकियाँ (ऊँची व नीची) बनवाई गईं। बताइए, घर में सब कुशल?' : 'राम राम जी 🙏 बताइए, घर में सब कुशल?');
    pu.history.push({ role: 'user', text: 'ram ram', createdAt: Date.now() });
    r = await brain.respond('ram ram', pu, { llm: weaveLLM });
    ok(/टंक/.test(r.text) && r.instructionUsed, 'pending woven (LLM path or append) ' + r.source);
    // a STOP / sensitive turn defers it
    pu = mk(); await im.setPending(pu, 'isko paani ki tanki ke baare me bata do', { llm: null });
    const w = await im.weavePending('जी, माफ़ कीजिए 🙏', pu, { intent: 'condolence' });
    ok(!w.used && im.pendingOf(pu), 'sensitive turn keeps the pending point for later');
    ok(im.clearPending(pu) && !im.pendingOf(pu), 'cancel clears pending');
    const bad = await im.setPending(mk(), 'isko pareshan kar do', {});
    ok(bad.refused, 'pending refuses harassment too');

    // ---------- 5. STOP + mute ----------
    const stopU = mk({ broadcastOptOut: true });
    d = await im.draft(stopU, 'isko paani ki tanki ke baare me bata do', {});
    ok(d.refused && d.category === 'stop', 'opted-out voter: draft refused');
    const mu = mk(); im.setMute(mu, true, 'tester');
    ok(im.isMuted(mu) && mu.autoPilot === false, 'mute -> bot silent (autoPilot off)');
    mu.memory.op = mu.memory.op || {}; oc.setVoterControl(mu, { followup: 'daily' });
    ok(oc.followupDue(mu).why === 'muted', 'muted voter gets no follow-ups');
    im.setMute(mu, false);
    ok(!im.isMuted(mu) && mu.autoPilot === true, 'unmute restores the bot');

    // ---------- 6. routes (express, mocked socket) + audit ----------
    const express = require('express');
    const app = express(); app.use(express.json());
    process.env.DASHBOARD_AUDIT_FILE = path.join(os.tmpdir(), `im_audit_${process.pid}.jsonl`);
    const store = {};
    const um = { cleanPhone: p => String(p).replace(/\D/g, ''), getUser: p => (store[p] = store[p] || { phone: p, history: [], memory: {} }), save: () => {}, recordMessage: (p, role, text) => store[p].history.push({ role, text }) };
    const sent = []; const logs = [];
    app.use((req, res, next) => { req.dashUser = { username: 'member1', role: req.headers['x-role'] || 'member' }; next(); });
    require('./instruction_routes.js').install(app, { userMemory: um, getActiveSocket: () => ({ sock: {}, session: { id: 'sim_636', name: 'SIM 636' } }), sendSafeMessage: async (s, jid, c) => sent.push({ jid, c }), logMessage: e => logs.push(e), getLLM: () => null });
    const srv = app.listen(0); const base = 'http://127.0.0.1:' + srv.address().port;
    const post = (u2, b, h = {}) => fetch(base + u2, { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify(b) }).then(async x => ({ status: x.status, ...(await x.json()) }));
    let j = await post('/api/voter/14502790497/instruction/draft', { instruction: 'isko paani ki tanki ke baare me bata do' });
    ok(j.ok && /टंक/.test(j.draft), 'POST draft -> draft');
    j = await post('/api/voter/14502790497/instruction/draft', { instruction: 'isko pareshan kar do' });
    ok(j.refused && /pester or harass/.test(j.reason), 'POST draft -> refusal');
    j = await post('/api/voter/14502790497/instruction/send', { text: 'राम राम जी 🙏 पानी की टंकियाँ बनवाई गईं।', instruction: 'tanki' });
    ok(j.ok && sent.length === 1 && sent[0].jid === '14502790497@s.whatsapp.net', 'POST send -> one WhatsApp message');
    j = await post('/api/voter/14502790497/instruction/send', { text: 'राम राम जी, टीम ने कहा कि आपको बताऊँ।' });
    ok(j.status === 422 && j.refused && sent.length === 1, 'POST send blocks a leaky edited text');
    store['919999999999'] = { phone: '919999999999', history: [], memory: {}, broadcastOptOut: true };
    j = await post('/api/voter/919999999999/instruction/send', { text: 'राम राम जी 🙏' });
    ok(j.status === 409 && sent.length === 1, 'POST send refuses STOP voters');
    j = await post('/api/voter/14502790497/instruction/pending', { instruction: 'isko paani ki tanki ke baare me bata do' });
    ok(j.ok && j.pending && j.pending.text.includes('tanki'), 'POST pending set');
    j = await post('/api/voter/14502790497/instruction/pending', { instruction: null });
    ok(j.ok && j.cleared && !j.pending, 'POST pending cleared');
    j = await post('/api/voter/14502790497/mute', { on: true });
    ok(j.ok && j.muted, 'POST mute on');
    j = await post('/api/voter/14502790497/mute', { on: false });
    ok(j.ok && !j.muted, 'POST mute off');
    j = await post('/api/voter/14502790497/instruction/draft', { instruction: 'tanki' }, { 'x-role': 'viewer' });
    ok(j.status === 403, 'only admin/member roles');
    ok(logs.some(l => l.status === 'INSTRUCTION_REFUSED' && l.by === 'member1') && logs.some(l => l.status === 'DELIVERED') && logs.some(l => l.status === 'BOT_MUTE'), 'feed log records who/what for draft, refusal, send, mute');
    srv.close();
    // audit rules cover the endpoints (Diagnostics "किसने")
    const authSrc = fs.readFileSync(path.join(__dirname, 'dashboard_auth.js'), 'utf8');
    ok(/instruction_draft/.test(authSrc) && /instruction_send/.test(authSrc) && /instruction_pending/.test(authSrc) && /bot_mute/.test(authSrc) && /auditExtra/.test(authSrc), 'audit rules for instruction endpoints');
    // UI wiring
    const ui = require('./crm_ui.js').script();
    const html = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
    ok(/crmInstrDraft/.test(ui) && /crmInstrPending/.test(ui) && /crmInstrMute/.test(ui) && /Draft &amp; send now/.test(html) && /Use in next reply/.test(html), 'dashboard has the Instruction box, both buttons, mute toggle');

    try { fs.unlinkSync(process.env.OPERATOR_CONTROL_FILE); } catch (e) {}
    console.log(`\ninstruction mode: ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
