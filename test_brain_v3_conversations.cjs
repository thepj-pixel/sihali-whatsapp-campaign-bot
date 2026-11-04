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
process.env.OUTBOUND_SETTINGS_PATH = path.join(os.tmpdir(), `v3_outbound_${process.pid}.json`);
delete process.env.PROACTIVE_OUTBOUND;
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
    check(`${tag} length <= 480`, reply.length <= 480 || /डिजिटल मतदाता पर्ची/.test(reply));
    check(`${tag} at most one question`, (reply.match(/\?/g) || []).length <= 1);
    check(`${tag} never a bare Ji/Achha`, !/^(ji|जी|achha|accha|अच्छा|samajh gayi|समझ गई)[\s.,!🙏]*((dada|tau|tai|mata|behan|bhai sahab|दादा|ताऊ|ताई|माता|बहन|भाई साहब)\s*(ji|जी)?)?[\s.,!🙏]*$/i.test(reply.trim()));
    if (prev) check(`${tag} not a repeat of previous bot reply`, replyQuality.normalize(reply) !== replyQuality.normalize(prev));
    if (/[a-z\u0900-\u097F]/i.test(msg) && !brain.MEDIA_RX.test(msg.trim()) && !/(डिजिटल मतदाता पर्ची|1️⃣)/.test(reply)) {
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
    if (spec.llm === stubLLM && !spec.allFlow && !spec.templateOnly) check(`[${spec.name}] LLM path used for at least one reply`, replies.some(x => x.r.source === 'llm'));
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
    { m: '40 saal me kya kiya?', intent: 'taunt', has: ['haq', 'sir aankhon', 'naraazgi'], not: /(kuch nahi kiya|jhooth)/i },
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
    { m: 'meri paani wali baat yaad hai?', intent: 'memory_check', hasAll: ['ward 3'], not: /S-\d{4}/ },
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
    { m: 'vote nahi denge', intent: 'opposed', has: ['zaroori'] },
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
], after: (u, rs) => check('[llm] symbol / promised date / two questions / pratinidhi outputs all rejected', rs.every(r => r.r.source !== 'llm') && rs.filter(r => /llm_rejected/.test(r.r.source)).length >= 4) });

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

