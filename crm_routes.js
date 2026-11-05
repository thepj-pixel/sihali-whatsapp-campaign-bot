/**
 * CRM (WhatsApp Web Live tab) routes — 5 Nov 2026.
 *
 *   GET  /api/crm/chat/:phone?limit=&before=   full chat history (archive + live memory), paged, oldest first
 *   GET  /api/crm/profile/:phone               voter profile & memory, auto-filled
 *   POST /api/crm/profile/:phone               operator edits -> user + user.memory (feeds the bot's memory card)
 *   POST /api/crm/copilot {phone, attempt, exclude[], instruction?}  best next reply (parcha-safe, validated)
 *   GET  /api/crm/actions                      which quick actions are available (approved posters/reels)
 *   POST /api/quick-action {phone, action, lineId?, note?, send?, when?, place?, purpose?}
 *
 * Full history: every recordMessage() is also appended to chat_archive/<phone>.jsonl (gitignored), and the
 * existing 50-message memory history is seeded into it the first time a contact is opened, so nothing is lost.
 */
const fs = require('fs');
const path = require('path');

const ARCHIVE_DIR = process.env.CHAT_ARCHIVE_DIR || path.join(__dirname, 'chat_archive');
const mediaPolicy = require('./media_policy.js');

function archiveFile(phone) { return path.join(ARCHIVE_DIR, String(phone).replace(/[^0-9]/g, '') + '.jsonl'); }

function appendArchive(phone, entry) {
    try {
        if (!phone) return;
        if (!fs.existsSync(ARCHIVE_DIR)) fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
        fs.appendFileSync(archiveFile(phone), JSON.stringify(entry) + '\n', 'utf8');
    } catch (e) { /* archive is best effort */ }
}

function readArchive(phone) {
    try {
        const f = archiveFile(phone);
        if (!fs.existsSync(f)) return [];
        return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
    } catch (e) { return []; }
}

const keyOf = h => (h.role || '') + '|' + (h.createdAt || h.time || '') + '|' + String(h.text || '').slice(0, 80);

/** Merge archive + live history, dedupe, oldest first. Seeds the archive from live history on first read. */
function fullHistory(user) {
    const phone = user && user.phone;
    const live = (user && Array.isArray(user.history)) ? user.history : [];
    let arch = readArchive(phone);
    const seen = new Set(arch.map(keyOf));
    const missing = live.filter(h => !seen.has(keyOf(h)));
    if (missing.length) {
        for (const h of missing) appendArchive(phone, h);
        arch = arch.concat(missing);
    }
    return arch.sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0));
}

function installArchiveHook(userMemory) {
    if (!userMemory || userMemory.__crmArchiveHook) return;
    const orig = userMemory.recordMessage.bind(userMemory);
    userMemory.recordMessage = function (rawPhone, role, text, ...rest) {
        const r = orig(rawPhone, role, text, ...rest);
        try {
            const u = this.getUser(rawPhone);
            const last = u && Array.isArray(u.history) ? u.history[u.history.length - 1] : null;
            if (u && last && last.text === text) {
                // seed the old history once, then append this message
                if (!fs.existsSync(archiveFile(u.phone))) fullHistory(u);
                else appendArchive(u.phone, last);
            }
        } catch (e) {}
        return r;
    };
    userMemory.__crmArchiveHook = true;
}

// ---------------- profile ----------------
const STANCES = ['unknown', 'undecided', 'leaning', 'committed', 'opposed'];

