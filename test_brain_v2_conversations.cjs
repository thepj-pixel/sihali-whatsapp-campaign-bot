// Brain v2 — offline multi-turn conversation suite (no network, no LLM keys).
// 28 scripted conversations (each >= 6 turns) through a fake WhatsApp socket + the real pipeline
// (opt-out -> consent -> ai_assistant_service.getAIResponse -> reply_brain v2), or through reply_brain.respond
// with a stub LLM / stub JSON extractor. Checks: memory recall, non-repetition, facts only from the sheets,
// hard rules (no "बाबा जी", no sarpanch-before claim, no money/counts, no attacks), STOP forever, follow-up
// planner rules, and the Live Self-Test harness with two fake lines (capture, voter routing, loop guard).
// Usage: npm run test:brainv2      (add --print to see every dialogue)
const userMemory = require('./user_memory.js');
userMemory.save = () => {};
const aiService = require('./ai_assistant_service.js');
const brain = require('./reply_brain.js');
const engagementPolicy = require('./engagement_policy.js');
const kb = require('./knowledge_base.js');
const voterMemory = require('./voter_memory.js');
const planner = require('./followup_planner.js');
const replyQuality = require('./reply_quality.js');
const { LiveSelfTest } = require('./self_test.js');
const os = require('os');
const path = require('path');

const PRINT = process.argv.includes('--print');
let passed = 0, failed = 0;
const fails = [];
function check(name, cond) { if (cond) passed++; else { failed++; fails.push(name); console.error('FAIL ' + name); } }

const HARD = [
    ['बाबा जी', /(बाबा जी|बाबाजी|\bbaba ji\b|\bbabaji\b)/i],
    ['sarpanch-before claim', brain.SARPANCH_CLAIM],
    ['money/budget', /(₹|रुपये|रुपए|लाख|करोड़|\blakh\b|crore|budget|बजट|लागत)/i],
    ['work count', /\d+\s*\+?\s*(काम|कार्य|संकल्प|सड़कें|kaam|sankalp|cc sadk)/i],
    ['caste/religion', /(हिंदू|मुसलमान|जाति|\bjaat\b|जाट|गुर्जर|मेघवाल|ब्राह्मण|dharm ke naam)/i],
    ['threat/bribe offer', /(धमकी|dhamki|देख लेंगे|अंजाम|paise denge|पैसे देंगे|दारू देंगे|daru denge)/i],
    ['opponent attack', /(वो चोर|wo chor|उनके झूठ|kis bil me|किस बिल में|बिकाऊ|bikau)/i],
    ['fake slip delivery', /(पर्ची भेज दी|parchi bhej di)/i]
];
const ALL_FACT_TEXT = kb.load().items.map(i => i.text + ' ' + (i.roman || '')).join(' ').toLowerCase();

function globalChecks(conv, turnNo, msg, reply, prevReply) {
    const tag = `[${conv} t${turnNo}]`;
    for (const [name, rx] of HARD) check(`${tag} no ${name}`, !rx.test(reply));
    check(`${tag} reply length <= 480`, reply.length <= 480);
    if (prevReply) check(`${tag} not a repeat of previous bot reply`, replyQuality.normalize(reply) !== replyQuality.normalize(prevReply) && replyQuality.similarity(replyQuality.normalize(reply), replyQuality.normalize(prevReply)) < 0.78);
    if (/[a-z\u0900-\u097F]/i.test(msg)) {
        const hi = /[\u0900-\u097F]/.test(msg);
        check(`${tag} script follows voter (${hi ? 'Devanagari' : 'Hinglish'})`, hi ? /[\u0900-\u097F]/.test(reply) : !/[\u0900-\u097F]/.test(reply));
    }
}

// ---------------- fake WhatsApp socket + pipeline (mirrors server.js text path) ----------------
class FakeSock {
    constructor(id, waid) { this.id = id; this.user = { id: waid + ':7@s.whatsapp.net' }; this.sent = []; this.onSend = null; }
    async sendMessage(jid, content) { this.sent.push({ jid, content }); if (this.onSend) setImmediate(() => this.onSend(jid, content)); return { key: { id: 'm' + this.sent.length, remoteJid: jid } }; }
}