// ---------------- v3.1 regressions from the 4 Nov live self-test (each runs with LLM off AND with a stub LLM) ----------------
const stubLLM = async (sys) => { const m = String(sys).split('SAFE DRAFT')[1] || ''; return m.slice(m.indexOf(':') + 1).trim(); };
const REG = [];
REG.push({ name: 'reg-opponent-support', turns: [
    { m: 'hum to dusre candidate ke saath hain', intent: 'opposed', has: ['samman'], not: /(dhanyavad|taakat|kitne vote|bharosa)/i },
    { m: 'unka parivar purana hai', intent: 'opponent', has: ['samman'] },
    { m: 'abhay singh me kya khaas hai', intent: 'about_baba', hasAll: ['40 saal'], has: ['zameen', 'up-swasthya'] },
    { m: 'acha library ke baare me batao', intent: 'works', has: ['library'], not: /(Moti Aangli|pratyashi hain)/i },
    { m: 'dusre wale to de rahe hain', intent: 'bribe_others', has: ['swabhimaan', 'izzat'], not: /(chor|jhoothe|bikau)/i },
    { m: 'theek hai' }
], after: (u) => check('[reg-opponent] stage opposed, never committed', u.persuasionStage === 'opposed' && !(u.persuasionHistory || []).some(h => h.to === 'committed')) });
REG.push({ name: 'reg-angry-grievance', turns: [
    { m: 'tum log chunav me hi yaad karte ho', intent: 'grievance', has: ['jaayaz', 'naraazgi'], not: /samajh nahi/i },
    { m: '5 saal kuch nahi kiya, sab jhooth', intent: 'taunt' },
    { m: 'hamare yahan to sadak tooti padi hai', intent: 'complaint' },
    { m: 'kaunsi sadak banwai bata', intent: 'works', has: ['sadak'] },
    { m: 'hmm', has: ['gali'], not: /(darj kar li|kis gali ya ward)/i },
    { m: 'bus stand ke paas wali gali' }
], after: (u) => check('[reg-angry] exactly one samasya record, no duplicate on filler', recs(u, samasya).length === 1) });
REG.push({ name: 'reg-chitchat-no-bare-ji', turns: [
    { m: 'aaj to bahut thand hai' },
    { m: 'fasal ki kataai chal rahi hai, thak gaye' },
    { m: 'beti ki shaadi hai agle mahine', has: ['badhai', 'khushi'] },
    { m: 'haan aap bhi aana', intent: 'invite', has: ['nyot'] },
    { m: 'vote ki baat baad me karenge', has: ['jaldi', 'fursat'], noVoteAsk: true },
    { m: 'theek hai beta' }
] });
REG.push({ name: 'reg-money-ask', turns: [
    { m: 'kya abhay singh pehle sarpanch the?', intent: 'was_sarpanch' },
    { m: 'to kaam kisne karwaye', intent: 'works' },
    { m: 'chunav chinh kya hai', intent: 'ballot' },
    { m: 'kitne crore kharch kiye', intent: 'money_ask', has: ['aankde'] },
    { m: 'acha ok' },
    { m: 'dhanyavad' }
] });
REG.push({ name: 'reg-youth-haryanvi', turns: [
    { m: 'bhai kya scene hai', intent: 'greeting', has: ['badhiya'], noVoteAsk: true },
    { m: 'gaon me khelne ki jagah kya hai', intent: 'works' },
    { m: 'aur gym?', has: ['gym'] },
    { m: 'haryanvi me bol bhai', intent: 'dialect_switch', has: ['sai', 'Haryanvi'] },
    { m: 'thik hai bhai vote pakka', intent: 'commit' },
    { m: 'ghar ke 4 vote' }
], after: (u) => check('[reg-youth] Haryanvi remembered', u.dialectPref === 'haryanvi') });
REG.push({ name: 'reg-question-breaks-samasya', turns: [
    { m: 'namaste bhaiya, main Sihali Khurd se bol rahi hu', has: ['Behan ji'] },
    { m: 'hamare yahan paani ki dikkat hai, nal me paani kam aata hai', intent: 'complaint' },
    { m: 'ladkiyon ke padhne ke liye kya hai', intent: 'works', has: ['library'], not: /kab se/i },
    { m: 'acha library kahan hai', has: ['library'] },
    { m: 'ward 6 me' },
    { m: 'pakka vote denge, ghar ke 3 vote', intent: 'commit', has: ['3 vote'] }
], after: (u) => { const r = recs(u, samasya)[0] || {}; check('[reg-question] question never stored as the location', !/padhne|library/i.test(r.location || '')); } });
REG.push({ name: 'reg-ghar-visit-multifield', allFlow: true, turns: [
    { m: 'Ram Ram sa' },
    { m: 'main Sihali Kalan ward 7 se, Abhay singh ji se milna hai', intent: 'meeting', has: ['din aur samay'] },
    { m: 'haan ghar bulana hai', has: ['din aur samay'] },
    { m: 'parso shaam 6 baje', has: ['pehchaan'] },
    { m: 'shiv mandir ke paas, 8 log hai ghar me', has: ['kis baare'] },
    { m: 'gaon ki baat karni hai', hasAll: ['shiv mandir', 'parso', '8 log', 'gaon ki baat'] }
], after: (u) => { const r = recs(u, mulaqat)[0] || {}; check('[reg-visit] place, when, family, purpose parsed', /shiv mandir/i.test(r.place || '') && /parso/.test(r.preferredWhen || '') && r.familyMembers === 8 && /gaon ki baat/.test(r.purpose || '') && !/ghar bulana/.test(r.purpose || '') && !/ghar bulana/.test(r.preferredWhen || '')); } });
REG.push({ name: 'reg-visit-purpose-followup', allFlow: true, turns: [
    { m: 'abhay singh ji ko ghar bulana hai', intent: 'meeting' },
    { m: 'kal shaam 5 baje' },
    { m: 'ward 2 school ke paas' },
    { m: '6 log' },
    { m: 'pata nahi', has: ['team'] },
    { m: 'gaon ki sadak ki baat karni hai', has: ['jod diya'] }
], after: (u) => { const r = recs(u, mulaqat)[0] || {}; check('[reg-purpose] purpose follow-up updates the record', /sadak ki baat/.test(r.purpose || '') && recs(u, mulaqat).length === 1); } });
REG.push({ name: 'reg-samasya-place-before-since', allFlow: true, turns: [
    { m: 'Namaste ji' },
    { m: 'main Haraheri ward 10 se hu', intent: 'introduce' },
    { m: 'hamari gali me naali band padi hai, ganda paani bhar jata hai', intent: 'complaint', has: ['gali'], not: /kab se/i },
    { m: 'madan panch ke ghar ke paas wali gali', has: ['kab se'] },
    { m: 'do mahine se', has: ['darj'] },
    { m: 'theek hai, dhanyavad', has: ['dhanyavad'], not: /(din aur samay|kaun sa din)/i }
], after: (u) => { const r = recs(u, samasya)[0] || {}; check('[reg-samasya] gali + since stored, no visit pushed', /madan panch/i.test(r.location || '') && /do mahine/.test(r.since || '') && recs(u, mulaqat).length === 0); } });
REG.push({ name: 'reg-elder-knee', turns: [
    { m: 'ram ram beta, main 72 saal ka hu', has: ['Dada ji'] },
    { m: 'mera ghutna dard karta hai, hospital me doctor nahi milta', intent: 'health_concern', hasAll: ['dard', 'up-swasthya', 'doctor'] },
    { m: 'aage kya karoge hospital ke liye', intent: 'future' },
    { m: 'vote kahan dena hai mera ward 2 hai', has: ['95'] },
    { m: 'theek hai beta', has: ['dhyan', 'aashirwad'] },
    { m: 'ram ram', has: ['Dada ji'] }
] });
REG.push({ name: 'reg-devanagari-works', turns: [
    { m: 'राम राम जी', intent: 'greeting' },
    { m: 'अभय सिंह ने क्या काम करवाए?', intent: 'works' },
    { m: 'हम तो दूसरे उम्मीदवार के साथ हैं', intent: 'opposed', has: ['सम्मान'] },
    { m: 'अभय सिंह में क्या ख़ास है', intent: 'about_baba', has: ['40 साल'] },
    { m: 'तुम लोग चुनाव में ही याद करते हो', intent: 'grievance' },
    { m: 'ठीक है' }
] });
// ---- v4: the owner's live test from 917976410227 (4 Nov 2026 night) ----
const opener = t => replyQuality.normalize(String(t || '')).slice(0, 18);
REG.push({ name: 'reg-owner-transcript', templateOnly: true, turns: [
    { m: 'Kaam bata saara ka saara', intent: 'works', hasAll: ['Jal Jeevan', 'library', 'swasthya'], not: /(ghar-gaon me sab theek|samajh gayi)/i },
    { m: 'Elon Musk kon h', intent: 'off_topic', has: ['Sihali Khurd', 'gaon'], not: /(Moti Aangli|pratyashi hain)/i },
    { m: 'Aree aur batao..mark zuckerberg kie news batao', intent: 'off_topic', not: /(Moti Aangli)/i },
    { m: 'Kutta abhay Singh', intent: 'abuse', has: ['naraaz', 'gusse', 'samman', 'bhavna'], not: /(kutta|kutte|parchi, booth ya gaon)/i },
    { m: 'Kha gaya saare paise', intent: 'corruption', hasAll: ['40 saal'], has: ['zameen', 'saamne', 'khud dekh'], not: /(\d{3,}|aankde|samajh li\. Koi naya sawal)/i },
    { m: 'Kis baat pe bhi nahi bekar h abhay singh', intent: 'taunt', not: /(bekar|chor)/i },
    { m: 'Are chup bekar aadmi h vo', intent: 'taunt', not: /(Sawal poochna aapka haq|bekar)/i },
    { m: 'Ward no 3 me sadak tuti padi h', intent: 'complaint' },
    { m: '3 saal se49 baar bol diya sarpanch ko', has: ['darj'] }
], after: (u, rs) => {
    const neg = rs.slice(3, 7).map(x => opener(x.reply));
    check('[owner] four negative replies all open differently', new Set(neg).size === neg.length);
    check('[owner] road complaint logged with ward 3 + since', (() => { const r = recs(u, samasya)[0] || {}; return r.category && r.ward === 3 && /3 saal/.test(r.since || ''); })());
} });
REG.push({ name: 'reg-abuse-variants', templateOnly: true, turns: [
    { m: 'kutte', intent: 'abuse' },
    { m: 'harami log ho tum sab', intent: 'abuse' },
    { m: 'bsdk', intent: 'abuse' },
    { m: 'chor hai abhay singh', intent: 'corruption', not: /chor/i },
    { m: 'ghotala kiya hai panchayat me', intent: 'corruption' },
    { m: 'nalayak', intent: 'abuse' }
], after: (u, rs) => {
    const ops = rs.map(x => opener(x.reply));
    check('[abuse-variants] no opener repeated back-to-back', ops.every((o, i) => i === 0 || o !== ops[i - 1]));
    check('[abuse-variants] never counter-abuse', rs.every(x => !/(kutt|harami|bsdk|nalayak|chor hai|tum log hi)/i.test(x.reply)));
} });
REG.push({ name: 'reg-first-messages', turns: [
    { m: 'hi', intent: 'greeting' },
    { m: 'kaun ho tum', intent: 'who_are_you' },
    { m: '❤️', intent: 'emoji_only' },
    { m: 'asdf qwer zxcv', intent: 'unclear', has: ['samajh nahi', 'khulkar'], not: /(denge na\?|koi baat nahi)/i },
    { m: 'who is abhay singh', intent: 'about_baba', has: ['40 saal'] },
    { m: 'what work has been done', intent: 'works', has: ['Jal Jeevan'] },
    { m: 'how are you', intent: 'greeting' }
] });
REG.push({ name: 'reg-devanagari-negative', templateOnly: true, turns: [
    { m: 'सारे काम बताओ', intent: 'works', hasAll: ['जल जीवन', 'लाइब्रेरी'] },
    { m: 'कुत्ता है अभय सिंह', intent: 'abuse', not: /कुत्त/ },
    { m: 'सारे पैसे खा गया', intent: 'corruption', has: ['40 साल'] },
    { m: 'बेकार आदमी है वो', intent: 'taunt', not: /बेकार/ },
    { m: 'चुप कर', intent: 'taunt' },
    { m: 'ठीक है' }
], after: (u, rs) => { const ops = rs.slice(1, 5).map(x => opener(x.reply)); check('[devanagari-negative] openers vary', new Set(ops).size === ops.length); } });

