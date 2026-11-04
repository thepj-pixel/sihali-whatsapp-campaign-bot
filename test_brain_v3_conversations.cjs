// Brain v3 — offline multi-turn suite (no network, no LLM keys).
// 44 scripted conversations (each >= 6 turns) through reply_brain.respond / ai_assistant_service.getAIResponse.
// Covers: samasya logging (asserting the stored records), mulaqat / ghar-visit requests (stored records), greetings,
// who-are-you, abuse/anger, daaru/paise, opponent supporters, undecided, committed (family votes + slip + booth),
// slip asks, media/voice/sticker, wrong number, elders, women, youth, daily life (health, crops, family, weather,
// festivals), condolence, ballot/symbol, "yaad hai?" memory, lane landmarks, the planner's next action, and the
// hard rules on every single reply.
// Usage: npm run test:brainv3   (add --print to see every dialogue)
const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.SAMASYA_PATH = path.join(os.tmpdir(), `v3_samasya_${process.pid}.json`);
process.env.MULAQAT_PATH = path.join(os.tmpdir(), `v3_mulaqat_${process.pid}.json`);
const userMemory = require('./user_memory.js');
userMemory.save = () => {};
const brain = require('./reply_brain.js');
const aiService = require('./ai_assistant_service.js');
const replyQuality = require('./reply_quality.js');
const planner = require('./followup_planner.js');
const flows = require('./conversation_flows.js');
const kb = require('./knowledge_base.js');
const samasya = require('./samasya_store.js');
const mulaqat = require('./mulaqat_store.js');

const PRINT = process.argv.includes('--print');
let passed = 0, failed = 0;
const fails = [];
function check(name, cond) { if (cond) passed++; else { failed++; fails.push(name); console.error('FAIL ' + name); } }

const HARD = [
    ['बाबा जी alone', /(बाबा जी|बाबाजी|\bbaba ji\b|\bbabaji\b)/i],
    ['sarpanch-before claim', brain.SARPANCH_CLAIM],
    ['money/budget', /(₹|रुपये|रुपए|लाख|करोड़|\blakh\b|crore|budget|बजट|लागत)/i],
    ['work count', /\d+\s*\+?\s*(काम|कार्य|संकल्प|सड़कें|kaam|sankalp|cc sadk)/i],
    ['caste/religion', /(हिंदू|मुसलमान|जाति|\bjaat\b|जाट|गुर्जर|मेघवाल|ब्राह्मण|dharm ke naam)/i],
    ['threat/bribe offer', /(धमकी|dhamki|देख लेंगे|अंजाम|paise denge|पैसे देंगे|दारू देंगे|daru denge)/i],
    ['opponent attack', /(वो चोर|wo chor|उनके झूठ|kis bil me|किस बिल में|बिकाऊ|bikau|nikamme|निकम्मे)/i],
    ['fake slip delivery', /(पर्ची भेज दी|parchi bhej di)/i],
    ['election symbol', /(चुनाव चिन्ह|स्वस्तिक|卐|swastik|symbol)/i],
    ['promised date/fix', brain.PROMISED_DATE],
    ['confirmed on his behalf', /(मुलाक़ात पक्की हो गई|mulaqat pakki ho gayi|baba aa jayenge|अभय सिंह जी आ जाएँगे|abhay singh ji aa jayenge|wo zaroor aayenge|वो ज़रूर आएँगे)/i],
    ['Gayasi Ram road (not on parcha)', /(गयासी|gayasi)/i],
    ['old electorate figure', /3,?570/]
];

function globalChecks(tag, msg, reply, prev) {
    for (const [name, rx] of HARD) check(`${tag} no ${name}`, !rx.test(reply));
    check(`${tag} length <= 480`, reply.length <= 480);
    check(`${tag} at most one question`, (reply.match(/\?/g) || []).length <= 1);
    if (prev) check(`${tag} not a repeat of previous bot reply`, replyQuality.normalize(reply) !== replyQuality.normalize(prev));
    if (/[a-z\u0900-\u097F]/i.test(msg) && !brain.MEDIA_RX.test(msg.trim())) {
        const hi = /[\u0900-\u097F]/.test(msg);
        check(`${tag} script follows voter (${hi ? 'Devanagari' : 'Hinglish'})`, hi ? /[\u0900-\u097F]/.test(reply) : !/[\u0900-\u097F]/.test(reply));
    }
}

let seq = 0;
function freshUser(extra = {}) {
    const phone = '9177' + String(10000000 + (++seq));
    delete userMemory.users[phone];
    const u = userMemory.getUser(phone);
    Object.assign(u, { consented: true, consentStatus: 'ACCEPTED', autoPilot: true, contactCardSent: true, history: [], context: {} }, extra);
    return u;
}

