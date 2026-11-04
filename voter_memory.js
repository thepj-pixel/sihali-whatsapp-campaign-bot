/**
 * Long-term per-voter memory (persisted inside the user_memory.json record as `user.memory`).
 *
 * After every voter message we extract facts — name, gender, age group, village/ward, family members,
 * concerns, objections, questions, commitment, family votes, language/dialect, last topic and an open
 * follow-up — with a rule-based extractor that always runs, plus an optional LLM JSON extractor whose
 * output is whitelisted field by field before it is merged.
 *
 * We also keep a rolling summary of older turns (anything beyond the last ~10 turns) so the prompt can
 * carry the whole relationship even after user_memory trims history, and the list of works already told
 * so the bot never repeats the same pitch.
 */
const kb = require('./knowledge_base.js');

const KEEP_TURNS = 10;
const MAX = { concerns: 8, objections: 6, questions: 8, family: 8, toldItems: 80, summaryChars: 900 };

const WARD_VILLAGE = { 1: 'sihali_khurd', 2: 'sihali_khurd', 3: 'sihali_khurd', 4: 'sihali_khurd', 5: 'sihali_khurd', 6: 'sihali_kalan', 7: 'sihali_kalan', 8: 'sihali_kalan', 9: 'hadahedi', 10: 'hadahedi', 11: 'hadahedi' };

function defaults() {
    return {
        v: 2, name: null, gender: null, genderSource: null, age: null, ageGroup: null, village: null, villageSource: null, ward: null,
        family: [], familyVotes: null, concerns: [], objections: [], questions: [], toldItems: [],
        told: { booth: false, pollDate: false, slipOffer: false, familyAsk: false, whoAmI: false },
        commitment: { status: null, at: null, quote: null },
        language: null, dialect: null, lastTopic: null, previousTopic: null,
        openFollowUp: null, summaryLines: [], summarizedUntil: 0,
        recall: {}, proactive: { lastAt: null, lastDay: null, unanswered: 0, sent: 0, lastLine: null },
        extractedBy: 'rules', updatedAt: null
    };
}

function ensure(user) {
    if (!user) return defaults();
    const d = defaults();
    const m = user.memory && typeof user.memory === 'object' ? user.memory : {};
    for (const k of Object.keys(d)) if (m[k] === undefined || m[k] === null && d[k] !== null && typeof d[k] === 'object') m[k] = d[k];
    m.told = { ...d.told, ...(m.told || {}) };
    m.commitment = { ...d.commitment, ...(m.commitment || {}) };
    m.proactive = { ...d.proactive, ...(m.proactive || {}) };
    user.memory = m;
    return m;
}

const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
const nowIso = () => new Date().toISOString();

// ---------------- rule extractors ----------------
const NAME_STOP = new Set(['kya', 'hai', 'h', 'है', 'हूँ', 'हूं', 'hoon', 'hu', 'hun', 'bhai', 'baba', 'ji', 'जी', 'भाई', 'sir', 'yaha', 'यहाँ', 'kaise', 'kaam', 'काम', 'vote', 'वोट', 'nahi', 'नहीं', 'nhi', 'dekh', 'bol', 'raha', 'rha', 'rahi', 'rhi', 'batana', 'batao', 'kar', 'karo', 'to', 'bhi', 'भी', 'kuch', 'कुछ', 'mat', 'parchi', 'slip', 'list', 'ward', 'gaon', 'abhay', 'singh', 'sihali', 'khurd', 'kalan', 'hadahedi', 'haraheri', 'ram', 'राम', 'namaste', 'ok', 'theek', 'thik', 'haan', 'ha', 'हाँ', 'pakka', 'पक्का', 'aur', 'और', 'se', 'से', 'ka', 'ki', 'का', 'की', 'ward', 'वार्ड', 'main', 'मैं', 'mera', 'मेरा', 'naam', 'नाम', 'yaha', 'yahan', 'यहाँ', 'gaon', 'गाँव', 'ghar', 'घर']);

function titleCase(s) { return s.replace(/\b([a-z])/g, c => c.toUpperCase()); }