/** One inbound voter text, handled like server.js (STOP -> consent -> autopilot -> brain). Returns reply or null. */
async function pipelineTurn(sock, phone, body) {
    userMemory.recordMessage(phone, 'user', body, null, 'Primary Line');
    const user = userMemory.getUser(phone);
    const jid = phone + '@s.whatsapp.net';
    const send = async (text) => { await sock.sendMessage(jid, { text }); userMemory.recordMessage(phone, 'bot', text, null, 'Primary Line'); return text; };
    if (engagementPolicy.isOptOutMessage(body)) {
        const first = !user.broadcastOptOut;
        engagementPolicy.applyOptOut(user);
        return first ? send(engagementPolicy.buildOptOutAck(engagementPolicy.messageLanguage(body))) : null;
    }
    if (user.broadcastOptOut && engagementPolicy.isOptInMessage(body)) { engagementPolicy.applyOptIn(user); return send('धन्यवाद! 🙏 आप फिर से जुड़ गए हैं।'); }
    const decision = engagementPolicy.parseConsentResponse(body);
    if (user.consentStatus === 'PENDING') { engagementPolicy.markConsentPrompted(user); return send(engagementPolicy.buildConsentPrompt(user.name, engagementPolicy.messageLanguage(body))); }
    const substantive = decision === 'accepted' && !/^(1|1\.|ha+n?|haa|हाँ|हां|ji|जी|ok+|okay|yes|theek( hai)?|thik( hai)?|ठीक है|bilkul|बिल्कुल|zaroor|ज़रूर|जरूर)[\s!.🙏👍]*$/i.test(body.trim());
    if (user.consentStatus === 'PROMPTED' && decision === 'accepted' && substantive) engagementPolicy.applyConsentDecision(user, 'accepted');
    else if (user.consentStatus === 'PROMPTED' && decision) {
        engagementPolicy.applyConsentDecision(user, decision);
        return send(decision === 'accepted' ? 'धन्यवाद! 🙏 बताइए—अपनी मतदाता पर्ची देखनी है, वार्ड की जानकारी चाहिए, या गाँव की कोई समस्या साझा करनी है?' : 'जी, आपके निर्णय का सम्मान है। 🙏');
    }
    if (user.autoPilot === false) return null;
    const history = userMemory.getUserHistory(phone).slice(0, -1).map(h => ({ role: h.role === 'bot' ? 'assistant' : 'user', content: h.text }));
    let reply = await aiService.getAIResponse(body, null, history, phone);
    if (!reply) reply = aiService.getSafeFallback(body, phone);
    return send(reply);
}

function freshPhone(n) { const p = '9188' + String(80000000 + n); delete userMemory.users[p]; return p; }
function consentedUser(phone, extra = {}) {
    const u = userMemory.getUser(phone);
    Object.assign(u, { consented: true, consentStatus: 'ACCEPTED', autoPilot: true, contactCardSent: true }, extra);
    return u;
}

/**
 * Run a conversation.
 * spec: { name, mode: 'pipeline'|'brain', consented: true, user: {...}, llm, llmJson, turns: [{ m, intent, has: [], hasAll: [], not: RegExp, noReply }], after(user, replies) }
 */
async function runConversation(n, spec) {
    const phone = freshPhone(n);
    const sock = new FakeSock('sim_636', '916367810227');
    if (spec.consented !== false) consentedUser(phone, spec.user || {});
    else Object.assign(userMemory.getUser(phone), spec.user || {});
    const user = userMemory.getUser(phone);
    const replies = [];
    let prev = null;
    if (PRINT) console.log(`\n=== ${n}. ${spec.name} ===`);
    for (let i = 0; i < spec.turns.length; i++) {
        const t = spec.turns[i];
        let reply = null, r = null;
        if (spec.mode === 'brain') {
            user.history.push({ role: 'user', text: t.m, createdAt: Date.now() + i * 10 });
            r = await brain.respond(t.m, user, { llm: spec.llm || null, llmJson: spec.llmJson || null });
            reply = r.text;
            user.history.push({ role: 'bot', text: reply, createdAt: Date.now() + i * 10 + 5 });
        } else {
            reply = await pipelineTurn(sock, phone, t.m);
        }
        replies.push({ m: t.m, reply, r });
        if (PRINT) console.log(`> ${t.m}\n${reply === null ? '(no reply)' : (r ? '[' + r.intent + '|' + r.source + '] ' : '') + reply}`);
        const tag = `[${spec.name} t${i + 1}]`;
        if (t.noReply) { check(`${tag} no reply (opted out / paused)`, reply === null); continue; }
        check(`${tag} got a reply`, typeof reply === 'string' && reply.length > 0);
        if (!reply) continue;
        globalChecks(spec.name, i + 1, t.m, reply, prev);
        if (t.intent && r) check(`${tag} intent ${t.intent} (got ${r.intent})`, r.intent === t.intent);
        if (t.has) check(`${tag} mentions one of ${JSON.stringify(t.has)}`, t.has.some(x => reply.toLowerCase().includes(String(x).toLowerCase())));
        if (t.hasAll) check(`${tag} mentions all of ${JSON.stringify(t.hasAll)}`, t.hasAll.every(x => reply.toLowerCase().includes(String(x).toLowerCase())));
        if (t.not) check(`${tag} does not match ${t.not}`, !t.not.test(reply));
        prev = reply;
    }
    if (spec.after) await spec.after(user, replies, { phone, sock });
    delete userMemory.users[phone];
}

// ---------------- stub LLMs ----------------
const draftOf = sys => ((String(sys).match(/SAFE DRAFT[^:]*:\s*([\s\S]*)$/) || [])[1] || '').trim();
const prompts = [];
const goodLLM = async (sys, history, msg) => { prompts.push({ sys, history, msg }); const d = draftOf(sys); return d ? d.replace(/^(Ji|जी),?\s*/, '') : null; };
const BAD_OUTPUTS = ['Abhay Singh ne 500 sadkein banwayi!', 'बाबा जी आपके साथ हैं, वोट दीजिए।', 'Abhay Singh ji pehle sarpanch rahe hain, unhone sab kiya.', 'अभय सिंह जी ने पानी की टंकियाँ बनवाईं।', 'Vote do, paise denge.', 'Wo chor hai, uske jhooth mat suno.'];
let badIdx = 0;
const badLLM = async () => BAD_OUTPUTS[(badIdx++) % BAD_OUTPUTS.length];