async function runConversation(n, spec) {
    const u = freshUser(spec.user || {});
    const replies = [];
    let prev = null;
    if (PRINT) console.log(`\n=== ${n}. ${spec.name} ===`);
    for (let i = 0; i < spec.turns.length; i++) {
        const t = spec.turns[i];
        u.history.push({ role: 'user', text: t.m, createdAt: Date.now() + i * 10 });
        let r;
        if (spec.pipeline) {
            const text = await aiService.getAIResponse(t.m, null, [], u.phone, { line: 'sim_636', test: !!u.selfTest });
            r = { text, intent: (aiService.getLastBrainResult() || {}).intent, source: (aiService.getLastBrainResult() || {}).source };
        } else {
            r = await brain.respond(t.m, u, { llm: spec.llm || null, meta: { line: 'sim_636' } });
        }
        u.history.push({ role: 'bot', text: r.text, createdAt: Date.now() + i * 10 + 5 });
        replies.push({ m: t.m, reply: r.text, r });
        if (PRINT) console.log(`> ${t.m}\n  [${r.intent}|${r.source}] ${r.text}`);
        const tag = `[${spec.name} t${i + 1}]`;
        check(`${tag} got a reply`, typeof r.text === 'string' && r.text.length > 0);
        globalChecks(tag, t.m, r.text, prev);
        if (t.intent) check(`${tag} intent ${t.intent} (got ${r.intent})`, r.intent === t.intent);
        if (t.has) check(`${tag} mentions one of ${JSON.stringify(t.has)}`, t.has.some(x => r.text.toLowerCase().includes(String(x).toLowerCase())));
        if (t.hasAll) check(`${tag} mentions all of ${JSON.stringify(t.hasAll)}`, t.hasAll.every(x => r.text.toLowerCase().includes(String(x).toLowerCase())));
        if (t.not) check(`${tag} does not match ${t.not}`, !t.not.test(r.text));
        if (t.noVoteAsk) check(`${tag} no vote ask here`, !/(साथ देंगे ना|वोट देंगे ना|saath denge na|vote denge na)/i.test(r.text));
        prev = r.text;
    }
    if (spec.after) await spec.after(u, replies);
}

const recs = (u, store) => store.list({ phone: u.phone, includeTest: true });
const C = [];

// ---------------- SAMASYA ----------------
C.push({ name: 'samasya-naali-hinglish', turns: [
    { m: 'Ram ram', intent: 'greeting' },
    { m: 'hamare yahan naali ka ganda pani bhar jata hai', intent: 'complaint', has: ['note'], not: /(jaldi|turant) (ban|theek)/i },
    { m: 'ward 5 me shiv mandir wali gali', has: ['ward 5', 'kab se'] },
    { m: '2 mahine se', hasAll: ['darj', 'Abhay Singh ji tak pahuncha di hai'], has: ['ghar bulana'] },
    { m: 'nahi abhi nahi', has: ['koi baat nahi'], noVoteAsk: true },
    { m: 'dhanyavad' }
], after: (u) => {
    const r = recs(u, samasya);
    check('[samasya-naali] one record stored', r.length === 1);
    const x = r[0] || {};
    check('[samasya-naali] category naali, ward 5, since, place', x.category === 'naali' && x.ward === 5 && /2 mahine/.test(x.since || '') && /shiv mandir/i.test(x.location || ''));
    check('[samasya-naali] linked to sankalp F5, status new, phone + line + IST time', x.sankalpId === 'F5' && x.status === 'new' && x.phone === u.phone && x.line === 'sim_636' && /IST/.test(x.createdAtIST));
    check('[samasya-naali] flow closed + no mulaqat after decline', !flows.inFlow(u) && recs(u, mulaqat).length === 0);
} });

C.push({ name: 'samasya-pani-hindi-then-visit', user: { pushName: 'Ramesh' }, turns: [
    { m: 'राम राम जी', intent: 'greeting' },
    { m: 'हमारे यहाँ पानी की बहुत दिक्कत है', intent: 'complaint', has: ['पानी'] },
    { m: 'वार्ड 9', has: ['कब से', '98'] },
    { m: 'एक साल से', has: ['दर्ज'], hasAll: ['घर बुलाना'] },
    { m: 'हाँ ज़रूर', has: ['दिन और समय'] },
    { m: 'कल सुबह 10 बजे', has: ['पता', 'पहचान'] },
    { m: 'शिव मंदिर के पास', has: ['कितने लोग'] },
    { m: 'घर पर 6 लोग होंगे', hasAll: ['टीम', 'फ़ोन'], not: /(पक्की हो गई|confirm)/i }
], after: (u) => {
    const s = recs(u, samasya)[0] || {};
    check('[pani-visit] samasya paani ward 9 hadahedi + F2', s.category === 'paani' && s.ward === 9 && s.village === 'hadahedi' && s.sankalpId === 'F2' && /एक साल/.test(s.since || ''));
    const m = recs(u, mulaqat)[0] || {};
    check('[pani-visit] mulaqat requested with when/date/place/family/purpose', m.status === 'requested' && /कल सुबह 10 बजे/.test(m.preferredWhen || '') && /^2026-\d\d-\d\d$/.test(m.preferredDate || '') && /शिव मंदिर/.test(m.place || '') && m.familyMembers === 6 && /S-\d{4}/.test(m.purpose || '') && m.samasyaId === s.id);
} });

C.push({ name: 'samasya-explicit-no-topic', turns: [
    { m: 'ek shikayat darj karni hai', intent: 'samasya_explicit', has: ['kya dikkat'] },
    { m: 'hamare mohalle me koi safai karne nahi aata', has: ['note'] },
    { m: 'ward 6 sihali kalan', has: ['kab se'] },
    { m: 'kaafi time se', has: ['darj'] },
    { m: 'ok' },
    { m: 'theek hai' }
], after: (u) => {
    const s = recs(u, samasya)[0] || {};
    check('[explicit] safai record ward 6 sihali kalan + F5', s.category === 'safai' && s.ward === 6 && s.village === 'sihali_kalan' && s.sankalpId === 'F5' && /kaafi time/.test(s.since || ''));
} });