function extractName(text, lastBotText) {
    const t = clean(text);
    const pats = [
        /(?:mera|meraa|mero|mhara|my)\s+(?:naam|name|nam)\s*(?:hai|h|he|is|:)?\s*([A-Za-z\u0900-\u097F]{2,20}(?:\s+[A-Za-z\u0900-\u097F]{2,20})?)/i,
        /(?:मेरा|म्हारा|मेरो)\s+नाम\s*(?:है|:)?\s*([\u0900-\u097F]{2,20}(?:\s+[\u0900-\u097F]{2,20})?)/,
        /(?:main|mai|mein|मैं)\s+([A-Za-z\u0900-\u097F]{2,20}(?:\s+[A-Za-z\u0900-\u097F]{2,20})?)\s+(?:bol raha|bol rha|bol rahi|bol rhi|बोल रहा|बोल रही)/i
    ];
    let cand = null;
    for (const p of pats) { const m = t.match(p); if (m) { cand = m[1]; break; } }
    if (!cand && lastBotText && /(naam|नाम)[^?]{0,30}\?/.test(lastBotText) && t.split(' ').length <= 3 && !/\d|\?/.test(t)) cand = t;
    if (!cand) return null;
    cand = cand.replace(/\s+(hai|h|he|है|hoon|hu|हूँ|ji|जी)$/i, '').trim();
    const parts = cand.toLowerCase().split(/\s+/);
    if (parts.some(p => NAME_STOP.has(p))) {
        // keep the leading clean part ("Ramesh hai" already stripped; "Ramesh ward" -> "Ramesh")
        const keep = [];
        for (const p of cand.split(/\s+/)) { if (NAME_STOP.has(p.toLowerCase())) break; keep.push(p); }
        cand = keep.join(' ');
    }
    if (!cand || cand.length < 2 || cand.length > 30) return null;
    if (kb.detectVillages(cand).length || kb.detectTopics(cand).length) return null;
    return /[a-z]/.test(cand) ? titleCase(cand.toLowerCase()) : cand;
}

const MALE_SELF = /(\b(raha|rha|karta|jaata|jata|aata|baitha|gaya|aaunga|aaunga|aunga|dunga|dhunga|dalunga|dalunga|lunga|bataunga|sochunga|rehta)\b\s*(hu|hoon|hun|h|हूँ)?\b|\b(dunga|dalunga|aaunga|aunga)\b|रहा हूँ|रहा हूं|करता हूँ|करता हूं|दूँगा|दूंगा|डालूँगा|डालूंगा|आऊँगा|आऊंगा|रहता हूँ)/i;
const FEMALE_SELF = /(\b(rahi|rhi|karti|jaati|jati|aati|baithi|gayi|gai|aaungi|aungi|dungi|dalungi|lungi|bataungi|sochungi|rehti)\b|रही हूँ|रही हूं|करती हूँ|करती हूं|दूँगी|दूंगी|डालूँगी|डालूंगी|आऊँगी|आऊंगी|रहती हूँ|main (ek )?(mahila|aurat|ladki|bahu|beti)|मैं (एक )?(महिला|औरत|लड़की|बहू|बेटी))/i;

function extractGender(text) {
    const t = String(text || '');
    // Bot addressing words like "didi" are about the bot, not the voter; only self-reference counts.
    const f = FEMALE_SELF.test(t), m = MALE_SELF.test(t);
    if (f && !m) return 'F';
    if (m && !f) return 'M';
    return null;
}

function extractAge(text) {
    const t = String(text || '');
    let m = t.match(/(?:umar|umr|umra|age|उम्र|उमर|आयु)\s*(?:hai|है|:)?\s*(\d{2})\b/i) || t.match(/\b(\d{2})\s*(?:saal|sal|varsh|years?|yrs|साल|वर्ष)\s*(?:ka|ki|ke|का|की|के|hai|है|ho|हो)/i);
    if (m) { const a = Number(m[1]); if (a >= 18 && a <= 105) return { age: a, ageGroup: a >= 60 ? 'elder' : a >= 38 ? 'middle' : 'young' }; }
    if (/(retired|retire ho|pension (leta|leti|milti)|budha|buddha hu|buzurg hu|bujurg hu|pote|poti|बुजुर्ग हूँ|बूढ़ा|बूढ़ी|रिटायर|पोते|पोती)/i.test(t)) return { age: null, ageGroup: 'elder' };
    if (/(student|college|padh raha|padh rahi|padhai kar|exam ki taiyari|naukri dhundh|कॉलेज|पढ़ाई कर|पढ़ रहा|पढ़ रही)/i.test(t)) return { age: null, ageGroup: 'young' };
    return null;
}