// ---------------- conversations ----------------
const C = [];

C.push({ name: 'road-concern-recall', mode: 'pipeline', turns: [
    { m: 'Ram ram' },
    { m: 'main ward 5 Sihali Khurd se hu', has: ['96', 'ward 5'] },
    { m: 'hamare ward me sadak tooti padi hai, kab banegi?', has: ['sadak', 'priority', 'note'] },
    { m: 'Abhay singh ne pani ke liye kya kiya?', has: ['paani', 'jal', 'nal', 'borewell'] },
    { m: 'aur aage kya karenge?', has: ['sankalp', 'prathmikta'] },
    { m: 'hmm soch ke batayenge' },
    { m: 'meri sadak wali baat yaad hai?', hasAll: ['sadak', 'ward 5'] },
    { m: 'theek hai pakka vote denge, ghar ke 4 vote', has: ['4'] }
], after: (u) => {
    check('[road-concern-recall] memory ward 5', u.memory.ward === 5);
    check('[road-concern-recall] memory concern road @ward5', u.memory.concerns.some(c => c.topic === 'road' && c.ward === 5));
    check('[road-concern-recall] memory family votes 4', u.memory.familyVotes === 4);
    check('[road-concern-recall] memory committed', u.memory.commitment.status === 'committed' && u.persuasionStage === 'committed');
    check('[road-concern-recall] works told are tracked', u.memory.toldItems.length >= 2);
} });

C.push({ name: 'hindi-woman-water-hadahedi', mode: 'pipeline', turns: [
    { m: 'राम राम' },
    { m: 'मैं हाड़ाहेड़ी से बोल रही हूँ' },
    { m: 'हमारे यहाँ पानी की बहुत दिक्कत है', has: ['पानी', 'नल', 'जल'] },
    { m: 'आगे क्या करेंगे पानी के लिए?', has: ['संकल्प', 'पानी'] },
    { m: 'सोचकर बताएँगे' },
    { m: 'ठीक है' },
    { m: 'राम राम', has: ['पानी'] }
], after: (u) => {
    check('[hindi-woman] gender F from verb ending', u.memory.gender === 'F');
    check('[hindi-woman] village hadahedi', u.memory.village === 'hadahedi');
    check('[hindi-woman] honorific बहन जी used', /बहन जी/.test(u.history.filter(h => h.role === 'bot').map(h => h.text).join(' ')));
} });

C.push({ name: 'elder-pension', mode: 'brain', turns: [
    { m: 'ram ram beta' },
    { m: 'meri umar 70 saal ki hai, main vote dalne zaroor aaunga' },
    { m: 'pension nahi milti budhape ki', intent: 'complaint', has: ['chaupal'] },
    { m: 'buzurgon ke liye kya karoge?', intent: 'future' },
    { m: 'achha kaam kiya hai', intent: 'positive' },
    { m: 'pakka vote denge', intent: 'commit', has: ['Dada ji'] }
], after: (u) => { check('[elder] age 70 + male remembered', u.memory.age === 70 && u.memory.gender === 'M'); } });

C.push({ name: 'taunt-to-commit', mode: 'brain', turns: [
    { m: '40 saal me kya kiya kuch nahi kiya', intent: 'taunt', has: ['gali/ward', 'ward'] },
    { m: 'ward 9', intent: 'gave_ward', has: ['98'] },
    { m: 'hamare yahan naali ka bura haal hai, gandagi hai', intent: 'complaint' },
    { m: 'theek hai' },
    { m: 'naali wali baat yaad hai?', intent: 'memory_check', has: ['naali'] },
    { m: 'chalo vote denge', intent: 'commit' }
], after: (u) => { check('[taunt] objection remembered', u.memory.objections.length >= 1); check('[taunt] drainage concern at ward 9', u.memory.concerns.some(c => c.topic === 'drainage' && c.ward === 9)); } });

C.push({ name: 'opponent-pivot', mode: 'brain', turns: [
    { m: 'dusra candidate bolta hai abhay singh ne kuch nahi kiya', intent: 'opponent', has: ['samman', 'bura nahi'] },
    { m: 'aur kya kaam kiya?', intent: 'works' },
    { m: 'school ka kya kiya?', has: ['library', 'school'] },
    { m: 'library kahan hai?' },
    { m: 'vote soch ke denge', intent: 'undecided' },
    { m: 'ok' }
], after: (u, rs) => {
    const told = u.memory.toldItems;
    check('[opponent] no work told twice', new Set(told).size === told.length);
} });