C.push({ name: 'samasya-park-and-resume', turns: [
    { m: 'naali band padi hai', intent: 'complaint', has: ['ward'] },
    { m: 'abhay singh ne kya kaam kiya?', intent: 'works' },
    { m: 'ward 4', has: ['kab se', '96'] },
    { m: '3 hafte se', has: ['darj'] },
    { m: 'nahi', has: ['koi baat nahi'] },
    { m: 'ok' }
], after: (u) => {
    const s = recs(u, samasya)[0] || {};
    check('[park-resume] one record, ward 4, since 3 hafte', recs(u, samasya).length === 1 && s.ward === 4 && /3 hafte/.test(s.since || ''));
} });

C.push({ name: 'samasya-pension-personal', turns: [
    { m: 'meri pension 3 mahine se nahi aa rahi', intent: 'complaint', has: ['ward se'] },
    { m: 'ward 10 hadahedi', has: ['darj'] },
    { m: 'haan', has: ['din'] },
    { m: 'ravivar shaam', has: ['pata'] },
    { m: 'school ke paas', has: ['kitne log'] },
    { m: '3', has: ['team'] }
], after: (u) => {
    const s = recs(u, samasya)[0] || {};
    check('[pension] category pension, no sankalp invented, since from first msg', s.category === 'pension' && !s.sankalpId && /3 mahine/.test(s.since || ''));
    const m = recs(u, mulaqat)[0] || {};
    check('[pension] visit: ravivar shaam, school ke paas, 3 family', /ravivar/i.test(m.preferredWhen || '') && /school/.test(m.place || '') && m.familyMembers === 3);
} });

C.push({ name: 'samasya-ration-no-sankalp', turns: [
    { m: 'rashan nahi mil raha do mahine se', intent: 'complaint' },
    { m: 'ward 1', has: ['darj'] },
    { m: 'nahi', noVoteAsk: true },
    { m: 'aage kya karoge?', intent: 'future' },
    { m: 'achha', },
    { m: 'pakka vote denge', intent: 'commit' }
], after: (u) => { const s = recs(u, samasya)[0] || {}; check('[ration] logged, no sankalp', s.category === 'ration' && !s.sankalpId && s.ward === 1); } });

C.push({ name: 'samasya-patwari', turns: [
    { m: 'patwari ke chakkar lagane padte hain namantaran ke liye', intent: 'complaint', has: ['zameen'] },
    { m: 'ward 8', has: ['kab se'] },
    { m: 'saal bhar se', hasAll: ['patwar ghar'] },
    { m: 'nahi abhi nahi' },
    { m: 'mundawar jana padta hai', },
    { m: 'dhanyavad' }
], after: (u) => { const s = recs(u, samasya)[0] || {}; check('[patwari] jameen_patwari + F10', s.category === 'jameen_patwari' && s.sankalpId === 'F10' && s.ward === 8); } });

C.push({ name: 'samasya-streetlight-woman', user: { pushName: 'Sunita Devi' }, turns: [
    { m: 'मैं सिहाली कलां से बोल रही हूँ', intent: 'introduce', has: ['बहन जी'] },
    { m: 'गली में अँधेरा रहता है, लाइट नहीं है', intent: 'complaint', has: ['बहन', 'अँधेरे'] },
    { m: 'वार्ड 7', has: ['कब से'] },
    { m: 'छह महीने से', has: ['रोड लाइट'] },
    { m: 'नहीं', has: ['कोई बात नहीं'] },
    { m: 'बेटियों की सुरक्षा का क्या?', has: ['CCTV'] }
], after: (u) => { const s = recs(u, samasya)[0] || {}; check('[streetlight] road_light + F4 + ward 7', s.category === 'road_light' && s.sankalpId === 'F4' && s.ward === 7); } });

C.push({ name: 'samasya-lane-landmark', turns: [
    { m: 'mahendra ke ghar ki or wali gali me interlocking toot gayi hai', intent: 'complaint', has: ['Mahendra'] },
    { m: '4 mahine se', has: ['darj'] },
    { m: 'nahi' },
    { m: 'aur kya kaam hua?', intent: 'works' },
    { m: 'theek hai' },
    { m: 'vote denge', intent: 'commit' }
], after: (u) => { const s = recs(u, samasya)[0] || {}; check('[lane] sadak + F6 + landmark place', s.category === 'sadak' && s.sankalpId === 'F6' && /mahendra/i.test(s.location || s.description)); } });

C.push({ name: 'samasya-abuse-then-problem', turns: [
    { m: 'bc kuch nahi karte tum log', intent: 'abuse', not: /(gaali|bewakoof)/i },
    { m: 'sorry gussa tha, gali me kichad hai', intent: 'complaint' },
    { m: 'ward 2', has: ['kab se'] },
    { m: 'barsaat se', has: ['darj'] },
    { m: 'ok' },
    { m: 'dhanyavad' }
], after: (u) => { const s = recs(u, samasya)[0] || {}; check('[abuse-problem] logged naali/sadak ward 2', !!s.id && s.ward === 2 && /barsaat/.test(s.since || '')); } });

C.push({ name: 'samasya-two-problems', turns: [
    { m: 'paani ki dikkat hai ward 3 me', intent: 'complaint', has: ['kab se'] },
    { m: '1 saal se', has: ['darj'] },
    { m: 'nahi' },
    { m: 'aur sadak bhi tooti hai', intent: 'complaint' },
    { m: 'ward 3 main road', has: ['kab se'] },
    { m: 'pata nahi', has: ['darj'] }
], after: (u) => { const r = recs(u, samasya); check('[two-problems] two records (paani, sadak)', r.length === 2 && r.some(x => x.category === 'paani') && r.some(x => x.category === 'sadak')); } });

