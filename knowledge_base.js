/**
 * Knowledge retrieval over the campaign fact sheets (the ONLY allowed source of claims about works/promises).
 *
 *   rag_vault/02_MAJOR_KAAM_LIST_HIGHLIGHTS.json   -> 12 major completed works      (type: done,   kind: major)
 *   rag_vault/03_FUTURE_WORK_SANKALP_RESOLUTIONS.json -> 15 future resolutions      (type: future, kind: sankalp)
 *   rag_vault/01_CATEGORY_WISE_KAAM_LIST.json       -> category-wise works + places (type: done,   kind: detail)
 *
 * Each item: { id, type, kind, title, desc, text, topics[], villages[], location, held, heldReason, roman }
 * retrieve(message, opts) returns the 3-5 most relevant items (keyword + Hindi/Hinglish synonyms + village names).
 *
 * Sheet rules enforced here:
 *   - no budgets / rupee figures ever leave this module (sanitize())
 *   - road-tile / CC-lane details are on CONTENT HOLD (campaign_profile.json) -> held=true, never quoted
 *   - an item that conflicts with the operator profile is held (see CONFLICT_HOLD)
 *   - work COUNTS ("45+ सड़कें", "15 संकल्प") are not quoted: we never render totals
 */
const fs = require('fs');
const path = require('path');

const VAULT = process.env.RAG_VAULT_DIR || path.join(__dirname, 'rag_vault');