C.push({ name: 'bribe-abuse-calm', mode: 'brain', turns: [
    { m: 'paisa doge kya vote ke', intent: 'bribe', has: ['kanoon'] },
    { m: 'daru milegi?', intent: 'bribe' },
    { m: 'bc bakwas band karo', intent: 'abuse' },
    { m: 'sorry gussa tha, sadak kharab hai', intent: 'complaint' },
    { m: 'ward 2', intent: 'gave_ward', has: ['95'] },
    { m: 'dhanyavad' }
] });

C.push({ name: 'stop-forever', mode: 'pipeline', consented: false, turns: [
    { m: 'ram ram' },
    { m: 'pani ki dikkat hai ward 3 me', has: ['paani', 'jal', 'nal', 'note'], not: /mukhya|Dhanyavad! 🙏 Bataiye/i },
    { m: 'STOP', has: ['faisla'] },
    { m: 'hello?', noReply: true },
    { m: 'kaam batao', noReply: true },
    { m: 'band', noReply: true }
], after: (u) => {
    check('[stop] opted out permanently', u.broadcastOptOut === true && u.consentStatus === 'REJECTED');
    check('[stop] planner blocks opted-out voter', planner.blockReason(u, new Date('2026-11-06T06:30:00Z')) === 'opted_out');
} });

C.push({ name: 'who-joke-offtopic', mode: 'brain', turns: [
    { m: 'tum kaun ho?', intent: 'who_are_you', has: ['Suman', 'automated'] },
    { m: 'joke sunao', intent: 'joke' },
    { m: 'modi ke baare me kya kehna hai', intent: 'off_topic', has: ['panchayat'] },
    { m: 'IPL match kaun jeetega', intent: 'off_topic' },
    { m: 'accha abhay singh ne kya kaam kiya', intent: 'works' },
    { m: 'aur joke sunao', intent: 'joke' }
] });

C.push({ name: 'was-sarpanch', mode: 'brain', turns: [
    { m: 'kya abhay singh pehle sarpanch the?', intent: 'was_sarpanch', hasAll: ['nahi', 'pratinidhi'] },
    { m: 'to kaam kisne karwaye?' },
    { m: 'Abhay singh kaun hai?', intent: 'about_baba', has: ['40 saal'] },
    { m: 'अभय सिंह जी पहले सरपंच रहे थे क्या?', intent: 'was_sarpanch', has: ['नहीं'] },
    { m: 'अच्छा काम किया है', intent: 'positive' },
    { m: 'ठीक है' }
] });

C.push({ name: 'polling-booth-family', mode: 'brain', turns: [
    { m: 'vote kab hai?', intent: 'polling', hasAll: ['16 November', '7:30'] },
    { m: 'ward 7', intent: 'gave_ward', has: ['97'] },
    { m: 'booth kaun sa hai?', intent: 'polling', has: ['97'] },
    { m: 'pakka vote denge', intent: 'commit' },
    { m: 'ghar ke 5 vote hain', intent: 'family_votes', has: ['5'] },
    { m: 'dhanyavad' }
], after: (u) => { check('[polling] family votes 5', u.memory.familyVotes === 5); check('[polling] ward 7', u.memory.ward === 7 || u.ward === 7); } });

C.push({ name: 'repeat-question-stress', mode: 'brain', turns: [
    { m: 'kya kaam kiya?' }, { m: 'kya kaam kiya?' }, { m: 'kya kaam kiya?' }, { m: 'kya kaam kiya?' }, { m: 'kya kaam kiya?' }, { m: 'kya kaam kiya?' }
], after: (u, rs) => {
    const all = rs.map(r => replyQuality.normalize(r.reply));
    check('[repeat-stress] all 6 replies distinct', new Set(all).size === all.length);
} });

C.push({ name: 'greeting-loop', mode: 'brain', turns: [
    { m: 'ram ram' }, { m: 'ram ram' }, { m: 'ram ram' }, { m: 'hello' }, { m: 'namaste' }, { m: 'ram ram' }
] });

C.push({ name: 'cc-held', mode: 'brain', turns: [
    { m: 'hamari gali me interlocking kab lagegi?', has: ['jaanch', 'note', 'verify'], not: /\b45\b/ },
    { m: 'cc road ka kya hua?', not: /\b45\b/ },
    { m: 'kitni cc sadkein bani?', not: /\b\d{2}\+?\s*(cc|sadk)/i },
    { m: 'ward 1', has: ['95'] },
    { m: 'theek hai' },
    { m: 'pakka vote denge', intent: 'commit' }
] });

C.push({ name: 'hindi-health', mode: 'brain', turns: [
    { m: 'अस्पताल में डॉक्टर नहीं आता', intent: 'complaint', has: ['डॉक्टर'] },
    { m: 'वार्ड 10', intent: 'gave_ward', has: ['98'] },
    { m: 'एम्बुलेंस की सुविधा होगी?', has: ['एम्बुलेंस'] },
    { m: 'दवाई बहुत महंगी है', has: ['दवा', 'औषधि'] },
    { m: 'अच्छा' },
    { m: 'पक्का वोट देंगे', intent: 'commit' }
] });

