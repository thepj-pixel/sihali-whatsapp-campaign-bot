/**
 * Knowledge retrieval over the campaign PARCHAS — the ONLY allowed source of claims about the candidate,
 * the works done, the future sankalp and the poll.
 *
 *   rag_vault/parcha_facts.json  (structured by hand from rag_vault/PARCHA_1_2PAGE.md + PARCHA_2_CATEGORY_WISE.md)
 *     major[]   -> 12 major works done "पिछले कार्यकाल में 5 वर्षों में"         (type: done,   kind: major)
 *     sankalp[] -> 15 future sankalp                                              (type: future, kind: sankalp)
 *     details[] -> category-wise works with places, incl. interlocking lanes,
 *                  borewells and sewer lines                                      (type: done,   kind: detail)
 *
 * Rules enforced here:
 *   - no budgets / rupee figures ever leave this module (sanitize())
 *   - the public rendering of an item never names a private individual; the parcha's landmark wording
 *     (hiFull) is used only when the voter themself names that lane / landmark (matchLandmarks())
 *   - lane-level interlocking items (laneOnly) are never volunteered — only returned for a landmark match
 *   - work COUNTS are never rendered
 *   - the old sheets live in rag_vault/retired/ and are NOT read
 */
const fs = require('fs');
const path = require('path');

const VAULT = process.env.RAG_VAULT_DIR || path.join(__dirname, 'rag_vault');
const FACTS_FILE = path.join(VAULT, 'parcha_facts.json');

// ---------------- villages ----------------
const VILLAGES = [
    { key: 'sihali_khurd', hi: 'सिहाली खुर्द', en: 'Sihali Khurd', rx: /(सिहाली\s*खुर्द|छोटी\s*सिहाली|sihali\s*khurd|sihali\s*khurad|sihali\s*khu?rd|chhoti\s*sihali|choti\s*sihali)/i },
    { key: 'sihali_kalan', hi: 'सिहाली कलां', en: 'Sihali Kalan', rx: /(सिहाली\s*कलां|सिहाली\s*कला|बड़ी\s*सिहाली|बडी\s*सिहाली|sihali\s*kal[ae]n|sihali\s*kala\b|badi\s*sihali|bari\s*sihali|badi\s*siyali)/i },
    { key: 'hadahedi', hi: 'हाड़ाहेड़ी', en: 'Hadahedi', rx: /(हाड़ाहेड़ी|हाडाहेडी|हाड़ाहेडी|हाडाहेड़ी|हड़ाहेड़ी|हाड़ा\s*हेड़ी|haraheri|hadaheri|hadahedi|harahedi|hadhedi|harheri|hara\s*heri|hada\s*hedi)/i }
];

function detectVillages(text) {
    const t = String(text || '');
    return VILLAGES.filter(v => v.rx.test(t)).map(v => v.key);
}
function villageName(key, l = 'hi') {
    const v = VILLAGES.find(x => x.key === key);
    return v ? (l === 'hi' ? v.hi : v.en) : '';
}