C.push({ name: 'samasya-taunt-angry', turns: [
    { m: '40 saal me kya kiya?', intent: 'taunt', has: ['haq'] },
    { m: 'sab jhoothe ho', intent: 'taunt' },
    { m: 'hamare yahan to naali bhi nahi hai', intent: 'complaint' },
    { m: 'ward 10 hadahedi', has: ['kab se'] },
    { m: 'pata nahi', has: ['darj'] },
    { m: 'dekhte hain' }
], after: (u) => { check('[taunt] samasya stored for the angry voter', recs(u, samasya).length === 1); } });

// ---------------- MULAQAT ----------------
C.push({ name: 'mulaqat-direct-visit', turns: [
    { m: 'abhay singh ji se milna hai', intent: 'meeting', has: ['din aur samay'] },
    { m: 'parso shaam 5 baje', has: ['pata', 'pehchaan'] },
    { m: 'ward 3, school ke paas', has: ['kitne log'] },
    { m: '4 log', has: ['kis baare'] },
    { m: 'gaon ki sadak ke baare me', hasAll: ['team', 'phone'], not: /pakki ho gayi/i },
    { m: 'dhanyavad' }
], after: (u) => {
    const m = recs(u, mulaqat)[0] || {};
    check('[visit] record: visit/requested/parso/date/place/4/purpose', m.type === 'visit' && m.status === 'requested' && /parso/.test(m.preferredWhen) && /^2026-/.test(m.preferredDate || '') && /school/.test(m.place) && m.familyMembers === 4 && /sadak/.test(m.purpose));
    check('[visit] no duplicate request', recs(u, mulaqat).length === 1);
} });

C.push({ name: 'mulaqat-call-request', turns: [
    { m: 'baba se baat karao', intent: 'meeting', has: ['team', 'sampark'] },
    { m: 'nahi bas phone kar dena', has: ['phone'] },
    { m: 'theek hai' },
    { m: 'abhay singh ka number do', has: ['6367810227', 'pehle se'] },
    { m: 'ok' },
    { m: 'dhanyavad' }
], after: (u) => { const r = recs(u, mulaqat); check('[call] one call record requested', r.length === 1 && r[0].type === 'call' && r[0].status === 'requested'); } });

C.push({ name: 'mulaqat-offer-after-commit', turns: [
    { m: 'ram ram' },
    { m: 'main ward 7 se hu', intent: 'introduce', has: ['97'] },
    { m: 'abhay singh ne kya kiya?', intent: 'works' },
    { m: 'pakka vote denge', intent: 'commit', has: ['kitne vote'] },
    { m: 'ghar ke 5 vote', has: ['5 vote', 'ghar bulana'] },
    { m: 'haan bulayenge', has: ['din aur samay'] },
    { m: 'ravivar dopahar', has: ['pata'] }
], after: (u) => { const m = recs(u, mulaqat)[0] || {}; check('[offer-commit] familyVotes 5 + visit requested ravivar', u.memory.familyVotes === 5 && /ravivar/.test(m.preferredWhen || '')); check('[offer-commit] offer made only once', u.history.filter(h => h.role === 'bot' && /ghar bulana chahenge/i.test(h.text)).length === 1); } });

C.push({ name: 'mulaqat-skip-steps', turns: [
    { m: 'kabhi ghar aao', intent: 'meeting' },
    { m: 'kabhi bhi aa jao', has: ['pata'] },
    { m: 'pata nahi', has: ['kitne log'] },
    { m: '5', has: ['kis baare'] },
    { m: 'bas milna hai', has: ['team'] },
    { m: 'ok' }
], after: (u) => { const m = recs(u, mulaqat)[0] || {}; check('[skip] when kabhi bhi, family 5, purpose', /kabhi bhi/.test(m.preferredWhen || '') && m.familyMembers === 5 && /milna/.test(m.purpose || '')); } });

C.push({ name: 'mulaqat-hindi-chaupal', turns: [
    { m: 'चौपाल पर कब आओगे', intent: 'meeting', has: ['दिन'] },
    { m: 'शनिवार शाम', has: ['पता'] },
    { m: 'सीताराम मंदिर के सामने', has: ['कितने'] },
    { m: '10 लोग', has: ['किस बारे'] },
    { m: 'पूरे मोहल्ले से मिलना है', has: ['टीम'] },
    { m: 'धन्यवाद' }
], after: (u) => { const m = recs(u, mulaqat)[0] || {}; check('[chaupal] Saturday + place + 10', /शनिवार/.test(m.preferredWhen || '') && /सीताराम/.test(m.place || '') && m.familyMembers === 10); } });

C.push({ name: 'mulaqat-repeat-ask-dedupe', turns: [
    { m: 'abhay singh ji ko ghar bulana hai', intent: 'meeting' },
    { m: 'kal shaam', },
    { m: 'ward 2 bus stand ke paas' },
    { m: '6 log' },
    { m: 'milna hai bas' },
    { m: 'unse milna hai phir se', has: ['pehle se'] }
], after: (u) => { check('[dedupe] still one mulaqat record', recs(u, mulaqat).length === 1); } });

// ---------------- D: conversation quality ----------------
C.push({ name: 'greetings-no-repeat', turns: [
    { m: 'ram ram', intent: 'greeting' }, { m: 'sab badhiya', intent: 'wellbeing_reply' }, { m: 'ram ram' }, { m: 'namaste' }, { m: 'kaise ho?', has: ['theek'] }, { m: 'jai shri ram' }
] });