C.push({ name: 'youth-sports', mode: 'brain', turns: [
    { m: 'main student hu, khel ka maidan chahiye', has: ['khel', 'maidan', 'gym', 'track'] },
    { m: 'library hai kya?', has: ['library'] },
    { m: 'naukri ka kya?' },
    { m: 'gym kahan hai?', has: ['gym'] },
    { m: 'achha hai', intent: 'positive' },
    { m: 'dosto ko bhi bolunga, vote pakka', intent: 'commit' }
], after: (u) => { check('[youth] age group young', u.memory.ageGroup === 'young'); } });

C.push({ name: 'farmer-haryanvi', mode: 'brain', turns: [
    { m: 'mhara gaam sihali kalan se hu, kisan hu' },
    { m: 'khaad beej ki dikkat ghani hai', has: ['kisan seva', 'khaad'] },
    { m: 'patwari ke chakkar lagane padte hain', has: ['patwar'] },
    { m: 'johad ka kya hua?', has: ['johad'] },
    { m: 'thik se' },
    { m: 'vote pakka', intent: 'commit' }
], after: (u) => { check('[farmer] dialect haryanvi', u.memory.dialect === 'haryanvi'); check('[farmer] village sihali_kalan', u.memory.village === 'sihali_kalan'); } });

C.push({ name: 'family-members', mode: 'brain', turns: [
    { m: 'meri patni aur mera beta bhi vote denge' },
    { m: 'ghar ke 6 vote hain', has: ['6'] },
    { m: 'ward 4', has: ['96'] },
    { m: 'booth kaun sa?', has: ['96'] },
    { m: 'parchi chahiye', intent: 'voter_slip' },
    { m: 'dhanyavad' }
], after: (u) => {
    const rels = u.memory.family.map(f => f.relation);
    check('[family] wife + son remembered', rels.includes('wife') && rels.includes('son'));
    check('[family] family votes 6', u.memory.familyVotes === 6);
} });

C.push({ name: 'stub-llm-good-context', mode: 'brain', llm: goodLLM, turns: [
    { m: 'ram ram' },
    { m: 'main ward 6 se hu' },
    { m: 'hamari gali me naali tooti hai' },
    { m: 'abhay singh ne kya kaam kiya?' },
    { m: 'abhi soch rahe hain' },
    { m: 'naali wali baat yaad hai?', has: ['naali'] }
], after: (u, rs) => {
    check('[llm-good] LLM wrote replies (source llm)', rs.filter(r => r.r && r.r.source === 'llm').length >= 3);
    const last = prompts[prompts.length - 1] || { sys: '' };
    check('[llm-good] prompt carries memory card with the concern', /concerns: .*drainage/.test(last.sys));
    check('[llm-good] prompt carries retrieved fact lines', /\[(DONE|FUTURE SANKALP)\]/.test(prompts.map(p => p.sys).join('\n')));
    check('[llm-good] prompt carries last turns as history', Array.isArray(last.history) && last.history.length >= 4);
} });

C.push({ name: 'stub-llm-bad-rejected', mode: 'brain', llm: badLLM, turns: [
    { m: 'abhay singh ne kya kaam kiya?' },
    { m: 'aage kya karoge?' },
    { m: 'abhay singh kaun hai?' },
    { m: 'sadak kharab hai' },
    { m: 'soch rahe hain' },
    { m: 'dusra candidate kaisa hai?' }
], after: (u, rs) => {
    check('[llm-bad] every bad LLM output rejected', rs.every(r => r.r && /llm_rejected/.test(r.r.source)));
} });

C.push({ name: 'stub-llm-json-extract', mode: 'brain', llmJson: async (prompt) => /Mahesh/.test(prompt) ? '{"name":"Mahesh","gender":"M","dialect":"haryanvi","ageGroup":"middle"} trailing' : 'not json', turns: [
    { m: 'mhare ghar me sab Mahesh ke kehne pe chalte hain, wo main hi hu' },
    { m: 'ram ram', has: ['Mahesh'] },
    { m: 'pani ki dikkat hai' },
    { m: 'ward 11', has: ['98'] },
    { m: 'theek hai' },
    { m: 'vote denge', intent: 'commit', has: ['Mahesh'] }
], after: (u) => { check('[llm-json] name merged from LLM extraction', u.memory.name === 'Mahesh' && u.memory.extractedBy === 'rules+llm'); check('[llm-json] honorific uses male middle-age (Tau ji)', /Tau ji/.test(u.history.map(h => h.text).join(' '))); } });

C.push({ name: 'rolling-summary', mode: 'brain', llm: goodLLM, turns: [
    { m: 'ram ram' }, { m: 'main ward 3 se hu' }, { m: 'bijli ke khambe toote hain' }, { m: 'school ka kya kiya' }, { m: 'gym hai kya' },
    { m: 'mokshdham ka kya hua' }, { m: 'johad ka kya hua' }, { m: 'aage kya karoge' }, { m: 'cctv lagega?' }, { m: 'soch rahe hain' },
    { m: 'patwar ghar kab banega' }, { m: 'ambulance hai?' }, { m: 'meri bijli wali baat yaad hai?', has: ['light', 'bijli', 'road light'] }
], after: (u) => {
    check('[summary] older turns folded into rolling summary', u.memory.summaryLines.length >= 2 && /ward 3/.test(voterMemory.summaryText(u)));
    check('[summary] prompt includes OLDER CONVERSATION SUMMARY', /OLDER CONVERSATION SUMMARY/.test(prompts[prompts.length - 1].sys));
} });