// ---------------- villages ----------------
const VILLAGES = [
    { key: 'sihali_khurd', hi: 'सिहाली खुर्द', en: 'Sihali Khurd', rx: /(सिहाली\s*खुर्द|छोटी\s*सिहाली|sihali\s*khurd|sihali\s*khurad|chhoti\s*sihali)/i },
    { key: 'sihali_kalan', hi: 'सिहाली कलां', en: 'Sihali Kalan', rx: /(सिहाली\s*कलां|सिहाली\s*कला|बड़ी\s*सिहाली|बडी\s*सिहाली|sihali\s*kal[ae]n|sihali\s*kala\b|badi\s*sihali|bari\s*sihali)/i },
    { key: 'hadahedi', hi: 'हाड़ाहेड़ी', en: 'Hadahedi', rx: /(हाड़ाहेड़ी|हाडाहेडी|हाड़ाहेडी|हाडाहेड़ी|हड़ाहेड़ी|haraheri|hadaheri|hadahedi|harahedi|hadhedi|harheri)/i }
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
    water: /(pani|paani|panee|water|jjm|jal jeevan|jal jivan|nal\b|nal connection|tanki|tanki|tank\b|boring|borewell|bore well|tubewell|meetha pani|peyjal|peyajal|पानी|पाणी|जल जीवन|जेजेएम|नल|टंकी|बोरवेल|बोरिंग|ट्यूबवेल|पेयजल|मीठा पानी|जलाशय)/i,
    road: /(sadak|sadke|sarak|road|rasta|raasta|raste|marg|damar|daamar|gaddha|gaddhe|khadda|सड़क|सडक|रास्ता|रास्ते|मार्ग|डामर|गड्ढा|गड्ढे|खड्डा)/i,
    cc_lanes: /(interlocking|interlock|cc road|cc sadak|cc wali|\bcc\b|c\.c\.|khadanja|kharanja|tiles?\b|इंटरलॉकिंग|सीसी|सी\.सी\.|खड़ंजा|टाइल)/i,
    drainage: /(nali|naali|naliyan|drain|drainage|sewer|sewerage|gandagi|ganda pani|keechad|kichad|jal bharav|jalbharav|पानी भर|नाली|नालियां|सीवर|सीवरेज|गंदा पानी|गंदगी|कीचड़|जलभराव|निकासी)/i,
    cleanliness: /(safai|saaf safai|kachra|kooda|cleaning|swachh|सफाई|कचरा|कूड़ा|स्वच्छ)/i,
    electricity: /(bijli|light|street ?light|road ?light|solar|khamba|pole|andhera|बिजली|लाइट|रोड लाइट|सोलर|खंभा|अंधेरा|रोशनी)/i,
    health: /(hospital|aspatal|asptal|doctor|daktar|dawai|davai|dawa|ilaj|ilaaj|dispensary|swasthya|health|nurse|bimar|chikitsa|अस्पताल|डॉक्टर|डाक्टर|दवा|दवाई|इलाज|स्वास्थ्य|चिकित्सा|बीमार|आयुर्वेद)/i,
    ambulance: /(ambulance|emergency|एम्बुलेंस|एंबुलेंस|आपातकाल)/i,
    medicine: /(jan aushadhi|generic|sasti dawai|(dawai|dawa|davai)\s*(bahut |bohot |kaafi )?(mehngi|mahangi)|mehngi dawa|जन औषधि|जेनेरिक|सस्ती दवा|(दवाई|दवा)\s*(बहुत |काफी )?(महंगी|महँगी)|महंगी दवा)/i,
    animal: /(pashu|pashu aspatal|janwar|gaay|bhains|vet\b|पशु|जानवर|गाय|भैंस)/i,
    education: /(school|skool|college|library|padhai|padhna|kitab|student|bachche padh|teacher|shiksha|exam|competitive|स्कूल|विद्यालय|कॉलेज|लाइब्रेरी|पढ़ाई|किताब|शिक्षा|छात्र|परीक्षा)/i,
    youth: /(yuva|naujawan|youth|khel|khelkud|ground|maidan|gym|stadium|running|track|cricket|kabaddi|volleyball|basketball|badminton|युवा|नौजवान|खेल|मैदान|जिम|स्टेडियम|रनिंग|ट्रैक|क्रिकेट|कबड्डी)/i,
    jobs: /(naukri|job|rozgar|rojgar|berozgar|berojgar|नौकरी|रोजगार|बेरोजगार)/i,
    farming: /(kisan|kisaan|kheti|khet|fasal|khad|khaad|urea|dap\b|beej|krishi|किसान|खेती|खेत|फसल|खाद|यूरिया|बीज|कृषि)/i,
    patwar: /(patwar|patwari|jameen|zameen|namantaran|nakal|पटवार|पटवारी|जमीन|ज़मीन|नामांतरण|नकल)/i,
    seniors: /(pension|budhapa|buzurg|bujurg|bade log|chaupal|old age|पेंशन|बुढ़ापा|बुजुर्ग|बुज़ुर्ग|चौपाल)/i,
    safety: /(suraksha|safety|chori|chor\b|cctv|camera|darr|dar lagta|ladkiyon|betiyon|mahila suraksha|सुरक्षा|चोरी|सीसीटीवी|कैमरा|डर|बेटियों|लड़कियों)/i,
    cremation: /(shmashan|smashan|shamshan|mokshdham|moksh dham|marghat|श्मशान|मोक्षधाम|मरघट)/i,
    pond: /(johad|johar|talab|talaab|pond|farm pond|jal sanchay|जोहड़|जोहड|तालाब|फार्म पॉन्ड|जल संचय)/i,
    ashram: /(ashram|kundandas|kundan das|mandir|amrit sarovar|आश्रम|कुन्दनदास|कुंदनदास|मंदिर|अमृत सरोवर)/i,
    community_hall: /(samudayik bhawan|community hall|bhawan|baithak|सामुदायिक भवन|भवन|बैठक)/i,
    sanitation: /(toilet|shauchalay|sulabh|pink toilet|शौचालय|सुलभ|टॉयलेट)/i,
    environment: /(ped|paudhe|vriksharopan|trees|plantation|hariyali|पेड़|पौधे|वृक्षारोपण|हरियाली)/i
};
const TOPIC_LABEL = {
    hi: { water: 'पानी', road: 'सड़क', cc_lanes: 'गली की सीसी/इंटरलॉकिंग', drainage: 'नाली-निकासी', cleanliness: 'सफाई', electricity: 'रोड लाइट', health: 'अस्पताल-इलाज', ambulance: 'एम्बुलेंस', medicine: 'दवाई', animal: 'पशु चिकित्सा', education: 'पढ़ाई-स्कूल', youth: 'खेल-युवा', jobs: 'रोजगार', farming: 'खेती-किसानी', patwar: 'ज़मीन-पटवार', seniors: 'बुज़ुर्ग-पेंशन', safety: 'सुरक्षा', cremation: 'मोक्षधाम', pond: 'जोहड़-तालाब', ashram: 'आश्रम', community_hall: 'सामुदायिक भवन', sanitation: 'शौचालय', environment: 'पेड़-पौधे' },
    en: { water: 'paani', road: 'sadak', cc_lanes: 'gali ki CC/interlocking', drainage: 'naali-nikasi', cleanliness: 'safai', electricity: 'road light', health: 'aspatal-ilaj', ambulance: 'ambulance', medicine: 'dawai', animal: 'pashu chikitsa', education: 'padhai-school', youth: 'khel-yuva', jobs: 'rozgar', farming: 'kheti-kisani', patwar: 'zameen-patwar', seniors: 'buzurg-pension', safety: 'suraksha', cremation: 'mokshdham', pond: 'johad-talab', ashram: 'ashram', community_hall: 'samudayik bhawan', sanitation: 'shauchalay', environment: 'ped-paudhe' }
};