function buildProfile(user, deps) {
    const vm = require('./voter_memory.js');
    const m = vm.ensure(user);
    const kb = require('./knowledge_base.js');
    const op = user.operatorProfile || {};
    const vr = user.lastFoundVoter || user.voterProfile || null;
    const ward = op.ward || m.ward || user.ward || (vr && (vr.ward || vr.w)) || null;
    let booth = null;
    try { const b = kb.boothForWard(ward); if (b) booth = `${b.booth}${b.room ? ', कमरा ' + b.room : ''}`; } catch (e) {}
    const samasya = deps.samasyaStore ? deps.samasyaStore.list({ phone: user.phone, includeTest: true }).map(r => ({ id: r.id, status: r.status, category: r.category, description: r.description, location: r.location, at: r.createdAtIST })) : [];
    const mulaqat = deps.mulaqatStore ? deps.mulaqatStore.list({ phone: user.phone, includeTest: true }).map(r => ({ id: r.id, status: r.status, when: r.preferredWhen || r.preferredDate, place: r.place, purpose: r.purpose, at: r.createdAtIST })) : [];
    const topics = Array.from(new Set([].concat(m.interests || [], (m.concerns || []).map(c => c.topic), m.lastTopic ? [m.lastTopic] : []).filter(Boolean)));
    const relName = op.relName || m.relName || (m.slip && m.slip.relName) || (vr && (vr.rel_name_hi || vr.rel_name)) || user.fatherOrSpouse || null;
    return {
        phone: user.phone,
        name: op.name || m.name || user.name || (vr && vr.name_hi) || '',
        relName: relName || '',
        relType: op.relType || (m.slip && m.slip.relation) || (vr && require('./relation_label').relLabel(vr)) || '',
        ward: ward || '',
        village: m.village ? (kb.villageName ? kb.villageName(m.village, 'hi') : m.village) : '',
        booth: booth || '',
        gender: op.gender || m.gender || user.genderDetected || user.genderGuess || '',
        age: op.age || m.age || m.ageGroup || (vr && (vr.age || vr.aayu)) || '',
        stance: STANCES.includes(user.persuasionStage) ? user.persuasionStage : 'unknown',
        virodhi: !!user.virodhi,
        familyVotes: m.familyVotes || '',
        family: (m.family || []).map(f => f.relation + (f.name ? ': ' + f.name : '')).join(', '),
        interests: topics.join(', '),
        commitment: m.commitment && m.commitment.status ? (m.commitment.status + (m.commitment.soft ? ' (soft, emoji)' : '') + (m.commitment.quote ? ' — "' + String(m.commitment.quote).slice(0, 60) + '"' : '')) : '',
        notes: m.operatorNotes || '',
        scriptPref: m.scriptPref || '',
        summary: (m.summaryLines || []).slice(-3).join(' | '),
        optedOut: !!(user.broadcastOptOut || user.consentStatus === 'REJECTED'),
        line: user.assignedLine || '',
        samasya, mulaqat,
        ...(() => { const oc = require('./operator_control.js'); const c = oc.getVoterControl(user); return { about: c.about, style: c.style, mode: c.mode, effectiveMode: c.effectiveMode, modeLabel: oc.MODE_LABEL[c.effectiveMode], voteAsk: c.voteAsk, followup: c.followup, lastFollowupAt: c.lastFollowupAt, defaultMode: c.defaultMode }; })(),
        editedBy: op.updatedAt ? 'operator @ ' + op.updatedAt : null
    };
}