// ---- v4.4 (owner 22:48): people-pleaser on abuse/false allegations, then the samasya is logged; no vote push after anger ----
REG.push({ name: 'reg-allegation-then-samasya', turns: [
    { m: 'baba abhay singh chutiya h', intent: 'abuse', has: ['sir aankhon', 'naraaz', 'gusse', 'bhavna', 'samman'], not: /(chutiya|galat|jhooth|aisa nahi)/i },
    { m: 'kuch kaam nahi karwaya', intent: 'taunt', not: /(jhooth|galat|aisa nahi)/i },
    { m: 'sadak tooti padi hai ward 4 me', intent: 'complaint' },
    { m: 'mandir ke paas wali gali', has: ['kab se'] },
    { m: '2 saal se', has: ['darj'] },
    { m: 'theek hai', noVoteAsk: true }
], after: (u) => check('[allegation] the angry voter\'s samasya is logged', recs(u, samasya).length === 1) });
REG.push({ name: 'reg-grievance-open-logs-topic', templateOnly: true, turns: [
    { m: 'kha gaya saare paise', intent: 'corruption', noVoteAsk: true },
    { m: 'naali band hai', has: ['note', 'kab se', 'gali', 'ward'] },
    { m: 'ward 9 school ke paas' },
    { m: 'ek mahina' },
    { m: 'ok' },
    { m: 'dhanyavad' }
], after: (u) => check('[grievance-open] the problem after the allegation is a logged samasya', recs(u, samasya).length === 1) });