function detectTopics(text) {
    const t = String(text || '');
    return Object.keys(TOPIC_SYNONYMS).filter(k => TOPIC_SYNONYMS[k].test(t));
}
const SPECIFIC = ['medicine', 'ambulance', 'cc_lanes', 'patwar', 'animal', 'cleanliness', 'jobs', 'seniors', 'safety'];
/** Most specific topic in the text (e.g. "दवाई महंगी" -> medicine rather than health), else the hint/first. */
function primaryTopic(text, hint = null) {
    const ts = detectTopics(text);
    const sp = ts.find(t => SPECIFIC.includes(t));
    if (sp) return sp;
    if (hint && ts.includes(hint)) return hint;
    return hint || ts[0] || null;
}
function topicLabel(topic, l = 'hi') { return (TOPIC_LABEL[l === 'hi' ? 'hi' : 'en'] || {})[topic] || topic || ''; }

// ---------------- sheet -> items ----------------
const MAJOR_TOPICS = { 1: ['health', 'animal'], 2: ['road'], 3: ['education', 'sanitation'], 4: ['youth'], 5: ['water'], 6: ['ashram', 'road'], 7: ['drainage'], 8: ['cremation'], 9: ['community_hall'], 10: ['cc_lanes', 'drainage'], 11: ['pond', 'farming', 'water'], 12: ['environment'] };
const FUTURE_TOPICS = { 1: ['youth'], 2: ['water'], 3: ['safety'], 4: ['electricity', 'safety'], 5: ['cleanliness', 'drainage'], 6: ['road', 'cc_lanes'], 7: ['health'], 8: ['health'], 9: ['road'], 10: ['patwar', 'farming'], 11: ['farming'], 12: ['medicine', 'health'], 13: ['seniors'], 14: ['education', 'youth'], 15: ['ambulance', 'health'] };
const CATEGORY_TOPICS = {
    chikitsa_swasthya: ['health', 'animal'], damar_sadak: ['road'], shiksha_school: ['education'], khel_maidan_gym: ['youth'],
    peyejal_borewell: ['water'], ashram_vikas: ['ashram'], sewerage_drainage: ['drainage'], mokshdham_vikas: ['cremation'],
    samudayik_bhavan: ['community_hall'], interlocking_cc_sadak: ['cc_lanes', 'road', 'drainage'], jal_sanrakshan: ['pond', 'farming'],
    sulabh_shauchalay: ['sanitation'], paryavaran_vriksharopan: ['environment']
};
const CATEGORY_PARENT = { chikitsa_swasthya: 'M1', damar_sadak: 'M2', shiksha_school: 'M3', khel_maidan_gym: 'M4', peyejal_borewell: 'M5', ashram_vikas: 'M6', sewerage_drainage: 'M7', mokshdham_vikas: 'M8', samudayik_bhavan: 'M9', interlocking_cc_sadak: 'M10', jal_sanrakshan: 'M11', sulabh_shauchalay: 'M3', paryavaran_vriksharopan: 'M12' };