C.push({ name: 'who-bot-sarpanch-symbol', turns: [
    { m: 'tum kaun ho?', intent: 'who_are_you', has: ['digital saathi'] },
    { m: 'bot ho kya?', intent: 'who_are_you', has: ['AI', 'insaan nahi'] },
    { m: 'kya abhay singh pehle sarpanch the?', intent: 'was_sarpanch', hasAll: ['nahi', 'pratyashi'], not: /pratinidhi/i },
    { m: 'chunav chinh kya hai?', intent: 'ballot', has: ['kram sankhya 1'] },
    { m: 'matpatra kaise modna hai', intent: 'ballot', has: ['lambai'] },
    { m: 'vote kab hai', intent: 'polling', hasAll: ['16 November', '7:30'] }
] });

C.push({ name: 'bribe-daaru-paise', turns: [
    { m: 'daru milegi kya vote ke liye?', intent: 'bribe', has: ['swabhimaan', 'nahi'] },
    { m: 'paise kitne doge', intent: 'bribe', has: ['swabhimaan', 'mol'] },
    { m: 'kuch to milega', intent: 'bribe', has: ['laalach', 'nahi'] },
    { m: 'achha theek hai' },
    { m: 'kaam kya kiya hai?', intent: 'works' },
    { m: 'soch ke batayenge', intent: 'undecided' }
] });

C.push({ name: 'bribe-hindi', turns: [
    { m: 'दारू की बोतल मिलेगी?', intent: 'bribe', has: ['स्वाभिमान'] },
    { m: 'पैसे मिलेंगे क्या', intent: 'bribe' },
    { m: 'अच्छा' },
    { m: 'क्या काम किया', intent: 'works' },
    { m: 'ठीक है' },
    { m: 'देखेंगे', intent: 'undecided' }
] });

C.push({ name: 'opponent-supporter', turns: [
    { m: 'main to dusre ke saath hu', intent: 'opposed', has: ['samman'] },
    { m: 'unhone kuch nahi kiya', intent: 'taunt' },
    { m: 'dusra candidate achha hai', intent: 'opponent', has: ['samman', 'tippani'] },
    { m: 'theek hai' },
    { m: 'tum kaun ho', intent: 'who_are_you' },
    { m: 'vote nahi denge', intent: 'opposed', has: ['samman'] }
], after: (u) => check('[opponent] stage opposed, no vote push after', u.persuasionStage === 'opposed') });

C.push({ name: 'undecided-elder-hindi', user: { memory: { age: 72, ageGroup: 'elder', gender: 'M' } }, turns: [
    { m: 'राम राम', has: ['दादा जी'] },
    { m: 'अभी सोच रहे हैं', intent: 'undecided', has: ['दादा जी'] },
    { m: 'क्या काम किया?', intent: 'works' },
    { m: 'और आगे क्या करोगे?', intent: 'future', has: ['संकल्प'] },
    { m: 'बुजुर्गों के लिए क्या?', has: ['चौपाल'] },
    { m: 'देखेंगे', intent: 'undecided' }
] });

C.push({ name: 'elder-woman-voter-record', user: { lastFoundVoter: { name_hi: 'कमला देवी', gender: 'महिला', age: 70, ward: 2 } }, turns: [
    { m: 'राम राम', has: ['माता जी'] },
    { m: 'अस्पताल में डॉक्टर नहीं आता', intent: 'complaint', has: ['माता जी'] },
    { m: 'तीन महीने से', has: ['दर्ज', 'डॉक्टर'] },
    { m: 'नहीं' },
    { m: 'वोट देंगे', intent: 'commit', has: ['95'] },
    { m: 'ठीक है' }
], after: (u) => { const s = recs(u, samasya)[0] || {}; check('[elder-woman] hospital + ward 2 from her own record + F7', s.category === 'hospital' && s.sankalpId === 'F7'); } });

C.push({ name: 'youth-library-gym', turns: [
    { m: 'main student hu, gym kahan hai?', has: ['gym'] },
    { m: 'library kahan hai', has: ['library'] },
    { m: 'cricket ka ground chahiye', intent: 'works', has: ['khel maidan', 'stadium'] },
    { m: 'naukri ka kya?', has: ['jhootha vaada nahi'] },
    { m: 'running track bhi hai?', has: ['running track'] },
    { m: 'pakka vote denge', intent: 'commit' }
] });

C.push({ name: 'daily-life-health-crops', turns: [
    { m: 'ram ram bhai', intent: 'greeting' },
    { m: 'papa ki tabiyat kharab hai', intent: 'daily_life', has: ['dhyan', 'theek'], noVoteAsk: true },
    { m: 'haan dikha diya, ab theek hai', intent: 'daily_followup', has: ['tasalli', 'Bhagwan'] },
    { m: 'sarson ki buvai chal rahi hai', intent: 'daily_life', has: ['fasal'] },
    { m: 'diwali ki ram ram', intent: 'daily_life', has: ['shubhkamnayein'] },
    { m: 'abhi khet me hu baad me baat karte', intent: 'daily_life', has: ['fursat'], noVoteAsk: true }
], after: (u) => check('[daily] no samasya logged from chit-chat', recs(u, samasya).length === 0) });

C.push({ name: 'daily-life-family-weather', turns: [
    { m: 'beti ki shaadi hai agle mahine', intent: 'daily_life', has: ['badhai'] },
    { m: 'thand badh gayi hai', intent: 'daily_life', has: ['dhyan'] },
    { m: 'bhai dooj ki ram ram', intent: 'daily_life' },
    { m: 'beta fauj me bharti ho gaya', intent: 'daily_life', has: ['khushi', 'badhai'] },
    { m: 'haan sab theek' },
    { m: 'pakka', intent: 'commit' }
] });