for (const r of REG) {
    C.push({ ...r, name: r.name + '-nollm' });
    C.push({ ...r, name: r.name + '-stubllm', llm: stubLLM, after: async (u, rs) => { if (r.after) await r.after(u, rs); } });
}
// ---- v4.4: context-loss bug — the slip flow must never wipe the conversation ----
C.push({ name: 'reg-slip-keeps-context-pipeline', pipeline: true, turns: [
    { m: 'Ram ram' },
    { m: 'ward 3 me sadak tuti padi h', intent: 'complaint' },
    { m: '3 saal se', has: ['darj'] },
    { m: 'meri parchi chahiye', not: /सड़क/ },
    { m: 'Krishan Kumar', has: ['1️⃣'], not: /samajh gayi/ },
    { m: '1', has: ['डिजिटल मतदाता पर्ची'] },
    { m: 'meri sadak wali baat yaad hai?', intent: 'memory_check', has: ['sadak'], not: /(डिजिटल मतदाता पर्ची|वोटर लिस्ट)/ },
    { m: 'nahi pata kab banegi', not: /(डिजिटल मतदाता पर्ची|वोटर लिस्ट)/ },
    { m: 'mera naam yaad hai?', intent: 'memory_check', has: ['कृष्ण', 'Krishan'], not: /Yaad ji/ }
], after: (u) => {
    const m = u.memory || {};
    check('[context] samasya + concern survive the slip turns', recs(u, samasya).length === 1 && (m.concerns || []).some(c => c.topic === 'road'));
    check('[context] slip facts kept next to the conversation (name, father, ward)', m.slip && m.slip.relName === 'भवानी राम' && m.name && (m.ward === 3 || u.ward === 3));
    check('[context] history keeps the earlier turns', (u.history || []).some(h => /sadak tuti/.test(h.text || '')));
} });
C.push({ name: 'reg-memory-name-ward-pipeline', pipeline: true, turns: [
    { m: 'namaste' },
    { m: 'main ward 4 se hu, mera naam Suresh hai', has: ['Suresh'], not: /(वोटर लिस्ट|पिताजी का नाम)/ },
    { m: 'bijli ki problem hai, street light nahi hai', intent: 'complaint' },
    { m: 'kya hoga iska', has: ['vaada'] },
    { m: 'mera naam aur ward yaad hai?', intent: 'memory_check', hasAll: ['Suresh', 'ward 4'], not: /S-\d{4}/ },
    { m: 'vote kab hai aur booth kaunsa', intent: 'polling', has: ['96'] }
], after: (u) => check('[reg-memory] name stored even though a voter-list match exists', u.memory && u.memory.name === 'Suresh' && u.memory.ward === 4) });