C.push({ name: 'planner-followups', mode: 'brain', turns: [
    { m: 'main ward 8 se hu' },
    { m: 'hamare ward me sadak kab banegi?' },
    { m: 'abhay singh ne kya kiya' },
    { m: 'theek hai pakka vote denge' },
    { m: 'ghar ke 3 vote hain', has: ['3'] },
    { m: 'dhanyavad' }
], after: async (u) => {
    Object.assign(u, { consented: true, consentStatus: 'ACCEPTED', autoPilot: true, assignedLine: 'sim_636' });
    const day = new Date('2026-11-06T06:30:00Z'); // 12:00 IST
    u.memory.proactive.lastUserAt = new Date(day.getTime() - 5 * 3600e3).toISOString();
    u.memory.openFollowUp.dueAt = new Date(day.getTime() - 3600e3).toISOString();
    check('[planner] eligible at 12:00 IST', planner.blockReason(u, day) === null);
    const plan = planner.planFor(u, { now: day });
    check('[planner] follow-up references the concern + ward', plan && plan.kind === 'concern_followup' && /ward 8/.test(plan.text) && /sadak/.test(plan.text));
    check('[planner] quiet hours (22:00 IST) block', planner.blockReason(u, new Date('2026-11-06T16:30:00Z')) === 'quiet_hours');
    check('[planner] silence period (14 Nov 18:00 IST) blocks', planner.blockReason(u, new Date('2026-11-14T12:31:00Z')) === 'silence_period');
    check('[planner] 13:00 IST on 14 Nov still allowed', planner.blockReason(u, new Date('2026-11-14T07:30:00Z')) === null);
    const sent = [];
    const res1 = await planner.runCycle({ users: [u], lineId: 'sim_636', now: day, send: async (x, t) => sent.push(t) });
    check('[planner] runCycle sent 1', res1.sent === 1 && sent.length === 1);
    const res2 = await planner.runCycle({ users: [u], lineId: 'sim_636', now: new Date(day.getTime() + 3 * 3600e3), send: async (x, t) => sent.push(t) });
    check('[planner] max 1 per voter per day', res2.sent === 0 && res2.skipped.daily_limit === 1);
    u.memory.proactive.lastUserAt = new Date(day.getTime() - 30 * 3600e3).toISOString();
    const d2 = new Date(day.getTime() + 24 * 3600e3);
    await planner.runCycle({ users: [u], lineId: 'sim_636', now: d2, send: async (x, t) => sent.push(t) });
    const d3 = new Date(day.getTime() + 48 * 3600e3);
    const res3 = await planner.runCycle({ users: [u], lineId: 'sim_636', now: d3, send: async (x, t) => sent.push(t) });
    check('[planner] stops after 2 unanswered', res3.sent === 0 && res3.skipped.unanswered_limit === 1 && sent.length === 2);
    check('[planner] day-2 message is the poll reminder with booth 97 + family votes', /97/.test(sent[1]) && /3 vote/.test(sent[1]));
    check('[planner] proactive texts pass hard rules', sent.every(t => HARD.every(([, rx]) => !rx.test(t))));
    voterMemory.updateFromVoterMessage(u, 'haan ji', {});
    check('[planner] voter reply resets unanswered counter', u.memory.proactive.unanswered === 0);
    const res4 = await planner.runCycle({ users: [u], lineId: 'other_line', now: d3, send: async () => {} });
    check('[planner] sticky line: other line never messages this voter', res4.sent === 0);
} });

C.push({ name: 'consent-substantive-first-reply', mode: 'pipeline', consented: false, turns: [
    { m: 'ram ram' },
    { m: 'sadak tooti hai ward 6 me, kab banegi?', has: ['sadak', 'note', 'priority'], not: /बताइए—अपनी मतदाता पर्ची/ },
    { m: 'aur pani ka kya?' },
    { m: 'aage kya karoge?' },
    { m: 'soch ke batayenge' },
    { m: 'ok' }
], after: (u) => { check('[consent] accepted via substantive reply', u.consentStatus === 'ACCEPTED' && u.memory.concerns.some(c => c.topic === 'road' && c.ward === 6)); } });

C.push({ name: 'script-switching', mode: 'brain', turns: [
    { m: 'ram ram' }, { m: 'पानी की टंकी कब बनेगी?' }, { m: 'school ka kya hua' }, { m: 'स्कूल में क्या काम हुआ' }, { m: 'ok thik hai' }, { m: 'धन्यवाद' }
] });

C.push({ name: 'unclear-clarify', mode: 'brain', turns: [
    { m: 'asdf qwer zxcv lorem ipsum dolor sit amet blah' }, { m: 'qqq www eee rrr ttt yyy uuu iii ooo ppp' }, { m: 'paani' }, { m: 'ward 2' }, { m: 'ok' }, { m: 'zzz xxx ccc vvv bbb nnn mmm lll kkk' }
] });