C.push({ name: 'condolence-no-pitch', turns: [
    { m: 'mere dada ji guzar gaye kal', intent: 'condolence', has: ['dukh', 'shanti'], noVoteAsk: true },
    { m: 'dhanyavad', noVoteAsk: true },
    { m: 'ji', noVoteAsk: true },
    { m: 'ok', noVoteAsk: true },
    { m: 'haan', noVoteAsk: true },
    { m: 'theek hai', noVoteAsk: true }
], after: (u) => { Object.assign(u, { assignedLine: 'sim_636' }); u.memory.proactive.lastUserAt = new Date(Date.now() - 10 * 3600e3).toISOString(); check('[condolence] planner pauses proactive messages', planner.blockReason(u, new Date(Date.now() + 3600e3)) === 'condolence_pause' || planner.blockReason(u, new Date(Date.now() + 3600e3)) === 'quiet_hours'); } });

C.push({ name: 'media-voice-sticker', turns: [
    { m: '[voice note]', intent: 'media', has: ['voice', 'वॉइस'] },
    { m: '[sticker]', intent: 'media' },
    { m: '[photo]', intent: 'media', has: ['photo', 'फोटो'] },
    { m: '[location]', intent: 'media' },
    { m: '[document]', intent: 'media' },
    { m: 'ye sadak ki photo hai, tooti hui', intent: 'complaint' }
] });

C.push({ name: 'wrong-number', turns: [
    { m: 'galat number hai, kaun hai ye', intent: 'wrong_number', has: ['STOP'] },
    { m: 'main jaipur me rehta hu' },
    { m: 'achha' },
    { m: 'theek hai' },
    { m: 'ok bye' },
    { m: 'ram ram' }
] });

C.push({ name: 'slip-and-booth', turns: [
    { m: 'meri parchi chahiye', intent: 'voter_slip', has: ['pita/pati'] },
    { m: 'booth kaun sa hai', intent: 'polling' },
    { m: 'ward 4', has: ['96'] },
    { m: 'aadhaar lana hai kya?', intent: 'polling', has: ['Aadhaar'] },
    { m: 'kram sankhya kya hai abhay singh ki', intent: 'ballot', has: ['1'] },
    { m: 'pakka', intent: 'commit' }
] });

C.push({ name: 'committed-family-booth', turns: [
    { m: 'hum abhay singh ke saath hain', intent: 'commit', has: ['kitne vote'] },
    { m: '4', intent: 'family_votes', has: ['4 vote'] },
    { m: 'ward 9', has: ['98'] },
    { m: 'dhanyavad' },
    { m: 'vote kab hai', intent: 'polling' },
    { m: 'pakka aayenge sab', intent: 'commit', not: /kitne vote/i }
], after: (u) => check('[committed] familyVotes 4 + stage committed', u.memory.familyVotes === 4 && u.persuasionStage === 'committed') });

C.push({ name: 'contextual-yes-to-vote-ask', turns: [
    { m: 'abhay singh kaun hai', intent: 'about_baba' },
    { m: 'abhay singh ne pani ke liye kya kiya?', intent: 'works' },
    { m: 'haan ji', intent: 'commit' },
    { m: '3', intent: 'family_votes' },
    { m: 'ok' },
    { m: 'ram ram' }
], after: (u) => check('[ctx-yes] committed via contextual yes, 3 votes', u.persuasionStage === 'committed' && u.memory.familyVotes === 3) });

C.push({ name: 'memory-yaad-hai', turns: [
    { m: 'paani ki dikkat hai ward 3 me', intent: 'complaint' },
    { m: '2 mahine se', has: ['darj'] },
    { m: 'nahi' },
    { m: 'ram ram' },
    { m: 'meri paani wali baat yaad hai?', intent: 'memory_check', hasAll: ['ward 3', 'S-'] },
    { m: 'dhanyavad' }
] });

C.push({ name: 'haryanvi-farmer', turns: [
    { m: 'mhara gaam haraheri se, ghani dikkat paani ki', intent: 'complaint' },
    { m: 'ward 11', has: ['kab se'] },
    { m: 'barsaat se', has: ['darj'] },
    { m: 'nahi' },
    { m: 'thara kaam badhiya sai', },
    { m: 'vote pakka', intent: 'commit' }
], after: (u) => { const s = recs(u, samasya)[0] || {}; check('[haryanvi] dialect + hadahedi + paani', u.memory.dialect === 'haryanvi' && s.category === 'paani' && s.ward === 11); } });

C.push({ name: 'rajasthani-greeting', turns: [
    { m: 'khamma ghani hukum' },
    { m: 'mharo gaon sihali kalan hai' },
    { m: 'johad ka kaam hua kya', intent: 'works', has: ['johad'] },
    { m: 'ashram me kya hua', intent: 'works', has: ['ashram', 'chalu'] },
    { m: 'badhiya', },
    { m: 'pakka vote', intent: 'commit' }
] });

C.push({ name: 'jobs-and-counts-honest', turns: [
    { m: 'naukri ka kya karoge', has: ['jhootha vaada nahi'] },
    { m: 'kitni sadke bani', has: ['ginti'] },
    { m: 'cc road ka kya hua?', has: ['interlocking'] },
    { m: 'bijli ka kya', has: ['jhootha vaada nahi'] },
    { m: 'ok' },
    { m: 'dekhenge', intent: 'undecided' }
] });

C.push({ name: 'health-medicine-ambulance-hindi', turns: [
    { m: 'दवाई बहुत महंगी है', intent: 'complaint', has: ['दवा'] },
    { m: 'वार्ड 6', has: ['कब से'] },
    { m: 'हमेशा से', has: ['जन औषधि'] },
    { m: 'नहीं' },
    { m: 'एम्बुलेंस की सुविधा होगी?', has: ['एम्बुलेंस'] },
    { m: 'अच्छा है', intent: 'positive' }
] });