// ---------------- topics & synonyms (Hindi / Hinglish / dialect) ----------------
const TOPIC_SYNONYMS = {
    water: /(\bpani\b|paani|panee|\bwater\b|\bjjm\b|jal jeevan|jal jivan|\bnal\b|nal connection|\btanki|\bboring\b|borewell|bore well|tubewell|peyjal|meetha pani|पानी|पाणी|जल जीवन|जेजेएम|\sनल|^नल|टंकी|बोरवेल|बोरिंग|ट्यूबवेल|पेयजल|मीठा पानी)/i,
    road: /(sadak|sadke|sadako|sarak|\broad\b|\brasta\b|raasta|raste\b|\bmarg\b|damar|daamar|gaddh?[ae]|khadd?a|सड़क|सडक|रास्त|मार्ग|डामर|गड्ढ|खड्ड)/i,
    cc_lanes: /(interlock|cc road|cc sadak|cc wali|\bcc\b|c\.c\.|khadanja|kharanja|\btiles?\b|इंटरलॉकिंग|इंटरलाकिंग|सीसी|सी\.सी\.|खड़ंजा|टाइल)/i,
    drainage: /(\bnali\b|naali|naliyan|naaliyan|\bdrain|sewer|ganda pani|gandaa pani|gande pani|gande paani|ganda paani|keechad|kichad|kichar|jal ?bharav|paani bhar|pani bhar|नाली|नालियां|नालियों|सीवर|गंदा पानी|गंदे पानी|कीचड़|जलभराव|पानी भर|निकासी)/i,
    cleanliness: /(safai|saaf safai|kachra|kooda|\bkuda\b|swachh|gandagi|सफाई|सफ़ाई|कचरा|कूड़ा|स्वच्छ|गंदगी)/i,
    streetlight: /(street ?light|road ?light|khambe? (par|pe|me) light|gali me light|gali mein light|andhera|andhere|solar light|स्ट्रीट लाइट|रोड लाइट|रोड लाईट|गली में लाइट|अंधेरा|अँधेरा)/i,
    bijli: /(bijli|\blight (nahi|nhi|nai|chali|gayab|kat)|transformer|tranformer|voltage|\bcurrent nahi|बिजली|ट्रांसफार्मर|ट्रांसफॉर्मर|वोल्टेज|लाइट नहीं)/i,
    health: /(hospital|aspatal|asptal|haspatal|doctor|daktar|dactar|\bilaj|ilaaj|dispensary|swasthya|\bnurse|chikitsa|phc\b|अस्पताल|हस्पताल|डॉक्टर|डाक्टर|इलाज|स्वास्थ्य|चिकित्सा|आयुर्वेद)/i,
    ambulance: /(ambulance|emergency|एम्बुलेंस|एंबुलेंस|आपातकाल)/i,
    medicine: /(jan aushadhi|generic|sasti dawai|(dawai|dawa|davai|dava)(i)?\s*(bahut |bohot |kaafi |ghani )?(mehngi|mahangi|mehangi|nahi milti|nhi milti)|mehngi dawa|जन औषधि|जेनेरिक|सस्ती दवा|(दवाई|दवा)\s*(बहुत |काफी |घणी )?(महंगी|महँगी|नहीं मिलती)|महंगी दवा)/i,
    animal: /(pashu|janwar|\bgaay\b|\bgay ko\b|bhains|\bvet\b|पशु|जानवर|गाय|भैंस)/i,
    education: /(school|skool|college|library|padhai|padhaai|padhne|padhna|padhaayi|ladkiyon ki padh|chhatra|chhatraon|पढ़ने|पढ़ना|छात्र|kitab|teacher|master ji nahi|shiksha|स्कूल|विद्यालय|कॉलेज|लाइब्रेरी|पढ़ाई|पढाई|किताब|शिक्षा|अध्यापक)/i,
    youth: /(\byuva|naujawan|\byouth\b|\bkhel\b|khelkud|khelne|\bground\b|maidan|\bgym\b|stadium|running|\btrack\b|cricket|kabaddi|volleyball|basketball|badminton|युवा|नौजवान|खेल|मैदान|जिम|स्टेडियम|रनिंग|ट्रैक|क्रिकेट|कबड्डी)/i,
    jobs: /(naukri|\bjob\b|rozgar|rojgar|berozgar|berojgar|नौकरी|रोजगार|रोज़गार|बेरोजगार)/i,
    farming: /(kisan|kisaan|kheti|\bkhet\b|fasal|\bkhad\b|khaad|urea|\bdap\b|\bbeej\b|krishi|sarson|bajra|बाजरा|सरसों|किसान|खेती|खेत|फसल|खाद|यूरिया|बीज|कृषि)/i,
    patwar: /(patwar|patwari|jameen|zameen|jamin|namantaran|intkal|\bnakal\b|पटवार|पटवारी|जमीन|ज़मीन|नामांतरण|इंतकाल|नकल)/i,
    seniors: /(buzurg|bujurg|budhe log|chaupal|बुजुर्ग|बुज़ुर्ग|चौपाल)/i,
    pension: /(pension|penshan|पेंशन|पेन्शन)/i,
    ration: /(ration|rashan|raashan|rasan|राशन|रासन)/i,
    housing: /(\bawas\b|aawas|pm awas|pradhan ?mantri awas|kachcha makan|kacha makan|makan nahi|आवास|कच्चा मकान)/i,
    safety: /(suraksha|\bchori\b|\bcctv\b|camera|ladkiyon ki|betiyon ki|सुरक्षा|चोरी|सीसीटीवी|कैमरा)/i,
    cremation: /(shmashan|smashan|shamshan|mokshdham|moksh dham|marghat|श्मशान|मोक्षधाम|मरघट)/i,
    pond: /(johad|johar|talab|talaab|\bpond\b|जोहड़|जोहड|तालाब)/i,
    ashram: /(ashram|kundandas|kundan das|amrit sarovar|आश्रम|कुन्दनदास|कुंदनदास|कुन्दन दास|अमृत सरोवर)/i,
    sanitation: /(toilet|shauchalay|sulabh|शौचालय|सुलभ|टॉयलेट)/i
};
const TOPIC_LABEL = {
    hi: { water: 'पानी', road: 'सड़क', cc_lanes: 'गली की इंटरलॉकिंग', drainage: 'नाली-निकासी', cleanliness: 'सफ़ाई', streetlight: 'रोड लाइट', bijli: 'बिजली', health: 'अस्पताल-इलाज', ambulance: 'एम्बुलेंस', medicine: 'दवाई', animal: 'पशु इलाज', education: 'पढ़ाई-स्कूल', youth: 'खेल-युवा', jobs: 'रोज़गार', farming: 'खेती-किसानी', patwar: 'ज़मीन-पटवार', seniors: 'बुज़ुर्गों', pension: 'पेंशन', ration: 'राशन', housing: 'आवास-मकान', safety: 'सुरक्षा', cremation: 'मोक्षधाम', pond: 'जोहड़', ashram: 'आश्रम', sanitation: 'शौचालय' },
    en: { water: 'paani', road: 'sadak', cc_lanes: 'gali ki interlocking', drainage: 'naali-nikasi', cleanliness: 'safai', streetlight: 'road light', bijli: 'bijli', health: 'aspatal-ilaaj', ambulance: 'ambulance', medicine: 'dawai', animal: 'pashu ilaaj', education: 'padhai-school', youth: 'khel-yuva', jobs: 'rozgar', farming: 'kheti-kisani', patwar: 'zameen-patwar', seniors: 'buzurgon', pension: 'pension', ration: 'ration', housing: 'awas-makan', safety: 'suraksha', cremation: 'mokshdham', pond: 'johad', ashram: 'ashram', sanitation: 'shauchalay' }
};