// ---------------- unit checks ----------------
function unitChecks() {
    const CL = { 'hum to dusre candidate ke saath hain': 'opposed', 'dusre wale to de rahe hain': 'bribe_others', 'vote pakka nahi': 'undecided', 'unko vote denge': 'opposed', 'abhay singh ko vote nahi denge': 'opposed', 'hum aapke saath hain': 'commit', 'मैं अभय सिंह जी के साथ हूँ': 'commit', 'हम तो दूसरे उम्मीदवार के साथ हैं': 'opposed', 'pakka vote denge': 'commit', 'kitne crore kharch kiye': 'money_ask', 'tum log chunav me hi yaad karte ho': 'grievance', 'abhay singh me kya khaas hai': 'about_baba', 'acha library ke baare me batao': 'works', 'samne wale ke saath hain': 'opposed', 'baba ke against hain': 'opposed', 'Kutta abhay Singh': 'abuse', 'Kha gaya saare paise': 'corruption', 'chor hai abhay singh': 'corruption', 'wo chor nahi hai, achha aadmi hai': 'positive', 'Elon Musk kon h': 'off_topic', 'Kaam bata saara ka saara': 'works', 'moti aangli wale kaun': 'about_baba' };
    for (const [m, want] of Object.entries(CL)) check(`[classify] "${m}" -> ${want}`, brain.classify(m, { history: [] }).intent === want);
    check('[llm] dropped facts rejected', brain.validateAgainstDraft('Ji, bahut achha kaam hua hai.', 'x', { used: ['M8'], l: 'en', person: {} }) === 'dropped_facts');
    check('[llm] vote push not in draft rejected', brain.validateAgainstDraft('Library bani hai. 16 Nov ko saath denge na?', 'Library bani hai.', { l: 'en', person: {} }) === 'unasked_vote_push');
    check('[llm] dropping the draft question rejected', brain.validateAgainstDraft('Abhay Singh ji 40 saal se saath hain.', 'Naraazgi jaayaz hai. Aapke yahan kya dikkat hai?', { l: 'en', person: {} }) === 'dropped_question');
    check('[llm] guessed female voter rejected', brain.validateAgainstDraft('Kya aap aur jaanna chahti hain?', 'Library bani.', { l: 'en', person: {} }) === 'gender_guess');
    check('[llm] Haryanvi asked but plain Hindi rejected', brain.validateAgainstDraft('Aapka swagat hai ji.', 'x', { l: 'en', person: {}, user: { dialectPref: 'haryanvi' } }) === 'no_dialect');
    check('[llm] cleanLLM strips think blocks / labels', brain.cleanLLM('<think>x</think>Reply: "Ji, dhanyavad"') === 'Ji, dhanyavad');
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
    // ---- v4.4: short first reply ----
    const ep = require('./engagement_policy.js');
    const cp = [ep.buildConsentPrompt('', 'hi'), ep.buildConsentPrompt('', 'hinglish')];
    check('[first] consent intro is 1-2 short lines', cp.every(x => x.length <= 130 && x.split('\n').length <= 2));
    check('[server] substantive first message is answered directly (no intro block)', /firstIsSubstantive/.test(src) && !/await sendLineContactCardOnce\(sock, replyJid, senderPhone, sessionObj\);\n\s*continue;/.test(src));
    check('[server] "yahi"/"nahi pata" only re-run a voter search right after our slip prompt', /lastBotForSlip/.test(src));
    // ---- v4: slip flow (owner transcript) ----
    const sf = require('./slip_flow.js');
    check('[slip] choiceIndex: 1, 1️⃣, pehla, "no 2", "2 number", dusra', sf.choiceIndex('1', 2) === 0 && sf.choiceIndex('1️⃣', 2) === 0 && sf.choiceIndex('pehla', 2) === 0 && sf.choiceIndex('no 2', 3) === 1 && sf.choiceIndex('2 number', 3) === 1 && sf.choiceIndex('dusra', 3) === 1 && sf.choiceIndex('7', 3) === -1);
    check('[slip] nameQuery strips filler', sf.nameQuery('Haa Krishan Kumar naam h mera') === 'Krishan Kumar' && sf.nameQuery('Arre meri voter parchi bhejo naa') === '');
    const ku = { history: [], ward: 3, memory: {} };
    const step = (m, o = {}) => { ku.history.push({ role: 'user', text: m }); const r = sf.decide(m, ku, o); ku.history.push({ role: 'bot', text: r ? (r.text || 'पर्ची: ' + (r.voter && r.voter.name_hi)) : 'x' }); return r; };
    const s1 = step('meri parchi chahiye');
    check('[slip] parchi ask without a name asks for the name', s1 && s1.kind === 'ask_name');
    const s2 = step('Haa Krishan Kumar naam h mera');
    check('[slip] "Krishan Kumar" matches the full name कृष्ण कुमार (not bare कृष्ण), ward 3 from a complaint is no filter', s2 && s2.kind === 'choose' && s2.matches.every(v => /कृष्ण कुमार/.test(v.name_hi)) && !s2.matches.some(v => v.name_hi === 'कृष्ण'));
    const s3 = step('1');
    check('[slip] "1" selects option 1 and delivers that slip (never read as a ward)', s3 && s3.kind === 'deliver' && s3.voter.name_hi === s2.matches[0].name_hi && !ku.disambiguationMatches);
    const s4 = step('Arre meri voter parchi bhejo naa');
    check('[slip] later "meri parchi bhejo" reuses the found voter', s4 && s4.kind === 'deliver' && s4.voter.name_hi === s3.voter.name_hi);
    const s5 = step('Arre Maine abhi bataya naa');
    check('[slip] "maine abhi bataya" recalls the name instead of drifting', s5 && s5.kind === 'recall' && s5.text.includes(s3.voter.name_hi) && !/(sadak|सड़क)/.test(s5.text));
    const k2 = { history: [], memory: {} };
    const t1 = (k2.history.push({ role: 'user', text: 'Krishan Kumar parchi' }), sf.decide('Krishan Kumar parchi', k2, {}));
    k2.history.push({ role: 'bot', text: t1.text });
    const t2 = sf.decide('Arre Maine abhi bataya naa', k2, {});
    check('[slip] "maine abhi bataya" with a list pending re-shows the list', t2 && t2.kind === 'choose');
    const t3 = sf.decide('pehla', k2, {});
    check('[slip] "pehla" picks option 1', t3 && t3.kind === 'deliver');
    const k3 = { history: [], memory: { name: 'Krishan Kumar' } };
    const r3 = sf.decide('meri voter slip bhej do', k3, {});
    check('[slip] parchi ask reuses the name remembered from an earlier intro', r3 && r3.kind === 'choose');
    const k4 = { history: [], memory: {} };
    const single = sf.decide('Ramesh Yadav parchi', k4, {});
    check('[slip] single match asks the father/husband confirmation first (privacy rule kept)', single && single.kind === 'confirm' && /(हाँ|haan)/.test(single.text));
    k4.history.push({ role: 'bot', text: single.text });
    check('[slip] "haan" after the confirmation delivers', (sf.decide('haan', k4, {}) || {}).kind === 'deliver');
    check('[slip] abuse/candidate/news never trigger a slip search', ['Kutta abhay Singh', 'Elon Musk kon h', 'Kha gaya saare paise', 'who is abhay singh'].every(m => sf.decide(m, { history: [], memory: {} }, { slipIntent: true }) === null));
    // ---- v4: owner rule — no automatic outbound by default ----
    const ob = require('./outbound_settings.js');
    const saved = process.env.OUTBOUND_SETTINGS_PATH;
    ob._reset();
    check('[outbound] defaults: proactive OFF, quiet hours OFF (owner 22:48)', ob.get().proactiveOutbound === false && ob.get().quietHours === false && !saved.includes('outbound_settings.json'));
    check('[server] proactive runner gated by the outbound toggle', /if \(!require\('\.\/outbound_settings\.js'\)\.proactiveEnabled\(\)\) return \{ disabled: true \};/.test(src));
    check('[server] admin boot report stays opt-in', /process\.env\.ADMIN_BOOT_REPORT !== 'on'/.test(src));
    check('[server] outbound settings API + dashboard toggle', /\/api\/settings\/outbound/.test(src) && /id="ob-proactive"/.test(src) && /id="ob-quiet"/.test(src));
    check('[broadcast] quiet hours obey the dashboard toggle', /this\.quietHoursEnabled\(\) && inQuietHours\(now, c\.caps\)/.test(fs.readFileSync(path.join(__dirname, 'broadcast_engine.js'), 'utf8')));
    check('[poster] no symbol claim on posters', !/चुनाव चिन्ह: 卐|卐 स्वस्तिक/.test(fs.readFileSync(path.join(__dirname, 'poster_engine.js'), 'utf8')));
}