C.push({ name: 'opposed-then-problem', turns: [
    { m: 'vote nahi denge', intent: 'opposed', has: ['khatakti'] },
    { m: 'kyunki gali me naali tooti hai', intent: 'complaint' },
    { m: 'ward 5', has: ['kab se'] },
    { m: 'saal bhar se', has: ['darj'], not: /ghar bulana/i },
    { m: 'dekhte hain' },
    { m: 'ok' }
], after: (u) => check('[opposed-problem] samasya logged, no mulaqat offer to opposed', recs(u, samasya).length === 1 && !u.history.some(h => h.role === 'bot' && /ghar bulana/i.test(h.text))) });

C.push({ name: 'about-baba-honour', turns: [
    { m: 'abhay singh kaun hai?', intent: 'about_baba', has: ['40 saal'] },
    { m: 'moti aangli wale kaun', intent: 'about_baba' },
    { m: 'kuch nahi kiya inhone', intent: 'taunt' },
    { m: 'aur kya?', },
    { m: 'aage ka kya plan', intent: 'future' },
    { m: 'achha hai', intent: 'positive' }
] });

C.push({ name: 'off-topic-party', turns: [
    { m: 'modi ke baare me kya kehna hai', intent: 'off_topic', has: ['panchayat'] },
    { m: 'ipl kaun jeetega', intent: 'off_topic' },
    { m: 'joke sunao', intent: 'joke' },
    { m: 'hahaha' },
    { m: 'ok' },
    { m: 'vote kab hai', intent: 'polling' }
] });

C.push({ name: 'pipeline-meta-line-test-flag', pipeline: true, user: { selfTest: 'st_test' }, turns: [
    { m: 'Ram ram' },
    { m: 'hamari gali me andhera rehta hai' },
    { m: 'ward 2' },
    { m: '1 mahine se' },
    { m: 'haan' },
    { m: 'kal subah' }
], after: (u) => {
    const s = recs(u, samasya)[0] || {};
    check('[pipeline] samasya via getAIResponse carries line + test flag', s.line === 'sim_636' && s.test === true && s.category === 'road_light');
    const m = recs(u, mulaqat)[0] || {};
    check('[pipeline] mulaqat test record', m.test === true && /kal subah/.test(m.preferredWhen || ''));
    check('[pipeline] test records hidden from default list', !samasya.list({}).some(r => r.id === s.id));
} });

const llmSymbol = async () => 'Abhay Singh ji ka chunav chinh swastik hai, usi par mohar lagaiye!';
const llmPromise = async () => 'Aapki sadak 10 din me ban jayegi, pakka. Vote denge na?';
const llmTwoQ = async () => 'Kaise ho? Kya haal hai?';
const llmPratinidhi = async () => 'Abhay Singh ji sarpanch pratinidhi rahe hain aur sabka kaam karte hain.';
let li = 0;
C.push({ name: 'llm-rule-breaks-rejected', llm: async (...a) => [llmSymbol, llmPromise, llmTwoQ, llmPratinidhi][(li++) % 4](...a), turns: [
    { m: 'abhay singh ne kya kiya?' }, { m: 'aage kya karoge?' }, { m: 'ram ram' }, { m: 'abhay singh kaun hai' }, { m: 'kya kaam hua' }, { m: 'soch rahe hain' }
], after: (u, rs) => check('[llm] symbol / promised date / two questions / pratinidhi outputs all rejected', rs.every(r => /llm_rejected/.test(r.r.source))) });

const goodDaily = async (sys) => /daily_life/.test(sys) ? 'Arre, bhagwan jaldi theek karein ji 🙏 Apna dhyan rakhiye.' : null;
C.push({ name: 'llm-daily-life-ok', llm: goodDaily, turns: [
    { m: 'papa bimar hain' }, { m: 'haan dikha diya' }, { m: 'sarson boyi hai' }, { m: 'diwali ki ram ram' }, { m: 'ok' }, { m: 'ram ram' }
], after: (u, rs) => check('[llm-daily] valid LLM daily-life reply used', rs[0].r.source === 'llm') });

// ---------------- planner / plan view ----------------
C.push({ name: 'planner-next-action', turns: [
    { m: 'main ward 8 se hu' },
    { m: 'pakka vote denge' },
    { m: 'ghar ke 6 vote hain' },
    { m: 'nahi' },
    { m: 'dhanyavad' },
    { m: 'ok' }
], after: (u) => {
    Object.assign(u, { assignedLine: 'sim_636' });
    u.memory.told.mulaqatOffer = null; u.memory.flow = null;
    const day = new Date(Date.parse('2026-11-06T06:30:00Z'));
    u.memory.proactive.lastUserAt = new Date(day.getTime() - 5 * 3600e3).toISOString();
    const nx = planner.nextAction(u, day);
    check('[plan] next action for committed voter with family votes = mulaqat_invite now', nx.kind === 'mulaqat_invite' && !!nx.when && /ghar bulana/i.test(nx.text));
    check('[plan] nextAction is side-effect free', !u.memory.told.mulaqatOffer && !u.memory.flow);
    const night = new Date(Date.parse('2026-11-06T17:30:00Z')); // 23:00 IST
    const nn = planner.nextAction(u, night);
    check('[plan] quiet hours -> next morning 08:00 IST', nn.blockedBy === 'quiet_hours' && Date.parse(nn.when) === Date.parse('2026-11-07T02:30:00Z'));
    const silent = planner.nextAction(u, new Date(Date.parse('2026-11-15T06:30:00Z')));
    check('[plan] silence period -> no proactive', silent.blockedBy === 'silence_period' && !silent.kind);
} });

