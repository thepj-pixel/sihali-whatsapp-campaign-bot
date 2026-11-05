/**
 * 5 Nov 2026: emoji understanding, photo understanding, media policy (retired posters), CRM full chat archive,
 * voter profile & memory, AI co-pilot, quick actions (fake WhatsApp socket). Run: npm run test:crm
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
process.env.CHAT_ARCHIVE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'crm_arch_'));
process.env.SAMASYA_PATH = path.join(process.env.CHAT_ARCHIVE_DIR, 'samasya.json');
process.env.MULAQAT_PATH = path.join(process.env.CHAT_ARCHIVE_DIR, 'mulaqat.json');
process.env.VISION_NVIDIA = 'off';
const userMemory = require('./user_memory.js');
userMemory.save = () => {};
const replyBrain = require('./reply_brain.js');
const emojiSense = require('./emoji_sense.js');
const slipFlow = require('./slip_flow.js');
const mu = require('./media_understanding.js');
const mediaPolicy = require('./media_policy.js');
const samasyaStore = require('./samasya_store.js');
const mulaqatStore = require('./mulaqat_store.js');
const crm = require('./crm_routes.js');
const voterMemory = require('./voter_memory.js');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) pass++; else { fail++; console.log('❌', msg); } }
const BANNED = /(सरपंच रहे|sarpanch rahe|करोड़|crore|लाख|₹|जीतते ही|तुरंत करवाया|गारंटी|पक्का कर देंगे)/i;
const VOTE_ASK = '16 नवंबर को अभय सिंह जी का साथ देंगे ना?';
const mkUser = (hist = []) => ({ phone: '9199' + Math.floor(Math.random() * 1e8), history: hist });

(async () => {
    // ---------- 1. emoji ----------
    for (const [e, k] of [['🙏', 'pray'], ['👍', 'agree'], ['✅', 'agree'], ['❤️', 'love'], ['😡', 'upset'], ['👎', 'upset'], ['😂', 'laugh'], ['🤔', 'think'], ['👍🏽👍🏽', 'agree'], ['😢', 'sad']]) {
        const a = emojiSense.analyze(e); ok(a.emojiOnly && a.kind === k, `emoji ${e} -> ${k} (got ${a.kind})`);
    }
    ok(!emojiSense.analyze('ok 👍').emojiOnly, 'text+emoji is not emoji-only');
    ok(!emojiSense.analyze('1️⃣').emojiOnly, 'keycap 1 is a number, not emoji-only');
    for (const e of ['👍', '✅', '🙏', '❤️']) {
        const u = mkUser([{ role: 'bot', text: VOTE_ASK }, { role: 'user', text: e }]);
        const r = await replyBrain.respond(e, u, {});
        ok(r.intent === 'commit' && u.persuasionStage === 'committed', `${e} after vote ask = soft commit (got ${r.intent})`);
        ok(u.memory.commitment.soft === true, `${e} commitment marked soft`);
        ok(/धन्यवाद/.test(r.text) && !BANNED.test(r.text), `${e} commit reply warm: ${r.text}`);
    }
    for (const [e, rx, nm] of [['😡', /नाराज़गी|माफ़ी/, 'upset->empathy'], ['👎', /नाराज़गी|माफ़ी/, 'thumbs down->empathy'], ['😂', /😄|😂/, 'laugh->light'], ['🤔', /सवाल/, 'think->invite question'], ['❤️', /प्यार|धन्यवाद/, 'love->thanks'], ['🙏', /🙏/, 'pray->warm']]) {
        const u = mkUser([{ role: 'bot', text: 'राम राम जी 🙏 बताइए क्या मदद करूँ?' }, { role: 'user', text: e }]);
        const r = await replyBrain.respond(e, u, {});
        ok(rx.test(r.text) && r.text.length < 200 && !/साथ देंगे ना|वोट देंगे ना/.test(r.text), `${nm}: ${r.text}`);
        if (e === '😡') ok(!!u.memory.grievanceOpenAt, 'upset emoji opens the grievance window (no vote ask, next problem logged)');
    }
    {   // upset emoji then a problem -> samasya
        const u = mkUser([{ role: 'bot', text: 'राम राम जी' }, { role: 'user', text: '😡' }]);
        await replyBrain.respond('😡', u, { meta: { phone: u.phone, test: true } });
        u.history.push({ role: 'bot', text: 'x' }, { role: 'user', text: 'naali band hai ward 3 me' });
        const r = await replyBrain.respond('naali band hai ward 3 me', u, { meta: { phone: u.phone, test: true } });
        ok(!!r.samasyaId, 'after 😡 a problem message is logged as samasya');
    }
    ok(slipFlow.isYes('👍') && slipFlow.isYes('🙏') && slipFlow.isYes('✅') && !slipFlow.isYes('😡'), 'slip confirmation accepts 👍/🙏/✅ as yes');

    // ---------- 2. photos / stickers / voice ----------
    for (const [tok, rx] of [['[voice note]', /वॉइस|voice/i], ['[sticker]', /🙏|😊/], ['[video]', /वीडियो|video/i], ['[photo]', /फोटो|photo/i]]) {
        const u = mkUser([{ role: 'user', text: tok }]);
        const r = await replyBrain.respond(tok, u, {});
        ok(rx.test(r.text) && !BANNED.test(r.text), `${tok}: ${r.text}`);
    }
    {
        const u = mkUser(); u.memory = undefined;
        const r = mu.replyForPhoto({ user: u, analysis: { category: 'civic_issue', summaryHindi: 'टूटी सड़क और गड्ढे', details: { issueType: 'road' } }, meta: { phone: u.phone, test: true } });
        ok(r.kind === 'civic_issue' && r.samasyaId && /दर्ज/.test(r.text) && !BANNED.test(r.text), 'civic photo -> samasya logged: ' + r.text);
        const rec = samasyaStore.get(r.samasyaId);
        ok(rec && /photo received/.test(rec.notes) && rec.category === 'सड़क/रास्ता', 'samasya has "photo received" + category');
        const r2 = mu.replyForPhoto({ user: mkUser(), analysis: { category: 'civic_issue', summaryHindi: 'गंदी नाली का पानी', details: {} }, meta: { test: true } });
        ok(samasyaStore.get(r2.samasyaId).category === 'नाली/सफ़ाई', 'naali photo category');
        const r3 = mu.replyForPhoto({ user: mkUser(), analysis: { category: 'campaign_material', summaryHindi: 'पोस्टर' } });
        ok(/धन्यवाद/.test(r3.text) && !/बाबा जी/.test(r3.text), 'poster photo -> warm thanks: ' + r3.text);
        const r4 = mu.replyForPhoto({ user: mkUser(), analysis: { category: 'personal_photo', summaryHindi: 'सेल्फी' } });
        ok(/धन्यवाद/.test(r4.text), 'selfie -> polite');
        const uf = mkUser([{ role: 'user', text: '[photo]' }]);
        const r5 = mu.replyForPhoto({ user: uf, analysis: { category: 'other', fallback: true } });
        ok(r5.kind === 'fallback' && /किस बारे/.test(r5.text) && uf.memory.photoOpenAt, 'no vision -> ack + one-line ask');
        uf.history.push({ role: 'bot', text: r5.text }, { role: 'user', text: 'gali me paani bhar gaya hai ward 2' });
        const rr = await replyBrain.respond('gali me paani bhar gaya hai ward 2', uf, { meta: { phone: uf.phone, test: true } });
        ok(!!rr.samasyaId && /photo received/.test((samasyaStore.get(rr.samasyaId) || {}).notes || ''), 'answer after an unreadable photo -> samasya with photo noted');
    }
    {   // vision service never throws and returns fallback without keys
        const vs = require('./vision_service.js');
        vs.geminiKey = '';
        const a = await vs.analyzeImage(fs.readFileSync(path.join(__dirname, 'media', 'poster.jpg')));
        ok(a && a.fallback === true, 'vision without keys -> fallback flag');
    }

    // ---------- 3. media policy ----------
    for (const f of ['poster_sankalp.png', 'poster_vikas_infra.png', 'poster_statesman.png', 'poster_demo_test.png', 'poster_statesman']) ok(mediaPolicy.isRetired(f), 'retired: ' + f);
    ok(!mediaPolicy.isRetired('poster.jpg'), 'poster.jpg approved');
    ok(mediaPolicy.approved('poster').every(p => !mediaPolicy.isRetired(p.file)) && mediaPolicy.approved('poster').length >= 1, 'approved posters exclude retired');
    {
        const { BroadcastEngine } = require('./broadcast_engine.js');
        let threw = false;
        try { BroadcastEngine.prototype.resolveMedia.call({ mediaDir: path.join(__dirname, 'media') }, 'poster_statesman.png'); } catch (e) { threw = /Retired/.test(e.message); }
        ok(threw, 'Bulk Send refuses a retired poster');
    }
    {
        const mc = require('./media_catalog.js');
        ok(mc.setDemoMode(true) === false, 'demo poster mode can not be switched on without env');
    }

    // ---------- 4. CRM: archive, profile, co-pilot ----------
    crm.installArchiveHook(userMemory);
    const u = userMemory.getUser('919000011122');
    u.history = [];
    for (let i = 0; i < 70; i++) userMemory.recordMessage('919000011122', i % 2 ? 'bot' : 'user', 'संदेश ' + i, null, 'Test');
    ok(u.history.length === 50, 'live memory still capped at 50');
    const all = crm.fullHistory(u);
    ok(all.length === 70 && all[0].text === 'संदेश 0', 'full chat keeps all 70 messages (got ' + all.length + ')');
    u.history.push({ role: 'user', text: 'mera naam Ramesh hai, ward 4 me naali band hai', createdAt: Date.now() });
    crm.saveProfile(u, { name: 'रमेश कुमार', relName: 'सुरेश', ward: '4', gender: 'M', age: '45', stance: 'leaning', familyVotes: '5', interests: 'नाली, पानी', notes: 'शाम को बात करना पसंद' });
    const card = voterMemory.buildCard(u);
    ok(/रमेश कुमार/.test(card) && /ward: 4/.test(card) && /operatorNotes: शाम/.test(card) && /fatherOrHusband: सुरेश/.test(card) && /familyVotes: 5/.test(card), 'operator edits feed the memory card');
    const prof = crm.buildProfile(u, { samasyaStore, mulaqatStore });
    ok(prof.name === 'रमेश कुमार' && prof.stance === 'leaning' && String(prof.ward) === '4' && prof.booth, 'profile auto-fill + booth');
    const before = samasyaStore.list({ includeTest: true }).length;
    const s1 = await crm.copilotSuggest(u, { replyBrain, samasyaStore, mulaqatStore });
    ok(s1.text && !BANNED.test(s1.text) && s1.basedOn.includes('naali'), 'co-pilot suggestion from last voter message: ' + s1.text);
    ok(samasyaStore.list({ includeTest: true }).length === before, 'co-pilot creates no samasya record');
    ok(u.history.length === 51 && !u.history.some(h => h.session === 'copilot'), 'co-pilot does not touch the real chat');
    const stubLLM = async () => 'जी, नाली की बात नोट कर ली है 🙏 किस गली में है, बता देंगे?';
    const s2 = await crm.copilotSuggest(u, { replyBrain, samasyaStore, mulaqatStore, attempt: 1, exclude: [s1.text], llm: stubLLM });
    ok(s2.text && s2.text !== s1.text, 'try again gives a different suggestion: ' + s2.text);
    const s3 = await crm.copilotSuggest(u, { replyBrain, samasyaStore, mulaqatStore, instruction: 'चौपाल पर बुलाओ', llm: async () => 'अभय सिंह जी पहले सरपंच रहे हैं, 5 करोड़ का काम' });
    ok(s3.text && !BANNED.test(s3.text), 'invalid LLM draft is rejected by validator: ' + s3.text);

    // ---------- 5. quick actions over HTTP with a fake socket ----------
    const express = require('express');
    const app = express(); app.use(express.json());
    const sent = [];
    const fakeSock = { sendMessage: async (jid, c) => { sent.push({ jid, c }); return { key: { id: 'x' } }; } };
    crm.install(app, {
        userMemory, samasyaStore, mulaqatStore, replyBrain, slipFlow,
        getActiveSocket: (id) => ({ sock: fakeSock, session: { id: id || 'sim_636', name: 'Primary' } }),
        sendSafeMessage: (s, j, c) => s.sendMessage(j, c),
        sendMultiContactCard: (s, j) => s.sendMessage(j, { contacts: { displayName: 'x', contacts: [] } }),
        engagementPolicy: require('./engagement_policy.js'), contactCard: require('./contact_card.js'), logMessage: () => {},
        voterEngine: require('./voter_engine.js'), voterCardGen: { generateVoterCard: async () => null }, getLLM: () => null
    });
    const srv = app.listen(0); const base = 'http://127.0.0.1:' + srv.address().port;
    const post = (url, b) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(async r => ({ status: r.status, ...(await r.json()) }));
    const P = '14502790497';
    userMemory.getUser(P).history = [];
    for (const a of ['contact_card', 'ramram', 'poster', 'demo_poster', 'video', 'slip']) {
        const r = await post('/api/quick-action', { phone: P, action: a });
        ok(r.status === 200 && r.success, `quick action ${a}: ${r.status} ${r.error || ''}`);
    }
    ok(sent.some(s => s.c.image) && sent.every(s => !(s.c.caption || '').includes('Testing')), 'poster sent is approved (not demo)');
    ok(sent.some(s => s.c.video), 'approved reel sent');
    const slipMsg = sent[sent.length - 1].c.text || '';
    ok(!sent[sent.length - 1].c.image, 'slip action without confirmation never sends a slip card directly: ' + slipMsg.slice(0, 60));
    const reg = await post('/api/quick-action', { phone: P, action: 'baba_register', note: 'वार्ड 3 में नाली टूटी', test: true });
    ok(reg.success && reg.record && /^S-/.test(reg.record.id) && /दर्ज/.test(reg.message), 'baba_register creates samasya ' + (reg.record && reg.record.id));
    const meet = await post('/api/quick-action', { phone: P, action: 'meeting', when: 'कल शाम 5 बजे', place: 'चौपाल', purpose: 'पानी', test: true });
    ok(meet.success && meet.record && /^M-/.test(meet.record.id) && !/\d+ (नवंबर|बजे तक)/.test(meet.message), 'meeting creates mulaqat ' + (meet.record && meet.record.id));
    const noNote = await post('/api/quick-action', { phone: P, action: 'baba_register' });
    ok(noNote.status === 400, 'register without note -> clear error');
    const stopU = userMemory.getUser('919111122233'); require('./engagement_policy.js').applyOptOut(stopU);
    const st = await post('/api/quick-action', { phone: '919111122233', action: 'ramram' });
    ok(st.status === 409, 'STOP honoured by quick actions');
    const chat = await fetch(base + '/api/crm/chat/' + P + '?limit=3').then(r => r.json());
    ok(chat.success && chat.messages.length === 3 && chat.hasMore, 'chat API pages with hasMore');
    const acts = await fetch(base + '/api/crm/actions').then(r => r.json());
    ok(acts.actions.poster && acts.posters.every(p => !mediaPolicy.isRetired(p.file)), 'actions list only approved posters');
    const pr = await post('/api/crm/profile/' + P, { name: 'टेस्ट कनाडा', ward: '2' });
    ok(pr.success && pr.profile.name === 'टेस्ट कनाडा', 'profile save API');
    const cp = await post('/api/crm/copilot', { phone: P });
    ok(cp.success && cp.text, 'copilot API: ' + (cp.text || cp.error));
    srv.close();

    // ---------- 6. UI strings ----------
    const ui = require('./crm_ui.js');
    ok(/min-width: 0/.test(ui.css()) && /overflow-wrap: anywhere/.test(ui.css()), 'chat pane CSS: min-width 0 + wrap');
    ok(!/\?\./.test(ui.script()), 'UI script ES5-safe (no optional chaining)');
    try { new Function(ui.script().replace(/<\/?script>/g, '')); ok(true, ''); } catch (e) { ok(false, 'UI script parses: ' + e.message); }

    console.log(`\ntest:crm — ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