const POSS = '(?:mera|meri|mere|hamara|hamari|hamare|humara|humari|humare|mhara|mhari|mhare|मेरा|मेरी|मेरे|हमारा|हमारी|हमारे|म्हारा|म्हारी|म्हारे)\\s+(?:\\S+\\s+)?';
const RELATIONS = [
    ['wife', 'patni|wife|biwi|bivi|gharwali|ghar wali|lugai|पत्नी|बीवी|घरवाली|लुगाई'],
    ['husband', 'pati|husband|gharwala|ghar wale ji|पति|घरवाला'],
    ['son', 'beta|bete|son|chhora|छोरा|बेटा|बेटे'],
    ['daughter', 'beti|betiyan|daughter|chhori|छोरी|बेटी'],
    ['mother', 'maa|mummy|mataji|mata ji|amma|माँ|मां|माता जी|माताजी|अम्मा'],
    ['father', 'pitaji|pita ji|papa|father|bapu|बापू|पिताजी|पिता जी|पापा'],
    ['brother', 'bhai|bhaiya|भाई'],
    ['sister', 'behan|bahan|sister|बहन'],
    ['daughter_in_law', 'bahu|बहू'],
    ['grandfather', 'dada|dadaji|दादा'],
    ['grandmother', 'dadi|दादी'],
    ['uncle', 'tau|tauji|chacha|chachaji|ताऊ|चाचा'],
    ['aunt', 'tai|chachi|ताई|चाची']
];
const REL_HI = { wife: 'पत्नी', husband: 'पति', son: 'बेटा', daughter: 'बेटी', mother: 'माता जी', father: 'पिताजी', brother: 'भाई', sister: 'बहन', daughter_in_law: 'बहू', grandfather: 'दादा जी', grandmother: 'दादी जी', uncle: 'ताऊ/चाचा', aunt: 'ताई/चाची' };

function extractFamily(text) {
    const t = String(text || '');
    const out = [];
    for (const [rel, words] of RELATIONS) {
        const rx = new RegExp(POSS + '(' + words + ')(?:\\s+([A-Za-z\\u0900-\\u097F]{2,15}))?', 'i');
        const rx2 = new RegExp('(?:^|\\s)(' + words + ')\\s+(?:ka|ki|ke|का|की|के|bhi|भी)\\s+(?:vote|वोट)', 'i');
        const m = t.match(rx) || t.match(rx2);
        if (m) {
            let name = m[2] && !NAME_STOP.has(m[2].toLowerCase()) && !/^(ka|ki|ke|bhi|का|की|के|भी|vote|वोट|aur|और|ne|को|ko|se|से|hai|है|h)$/i.test(m[2]) ? m[2] : null;
            if (name && /[a-z]/.test(name)) name = titleCase(name.toLowerCase());
            out.push({ relation: rel, name });
        }
    }
    return out;
}

const NUM_WORDS = { ek: 1, do: 2, teen: 3, tin: 3, char: 4, chaar: 4, paanch: 5, panch: 5, chhe: 6, chhah: 6, saat: 7, aath: 8, nau: 9, das: 10, 'एक': 1, 'दो': 2, 'तीन': 3, 'चार': 4, 'पांच': 5, 'पाँच': 5, 'छह': 6, 'छः': 6, 'सात': 7, 'आठ': 8, 'नौ': 9, 'दस': 10 };
function extractFamilyVotes(text) {
    const t = String(text || '').toLowerCase();
    const num = '(\\d{1,2}|ek|do|teen|tin|char|chaar|paanch|panch|chhe|chhah|saat|aath|nau|das|एक|दो|तीन|चार|पांच|पाँच|छह|छः|सात|आठ|नौ|दस)';
    const m = t.match(new RegExp('(ghar|parivar|parivaar|family|kunba|khandan|gharwale|ghar wale|घर|परिवार|कुनबा|खानदान|घरवाले)[^\\d?]{0,25}?' + num + '\\s*(vote|वोट|log|लोग|members?|sadasya|सदस्य|jane|जने)'))
        || t.match(new RegExp('\\b' + num + '\\s*(vote|वोट)\\s*(hai|hain|h|हैं|है|pakke|pakka|पक्के|पक्का|milenge|मिलेंगे)'))
        || t.match(new RegExp('(saare|sare|सारे|sab)\\s*' + num + '\\s*(vote|वोट)'));
    if (!m) return null;
    const raw = m.slice(1).find(x => x && (/^\d+$/.test(x) || NUM_WORDS[x] !== undefined));
    const n = /^\d+$/.test(raw) ? Number(raw) : NUM_WORDS[raw];
    return n >= 1 && n <= 40 ? n : null;
}