function detectTopics(text) {
    const t = String(text || '');
    return Object.keys(TOPIC_SYNONYMS).filter(k => TOPIC_SYNONYMS[k].test(t));
}
// Most specific first: "दवाई महंगी" -> medicine (not health), "गंदा पानी" -> drainage (not water)
const SPECIFIC = ['medicine', 'ambulance', 'pension', 'ration', 'housing', 'patwar', 'animal', 'streetlight', 'bijli', 'cc_lanes', 'drainage', 'cleanliness', 'jobs', 'seniors', 'safety', 'cremation', 'ashram', 'sanitation', 'pond'];
function primaryTopic(text, hint = null) {
    const ts = detectTopics(text);
    const sp = SPECIFIC.find(s => ts.includes(s));
    if (sp) return sp;
    if (hint && ts.includes(hint)) return hint;
    return ts[0] || hint || null;
}
function topicLabel(topic, l = 'hi') { return (TOPIC_LABEL[l === 'hi' ? 'hi' : 'en'] || {})[topic] || topic || ''; }

// ---------------- samasya categories (dashboard) ----------------
const CATEGORY_OF_TOPIC = { water: 'paani', road: 'sadak', cc_lanes: 'sadak', drainage: 'naali', cleanliness: 'safai', streetlight: 'road_light', bijli: 'bijli', pension: 'pension', ration: 'ration', education: 'school', health: 'hospital', medicine: 'hospital', ambulance: 'hospital', patwar: 'jameen_patwari', farming: 'kheti', safety: 'suraksha', animal: 'pashu', housing: 'awas', seniors: 'buzurg', youth: 'khel_yuva', jobs: 'rozgar', cremation: 'mokshdham', pond: 'johad', sanitation: 'shauchalay', ashram: 'ashram' };
const CATEGORY_LABEL = { paani: 'पानी', sadak: 'सड़क/गली', naali: 'नाली', safai: 'सफ़ाई', road_light: 'रोड लाइट', bijli: 'बिजली', pension: 'पेंशन', ration: 'राशन', school: 'स्कूल', hospital: 'अस्पताल/दवा', jameen_patwari: 'ज़मीन/पटवारी', kheti: 'खेती', suraksha: 'सुरक्षा', pashu: 'पशु', awas: 'आवास', buzurg: 'बुज़ुर्ग', khel_yuva: 'खेल/युवा', rozgar: 'रोज़गार', mokshdham: 'मोक्षधाम', johad: 'जोहड़', shauchalay: 'शौचालय', ashram: 'आश्रम', other: 'अन्य' };
function samasyaCategory(topic) { return CATEGORY_OF_TOPIC[topic] || 'other'; }