(async () => {
    unitChecks();
    // owner 22:48 (5): the same opener/pitch is not reused across days (memory keeps the lines already used)
    {
        const vu = freshUser();
        const outs = [];
        for (let day = 0; day < 3; day++) {
            vu.history = []; // a new day: chat history window is empty, long-term memory stays
            for (const m of ['bc bakwas', 'theek hai']) { vu.history.push({ role: 'user', text: m }); const r = await brain.respond(m, vu, {}); vu.history.push({ role: 'bot', text: r.text }); outs.push(r.text); }
        }
        const abuseOps = [outs[0], outs[2], outs[4]].map(x => replyQuality.normalize(x).slice(0, 18));
        check('[variety] abuse openers differ on three different days', new Set(abuseOps).size === 3);
        const thanks = [outs[1], outs[3], outs[5]].map(x => replyQuality.normalize(x).slice(0, 18));
        check('[variety] thanks lines rotate across days', new Set(thanks).size >= 2);
    }
    // owner rule: with default settings, the 15-min proactive timer path sends nothing
    {
        const sent = [];
        const pu = freshUser({ consented: true, consentStatus: 'ACCEPTED', autoPilot: true, persuasionStage: 'undecided', lastActive: new Date(Date.now() - 2 * 86400e3).toISOString() });
        pu.memory = pu.memory || {}; pu.history = [{ role: 'user', text: 'paani ki dikkat hai', createdAt: Date.now() - 2 * 86400e3 }];
        const noon = new Date('2026-11-06T06:30:00Z'); // 12:00 IST, before the silence period
        const res = await planner.runCycle({ users: [pu], lineId: 'sim_636', now: noon, send: async (x, t) => sent.push(t) });
        check('[outbound] default planner cycle sends nothing (proactive_off)', res.sent === 0 && res.reason === 'proactive_off' && sent.length === 0);
        const { BroadcastEngine } = require('./broadcast_engine.js');
        const be = new BroadcastEngine({ stateFile: path.join(os.tmpdir(), `v3_bc_${process.pid}.json`), getSessions: () => [{ id: 'sim_636', status: 'CONNECTED', sock: { sendMessage: async () => { sent.push('bulk'); return {}; } } }], logger: { log() {}, warn() {}, error() {} } });
        await be.tick();
        check('[outbound] broadcast timer with no operator campaign sends nothing', sent.length === 0);
        try { fs.unlinkSync(path.join(os.tmpdir(), `v3_bc_${process.pid}.json`)); } catch (e) {}
    }
    let i = 0;
    for (const spec of C) { i++; await runConversation(i, spec); }
    check(`[suite] at least 60 conversations (${C.length})`, C.length >= 60);
    check('[suite] every conversation has >= 6 turns', C.every(c => c.turns.length >= 6));
    // cleanup of test-flagged records (what the dashboard cleanup endpoint does)
    const removed = samasya.removeWhere(r => !!r.test) + mulaqat.removeWhere(r => !!r.test);
    check('[cleanup] test-flagged records removable', removed >= 2 && !samasya.list({ onlyTest: true }).length);
    try { fs.unlinkSync(process.env.SAMASYA_PATH); fs.unlinkSync(process.env.MULAQAT_PATH); } catch (e) {}
    console.log(`\nConversations: ${C.length} (min turns ${Math.min(...C.map(c => c.turns.length))})`);
    console.log(`RESULT ${passed} passed, ${failed} failed`);
    if (failed) { console.log('Failures:\n - ' + fails.join('\n - ')); process.exitCode = 1; }
})();