const CONCERN_MARK = /(problem|pareshani|pareshan|dikkat|dikat|takleef|samasya|samashya|shikayat|nahi hai|nhi hai|nahi hua|nhi hua|nahi aata|nhi aata|nahi aati|nahi milti|nahi mil|toot|tut|tuti|tooti|kharab|band (hai|h|pada)|kab (banegi|banega|hoga|hogi|aayega|ayega)|chahiye|zaroorat|jarurat|bhar jata|bharta|kichad|keechad|gandagi|समस्या|परेशानी|दिक्कत|तकलीफ|शिकायत|नहीं है|नहीं हुआ|नहीं आता|नहीं आती|नहीं मिल|टूट|टूटी|खराब|बंद है|कब बनेगी|कब बनेगा|कब होगा|चाहिए|ज़रूरत|जरूरत|भर जाता|कीचड़|गंदगी)/i;
const OBJECTION_MARK = /(kuch nahi kiya|kuch nhi kiya|kuchh nahi kiya|kaam nahi hua|kaam nhi hua|koi kaam nahi|milte nahi|milte nhi|nazar nahi aate|dikhte nahi|jhooth|jhoot|jhoothe|jhuthe|chor|bhrasht|bekar|farzi|farji|wade jhoothe|kisi aur ko|dusre ko|doosre ko|unko nahi|vote nahi|कुछ नहीं किया|काम नहीं हुआ|कोई काम नहीं|मिलते नहीं|नज़र नहीं आते|झूठ|झूठे|चोर|भ्रष्ट|बेकार|फर्जी|किसी और को|दूसरे को|वोट नहीं)/i;
const QUESTION_MARK = /(\?|^(kya|kyu|kyun|kaise|kab|kahan|kidhar|kaun|kon|kitne)\b|\b(kya|kyu|kyun|kaise|kab|kahan|kidhar|kaun|kon)\b.*\b(hai|h|hoga|hogi|karoge|karenge|kiya|batao|bataiye)\b|(क्या|क्यों|कैसे|कब|कहाँ|कौन|कितने))/i;

const HARYANVI = /(\b(mhara|mhari|mhare|thara|thari|thare|ghana|ghani|manne|tanne|kade|kyukar|kyunkar|bera|sai\b|soon)\b|म्हारा|म्हारी|म्हारे|थारा|थारी|घणा|घणी|मन्ने|तन्ने|कड़े|क्यूँकर)/i;
const RAJASTHANI = /(\b(mharo|tharo|padharo|hukum|khamma|kathe|kai hai|kani)\b|म्हारो|थारो|पधारो|हुकुम|खम्मा|काई)/i;