function saveProfile(user, body = {}) {
    const vm = require('./voter_memory.js');
    const m = vm.ensure(user);
    const clean = v => (v === undefined || v === null) ? undefined : String(v).replace(/[<>]/g, '').trim().slice(0, 300);
    const op = Object.assign({}, user.operatorProfile || {});
    const name = clean(body.name);
    if (name !== undefined) { op.name = name; if (name) { m.name = name; m.nameSource = 'operator'; user.name = name; } }
    const rel = clean(body.relName);
    if (rel !== undefined) { op.relName = rel; m.relName = rel || null; if (rel) user.fatherOrSpouse = rel; }
    const relType = clean(body.relType); if (relType !== undefined) op.relType = relType;
    if (body.ward !== undefined) { const w = Number(String(body.ward).replace(/[^0-9]/g, '')); if (w >= 1 && w <= 20) { op.ward = w; m.ward = w; user.ward = w; } else if (String(body.ward).trim() === '') { op.ward = null; } }
    const g = clean(body.gender);
    if (g !== undefined) { const gg = /^(f|female|महिला|स्त्री)/i.test(g) ? 'F' : (/^(m|male|पुरुष)/i.test(g) ? 'M' : null); op.gender = gg; if (gg) { m.gender = gg; m.genderSource = 'operator'; user.genderDetected = gg; } }
    const age = clean(body.age);
    if (age !== undefined) { op.age = age; const n = Number(age); if (n >= 18 && n <= 110) { m.age = n; m.ageGroup = n >= 60 ? 'elder' : (n < 30 ? 'young' : 'adult'); } else if (/elder|बुज़ुर्ग|बुजुर्ग/i.test(age)) m.ageGroup = 'elder'; }
    if (body.stance !== undefined && STANCES.includes(body.stance)) {
        const prev = user.persuasionStage || 'unknown';
        if (prev !== body.stance) { user.persuasionStage = body.stance; user.persuasionHistory = (user.persuasionHistory || []).concat([{ from: prev, to: body.stance, at: new Date().toISOString(), intent: 'operator' }]).slice(-20); }
        if (body.stance !== 'unknown') m.commitment = Object.assign({}, m.commitment, { status: body.stance, at: new Date().toISOString(), soft: false, quote: 'operator' });
    }
    if (body.familyVotes !== undefined) { const n = Number(body.familyVotes); if (n >= 1 && n <= 40) m.familyVotes = n; else if (String(body.familyVotes).trim() === '') m.familyVotes = null; }
    const interests = clean(body.interests);
    if (interests !== undefined) m.interests = interests.split(/[,;]/).map(s => s.trim()).filter(Boolean).slice(0, 10);
    if (body.scriptPref !== undefined) {
        if (['hindi', 'hinglish'].includes(body.scriptPref)) require('./reply_brain.js').setScriptPref(user, body.scriptPref, 'operator');
        else if (body.scriptPref === '') { m.scriptPref = null; }
    }
    const notes = clean(body.notes);
    if (notes !== undefined) m.operatorNotes = notes;
    // v6 private brief + mode (never shown to the voter; hidden guidance for NLU / replies / co-pilot)
    const ocKeys = ['about', 'style', 'mode', 'voteAsk', 'followup'];
    if (ocKeys.some(k => body[k] !== undefined)) { const ob = {}; ocKeys.forEach(k => { if (body[k] !== undefined) ob[k] = body[k]; }); require('./operator_control.js').setVoterControl(user, ob); }
    op.updatedAt = new Date().toISOString();
    user.operatorProfile = op;
    m.updatedAt = op.updatedAt;
    return user;
}