C.push({ name: 'committed-no-double-family-ask', mode: 'brain', turns: [
    { m: 'pakka vote denge', intent: 'commit', has: ['kitne vote'] },
    { m: 'ram ram' },
    { m: 'haan pakka saath hain', intent: 'commit', not: /kitne vote/ },
    { m: 'joke sunao' },
    { m: 'vote kab hai', intent: 'polling' },
    { m: 'aapke saath hain', intent: 'commit', not: /kitne vote/ }
] });

// Self-test harness with two fake lines (target = sim_636 runs the pipeline; tester = canada only captures)
C.push({ name: 'live-self-test-harness', special: true, run: async () => {
    const target = new FakeSock('sim_636', '916367810227');
    const tester = new FakeSock('canada', '14502790497');
    const SESSIONS = [{ id: 'sim_636', status: 'CONNECTED', sock: target }, { id: 'canada', status: 'CONNECTED', sock: tester }];
    const st = new LiveSelfTest({ getSessions: () => SESSIONS, lineContacts: engagementPolicy.LINE_CONTACTS, userMemory, sendText: (sock, jid, text) => sock.sendMessage(jid, { text }), resultsDir: path.join(os.tmpdir(), 'st_runs_test') });
    let testerBrainCalls = 0, targetBrainCalls = 0;
    // inbound handler per line (what server.js does before any brain work)
    const inbound = async (sessionId, fromPhone, text) => {
        const route = st.route(sessionId, [fromPhone]);
        if (route === 'capture') { st.capture(sessionId, text); return; }
        if (route === 'ignore_own') return;
        if (route === 'voter') st.prepareRecord(fromPhone);
        if (sessionId === 'canada') testerBrainCalls++; else targetBrainCalls++;
        await pipelineTurn(SESSIONS.find(s => s.id === sessionId).sock, fromPhone, text);
    };
    tester.onSend = (jid, c) => { if (jid.startsWith('916367810227')) inbound('sim_636', '14502790497', c.text); };
    target.onSend = (jid, c) => { if (jid.startsWith('14502790497')) inbound('canada', '916367810227', c.text); };
    // 1) loop guard outside a run
    await inbound('sim_636', '14502790497', 'ram ram');
    await inbound('canada', '916367810227', 'ram ram');
    check('[self-test] outside a run own lines ignore each other', target.sent.length === 0 && tester.sent.length === 0 && targetBrainCalls === 0 && testerBrainCalls === 0);
    // 2) a real run
    const script = ['Ram ram', 'main ward 5 Sihali Khurd se hu || ward 5, 96', 'hamare ward me sadak tooti hai', 'Abhay singh ne pani ke liye kya kiya?', 'hmm soch ke batayenge', 'meri sadak wali baat yaad hai? || sadak'];
    st.start({ testerLine: 'canada', targetLine: 'sim_636', script, replyTimeoutMs: 3000, settleMs: 150, gapMs: 10 });
    for (let i = 0; i < 200 && st.isActive(); i++) await new Promise(r => setTimeout(r, 50));
    const s = st.status();
    if (PRINT) console.log(st.toMarkdown(st.run));
    check('[self-test] run finished', ['passed', 'failed'].includes(s.status));
    check('[self-test] 6 turns recorded with replies', s.turns.length === 6 && s.turns.every(t => t.replies.length >= 1));
    check('[self-test] all turn checks passed', s.status === 'passed' && s.failed === 0);
    check('[self-test] context check present and passed on recall turn', s.turns[5].checks.referencesEarlierContext === true);
    check('[self-test] tester line never ran its brain', testerBrainCalls === 0);
    check('[self-test] target answered every scripted message', targetBrainCalls === 6);
    check('[self-test] markdown + json export', /Live Self-Test/.test(st.toMarkdown(st.run)) && st.toJSON(st.run).turns.length === 6);
    check('[self-test] temporary tester voter record removed', !userMemory.users['14502790497']);
    // 3) after the run the guard is back
    const before = target.sent.length;
    await inbound('sim_636', '14502790497', 'ram ram again');
    check('[self-test] after the run own lines ignored again', target.sent.length === before);
    check('[self-test] rejects same line as tester and target', (() => { try { st.start({ testerLine: 'canada', targetLine: 'canada' }); return false; } catch (e) { return true; } })());
} });