function extractPlace(text) {
    const t = String(text || '');
    const ward = (t.match(/(?:ward|vard|वार्ड)\s*(?:no\.?|नं\.?|number|नंबर)?\s*[:#-]?\s*(\d{1,2})\b/i) || [])[1];
    const gali = (t.match(/([A-Za-z\u0900-\u097F]{2,20}\s+(?:wali gali|ki gali|की गली|वाली गली|mohalla|मोहल्ला|dhani|ढाणी|basti|बस्ती))/i) || [])[1];
    return { ward: ward ? Number(ward) : null, place: gali ? clean(gali) : null };
}

/**
 * Rule-based extraction. Returns a patch (never mutates).
 * @param {string} text  voter message
 * @param {object} ctx   { lastBotText, intent, topic }
 */
function extractRules(text, ctx = {}) {
    const t = clean(text);
    const patch = {};
    if (!t) return patch;
    const name = extractName(t, ctx.lastBotText);
    if (name) patch.name = name;
    const g = extractGender(t);
    if (g) patch.gender = g;
    const age = extractAge(t);
    if (age) Object.assign(patch, age);
    const villages = kb.detectVillages(t);
    const selfRef = /(se hu|se hoon|se hun|se h\b|से हूँ|से हूं|से हैं|ka rehne|ki rehne|ke rehne|rehta|rehti|rehte|रहता|रहती|रहते|hamara gaon|mera gaon|हमारा गाँव|मेरा गाँव|म्हारा गाम|mhara gaam|गाँव से|gaon se|me rehte|में रहते|wala hu|wali hu|वाला हूँ|वाली हूँ|se bol|से बोल|से हैं|से है)/i.test(t)
        || (villages.length === 1 && /(ward|वार्ड)/i.test(t)) || (villages.length === 1 && ctx.lastBotText && /(gaon|गाँव|village)/i.test(ctx.lastBotText));
    if (villages.length === 1 && selfRef) { patch.village = villages[0]; patch.villageSource = 'message'; }
    const place = extractPlace(t);
    if (place.ward && place.ward >= 1 && place.ward <= 11) patch.ward = place.ward;
    const fam = extractFamily(t);
    if (fam.length) patch.family = fam;
    const fv = extractFamilyVotes(t);
    if (fv) patch.familyVotes = fv;
    const topics = kb.detectTopics(t);
    const topic = kb.primaryTopic(t, ctx.topic && (topics.includes(ctx.topic) || !topics.length) ? ctx.topic : null) || topics[0] || null;
    if (topic && (CONCERN_MARK.test(t) || ctx.intent === 'complaint')) {
        patch.concern = { topic, text: t.slice(0, 160), ward: place.ward || null, place: place.place || null, village: villages[0] || null };
    }
    if (OBJECTION_MARK.test(t) || ['taunt', 'opposed'].includes(ctx.intent)) patch.objection = t.slice(0, 160);
    if (QUESTION_MARK.test(t)) patch.question = { text: t.slice(0, 160), topic };
    if (topic) patch.lastTopic = topic;
    const stage = { commit: 'committed', opposed: 'opposed', undecided: 'undecided', positive: 'leaning' }[ctx.intent];
    if (stage) patch.commitment = { status: stage, quote: t.slice(0, 120) };
    patch.language = /[\u0900-\u097F]/.test(t) ? 'hi' : (/[a-z]/i.test(t) ? 'en' : null);
    if (HARYANVI.test(t)) patch.dialect = 'haryanvi'; else if (RAJASTHANI.test(t)) patch.dialect = 'rajasthani';
    if (patch.concern && (patch.concern.ward || patch.concern.place || /(kab|कब)/i.test(t))) {
        patch.openFollowUp = { topic, text: t.slice(0, 160), ward: patch.concern.ward };
    }
    return patch;
}

// ---------------- LLM extraction (optional) ----------------
function buildExtractionPrompt(text, user) {
    return [
        'Extract facts about the VOTER from their latest WhatsApp message. Output ONLY compact JSON, no prose.',
        'Keys (omit unknown): name (string), gender ("M"|"F", only if the voter refers to themself, e.g. verb endings raha/rahi, रहा/रही), ageGroup ("young"|"middle"|"elder"), age (number),',
        'village ("sihali_khurd"|"sihali_kalan"|"hadahedi", only if they say they live there), ward (1-11), family ([{relation, name}] relation in wife,husband,son,daughter,mother,father,brother,sister,daughter_in_law,grandfather,grandmother,uncle,aunt),',
        'familyVotes (number of votes in their household they mention), concern ({topic, text, ward}) topic in ' + Object.keys(kb.TOPIC_SYNONYMS).join(',') + ',',
        'objection (string, their criticism/objection), question (string), commitment ("committed"|"leaning"|"undecided"|"opposed"), dialect ("haryanvi"|"rajasthani").',
        'Known so far: ' + JSON.stringify(cardObject(user)).slice(0, 600),
        'Message: ' + JSON.stringify(String(text || '').slice(0, 400))
    ].join('\n');
}

const TOPICS = new Set(Object.keys(kb.TOPIC_SYNONYMS));
const RELS = new Set(RELATIONS.map(r => r[0]));
function parseExtraction(raw) {
    if (!raw) return null;
    let s = String(raw).trim();
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a < 0 || b <= a) return null;
    let o;
    try { o = JSON.parse(s.slice(a, b + 1)); } catch (e) { return null; }
    const p = {};
    const str = (v, n = 80) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
    if (str(o.name, 30) && !/\d/.test(o.name)) p.name = str(o.name, 30);
    if (o.gender === 'M' || o.gender === 'F') p.gender = o.gender;
    if (['young', 'middle', 'elder'].includes(o.ageGroup)) p.ageGroup = o.ageGroup;
    if (Number(o.age) >= 18 && Number(o.age) <= 105) p.age = Number(o.age);
    if (['sihali_khurd', 'sihali_kalan', 'hadahedi'].includes(o.village)) { p.village = o.village; p.villageSource = 'llm'; }
    if (Number(o.ward) >= 1 && Number(o.ward) <= 11) p.ward = Number(o.ward);
    if (Array.isArray(o.family)) p.family = o.family.filter(f => f && RELS.has(f.relation)).slice(0, 6).map(f => ({ relation: f.relation, name: str(f.name, 20) }));
    if (Number(o.familyVotes) >= 1 && Number(o.familyVotes) <= 40) p.familyVotes = Number(o.familyVotes);
    if (o.concern && TOPICS.has(o.concern.topic)) p.concern = { topic: o.concern.topic, text: str(o.concern.text, 160) || '', ward: Number(o.concern.ward) >= 1 && Number(o.concern.ward) <= 11 ? Number(o.concern.ward) : null };
    if (str(o.objection, 160)) p.objection = str(o.objection, 160);
    if (str(o.question, 160)) p.question = { text: str(o.question, 160), topic: null };
    if (['committed', 'leaning', 'undecided', 'opposed'].includes(o.commitment)) p.commitment = { status: o.commitment, quote: null };
    if (['haryanvi', 'rajasthani'].includes(o.dialect)) p.dialect = o.dialect;
    return p;
}

// ---------------- merge ----------------
const STAGE_RANK = { opposed: -1, undecided: 0, leaning: 1, committed: 2 };

function merge(user, patch, source = 'rules') {
    const m = ensure(user);
    if (!patch) return m;
    const at = nowIso();
    if (patch.name && !m.name) m.name = patch.name;
    if (patch.gender && (!m.gender || m.genderSource !== 'voter_record')) { m.gender = patch.gender; m.genderSource = source === 'llm' ? 'llm' : 'message'; }
    if (patch.age) m.age = patch.age;
    if (patch.ageGroup) m.ageGroup = patch.ageGroup;
    if (patch.ward) {
        m.ward = patch.ward;
        if (!m.village && WARD_VILLAGE[patch.ward]) { m.village = WARD_VILLAGE[patch.ward]; m.villageSource = 'ward(inferred)'; }
    }
    if (patch.village) { m.village = patch.village; m.villageSource = patch.villageSource || source; }
    for (const f of patch.family || []) {
        const ex = m.family.find(x => x.relation === f.relation && (!f.name || !x.name || x.name === f.name));
        if (ex) { if (f.name && !ex.name) ex.name = f.name; }
        else m.family.push({ relation: f.relation, name: f.name || null, at });
    }
    m.family = m.family.slice(-MAX.family);
    // inferred: a voter whose son/daughter/daughter-in-law votes is at least middle-aged (only if nothing better known)
    if (!m.ageGroup && !m.age && m.family.some(f => ['son', 'daughter', 'daughter_in_law'].includes(f.relation))) { m.ageGroup = 'middle'; m.ageSource = 'inferred(family)'; }
    if (patch.familyVotes) m.familyVotes = patch.familyVotes;
    const OWN = /(hamar|humar|mer[ae]|apn[ae]|mhar|हमार|मेर|अपन|म्हार)/i;
    if (patch.concern && patch.concern.topic && !patch.concern.ward && m.ward && OWN.test(patch.concern.text || '')) patch.concern.ward = m.ward;
    if (patch.openFollowUp && !patch.openFollowUp.ward && m.ward && OWN.test(patch.openFollowUp.text || '')) patch.openFollowUp.ward = m.ward;
    if (patch.concern && patch.concern.topic) {
        const ex = m.concerns.find(c => c.topic === patch.concern.topic);
        if (ex) { ex.prevText = ex.text; ex.text = patch.concern.text || ex.text; ex.ward = patch.concern.ward || ex.ward; ex.place = patch.concern.place || ex.place; ex.at = at; ex.count = (ex.count || 1) + 1; }
        else m.concerns.push({ ...patch.concern, at, status: 'open', count: 1 });
        m.concerns = m.concerns.slice(-MAX.concerns);
    }
    if (patch.objection && !m.objections.some(o => o.text === patch.objection)) { m.objections.push({ text: patch.objection, at }); m.objections = m.objections.slice(-MAX.objections); }
    if (patch.question && patch.question.text) { m.questions.push({ ...patch.question, at }); m.questions = m.questions.slice(-MAX.questions); }
    if (patch.commitment && patch.commitment.status) {
        const cur = m.commitment.status;
        const next = patch.commitment.status;
        // Never silently downgrade a committed voter on a soft signal; an explicit opposed statement still counts.
        if (!cur || next === 'opposed' || next === 'committed' || (STAGE_RANK[next] >= (STAGE_RANK[cur] ?? -2)) || cur === 'opposed') {
            m.commitment = { status: next, at, quote: patch.commitment.quote || m.commitment.quote };
        }
    }
    if (patch.lastTopic && patch.lastTopic !== m.lastTopic) { m.previousTopic = m.lastTopic; m.lastTopic = patch.lastTopic; }
    if (patch.language) m.language = patch.language;
    if (patch.dialect) m.dialect = patch.dialect;
    if (patch.openFollowUp && patch.openFollowUp.topic) {
        m.openFollowUp = { ...patch.openFollowUp, createdAt: at, dueAt: new Date(Date.now() + 18 * 3600e3).toISOString(), status: 'open' };
    }
    if (source === 'llm') m.extractedBy = 'rules+llm';
    m.updatedAt = at;
    return m;
}

/** Called for every voter message: reset proactive "unanswered" counter, extract and merge. */
function updateFromVoterMessage(user, text, ctx = {}) {
    const m = ensure(user);
    m.proactive.unanswered = 0;
    m.proactive.lastUserAt = nowIso();
    const patch = extractRules(text, ctx);
    merge(user, patch, 'rules');
    // keep the legacy top-level fields in sync so the CRM/dashboard shows them
    if (m.name && (!user.name || /ग्रामवासी|^Voter$|^contact$/i.test(user.name))) user.name = m.name;
    if (m.ward && !user.ward) user.ward = m.ward;
    return { memory: m, patch };
}

async function llmExtract(user, text, llmJson, budgetMs = 2500) {
    if (!llmJson || String(text || '').trim().length < 8) return null;
    try {
        const raw = await Promise.race([llmJson(buildExtractionPrompt(text, user)), new Promise(r => setTimeout(() => r(null), budgetMs))]);
        const p = parseExtraction(raw);
        if (p) merge(user, p, 'llm');
        return p;
    } catch (e) { return null; }
}

// ---------------- told items / recall ----------------
function markTold(user, ids) {
    const m = ensure(user);
    for (const id of ids || []) if (id && !m.toldItems.includes(id)) m.toldItems.push(id);
    m.toldItems = m.toldItems.slice(-MAX.toldItems);
}

/** The most relevant earlier concern to reference (not the one being discussed right now, unless asked). */
function concernToRecall(user, { currentTopic = null, allowSame = false, preferTopic = null } = {}) {
    const m = ensure(user);
    const list = m.concerns.slice().reverse();
    if (preferTopic) { const hit = list.find(c => c.topic === preferTopic); if (hit) return hit; }
    return list.find(c => allowSame || c.topic !== currentTopic) || null;
}

function recallPhrase(user, l = 'hi', opts = {}) {
    const c = concernToRecall(user, opts);
    if (!c) return null;
    const m = ensure(user);
    const turn = (m.recall.turn || 0);
    const last = m.recall[c.topic];
    if (!opts.force && last !== undefined && turn - last < 3) return null; // don't keep reciting the same memory
    m.recall[c.topic] = turn;
    m.recallCount = (m.recallCount || 0) + 1;
    const where = c.ward ? (l === 'hi' ? `वार्ड ${c.ward} की ` : `ward ${c.ward} ki `) : (c.place ? c.place + (l === 'hi' ? ' की ' : ' ki ') : '');
    const label = kb.topicLabel(c.topic, l);
    const variants = l === 'hi'
        ? [`आपने ${where}${label} वाली बात बताई थी—वो अभय सिंह जी की प्राथमिकता सूची में दर्ज है।`,
            `${where}${label} वाली आपकी बात मैं भूली नहीं हूँ—वो रजिस्टर में दर्ज है, बताई थी आपने।`,
            `और हाँ, ${where}${label} वाली जो बात आपने बताई थी, उस पर टीम की नज़र है।`]
        : [`Aapne ${where}${label} wali baat batayi thi—wo Abhay Singh ji ki priority list me darj hai.`,
            `${where}${label} wali aapki baat main bhooli nahi hoon—register me darj hai, batayi thi aapne.`,
            `Aur haan, ${where}${label} wali jo baat aapne batayi thi, us par team ki nazar hai.`];
    const v = variants[(m.recallCount - 1) % variants.length];
    return v.charAt(0).toUpperCase() + v.slice(1);
}

function tickTurn(user) { const m = ensure(user); m.recall.turn = (m.recall.turn || 0) + 1; }

// ---------------- rolling summary ----------------
/**
 * Fold turns older than the last KEEP_TURNS into memory.summaryLines (compact, ≤ 900 chars).
 * Works from createdAt so turns already folded are never folded twice, even after history is trimmed.
 */
function rollSummary(user, keep = KEEP_TURNS) {
    const m = ensure(user);
    const h = Array.isArray(user.history) ? user.history : [];
    if (h.length <= keep) return m.summaryLines;
    const older = h.slice(0, -keep).filter(x => (x.createdAt || 0) > (m.summarizedUntil || 0) && x.text);
    for (const x of older) {
        const txt = clean(x.text).replace(/[\n\r]+/g, ' ');
        if (/^📇|\[Line contact card|\[Auto Anti-Ban/.test(txt)) continue;
        m.summaryLines.push((x.role === 'user' ? 'V: ' : 'B: ') + txt.slice(0, x.role === 'user' ? 90 : 60));
        m.summarizedUntil = Math.max(m.summarizedUntil || 0, x.createdAt || 0);
    }
    while (m.summaryLines.join(' | ').length > MAX.summaryChars && m.summaryLines.length > 1) m.summaryLines.shift();
    return m.summaryLines;
}

function summaryText(user) { return ensure(user).summaryLines.join(' | '); }

// ---------------- memory card for prompts ----------------
function cardObject(user) {
    const m = ensure(user);
    const o = {};
    if (m.name || user.name) o.name = m.name || user.name;
    if (m.gender) o.gender = m.gender;
    if (m.ageGroup || m.age) o.age = m.age || m.ageGroup;
    if (m.village) o.village = kb.villageName(m.village, 'en');
    if (m.ward || user.ward) o.ward = m.ward || user.ward;
    if (m.family.length) o.family = m.family.map(f => f.relation + (f.name ? ':' + f.name : ''));
    if (m.familyVotes) o.familyVotes = m.familyVotes;
    if (m.commitment.status) o.commitment = m.commitment.status;
    if (m.concerns.length) o.concerns = m.concerns.map(c => `${c.topic}${c.ward ? '@ward' + c.ward : ''}: "${c.text.slice(0, 70)}"`);
    if (m.objections.length) o.objections = m.objections.slice(-3).map(x => x.text.slice(0, 80));
    if (m.questions.length) o.recentQuestions = m.questions.slice(-3).map(x => x.text.slice(0, 80));
    if (m.toldItems.length) o.alreadyTold = m.toldItems.slice(-12);
    if (m.openFollowUp && m.openFollowUp.status === 'open') o.openFollowUp = `${m.openFollowUp.topic}${m.openFollowUp.ward ? ' ward ' + m.openFollowUp.ward : ''}`;
    if (m.lastTopic) o.lastTopic = m.lastTopic;
    o.language = m.language === 'en' ? 'hinglish' : (m.language === 'hi' ? 'devanagari' : 'unknown');
    if (m.dialect) o.dialect = m.dialect;
    if (user.lastFoundVoter) o.voterSlipFound = true;
    return o;
}

function buildCard(user) {
    const o = cardObject(user);
    return Object.entries(o).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join('; ') : v}`).join('\n');
}

function familyLabel(rel) { return REL_HI[rel] || rel; }

module.exports = {
    KEEP_TURNS, WARD_VILLAGE, ensure, extractRules, extractName, extractGender, extractAge, extractFamily, extractFamilyVotes,
    buildExtractionPrompt, parseExtraction, merge, updateFromVoterMessage, llmExtract, markTold, concernToRecall, recallPhrase, tickTurn,
    rollSummary, summaryText, cardObject, buildCard, familyLabel
};