// Roman (Hinglish) renderings — faithful, shortened transliterations of the sheet items. No numbers that are not in the sheet.
const ROMAN = {
    M1: 'Abhay Singh ji ne apni niji zameen daan karke Sihali Khurd me up-swasthya kendra ka bhawan banwaya, aur Sihali Kalan me Surjan parivar se bhoomi-daan karwakar pashu chikitsalay bhawan banwaya.',
    M2: 'Sihali Kalan se Hadahedi main road, Ashram marg, Baniya Wala Kundi marg aur Radwa marg pakki damar sadak ke roop me dobara bane aur chaude hue.',
    M3: 'Sihali Khurd me yuvaon ke liye modular/digital library bani, schoolon me meeting hall, kamron ki marammat aur betiyon ke liye pink toilet ka kaam hua.',
    M4: 'Sihali Khurd khel maidan me running track, basketball-badminton-kho kho court aur open gym bana, saath me pakki chaardiwari ka bada hissa bana.',
    M5: 'Jal Jeevan Mission ke tahat paani ki tankiyan, ghar-ghar nal connection aur paani ki kami wali jagahon par naye borewell lage.',
    M6: 'Baba Kundandas Ashram tak pakki damar sadak, ashram ki chaardiwari, Amrit Sarovar aur swachhta complex ka kaam hua.',
    M7: 'Keechad aur jalbharav se mukti ke liye bhumigat sewerage/naali line dali gayi, jaise Mahipal Tanwar ke ghar se johad ki taraf aur Madan Panch ke ghar se school ki taraf.',
    M8: 'Mokshdham me mitti bharat aur samtalikaran hua, naye borewell lage aur chhayadar ped lagaye gaye.',
    M9: 'Gaon ke samajik aur mangalik aayojanon ke liye pakka samudayik bhawan banwaya gaya.',
    M10: null, // held
    M11: 'Panchayat ke purane johad aur jalashay gehre khudwakar theek karwaye gaye, aur kisanon ke liye farm pond bana.',
    M12: 'Khel maidan, mokshdham, ashram aur charagah bhoomi me saikdon chhayadar aur phaldar paudhe lagaye gaye.',
    F1: 'Hadahedi aur Sihali Kalan ke khel maidan ka vikas, aur Sihali Khurd me naya bada khel maidan (open gym, running track) ka sankalp hai.',
    F2: 'Jal Jeevan Mission me jo ghar abhi bache hain, wahan tak meetha paani pahunchana pehli prathmikta hai.',
    F3: 'Panchayat ke mukhya raston, gaon ke pravesh dwar aur chauraahon par night-vision CCTV camere lagwane ka sankalp hai.',
    F4: 'Mukhya raston, galiyon aur sabhi mohallon me road light aur solar street light lagwane ka sankalp hai.',
    F5: 'Naaliyon aur raston ki lagatar safai ke liye sthayi karmchariyon ki vyavastha karne ka sankalp hai.',
    F6: 'Toot chuki sadkon ko dobara majboot banwane ka sankalp hai.',
    F7: 'Aspatal aur up-swasthya kendra me niyamit doctor ki vyavastha karwane ka sankalp hai.',
    F8: 'Hadahedi me up-swasthya kendra, aur Sihali Khurd va Sihali Kalan me Ayurvedic aspatal khulwane ke thos prayas karenge.',
    F9: 'Sihali Khurd se Hadahedi ko jodne wali mukhya sadak ka chaudikaran aur achhi damar sadak banwane ka sankalp hai.',
    F10: 'Panchayat me patwar ghar banwana, taaki namantaran, nakal aur zameen ke kaam ke liye Mundawar na bhatakna pade.',
    F11: 'Kisan seva kendra bhawan banwana, taaki khaad, unnat beej aur krishi dawaiyan panchayat me hi sahi sarkari daam par milen.',
    F12: 'Sasti generic dawaiyon ke liye Jan Aushadhi Kendra khulwane ka sankalp hai, taaki dawai ke liye Mundawar na jaana pade.',
    F13: 'Buzurgon ke baithne ke liye chhayadar, pankhe aur peene ke paani wali chaupal banwane ka sankalp hai.',
    F14: 'Sihali Khurd ki tarah ab Hadahedi aur Sihali Kalan me bhi modern modular library banwane ka sankalp hai.',
    F15: 'Swasthya kendra par 24 ghante emergency ambulance ki sthayi vyavastha ka sankalp hai.'
};