// ---------------- co-pilot ----------------
/** Suggest the best next reply for the open chat without touching the real record or creating samasya/mulaqat. */
async function copilotSuggest(user, { attempt = 0, exclude = [], instruction = '', llm = null, replyBrain, samasyaStore, mulaqatStore } = {}) {
    const clone = JSON.parse(JSON.stringify(user || {}));
    const hist = Array.isArray(clone.history) ? clone.history : [];
    let lastUserIdx = -1;
    for (let i = hist.length - 1; i >= 0; i--) if (hist[i].role === 'user') { lastUserIdx = i; break; }
    const lastMsg = lastUserIdx >= 0 ? String(hist[lastUserIdx].text || '') : '';
    clone.history = lastUserIdx >= 0 ? hist.slice(0, lastUserIdx) : hist;
    const excl = new Set((exclude || []).map(s => String(s).trim()));
    // previous suggestions count as "already said" so vary() and the repeat guard choose a different line
    clone.history = clone.history.concat([...excl].map(t => ({ role: 'bot', text: t, session: 'copilot' })));
    if (lastUserIdx >= 0) clone.history.push(hist[lastUserIdx]);
    else clone.history.push({ role: 'user', text: 'राम राम' });
    const message = lastMsg || 'राम राम';
    const stub = s => { const o = s.create; s.create = (f) => ({ id: (s.prefix || 'X') + '-preview', ...f }); return () => { s.create = o; }; };
    const out = [];
    const runOnce = async (useLlm) => {
        const c2 = JSON.parse(JSON.stringify(clone));
        const r1 = samasyaStore ? stub(samasyaStore) : () => {};
        const r2 = mulaqatStore ? stub(mulaqatStore) : () => {};
        let p;
        try { p = replyBrain.respond(message, c2, { llm: useLlm ? llm : null, meta: { phone: user.phone, test: true } }); }
        finally { r1(); r2(); } // stores are restored before the first await (the brain's flow part is synchronous)
        const r = await p;
        return { text: String(r.text || '').trim(), source: r.source, intent: r.intent };
    };
    // instruction from the operator: the LLM writes it, the validator checks it, the template is the backstop
    if (instruction && llm) {
        try {
            const facts = replyBrain.validateLLM ? '' : '';
            const ocm = require('./operator_control.js');
            const sys = `You write ONE short WhatsApp reply (Hindi in Devanagari unless the voter writes Hinglish) for Abhay Singh ji's campaign team (female voice, "main ... karti hoon"). Operator instruction: "${instruction}". Voter's last message: "${message}". Rules: no money/budget figures or work counts, never say Abhay Singh ji was sarpanch before, no promised dates, no caste/religion, no threats or bribes, no attacks on anyone. Max 2 lines. Output only the message.\n${ocm.promptBlock(clone)}`;
            let d = replyBrain.cleanLLM(await llm(sys, [], message));
            const why = replyBrain.validateLLM(d, { allowedText: message + ' ' + instruction + ' 16 2026', user: clone, l: /[\u0900-\u097F]/.test(d) ? 'hi' : 'en' }) || ocm.leakCheck(d, clone, { allowedText: instruction, message });
            if (d && !why && !excl.has(d.trim())) return { text: d.trim(), source: 'llm(instruction)', basedOn: message };
            out.push({ rejected: why || 'repeat' });
        } catch (e) { out.push({ rejected: 'llm_error' }); }
    }
    const order = attempt % 2 === 0 ? [true, false] : [false, true];
    for (const useLlm of order) {
        if (useLlm && !llm) continue;
        try {
            const r = await runOnce(useLlm);
            if (r.text && !excl.has(r.text)) return { ...r, basedOn: message };
            out.push(r);
        } catch (e) { out.push({ error: e.message }); }
    }
    const any = out.find(x => x.text);
    return any ? { ...any, basedOn: message, note: 'same as before — no other safe variant right now' } : { text: '', source: 'none', basedOn: message };
}

// ---------------- quick actions ----------------
function safeGreeting(user) {
    const n = user && user.name && !/^(ग्रामवासी|voter|unknown)$/i.test(user.name) ? ' ' + String(user.name).split(/\s+/)[0] + ' जी' : ' जी';
    return `राम राम${n} 🙏 मैं अभय सिंह जी की टीम से हूँ। कोई भी काम हो—पर्ची, बूथ या गाँव की कोई बात—तो बेझिझक बताइए।`;
}