C.push({ name: 'planner-samasya-followup', turns: [
    { m: 'naali ka paani bhar jata hai ward 5 me' },
    { m: 'kaafi time se' },
    { m: 'nahi' },
    { m: 'ok' },
    { m: 'theek hai' },
    { m: 'ram ram' }
], after: (u) => {
    Object.assign(u, { assignedLine: 'sim_636' });
    const day = new Date(Date.parse('2026-11-07T06:30:00Z'));
    u.memory.proactive.lastUserAt = new Date(day.getTime() - 5 * 3600e3).toISOString();
    if (u.memory.openFollowUp) u.memory.openFollowUp.dueAt = new Date(day.getTime() - 3600e3).toISOString();
    const plan = planner.planFor(u, { now: day, dryRun: true });
    check('[plan-samasya] concern follow-up quotes the register number', plan && plan.kind === 'concern_followup' && /S-\d{4}/.test(plan.text) && !brain.PROMISED_DATE.test(plan.text));
} });

// ---------------- unit checks ----------------
function unitChecks() {
    check('[parse] since', flows.parseSince('do mahine se pani nahi') === 'do mahine se' && /साल/.test(flows.parseSince('एक साल से टूटी है')) && flows.parseSince('kaafi time se') && !flows.parseSince('pakka vote denge'));
    check('[parse] when', flows.parseWhen('kal shaam 6 baje') && flows.parseWhen('ravivar dopahar') && flows.parseWhen('शनिवार शाम') && !flows.parseWhen('dhanyavad'));
    const w = flows.parseWhen('15 tarikh ko');
    check('[parse] when date 15 Nov', w && w.date === '2026-11-15');
    check('[parse] count', flows.parseCount('5 log') === 5 && flows.parseCount('घर पर 6 लोग') === 6 && flows.parseCount('paanch log') === 5);
    const loc = flows.parseLocation('ward 5 me shiv mandir wali gali');
    check('[parse] location ward + place (leading "me" stripped)', loc && loc.ward === 5 && /^shiv mandir/.test(loc.place));
    check('[parse] a bare name is not a location', !flows.parseLocation('Ramesh Kumar'));
    check('[kb] booth from parcha', kb.boothForWard(6).booth === '96' && kb.boothForWard(11).booth === '98' && !kb.boothForWard(12));
    check('[kb] sankalp link: pension none, water F2, sihali khurd-hadahedi road F9', !kb.sankalpFor('pension') && kb.sankalpFor('water').id === 'F2' && kb.sankalpFor('road', { text: 'sihali khurd se haraheri wali sadak' }).id === 'F9');
    check('[gender] 3rd-person verbs never set gender', require('./voter_memory.js').extractGender('sarson ki buvai chal rahi hai') === null && require('./voter_memory.js').extractGender('pani bhar jata hai') === null);
    check('[honorific] unknown-gender elder gets a neutral जी (never guessed ताऊ/ताई)', brain.honorific({ gender: null, age: 70 }, 'hi') === 'जी');
    const v = brain.validateLLM('मतपत्र में स्वस्तिक पर मुहर लगाइए', { allowedText: '', l: 'hi' });
    check('[validator] symbol claim rejected', v === 'symbol_claim');
    // server.js regression guards (the TDZ bug that silently sent EVERY consented reply to the fallback)
    const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
    const a = src.indexOf("const isConsentPromptActive = (user && user.consentStatus === 'PROMPTED');");
    const b = src.indexOf('Error resolving reply:', a);
    check('[server] no `const user` re-declaration inside the reply try-block (TDZ)', a > 0 && b > a && !/const user = userMemory\.getUser\(senderPhone\)/.test(src.slice(a, b)));
    check('[server] non-text messages become tokens, reactions ignored', /function mediaPlaceholder/.test(src) && /'\[voice note\]'/.test(src) && /IGNORED_NON_TEXT/.test(src));
    check('[server] 401 message does not print the PIN', !/Enter PIN 2026/.test(src));
    check('[server] slip search is skipped while a samasya/mulaqat flow is open', /inBrainFlow/.test(src));
    check('[server] no election-symbol claim in templates', !/स्वस्तिक \(卐\) पर मुहर/.test(src));
    check('[poster] no symbol claim on posters', !/चुनाव चिन्ह: 卐|卐 स्वस्तिक/.test(fs.readFileSync(path.join(__dirname, 'poster_engine.js'), 'utf8')));
}

(async () => {
    unitChecks();
    let i = 0;
    for (const spec of C) { i++; await runConversation(i, spec); }
    check(`[suite] at least 40 conversations (${C.length})`, C.length >= 40);
    check('[suite] every conversation has >= 6 turns', C.every(c => c.turns.length >= 6));
    // cleanup of test-flagged records (what the dashboard cleanup endpoint does)
    const removed = samasya.removeWhere(r => !!r.test) + mulaqat.removeWhere(r => !!r.test);
    check('[cleanup] test-flagged records removable', removed >= 2 && !samasya.list({ onlyTest: true }).length);
    try { fs.unlinkSync(process.env.SAMASYA_PATH); fs.unlinkSync(process.env.MULAQAT_PATH); } catch (e) {}
    console.log(`\nConversations: ${C.length} (min turns ${Math.min(...C.map(c => c.turns.length))})`);
    console.log(`RESULT ${passed} passed, ${failed} failed`);
    if (failed) { console.log('Failures:\n - ' + fails.join('\n - ')); process.exitCode = 1; }
})();