// Items held for verification or because they conflict with the operator's 4-Nov profile.
const CONFLICT_HOLD = [
    { rx: /गयासी राम/, reason: 'conflict: campaign_profile.json lists this road as a FUTURE commitment' }
];
const ROAD_TILE_HOLD = /(इंटरलॉकिंग|सी\.सी\.|\bCC\b)[^।]*?(सड़क|मार्ग|गली|गलियों)|(सड़क|मार्ग|गली|गलियों)[^।]*?(इंटरलॉकिंग|सी\.सी\.)/;

/** Remove any budget / rupee figure. Sheet rule: never mention budgets. */
function sanitize(text) {
    return String(text || '')
        .replace(/(₹|rs\.?|inr)\s*[\d,.]+\s*(lakh|लाख|crore|करोड़|हज़ार|हजार)?/gi, '')
        .replace(/[\d,.]+\s*(लाख|करोड़|हज़ार रुपये|हजार रुपये|रुपये|रुपए|रुपया|lakh|crore|rupees?|rupaye)/gi, '')
        .replace(/(बजट|लागत|budget|lagat)\s*[:：-]?\s*[\d,.]+/gi, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
}
const stripEmoji = s => String(s || '').replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '').trim();

let CACHE = null;
function readJson(file) {
    try { return JSON.parse(fs.readFileSync(path.join(VAULT, file), 'utf8')); } catch (e) { return null; }
}

function load(force = false) {
    if (CACHE && !force) return CACHE;
    const items = [];
    const major = readJson('02_MAJOR_KAAM_LIST_HIGHLIGHTS.json');
    for (const w of (major && major.works) || []) {
        const id = 'M' + w.id;
        const title = sanitize(stripEmoji(w.title));
        const desc = sanitize(w.desc);
        const held = w.id === 10 || /\d+\+\s*पक्की सी\.सी/.test(desc);
        items.push({ id, type: 'done', kind: 'major', title, desc, text: title + ' — ' + desc, topics: MAJOR_TOPICS[w.id] || detectTopics(title + ' ' + desc), villages: detectVillages(desc), location: '', held, heldReason: held ? 'CONTENT HOLD: road-tile/CC-lane details under verification' : null, roman: ROMAN[id] || null, source: '02_MAJOR_KAAM_LIST_HIGHLIGHTS' });
    }
    const future = readJson('03_FUTURE_WORK_SANKALP_RESOLUTIONS.json');
    for (const w of Array.isArray(future) ? future : []) {
        const id = 'F' + w.id;
        const title = sanitize(stripEmoji(w.title));
        const desc = sanitize(w.desc);
        items.push({ id, type: 'future', kind: 'sankalp', title, desc, text: title + ' — ' + desc, topics: FUTURE_TOPICS[w.id] || detectTopics(title + ' ' + desc), villages: detectVillages(title + ' ' + desc), location: '', held: false, heldReason: null, roman: ROMAN[id] || null, source: '03_FUTURE_WORK_SANKALP_RESOLUTIONS' });
    }
    const cats = readJson('01_CATEGORY_WISE_KAAM_LIST.json');
    for (const cat of (cats && cats.categories) || []) {
        (cat.works || []).forEach((w, i) => {
            const id = `C-${cat.category_id}-${i + 1}`;
            const work = sanitize(w.work);
            const location = sanitize(w.location || '');
            let held = cat.category_id === 'interlocking_cc_sadak' || ROAD_TILE_HOLD.test(work);
            let heldReason = held ? 'CONTENT HOLD: road-tile/CC-lane details under verification' : null;
            for (const c of CONFLICT_HOLD) if (c.rx.test(work)) { held = true; heldReason = c.reason; }
            items.push({ id, type: 'done', kind: 'detail', category: cat.category_id, title: work.split(' — ')[0], desc: work, text: work + ' (' + location + ')', topics: CATEGORY_TOPICS[cat.category_id] || detectTopics(work), villages: detectVillages(work + ' ' + location), location, held, heldReason, roman: null, parent: CATEGORY_PARENT[cat.category_id] || null, source: '01_CATEGORY_WISE_KAAM_LIST' });
        });
    }
    CACHE = { items, byId: Object.fromEntries(items.map(i => [i.id, i])), loadedAt: new Date().toISOString() };
    return CACHE;
}