function install(app, deps) {
    const { userMemory, getActiveSocket, sendSafeMessage, sendMultiContactCard, engagementPolicy, contactCard, logMessage, samasyaStore, mulaqatStore, voterEngine, voterCardGen, slipFlow, replyBrain, getLLM } = deps;
    installArchiveHook(userMemory);

    app.get('/api/crm/chat/:phone', (req, res) => {
        try {
            const u = userMemory.getUser(req.params.phone);
            if (!u) return res.status(404).json({ error: 'not found' });
            const all = fullHistory(u);
            const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 2000);
            const before = req.query.before !== undefined ? Number(req.query.before) : all.length;
            const start = Math.max(0, before - limit);
            res.json({ success: true, phone: u.phone, total: all.length, start, end: before, hasMore: start > 0, messages: all.slice(start, before) });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.get('/api/crm/profile/:phone', (req, res) => {
        try { const u = userMemory.getUser(req.params.phone); res.json({ success: true, profile: buildProfile(u, deps) }); }
        catch (e) { res.status(500).json({ error: e.message }); }
    });
    app.post('/api/crm/profile/:phone', (req, res) => {
        try {
            const u = userMemory.getUser(req.params.phone);
            saveProfile(u, req.body || {});
            userMemory.save();
            res.json({ success: true, profile: buildProfile(u, deps) });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.post('/api/crm/copilot', async (req, res) => {
        try {
            const b = req.body || {};
            if (!b.phone) return res.status(400).json({ error: 'phone required' });
            const u = userMemory.getUser(b.phone);
            const r = await copilotSuggest(u, { attempt: Number(b.attempt) || 0, exclude: Array.isArray(b.exclude) ? b.exclude.slice(-10) : [], instruction: String(b.instruction || '').slice(0, 300), llm: getLLM ? getLLM() : null, replyBrain, samasyaStore, mulaqatStore });
            if (!r.text) return res.status(422).json({ success: false, error: 'No safe suggestion right now' });
            res.json({ success: true, ...r });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.get('/api/crm/actions', (req, res) => {
        const posters = mediaPolicy.approved('poster');
        const reels = mediaPolicy.approved('video');
        res.json({ success: true, posters: posters.map(p => ({ id: p.id, title: p.title, file: p.file })), reels: reels.map(r => ({ id: r.id, title: r.title, file: r.file })),
            actions: { contact_card: true, ramram: true, poster: posters.length > 0, video: reels.length > 0, slip: true, baba_register: true, meeting: true } });
    });

    app.post('/api/quick-action', async (req, res) => {
        const b = req.body || {};
        const action = b.action === 'demo_poster' ? 'poster' : b.action;
        try {
            if (!b.phone || !action) return res.status(400).json({ success: false, error: 'phone and action are required' });
            const phone = userMemory.cleanPhone(b.phone);
            const user = userMemory.getUser(phone);
            const send = b.send !== false && b.send !== 'false';
            const logOnly = ['baba_register', 'meeting'].includes(action) && !send;
            const blocked = (user.broadcastOptOut || user.consentStatus === 'REJECTED');
            if (blocked && !logOnly) return res.status(409).json({ success: false, error: 'This number said STOP / refused — message will not be sent (STOP honoured).' });
            const lineId = b.lineId || user.assignedLine || 'sim_636';
            const active = logOnly ? null : getActiveSocket(lineId);
            if (!logOnly && !active) return res.status(503).json({ success: false, error: 'WhatsApp line not connected: ' + lineId });
            const sock = active && active.sock;
            const jid = phone + '@s.whatsapp.net';
            let text = '', mediaType = null, record = null;
            const say = async (content) => { await sendSafeMessage(sock, jid, content); };

            if (action === 'contact_card') {
                await sendMultiContactCard(sock, jid, active.session.id);
                try { contactCard.markSent(user, active.session.id); } catch (e) {}
                text = '📇 [Contact Card Sent]'; mediaType = 'contactCard';
            } else if (action === 'ramram') {
                text = safeGreeting(user); await say({ text });
            } else if (action === 'poster') {
                const list = mediaPolicy.approved('poster');
                const p = (b.posterId && list.find(x => x.id === b.posterId)) || list[0];
                if (!p) return res.status(404).json({ success: false, error: 'No approved poster in the media bank' });
                mediaPolicy.assertSendable(p.file);
                text = p.caption; await say({ image: fs.readFileSync(p.path), caption: text }); mediaType = 'poster';
            } else if (action === 'video') {
                const list = mediaPolicy.approved('video');
                const v = list.find(x => !(user.sentVideos || []).includes(x.id)) || list[0];
                if (!v) return res.status(404).json({ success: false, error: 'No approved video in the media bank' });
                mediaPolicy.assertSendable(v.file);
                text = v.caption; await say({ video: fs.readFileSync(v.path), caption: text }); mediaType = 'video';
                user.sentVideos = Array.from(new Set((user.sentVideos || []).concat([v.id])));
            } else if (action === 'slip') {
                // privacy rule (voter_engine / slip_flow): a match is confirmed by the voter (father/husband name) before the slip goes out
                const plan = slipFlow.decide('पर्ची', user, { slipIntent: true, searchText: b.name || undefined });
                if (!plan) return res.status(422).json({ success: false, error: 'No slip step available' });
                if (plan.kind === 'deliver' && plan.voter) {
                    let card = null; try { card = await voterCardGen.generateVoterCard(plan.voter); } catch (e) {}
                    text = card ? slipFlow.deliverCaption(user, plan.voter, false, !!plan.other) : voterEngine.formatShortSlipResponse(plan.voter) + slipFlow.FAMILY_TAIL;
                    if (card) { await say({ image: card, caption: text }); mediaType = 'voterSlipCard'; } else { await say({ text }); mediaType = 'voterSlip'; }
                } else {
                    text = plan.text; await say({ text });
                    mediaType = { confirm: 'parchiConfirmation', choose: 'disambiguation', ask_name: 'parchiNamePrompt', not_found: 'parchiNotFound', recall: 'parchiRecall' }[plan.kind] || 'parchi';
                }
                record = { slipStep: plan.kind };
            } else if (action === 'baba_register') {
                const note = String(b.note || '').trim();
                if (!note) return res.status(400).json({ success: false, error: 'Write the problem (note required)' });
                const m = require('./voter_memory.js').ensure(user);
                record = samasyaStore.create({ phone, name: user.name || m.name || null, village: m.village || null, ward: m.ward || user.ward || null, category: b.category || 'other', topic: null, description: note.slice(0, 300), location: b.place || null, since: null, line: lineId, test: !!b.test, source: 'crm', notes: 'logged from CRM chat' });
                text = `आपकी बात रजिस्टर में दर्ज कर ली है (क्रमांक ${record.id}) और अभय सिंह जी तक पहुँचा दी है 🙏`;
                if (send) await say({ text });
            } else if (action === 'meeting') {
                const m = require('./voter_memory.js').ensure(user);
                record = mulaqatStore.create({ type: 'visit', phone, name: user.name || m.name || null, village: m.village || null, ward: m.ward || user.ward || null, preferredWhen: String(b.when || '').slice(0, 80) || null, place: String(b.place || '').slice(0, 120) || null, familyMembers: null, purpose: String(b.purpose || '').slice(0, 200) || null, line: lineId, test: !!b.test, source: 'crm', notes: 'created from CRM chat' });
                text = `आपकी मुलाकात की बात दर्ज कर ली है (क्रमांक ${record.id}) 🙏 टीम आपसे बात करके समय पक्का करेगी।`;
                if (send) await say({ text });
            } else {
                return res.status(400).json({ success: false, error: 'unknown action ' + action });
            }
            if (!logOnly) userMemory.recordMessage(phone, 'bot', text, mediaType, 'Admin Quick Action');
            else userMemory.save();
            try { logMessage({ session: active ? active.session.name : 'CRM', phone, incoming: `[Action: ${action}]`, reply: text, by: req.dashUser ? req.dashUser.username : undefined, status: logOnly ? 'LOGGED' : (mediaType ? 'MEDIA_SENT' : 'DELIVERED') }); } catch (e) {}
            res.json({ success: true, action, sent: !logOnly, message: text, record });
        } catch (e) {
            res.status(e.retired ? 400 : 500).json({ success: false, error: e.message });
        }
    });
}

module.exports = { install, fullHistory, buildProfile, saveProfile, copilotSuggest, appendArchive, readArchive, installArchiveHook, safeGreeting, ARCHIVE_DIR };