/** The parcha sankalp that matches a voter's problem (null when the parcha has none — never invent one). */
const SANKALP_OF_TOPIC = { water: 'F2', cc_lanes: 'F6', drainage: 'F5', cleanliness: 'F5', streetlight: 'F4', safety: 'F3', health: 'F7', medicine: 'F12', ambulance: 'F15', patwar: 'F10', farming: 'F11', seniors: 'F13', youth: 'F1' };
function sankalpFor(topic, { village = null, text = '' } = {}) {
    if (!topic) return null;
    let id = SANKALP_OF_TOPIC[topic] || null;
    if (topic === 'road') {
        const v = detectVillages(text);
        id = (v.includes('hadahedi') && (v.includes('sihali_khurd') || village === 'sihali_khurd')) || (village === 'hadahedi' && v.includes('sihali_khurd')) ? 'F9' : 'F6';
    }
    if (topic === 'health' && village === 'hadahedi') id = 'F8';
    if (topic === 'education') id = (village === 'hadahedi' || village === 'sihali_kalan') ? 'F14' : null;
    return id ? getItem(id) : null;
}

/** Remove any budget / rupee figure. Parcha rule: never mention budgets. */
function sanitize(text) {
    return String(text || '')
        .replace(/(₹|rs\.?|inr)\s*[\d,.]+\s*(lakh|लाख|crore|करोड़|हज़ार|हजार)?/gi, '')
        .replace(/[\d,.]+\s*(लाख|करोड़|हज़ार रुपये|हजार रुपये|रुपये|रुपए|रुपया|lakh|crore|rupees?|rupaye)/gi, '')
        .replace(/(बजट|लागत|budget|lagat)\s*[:：-]?\s*[\d,.]+/gi, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

let CACHE = null;
function readFacts() {
    try { return JSON.parse(fs.readFileSync(FACTS_FILE, 'utf8')); } catch (e) { console.error('[KB] parcha_facts.json missing/invalid:', e.message); return { major: [], sankalp: [], details: [] }; }
}

function load(force = false) {
    if (CACHE && !force) return CACHE;
    const raw = readFacts();
    const items = [];
    const push = (w, type, kind) => {
        const hi = sanitize(w.hi), roman = sanitize(w.roman);
        const hiFull = w.hiFull ? sanitize(w.hiFull) : null, romanFull = w.romanFull ? sanitize(w.romanFull) : null;
        const title = w.title_hi || hi.split(/[।,]/)[0];
        items.push({
            id: w.id, type, kind, status: w.status || (type === 'future' ? 'sankalp' : 'done'), category: w.category || null, parent: w.parent || null,
            title, desc: hi, hi, roman, hiFull, romanFull,
            text: [title, hi, hiFull].filter(Boolean).join(' — '),
            topics: w.topics || [], villages: w.villages || [], landmarks: (w.landmarks || []).map(s => String(s).toLowerCase()),
            laneOnly: !!w.laneOnly, location: '', held: false, heldReason: null, source: 'parcha'
        });
    };
    (raw.major || []).forEach(w => push(w, 'done', 'major'));
    (raw.sankalp || []).forEach(w => push(w, 'future', 'sankalp'));
    (raw.details || []).forEach(w => push(w, 'done', 'detail'));
    CACHE = { items, byId: Object.fromEntries(items.map(i => [i.id, i])), facts: raw, loadedAt: new Date().toISOString() };
    return CACHE;
}
function facts() { return load().facts; }

function tokens(text) {
    return String(text || '').toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .split(/\s+/)
        .filter(w => w.length >= 3 && !STOP.has(w));
}
const STOP = new Set(['kya', 'hai', 'hain', 'aur', 'the', 'kab', 'kaise', 'ke', 'liye', 'mein', 'hamare', 'hamari', 'abhay', 'singh', 'baba', 'kaam', 'kiya', 'karenge', 'karoge', 'gaon', 'wala', 'wali', 'bhi', 'nahi', 'nhi', 'main', 'road', 'ghar', 'hua', 'bana', 'bani', 'banwaya', 'gaya', 'gayi', 'diya', 'diye',
    'क्या', 'है', 'हैं', 'और', 'के', 'लिए', 'में', 'हमारे', 'हमारी', 'अभय', 'सिंह', 'बाबा', 'काम', 'किया', 'करेंगे', 'गाँव', 'गांव', 'वाला', 'वाली', 'भी', 'नहीं', 'कार्य', 'निर्माण', 'हेतु', 'तथा', 'एवं', 'का', 'की', 'को', 'से', 'तक', 'पर', 'घर', 'गया', 'गई', 'गईं', 'करवाया', 'बनवाया', 'बनवाई', 'मेन', 'मुख्य', 'सड़क', 'रोड']);

const LOCATION_CONTEXT = /(gali|galli|ghar|rasta|raasta|raste|sadak|road|interlock|tiles?|naali|nali|sewer|bore|boring|ke paas|ke pas|ki or|ki taraf|mohalla|basti|wale|wali|गली|घर|रास्त|सड़क|इंटरलॉकिंग|टाइल|नाली|सीवर|बोर|के पास|की ओर|की तरफ|मोहल्ल|बस्ती|वाले|वाली)/i;
/** Items whose landmark the voter named (their own lane/place). Needs a location word so a bare name never matches. */
function matchLandmarks(message) {
    const t = String(message || '').toLowerCase();
    if (!LOCATION_CONTEXT.test(t)) return [];
    return load().items.filter(i => i.landmarks.length && i.landmarks.some(lm => lm.length >= 3 && t.includes(lm)));
}

/**
 * @param {string} message
 * @param {object} [opts] { k=4, exclude: ids already told, type: 'done'|'future'|null, topics: [] hints, villages: [] voter's village }
 */
function retrieve(message, opts = {}) {
    const { items } = load();
    const k = Math.max(1, Math.min(opts.k || 4, 5));
    const exclude = new Set(opts.exclude || []);
    const msgTopics = detectTopics(message);
    const hintTopics = (opts.topics || []).filter(Boolean);
    const msgVillages = detectVillages(message);
    const voterVillages = (opts.villages || []).filter(Boolean);
    const toks = tokens(message);
    const landmarkHits = new Set(matchLandmarks(message).map(i => i.id));
    const wantFuture = opts.type === 'future' || /(aage|आगे|sankalp|संकल्प|vaada|vada|wada|वादा|karoge|karenge|करोगे|करेंगे|plan|manifesto|kab banega|कब बनेगा|kab hoga|कब होगा|kab banegi|कब बनेगी)/i.test(message);
    const wantDone = opts.type === 'done' || /(kya kiya|kiya hai|karwaya|hua\b|hua kya|हुआ|किया|करवाया|बना|bana)/i.test(message);
    const scored = [];
    for (const it of items) {
        if (it.laneOnly && !landmarkHits.has(it.id)) continue; // lane items only when the voter names the lane
        let s = 0;
        if (landmarkHits.has(it.id)) s += 12;
        for (const t of it.topics) {
            if (msgTopics.includes(t)) s += 6;
            else if (hintTopics.includes(t)) s += 3;
        }
        const hay = (it.hi + ' ' + it.roman).toLowerCase();
        for (const w of toks) if (hay.includes(w)) s += 1;
        for (const v of it.villages) {
            if (msgVillages.includes(v)) s += 2.5;
            else if (voterVillages.includes(v)) s += 1;
        }
        if (opts.type && it.type !== opts.type) s -= 4;
        if (wantFuture && it.type === 'future') s += 2;
        if (wantDone && !wantFuture && it.type === 'done') s += 1.5;
        if (it.kind === 'major' || it.kind === 'sankalp') s += 0.5;
        if (exclude.has(it.id)) s -= 5;
        if (s > 1) scored.push({ ...it, score: Math.round(s * 10) / 10, landmark: landmarkHits.has(it.id) });
    }
    scored.sort((a, b) => b.score - a.score);
    const out = [], perCat = {};
    for (const it of scored) {
        const c = it.category || it.id;
        if ((perCat[c] || 0) >= 2) continue;
        perCat[c] = (perCat[c] || 0) + 1;
        out.push(it);
        if (out.length >= k) break;
    }
    return out;
}

/** Items for a topic (no message), e.g. a proactive follow-up tied to the voter's concern. Never lane items. */
function byTopic(topic, { type = null, exclude = [], villages = [] } = {}) {
    const ex = new Set(exclude);
    return load().items
        .filter(i => !i.laneOnly && i.topics.includes(topic) && (!type || i.type === type) && !ex.has(i.id))
        .sort((a, b) => {
            const va = a.villages.some(v => villages.includes(v)) ? 1 : 0, vb = b.villages.some(v => villages.includes(v)) ? 1 : 0;
            const ka = (a.kind === 'detail' ? 0 : 1), kb = (b.kind === 'detail' ? 0 : 1);
            return (vb - va) || (kb - ka);
        });
}

/** One WhatsApp-sized line for an item in the reply language. full=true uses the parcha's landmark wording. */
function render(item, l = 'hi', { full = false } = {}) {
    if (!item) return null;
    if (l === 'hi') return (full && item.hiFull) || item.hi;
    return (full && item.romanFull) || item.roman || null;
}

/** Render up to `max` distinct lines (skips a detail whose flagship is already used). Returns { lines, used }. */
function renderList(items, l = 'hi', max = 2, { full = false } = {}) {
    const lines = [], used = [], seen = new Set(), families = new Set();
    for (const it of items || []) {
        const fam = it.parent || it.id;
        if (families.has(fam) && lines.length && !it.landmark) continue;
        const line = render(it, l, { full: full || !!it.landmark });
        if (!line || seen.has(line)) continue;
        families.add(fam);
        seen.add(line);
        lines.push(line);
        used.push(it.id);
        if (lines.length >= max) break;
    }
    return { lines, used };
}

function getItem(id) { return load().byId[id] || null; }

/** Concatenated text of the given items + the parcha headline facts — used to whitelist numbers in LLM output. */
function allowedTextFor(items) {
    const f = facts();
    const head = JSON.stringify({ poll: f.poll, booths: f.booths, panchayat: f.panchayat, contact: f.contact });
    return (items || []).map(i => [i.hi, i.roman, i.hiFull, i.romanFull].filter(Boolean).join(' ')).join(' ') + ' ' + head;
}

/** { booth, room } for a ward, from the parcha. */
function boothForWard(ward) {
    const w = Number(ward);
    if (!w) return null;
    const b = (facts().booths || []).find(x => (x.wards || []).includes(w));
    return b ? { booth: String(b.booth), room: String(b.room) } : null;
}

module.exports = {
    primaryTopic, load, facts, retrieve, byTopic, render, renderList, sanitize, detectTopics, detectVillages, villageName, topicLabel,
    getItem, allowedTextFor, matchLandmarks, sankalpFor, samasyaCategory, boothForWard, VILLAGES, TOPIC_SYNONYMS, CATEGORY_LABEL, CATEGORY_OF_TOPIC
};