function tokens(text) {
    return String(text || '').toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .split(/\s+/)
        .filter(w => w.length >= 3 && !STOP.has(w));
}
const STOP = new Set(['kya', 'hai', 'hain', 'aur', 'the', 'kab', 'kaise', 'ke', 'liye', 'mein', 'hamare', 'hamari', 'abhay', 'singh', 'baba', 'kaam', 'kiya', 'karenge', 'karoge', 'gaon', 'wala', 'wali', 'bhi', 'nahi', 'nhi',
    'क्या', 'है', 'हैं', 'और', 'के', 'लिए', 'में', 'हमारे', 'हमारी', 'अभय', 'सिंह', 'बाबा', 'काम', 'किया', 'करेंगे', 'गाँव', 'गांव', 'वाला', 'वाली', 'भी', 'नहीं', 'कार्य', 'निर्माण', 'हेतु', 'तथा', 'एवं', 'का', 'की', 'को', 'से', 'तक', 'पर']);

/**
 * @param {string} message
 * @param {object} [opts] { k=4, exclude: Set|Array of item ids already told, type: 'done'|'future'|null,
 *                         topics: [] extra topic hints (e.g. voter's concern), villages: [] voter's village }
 * @returns {Array<item & {score}>}
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
    const wantFuture = opts.type === 'future' || /(aage|आगे|sankalp|संकल्प|vaada|vada|wada|वादा|karoge|karenge|करोगे|करेंगे|plan|manifesto|kab banega|कब बनेगा|kab hoga|कब होगा)/i.test(message);
    const wantDone = opts.type === 'done' || /(kya kiya|kiya hai|karwaya|hua\b|hua kya|हुआ|किया|करवाया|बना|bana)/i.test(message);
    const scored = [];
    for (const it of items) {
        let s = 0;
        for (const t of it.topics) {
            if (msgTopics.includes(t)) s += 6;
            else if (hintTopics.includes(t)) s += 3;
        }
        const hay = (it.text + ' ' + (it.roman || '')).toLowerCase();
        for (const w of toks) if (hay.includes(w)) s += 1;
        for (const v of it.villages) {
            if (msgVillages.includes(v)) s += 2.5;
            else if (voterVillages.includes(v)) s += 1;
        }
        if (opts.type && it.type !== opts.type) s -= 4;
        if (wantFuture && it.type === 'future') s += 2;
        if (wantDone && !wantFuture && it.type === 'done') s += 1.5;
        if (it.kind === 'major' || it.kind === 'sankalp') s += 0.5; // prefer the flagship line when tied
        if (exclude.has(it.id)) s -= 5;
        if (it.held) s -= 1.5;
        if (s > 1) scored.push({ ...it, score: Math.round(s * 10) / 10 });
    }
    scored.sort((a, b) => b.score - a.score);
    // Diversity: at most 2 detail items from the same category
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

/** Items for a topic (no message), e.g. a proactive follow-up tied to the voter's concern. */
function byTopic(topic, { type = null, exclude = [], villages = [] } = {}) {
    const ex = new Set(exclude);
    return load().items
        .filter(i => !i.held && i.topics.includes(topic) && (!type || i.type === type) && !ex.has(i.id))
        .sort((a, b) => {
            const va = a.villages.some(v => villages.includes(v)) ? 1 : 0, vb = b.villages.some(v => villages.includes(v)) ? 1 : 0;
            const ka = (a.kind === 'detail' ? 0 : 1), kb = (b.kind === 'detail' ? 0 : 1);
            return (vb - va) || (kb - ka);
        });
}