C.push({ name: 'self-test-detects-failures', special: true, run: async () => {
    // A target that repeats itself and quotes a budget must fail the checks.
    const target = new FakeSock('sim_636', '916367810227');
    const tester = new FakeSock('canada', '14502790497');
    const SESSIONS = [{ id: 'sim_636', status: 'CONNECTED', sock: target }, { id: 'canada', status: 'CONNECTED', sock: tester }];
    const st = new LiveSelfTest({ getSessions: () => SESSIONS, lineContacts: engagementPolicy.LINE_CONTACTS, userMemory, resultsDir: path.join(os.tmpdir(), 'st_runs_test') });
    let n = 0;
    tester.onSend = (jid) => { n++; const text = n === 3 ? null : (n >= 4 ? 'Sadak par 5 lakh lage.' : 'Same canned reply every time, nothing else to say here.'); if (text) target.sendMessage('14502790497@s.whatsapp.net', { text }); };
    target.onSend = (jid, c) => { if (st.route('canada', ['916367810227']) === 'capture') st.capture('canada', c.text); };
    st.start({ testerLine: 'canada', targetLine: 'sim_636', script: ['a1 hello', 'a2 hello', 'a3 hello', 'a4 hello', 'a5 hello', 'a6 hello || sadak'], replyTimeoutMs: 400, settleMs: 100, gapMs: 5 });
    for (let i = 0; i < 200 && st.isActive(); i++) await new Promise(r => setTimeout(r, 30));
    const s = st.status();
    check('[self-test-fail] run marked failed', s.status === 'failed');
    check('[self-test-fail] repeat detected on turn 2', s.turns[1].checks.noRepeat === false);
    check('[self-test-fail] timeout detected on turn 3', s.turns[2].checks.repliedWithin60s === false);
    check('[self-test-fail] budget claim detected on turn 4', s.turns[3].checks.noBannedClaims === false);
} });

// ---------------- knowledge-base unit checks ----------------
function kbChecks() {
    const items = kb.load().items;
    check('[kb] 12 major + 15 future + category items loaded', items.filter(i => i.kind === 'major').length === 12 && items.filter(i => i.kind === 'sankalp').length === 15 && items.filter(i => i.kind === 'detail').length > 50);
    check('[kb] no rupee/budget figure in any item', items.every(i => !/(₹|रुपये|रुपए|लाख|करोड़)/.test(i.text)));
    check('[kb] CC/interlocking lanes are held', items.filter(i => i.category === 'interlocking_cc_sadak').every(i => i.held) && kb.getItem('M10').held);
    check('[kb] conflicting Gayasi Ram road item is held', items.some(i => /गयासी राम/.test(i.text) && i.held));
    check('[kb] held items never rendered with details', kb.render(kb.getItem('M10'), 'hi').includes('जाँच') && !/45/.test(kb.render(kb.getItem('M10'), 'en')));
    const r1 = kb.retrieve('pani ki dikkat hai hadahedi me');
    check('[kb] water query -> JJM item first', r1[0] && r1[0].topics.includes('water'));
    const r2 = kb.retrieve('doctor nahi aata hospital me');
    check('[kb] health query -> health items', r2.slice(0, 3).every(i => i.topics.some(t => ['health', 'ambulance', 'medicine', 'animal'].includes(t))));
    const r3 = kb.retrieve('aage kya karoge', { type: 'future' });
    check('[kb] future query -> sankalp items', r3.length >= 3 && r3.every(i => i.type === 'future'));
    const r4 = kb.retrieve('मोक्षधाम का काम');
    check('[kb] Hindi synonym retrieval (मोक्षधाम)', r4[0] && r4[0].topics.includes('cremation'));
    check('[kb] retrieve returns 1-5 items', [r1, r2, r3, r4].every(r => r.length >= 1 && r.length <= 5));
    check('[kb] village detection (Haraheri/बड़ी सिहाली)', kb.detectVillages('haraheri').includes('hadahedi') && kb.detectVillages('बड़ी सिहाली').includes('sihali_kalan'));
    check('[kb] sanitize strips budgets', kb.sanitize('सड़क 5 लाख रुपये में बनी') === 'सड़क में बनी' || !/लाख/.test(kb.sanitize('सड़क 5 लाख रुपये में बनी')));
    // every rendered fact line in Hindi comes verbatim from a sheet item
    const sample = items.filter(i => !i.held && i.kind !== 'detail').map(i => kb.render(i, 'hi').replace(/^संकल्प: /, '').replace(/…$/, '').slice(0, 40));
    check('[kb] Hindi renders are sheet text', sample.every(s => ALL_FACT_TEXT.includes(s.toLowerCase())));
    // legacy backstop neutralised
    const legacy = aiService.getFastLocalAnswer('sankalp batao aage kya karoge', '919999000111') + aiService.getFastLocalAnswer('shubh ratri', '919999000111');
    check('[legacy] getFastLocalAnswer no longer quotes counts or "बाबा जी"', !/\d+\s*(प्रमुख संकल्प|mukhya sankalp)/i.test(legacy) && !/(बाबा जी|\bbaba ji\b)/i.test(legacy));
    delete userMemory.users['919999000111'];
}

(async () => {
    kbChecks();
    let i = 0;
    for (const spec of C) {
        i++;
        if (spec.special) await spec.run(); else await runConversation(i, spec);
    }
    const convs = C.length;
    const minTurns = Math.min(...C.filter(c => !c.special).map(c => c.turns.length));
    check(`suite has >= 25 conversations (${convs})`, convs >= 25);
    check(`every scripted conversation has >= 6 turns (min ${minTurns})`, minTurns >= 6);
    console.log(`\nConversations: ${convs} (min turns ${minTurns})`);
    console.log(`RESULT ${passed} passed, ${failed} failed`);
    if (failed) { console.log('Failures:\n - ' + fails.join('\n - ')); process.exitCode = 1; }
})().catch(e => { console.error(e); process.exitCode = 1; });