function shorten(s, max = 170) {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    if (t.length <= max) return t;
    const cut = t.slice(0, max);
    const i = Math.max(cut.lastIndexOf(','), cut.lastIndexOf('।'), cut.lastIndexOf(' व '), cut.lastIndexOf(' तथा '));
    return (i > 60 ? cut.slice(0, i) : cut.replace(/\s+\S*$/, '')).trim() + '…';
}

/**
 * One WhatsApp-sized line for an item, in the reply language. Held items are never quoted.
 * Done items are framed as work done under Abhay Singh's initiative; future items as a sankalp.
 */
function render(item, l = 'hi') {
    if (!item) return null;
    if (item.held) {
        return l === 'hi'
            ? 'गलियों की सीसी/इंटरलॉकिंग का गली-वार ब्योरा अभी जाँच में है, इसलिए उस पर पक्का करके ही बताऊँगी।'
            : 'Galiyon ki CC/interlocking ka gali-war byora abhi jaanch me hai, isliye us par pakka karke hi bataungi.';
    }
    if (l === 'hi') {
        if (item.kind === 'detail') {
            const loc = item.location && !item.desc.includes(item.location) ? ` (${item.location})` : '';
            return shorten(item.desc.replace(/\s*—\s*/g, ' — '), 160) + loc + (item.type === 'future' ? ' का संकल्प है।' : ' — यह काम हो चुका है।');
        }
        if (item.type === 'future') return 'संकल्प: ' + shorten(item.desc.replace(/\s*\([^)]*\)/g, ''), 150);
        return shorten(item.desc.replace(/\s*\([^)]*\)/g, ''), 150);
    }
    if (item.roman) return item.roman;
    const parent = item.parent && load().byId[item.parent];
    if (parent && parent.roman) return parent.roman;
    return null; // no faithful Roman rendering available -> caller picks another item
}

/**
 * Render up to `max` distinct lines (skips duplicates, items without a faithful rendering, and held items
 * unless nothing else is available). Returns { lines: [], used: [item ids] }.
 */
function renderList(items, l = 'hi', max = 2) {
    const lines = [], used = [], seen = new Set();
    const nonHeld = (items || []).filter(i => !i.held);
    const pool = nonHeld.length ? nonHeld : (items || []).slice(0, 1);
    const families = new Set();
    for (const it of pool) {
        const fam = it.parent || it.id;
        if (families.has(fam) && lines.length) continue; // a detail and its flagship say the same thing
        const line = render(it, l);
        if (!line || seen.has(line)) { if (line) used.push(it.id); continue; }
        families.add(fam);
        seen.add(line);
        lines.push(line);
        used.push(it.id);
        if (lines.length >= max) break;
    }
    return { lines, used };
}

function getItem(id) { return load().byId[id] || null; }

/** Concatenated sanitized text of the given items — used to whitelist numbers in LLM output. */
function allowedTextFor(items) { return (items || []).map(i => i.text + ' ' + (i.roman || '')).join(' '); }

module.exports = { primaryTopic, load, retrieve, byTopic, render, renderList, sanitize, detectTopics, detectVillages, villageName, topicLabel, getItem, allowedTextFor, VILLAGES, TOPIC_SYNONYMS };
