/**
 * Brain v3 structured flows — the two things a good campaign worker writes down in the diary:
 *
 *   SAMASYA  a voter mentions a problem -> ask, one question at a time, only what is missing
 *            (kya problem / kahan: ward-gali-landmark / kab se), log it to samasya_store with the matching
 *            parcha sankalp, confirm warmly ("अभय सिंह जी तक पहुँचा दी है"). Never promise a date or a fix.
 *   MULAQAT  the voter wants to meet / call Abhay Singh ji, or says yes to "घर बुलाना चाहेंगे?" ->
 *            collect preferred date+time, place/landmark, family members, purpose; log a request
 *            (status requested). Never confirm on his behalf — the team confirms.
 *
 * State lives in user.memory.flow = { type: 'samasya'|'mulaqat'|'mulaqat_offer', step, recordId, data, asked, at }.
 * A message that clearly is about something else ends the flow (the record keeps what we have) and is
 * answered normally by reply_brain.
 */
const kb = require('./knowledge_base.js');
const voterMemory = require('./voter_memory.js');

let samasyaStore = null, mulaqatStore = null;
function stores() {
    if (!samasyaStore) samasyaStore = require('./samasya_store.js');
    if (!mulaqatStore) mulaqatStore = require('./mulaqat_store.js');
    return { samasyaStore, mulaqatStore };
}
function setStores(s, m) { samasyaStore = s; mulaqatStore = m; }

const FLOW_TTL_MS = 6 * 3600e3;
const hasDev = t => /[\u0900-\u097F]/.test(String(t || ''));
const clean = s => String(s || '').replace(/\s+/g, ' ').trim();

// ---------------- parsers ----------------
const NUM_WORDS = { ek: 1, do: 2, teen: 3, tin: 3, char: 4, chaar: 4, paanch: 5, panch: 5, chhe: 6, chhah: 6, che: 6, saat: 7, aath: 8, nau: 9, das: 10, gyarah: 11, barah: 12, 'एक': 1, 'दो': 2, 'तीन': 3, 'चार': 4, 'पांच': 5, 'पाँच': 5, 'छह': 6, 'छः': 6, 'सात': 7, 'आठ': 8, 'नौ': 9, 'दस': 10, 'ग्यारह': 11, 'बारह': 12 };
const NUM = '(\\d{1,3}|ek|do|teen|tin|char|chaar|paanch|panch|chhe|chhah|che|saat|aath|nau|das|gyarah|barah|एक|दो|तीन|चार|पांच|पाँच|छह|छः|सात|आठ|नौ|दस|ग्यारह|बारह|कई|kai|bahut|बहुत)';
const toNum = x => (/^\d+$/.test(x) ? Number(x) : NUM_WORDS[String(x).toLowerCase()]);

/** "2 mahine se", "kaafi time se", "barsaat se", "saal bhar se" -> the voter's own words (trimmed), else null */
function parseSince(text) {
    const t = clean(text);
    const m = t.match(new RegExp(NUM + '\\s*(din|dino|hafte|hafta|hapte|mahine|mahina|mahino|month|months|saal|sal|baras|varsh|years?|दिन|दिनों|हफ्ते|हफ़्ते|हफ्ता|महीने|महीना|महीनों|साल|बरस|वर्ष)\\s*(se|से|te|tai|तै|तें|ho gaye|हो गए|ho gya|ho gaya|हो गया)?', 'i'));
    if (m) return clean(m[0]);
    const m2 = t.match(/(kaafi|kafi|bahut|lambe|kai)\s*(time|samay|din|dino|saal|mahino)\s*se|kaafi pehle se|shuru se|hamesha se|barsaat se|barish se|baarish se|chunav ke baad se|saal bhar se|pichhle saal se|pichle saal se|kal se|parso se|aaj se|abhi abhi|(barsaat|barish|baarish|saal bhar|kai din|ghane din|kaafi din) (te|tai)|(बरसात|बारिश|साल भर|कई दिन|घणे दिन|घणे दिनां) (तै|तें)|काफ़ी|काफी\s*(समय|दिनों|साल)\s*से|बहुत\s*(समय|दिनों)\s*से|शुरू से|हमेशा से|बरसात से|बारिश से|साल भर से|पिछले साल से|कल से|परसों से|आज से/i);
    return m2 ? clean(m2[0]) : null;
}

const PLACE_RX = /([A-Za-z\u0900-\u097F.]{2,25}(\s+[A-Za-z\u0900-\u097F.]{2,25}){0,3}\s+(wali gali|ki gali|wala mohalla|ka mohalla|mohalla|basti|dhani|chowk|chauraha|ke paas|ke pas|ke saamne|ke samne|ki taraf|ki or|ke peeche|wali sadak|की गली|वाली गली|मोहल्ला|बस्ती|ढाणी|चौक|चौराहा|के पास|के सामने|की तरफ|की ओर|के पीछे|वाली सड़क))/i;
/** ward / village / landmark / place phrase in the text */
function parseLocation(text, { loose = false } = {}) {
    const t = clean(text);
    const out = {};
    const w = t.match(/(?:ward|vard|wad|वार्ड|w)\s*(?:no\.?|nan?\.?|number|नंबर|नं\.?)?\s*[:#-]?\s*(\d{1,2})\b/i);
    if (w && Number(w[1]) >= 1 && Number(w[1]) <= 11) out.ward = Number(w[1]);
    const v = kb.detectVillages(t);
    if (v.length === 1) out.village = v[0];
    const p = t.match(PLACE_RX);
    if (p) out.place = clean(p[1]).replace(/^((me|mein|men|में|ke|की|का|ka|ki|se|से|hamari|hamare|humari|meri|mere|हमारी|हमारे|मेरी|मेरे|wo|वो|ye|ये)\s+)+/i, '');
    const lm = kb.matchLandmarks(t);
    if (lm.length) { out.landmarkItems = lm.map(i => i.id); if (!out.place) out.place = t.slice(0, 80); }
    if (loose && !out.place && /(gali|galli|mohalla|mohalle|गली|मोहल्ले|मोहल्ला|basti|बस्ती|mandir|मंदिर|school|स्कूल|johad|जोहड़|kuan|कुआँ|kuye|chakki|चक्की|bus stand|बस स्टैंड|main road|मेन रोड|ke ghar ke paas|के घर के पास)/i.test(t) && t.length <= 90) out.place = t;
    return (out.ward || out.village || out.place) ? out : null;
}

const WEEKDAYS = [
    [0, /(ravivar|raviwar|itwar|itvar|sunday|रविवार|इतवार)/i], [1, /(somvar|somwar|monday|सोमवार)/i], [2, /(mangalvar|mangalwar|tuesday|मंगलवार)/i],
    [3, /(budhvar|budhwar|wednesday|बुधवार)/i], [4, /(guruvar|guruwar|brihaspativar|veervar|thursday|गुरुवार|बृहस्पतिवार|वीरवार)/i], [5, /(shukravar|shukrawar|friday|शुक्रवार)/i], [6, /(shanivar|shaniwar|saturday|शनिवार)/i]
];
function istToday(now = new Date()) { return new Date(now.getTime() + 5.5 * 3600e3); }
function ymd(d) { return d.toISOString().slice(0, 10); }
/** preferred date/time for a visit: { text, date (YYYY-MM-DD IST) | null } or null */
function parseWhen(text, now = new Date()) {
    const t = clean(text);
    const low = t.toLowerCase();
    const today = istToday(now);
    let date = null, hit = false;
    const addDays = n => { const d = new Date(today); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
    if (/(\baaj\b|\baj\b|today|आज)/i.test(low)) { date = addDays(0); hit = true; }
    else if (/(parso|parson|परसों)/i.test(low)) { date = addDays(2); hit = true; }
    else if (/(\bkal\b|tomorrow|कल)/i.test(low)) { date = addDays(1); hit = true; }
    else {
        for (const [dow, rx] of WEEKDAYS) if (rx.test(low)) { let n = (dow - today.getUTCDay() + 7) % 7; if (n === 0) n = 7; date = addDays(n); hit = true; break; }
    }
    const dm = low.match(/\b(\d{1,2})\s*(tarikh|tareekh|तारीख|nov|november|नवंबर|नवम्बर)/i);
    if (dm && Number(dm[1]) >= 1 && Number(dm[1]) <= 30) { date = `2026-11-${String(dm[1]).padStart(2, '0')}`; hit = true; }
    const timeHit = /(subah|savere|सुबह|सवेरे|dopahar|dopher|दोपहर|shaam|sham|शाम|raat|रात|baje|बजे|\d{1,2}:\d{2}|\d{1,2}\s*(am|pm)|kabhi bhi|कभी भी|jab (bhi )?(marzi|mann|samay)|जब भी)/i.test(low);
    if (/(is hafte|isi hafte|agle hafte|इस हफ्ते|अगले हफ्ते|weekend|chhutti|छुट्टी)/i.test(low)) hit = true;
    if (!hit && !timeHit) return null;
    return { text: t.slice(0, 80), date };
}

function parseCount(text) {
    const t = clean(text).toLowerCase();
    const m = t.match(new RegExp('(?:^|\\s)' + NUM.replace('|कई|kai|bahut|बहुत', '') + '\\s*(log|log honge|jane|jan|member|sadasya|लोग|जने|सदस्य|vote|वोट)?(?:\\s|$|[.!])', 'i'));
    if (m && toNum(m[1])) { const n = toNum(m[1]); if (n >= 1 && n <= 60) return n; }
    return null;
}

const YES = /^(ha+n?|haan ji|haa|ji+|ji haan|jee|yes|yup|ok+|okay|theek( hai)?|thik( hai)?|zaroor|jaroor|jarur|bilkul|kyon nahi|kyu nahi|aao|aaiye|aaiyega|bulayenge|bula lenge|swagat hai|हाँ|हां|जी|जी हाँ|जी हां|ठीक है|ज़रूर|जरूर|बिल्कुल|क्यों नहीं|आइए|आइएगा|बुलाएँगे|बुलाएंगे|स्वागत है)[\s!.,🙏👍😊]*/i;
const NO = /^(nahi+|nhi|nahin|na\b|no\b|abhi nahi|abhi nhi|zarurat nahi|jarurat nahi|rehne do|rahne do|mat|नहीं|ना\b|अभी नहीं|ज़रूरत नहीं|जरूरत नहीं|रहने दो)/i;
const SKIP = /^(pata nahi|pata nhi|nahi pata|nhi pata|maloom nahi|yaad nahi|bas itna|itna hi|skip|छोड़ो|पता नहीं|नहीं पता|मालूम नहीं|याद नहीं|बस इतना)/i;
const ACK = /^(ok+|okay|thik|theek|thik hai|theek hai|achha|accha|acha|ji|jee|haan|ha|hmm+|dhanyavad|dhanyawad|shukriya|thanks|thank you|👍|🙏|ठीक है|अच्छा|जी|हाँ|हां|धन्यवाद|शुक्रिया)[\s!.🙏👍]*$/i;
function isAck(t) { return ACK.test(clean(t)); }
function isYes(t) { return YES.test(clean(t)); }
function isNo(t) { return NO.test(clean(t)); }
function isSkip(t) { return SKIP.test(clean(t)); }

// ---------------- wording ----------------
const EMPATHY = {
    water: ['पानी की दिक्कत तो सच में सबसे बड़ी परेशानी है', 'Paani ki dikkat to sach me sabse badi pareshani hai'],
    drainage: ['नाली और कीचड़ की दिक्कत रोज़ की तकलीफ़ है', 'Naali aur keechad ki dikkat roz ki takleef hai'],
    cleanliness: ['गंदगी से तो बीमारी भी फैलती है, ये ज़रूरी बात है', 'Gandagi se to bimari bhi phailti hai, ye zaroori baat hai'],
    road: ['टूटे रास्ते से रोज़ का आना-जाना मुश्किल हो जाता है', 'Toote raste se roz ka aana-jaana mushkil ho jata hai'],
    cc_lanes: ['गली का रास्ता ख़राब हो तो रोज़ परेशानी होती है', 'Gali ka rasta kharab ho to roz pareshani hoti hai'],
    streetlight: ['अँधेरे में आना-जाना ठीक नहीं, ख़ासकर बहन-बेटियों और बुज़ुर्गों के लिए', 'Andhere me aana-jaana theek nahi, khaaskar behan-betiyon aur buzurgon ke liye'],
    bijli: ['बिजली की दिक्कत से घर और खेत दोनों का काम रुकता है', 'Bijli ki dikkat se ghar aur khet dono ka kaam rukta hai'],
    health: ['इलाज की परेशानी सबसे बड़ी चिंता होती है', 'Ilaaj ki pareshani sabse badi chinta hoti hai'],
    medicine: ['दवाई महँगी हो तो घर का ख़र्चा बिगड़ जाता है', 'Dawai mehngi ho to ghar ka kharcha bigad jata hai'],
    ambulance: ['आपात में गाड़ी न मिले तो बहुत डर लगता है', 'Emergency me gaadi na mile to bahut dar lagta hai'],
    pension: ['बुज़ुर्गों की पेंशन अटके तो बहुत तकलीफ़ होती है', 'Buzurgon ki pension atke to bahut takleef hoti hai'],
    ration: ['राशन तो हर घर की ज़रूरत है', 'Ration to har ghar ki zaroorat hai'],
    patwar: ['ज़मीन के काम में चक्कर लगाना बहुत थकाता है', 'Zameen ke kaam me chakkar lagana bahut thakata hai'],
    farming: ['किसान की परेशानी पूरे गाँव की परेशानी है', 'Kisan ki pareshani poore gaon ki pareshani hai'],
    education: ['बच्चों की पढ़ाई से बड़ा कुछ नहीं', 'Bachchon ki padhai se bada kuch nahi'],
    housing: ['अपना पक्का घर हर परिवार का सपना होता है', 'Apna pakka ghar har parivar ka sapna hota hai'],
    safety: ['गाँव में सबकी सुरक्षा सबसे ज़रूरी है', 'Gaon me sabki suraksha sabse zaroori hai'],
    animal: ['पशु तो किसान का धन है, उनका इलाज ज़रूरी है', 'Pashu to kisan ka dhan hai, unka ilaaj zaroori hai'],
    _: ['ये तो सच में परेशानी वाली बात है', 'Ye to sach me pareshani wali baat hai']
};
function empathy(topic, l) { const e = EMPATHY[topic] || EMPATHY._; return l === 'hi' ? e[0] : e[1].charAt(0).toLowerCase() + e[1].slice(1); }

const Q = {
    what: ['बताइए, क्या दिक्कत है? पूरी बात लिख दीजिए, मैं नोट करके अभय सिंह जी तक पहुँचाऊँगी।', 'Bataiye, kya dikkat hai? Poori baat likh dijiye, main note karke Abhay Singh ji tak pahunchaungi.'],
    where: ['ये किस वार्ड या गली-मोहल्ले में है?', 'Ye kis ward ya gali-mohalle me hai?'],
    whereWho: ['आप किस गाँव और वार्ड से हैं?', 'Aap kis gaon aur ward se hain?'],
    whereWard: ['आप किस वार्ड से हैं?', 'Aap kis ward se hain?'],
    since: ['और ये दिक्कत कब से चल रही है?', 'Aur ye dikkat kab se chal rahi hai?'],
    when: ['कौन-सा दिन और समय आपके लिए ठीक रहेगा?', 'Kaun sa din aur samay aapke liye theek rahega?'],
    place: ['घर का पता या कोई पहचान बता दीजिए—वार्ड, गली या पास का मंदिर/स्कूल?', 'Ghar ka pata ya koi pehchaan bata dijiye—ward, gali ya paas ka mandir/school?'],
    family: ['घर पर परिवार के कितने लोग मिलेंगे?', 'Ghar par parivar ke kitne log milenge?'],
    purpose: ['और किस बारे में बात करनी है—कोई समस्या, या बस मिलना-जुलना?', 'Aur kis baare me baat karni hai—koi samasya, ya bas milna-julna?']
};
const q = (k, l) => (l === 'hi' ? Q[k][0] : Q[k][1]);
const PERSONAL = new Set(['pension', 'ration', 'housing', 'patwar', 'health', 'medicine', 'jobs', 'animal', 'education']);
const whereQ = (topic, l, village = null) => q(PERSONAL.has(topic) ? (village ? 'whereWard' : 'whereWho') : 'where', l);

const OFFER = ['क्या आप अभय सिंह जी को अपने घर बुलाना चाहेंगे? सुविधा का समय बता दीजिए।', 'Kya aap Abhay Singh ji ko apne ghar bulana chahenge? Suvidha ka samay bata dijiye.'];

// ---------------- helpers ----------------
function metaOf(ctx) {
    const u = ctx.user || {};
    const m = voterMemory.ensure(u);
    return {
        phone: (ctx.meta && ctx.meta.phone) || u.phone || null,
        name: [m.name, u.name, u.lastFoundVoter && u.lastFoundVoterSelf !== false && (u.lastFoundVoter.name_hi || u.lastFoundVoter.name)].find(n => n && !/^(mera|meri|main|mai|hum|ham|kya|nahi|haan|ji|ok|मेरा|मैं|हम|क्या|नहीं|जी|ग्रामवासी)$/i.test(String(n).trim().split(/\s+/)[0]) && !/self-test|ग्रामवासी/i.test(n)) || null,
        village: m.village || null,
        ward: u.ward || m.ward || (u.lastFoundVoter && Number(u.lastFoundVoter.ward)) || null,
        line: (ctx.meta && ctx.meta.line) || u.lastSessionId || u.assignedLine || null,
        test: !!(u.selfTest || (ctx.meta && ctx.meta.test))
    };
}
function locText(rec, l) {
    const parts = [];
    if (rec.ward) parts.push(l === 'hi' ? `वार्ड ${rec.ward}` : `ward ${rec.ward}`);
    else if (rec.village) parts.push(kb.villageName(rec.village, l));
    let loc = rec.location ? String(rec.location).replace(/(ward|vard|वार्ड)\s*(no\.?|नं\.?)?\s*\d{1,2}\s*,?\s*(me|में|ke|के)?/ig, '').replace(/^[\s,.-]+|[\s,.-]+$/g, '') : '';
    if (loc && (l === 'hi' || !hasDev(loc))) parts.push(parts.length ? `(${loc.slice(0, 60)})` : loc.slice(0, 60));
    return parts.join(' ');
}
function sinceText(s, l) { return s && (l === 'hi' || !hasDev(s)) ? s : ''; }

function setFlow(user, flow) { const m = voterMemory.ensure(user); m.flow = flow ? { ...flow, at: new Date().toISOString() } : null; }
function getFlow(user) {
    const m = voterMemory.ensure(user);
    const f = m.flow;
    if (!f) return null;
    if (Date.now() - Date.parse(f.at || 0) > FLOW_TTL_MS) { m.flow = null; return null; }
    return f;
}
function inFlow(user) { const f = user && user.memory && user.memory.flow; return !!(f && f.type && Date.now() - Date.parse(f.at || 0) <= FLOW_TTL_MS); }

// Intents that always end a flow (the voter moved on)
const BREAKERS = new Set(['abuse', 'bribe', 'opposed', 'wrong_number', 'condolence', 'who_are_you', 'was_sarpanch', 'voter_slip', 'opponent', 'taunt', 'memory_check', 'polling', 'ballot', 'commit', 'joke', 'about_baba', 'future', 'works']);
const isQuestion = t => /\?|\b(kya|kaise|kab|kahan|kaha|kaun|kon|kyon|kyu|kyun|kitna|kitne|kitni|kidhar|konsa|kaunsa|kaunsi)\b|(क्या|कैसे|कब|कहाँ|कहां|कौन|क्यों|कितन|किधर)/i.test(clean(t));
const WHAT_NEXT = /(kya hoga|kab hoga|kab tak|kuch hoga|hoga kuch|kab theek|kab thik|kab banegi|kab banega|kab lagegi|kab lagega|iska kya|uska kya|क्या होगा|कब होगा|कब तक|कुछ होगा|कब ठीक|कब बनेगी|कब बनेगा|इसका क्या)/i;
const PURPOSE_RX = /(baat karni|baat karna|baat krni|baat hai|baare me|bare me|ke liye|samasya|problem|shikayat|aashirwad|ashirwad|milna julna|milna-julna|chai pani|chai-pani|बात करनी|बात करना|के बारे में|के लिए|समस्या|शिकायत|आशीर्वाद|मिलना-जुलना|चाय)/i;
const THANKS_ACK = /(dhanyavad|dhanyawad|shukriya|thanks|thank you|धन्यवाद|शुक्रिया)/i;

// ---------------- SAMASYA ----------------
function canOfferMulaqat(user) {
    const m = voterMemory.ensure(user);
    if (m.told.mulaqatDeferredAt && Date.now() - Date.parse(m.told.mulaqatDeferredAt) < 20 * 3600e3) return false;
    if (m.told.mulaqatOffer || m.condolenceAt && Date.now() - Date.parse(m.condolenceAt) < 3 * 86400e3) return false;
    if (user.persuasionStage === 'opposed' || m.commitment.status === 'opposed') return false;
    try { const { mulaqatStore: ms } = stores(); if (user.phone && ms.openForPhone(user.phone).length) return false; } catch (e) {}
    return true;
}

function offerMulaqat(ctx) {
    const m = voterMemory.ensure(ctx.user);
    m.told.mulaqatOffer = new Date().toISOString();
    setFlow(ctx.user, { type: 'mulaqat_offer', step: 'answer' });
    return ctx.l === 'hi' ? OFFER[0] : OFFER[1];
}

/** Start logging a problem. topic may be null (voter only said "ek problem hai"). */
function startSamasya(ctx, { topic = null, explicit = false } = {}) {
    const { l, hon, message, user } = ctx;
    const S = (h, e) => (l === 'hi' ? h : e);
    if (!topic) {
        setFlow(user, { type: 'samasya', step: 'what', recordId: null, asked: 1 });
        const ji = /^(जी|ji)$/i.test(hon);
        return { text: (ji ? S('जी, ', 'Ji, ') : S(`जी ${hon}, `, `Ji ${hon}, `)) + (l === 'hi' ? q('what', l) : q('what', l).replace(/^B/, 'b')), flow: true };
    }
    const meta = metaOf(ctx);
    const loc = parseLocation(message) || {};
    const since = parseSince(message);
    const sank = kb.sankalpFor(topic, { village: loc.village || meta.village, text: message });
    const { samasyaStore: ss } = stores();
    const rec = ss.create({
        phone: meta.phone, name: meta.name, village: loc.village || (loc.ward ? voterMemory.WARD_VILLAGE[loc.ward] : null) || meta.village,
        ward: loc.ward || null, category: kb.samasyaCategory(topic), topic, description: clean(message).slice(0, 300),
        location: loc.place || null, since: since || null, sankalpId: sank ? sank.id : null, sankalp: sank ? sank.title : null,
        line: meta.line, test: meta.test, source: 'whatsapp'
    });
    const m = voterMemory.ensure(user);
    m.samasyaIds = (m.samasyaIds || []).concat([rec.id]).slice(-10);
    // The voter's own ward is a good default if they said "hamari/meri" (their own place) or the problem is personal
    if (!rec.ward && !rec.location && meta.ward && (PERSONAL.has(topic) || /(hamar|humar|mer[ae]|apn[ae]|mhar|हमार|मेर|अपन|म्हार|yahan|यहाँ|यहां)/i.test(message))) {
        ss.update(rec.id, { ward: meta.ward, village: rec.village || voterMemory.WARD_VILLAGE[meta.ward] || null, location: null }, 'bot');
    }
    const lmItems = kb.matchLandmarks(message).filter(i => i.type === 'done');
    const ji = /^(जी|ji)$/i.test(hon);
    let lead = ji ? S(`जी, ${empathy(topic, l)}।`, `Ji, ${empathy(topic, l)}.`) : S(`${hon}, ${empathy(topic, l)}।`, `${hon}, ${empathy(topic, l)}.`);
    if (lmItems.length) {
        const it = lmItems[0];
        lead = S(`${hon}, उस रास्ते पर पिछले कार्यकाल में काम हुआ था—${kb.render(it, 'hi', { full: true })} अब वहाँ जो दिक्कत है, वो मैं नोट कर रही हूँ।`, `${hon}, us raste par pichhle karyakal me kaam hua tha—${kb.render(it, 'en', { full: true })} Ab wahan jo dikkat hai, wo main note kar rahi hoon.`);
    }
    if (/(\bkab\b|कब)/i.test(message) && !lmItems.length) {
        lead += S(' पक्की तारीख़ का वादा मैं नहीं करूँगी, पर आपकी बात नोट करके सीधे अभय सिंह जी तक पहुँचाऊँगी।', ' Pakki tareekh ka vaada main nahi karungi, par aapki baat note karke seedhe Abhay Singh ji tak pahunchaungi.');
    } else if (!lmItems.length) {
        lead += S(' मैं इसे नोट कर रही हूँ।', ' Main ise note kar rahi hoon.');
    }
    const cur = ss.get(rec.id);
    if (!cur.ward && !cur.location) {
        setFlow(user, { type: 'samasya', step: 'where', recordId: rec.id, asked: 1, topic });
        return { text: `${lead} ${whereQ(topic, l, cur.village)}`, flow: true, samasyaId: rec.id };
    }
    if (!cur.location && cur.ward && !loc.ward && !loc.village && !PERSONAL.has(topic) && !lmItems.length) {
        setFlow(user, { type: 'samasya', step: 'where', recordId: rec.id, asked: 1, topic });
        return { text: `${lead} ` + S(`वार्ड ${cur.ward} में किस गली में, या किसके घर के पास?`, `Ward ${cur.ward} me kis gali me, ya kiske ghar ke paas?`), flow: true, samasyaId: rec.id };
    }
    if (!cur.since) {
        setFlow(user, { type: 'samasya', step: 'since', recordId: rec.id, asked: 1, topic });
        return { text: `${lead} ${q('since', l)}`, flow: true, samasyaId: rec.id };
    }
    return finalizeSamasya(ctx, rec.id, { lead: lmItems.length ? lead : '' });
}

function finalizeSamasya(ctx, id, { lead = '' } = {}) {
    const { l, hon, user } = ctx;
    const S = (h, e) => (l === 'hi' ? h : e);
    const { samasyaStore: ss } = stores();
    const rec = ss.get(id);
    setFlow(user, null);
    if (!rec) return { text: S(`ठीक है ${hon}, आपकी बात नोट कर ली है 🙏`, `Theek hai ${hon}, aapki baat note kar li hai 🙏`), flow: true };
    ss.update(id, { detailsComplete: true }, 'bot');
    const m = voterMemory.ensure(user);
    const label = kb.topicLabel(rec.topic, l);
    const where = locText(rec, l);
    const since = sinceText(rec.since, l);
    const summary = [label, where, since].filter(Boolean).join(', ');
    let text = (lead ? lead + ' ' : '') + S(`ठीक है ${hon}, आपकी शिकायत दर्ज कर ली है—${summary}। अभय सिंह जी तक पहुँचा दी है 🙏`, `Theek hai ${hon}, aapki shikayat darj kar li hai—${summary}. Abhay Singh ji tak pahuncha di hai 🙏`);
    const sank = rec.sankalpId ? kb.getItem(rec.sankalpId) : null;
    const used = [];
    if (sank && !(m.toldItems || []).includes(sank.id)) {
        text += S(` इसके लिए अभय सिंह जी का संकल्प भी है: ${kb.render(sank, 'hi')}`, ` Iske liye Abhay Singh ji ka sankalp bhi hai: ${kb.render(sank, 'en')}`);
        used.push(sank.id);
    }
    m.concerns.forEach(c => { if (c.topic === rec.topic) { c.samasyaId = rec.id; if (rec.ward && !c.ward) c.ward = rec.ward; } });
    if (m.openFollowUp && m.openFollowUp.topic === rec.topic) m.openFollowUp.samasyaId = rec.id;
    let ask = true;
    if (canOfferMulaqat(user)) { text += ' ' + offerMulaqat(ctx); ask = false; }
    return { text, flow: true, samasyaId: rec.id, used, ask, concernTopic: rec.topic };
}

// ---------------- MULAQAT ----------------
function startMulaqat(ctx, { type = 'visit', fromOffer = false, purpose = null } = {}) {
    const { l, hon, message, user } = ctx;
    const S = (h, e) => (l === 'hi' ? h : e);
    const meta = metaOf(ctx);
    const m = voterMemory.ensure(user);
    m.told.mulaqatOffer = m.told.mulaqatOffer || new Date().toISOString();
    const lastSamasya = (m.samasyaIds || []).slice(-1)[0] || null;
    const { mulaqatStore: ms } = stores();
    const open = meta.phone ? ms.openForPhone(meta.phone).filter(r => r.status === 'requested' || r.status === 'confirmed') : [];
    if (open.length && !fromOffer) {
        const r = open[open.length - 1];
        if (type === 'call' || /(number|nambar|नंबर)/i.test(message)) {
            const nums = /(number|nambar|नंबर)/i.test(message) ? S(' अभियान का WhatsApp नंबर 6367810227 और 9509352067 है।', ' Abhiyan ka WhatsApp number 6367810227 aur 9509352067 hai.') : '';
            return { text: S(`जी, आपकी बात पहले से टीम के पास दर्ज है—टीम आपसे फ़ोन पर संपर्क करेगी 🙏${nums}`, `Ji, aapki baat pehle se team ke paas darj hai—team aapse phone par sampark karegi 🙏${nums}`), flow: true, ask: false, mulaqatId: r.id };
        }
        if (r.status === 'confirmed') return { text: S(`${hon}, आपकी मुलाक़ात की बात पहले से तय है${r.preferredWhen && (l === 'hi' || !hasDev(r.preferredWhen)) ? ' (' + r.preferredWhen + ')' : ''} 🙏 कोई बदलाव हो तो बताइए, टीम तक पहुँचा दूँगी।`, `${hon}, aapki mulaqat ki baat pehle se tay hai${r.preferredWhen && !hasDev(r.preferredWhen) ? ' (' + r.preferredWhen + ')' : ''} 🙏 Koi badlav ho to bataiye, team tak pahuncha dungi.`), flow: true, ask: false, mulaqatId: r.id };
        if (r.detailsComplete) {
            const got = absorbMulaqatFields(r, clean(message), ms);
            const m2 = voterMemory.ensure(user);
            m2.lastMulaqat = { id: r.id, at: new Date().toISOString() };
            if (Object.keys(got).length) return { text: S(`जी${/^(जी|ji)$/i.test(hon) ? '' : ' ' + hon}, ये भी आपकी मुलाक़ात वाली बात में जोड़ दिया 🙏 टीम समय पक्का करके फ़ोन करेगी।`, `Ji${/^(जी|ji)$/i.test(hon) ? '' : ' ' + hon}, ye bhi aapki mulaqat wali baat me jod diya 🙏 Team samay pakka karke phone karegi.`), flow: true, ask: false, mulaqatId: r.id };
            if (m2.told.mulaqatDupAt && Date.now() - Date.parse(m2.told.mulaqatDupAt) < 6 * 3600e3) return { text: S(`जी${/^(जी|ji)$/i.test(hon) ? '' : ' ' + hon}, आपकी बात टीम के पास है 🙏 मिलने का दिन-समय या कोई और बात बदलनी हो तो बता दीजिए।`, `Ji${/^(जी|ji)$/i.test(hon) ? '' : ' ' + hon}, aapki baat team ke paas hai 🙏 Milne ka din-samay ya koi aur baat badalni ho to bata dijiye.`), flow: true, ask: false, mulaqatId: r.id };
            m2.told.mulaqatDupAt = new Date().toISOString();
            return { text: S(`${hon}, आपकी मुलाक़ात की बात पहले से दर्ज है 🙏 टीम समय पक्का करके आपको फ़ोन करेगी। कुछ और जोड़ना हो तो लिख दीजिए।`, `${hon}, aapki mulaqat ki baat pehle se darj hai 🙏 Team samay pakka karke aapko phone karegi. Kuch aur jodna ho to likh dijiye.`), flow: true, ask: false, mulaqatId: r.id };
        }
        return askNextMulaqat(ctx, r.id, S(`ज़रूर ${hon} 🙏`, `Zaroor ${hon} 🙏`));
    }
    const when = parseWhen(message);
    const loc = parseLocation(message) || {};
    const fam = /(log|jane|लोग|जने|member|sadasya|सदस्य)/i.test(message) ? parseCount(message) : null;
    const purp = purpose || (/(baare me|bare me|ke liye|samasya|problem|shikayat|बारे में|के लिए|समस्या|शिकायत|आशीर्वाद|aashirwad|ashirwad)/i.test(message) ? clean(message).slice(0, 160) : null);
    const rec = ms.create({
        type, phone: meta.phone, name: meta.name, village: loc.village || meta.village, ward: loc.ward || meta.ward || null,
        preferredWhen: when ? when.text : null, preferredDate: when ? when.date : null, place: loc.place || null,
        familyMembers: fam, purpose: purp || (lastSamasya ? 'samasya ' + lastSamasya : null), samasyaId: lastSamasya,
        line: meta.line, test: meta.test, source: 'whatsapp', status: 'requested'
    });
    m.mulaqatIds = (m.mulaqatIds || []).concat([rec.id]).slice(-5);
    if (type === 'call') {
        setFlow(user, { type: 'mulaqat', step: 'when', recordId: rec.id, asked: 1, callFirst: true });
        const ji = /^(जी|ji)$/i.test(hon);
        const nums = /(number|nambar|नंबर|no\.)/i.test(message) ? S(' अभियान का WhatsApp नंबर 6367810227 और 9509352067 है।', ' Abhiyan ka WhatsApp number 6367810227 aur 9509352067 hai.') : '';
        return { text: S(`जी${ji ? '' : ' ' + hon}, अभय सिंह जी से बात कराने की आपकी बात टीम तक पहुँचा दी है—टीम आपसे फ़ोन पर संपर्क करेगी 🙏${nums} चाहें तो उन्हें घर भी बुला सकते हैं—कौन-सा दिन और समय ठीक रहेगा?`, `Ji${ji ? '' : ' ' + hon}, Abhay Singh ji se baat karane ki aapki baat team tak pahuncha di hai—team aapse phone par sampark karegi 🙏${nums} Chahein to unhe ghar bhi bula sakte hain—kaun sa din aur samay theek rahega?`), flow: true, mulaqatId: rec.id };
    }
    const lead = fromOffer ? S(`बहुत अच्छा ${hon}! 🙏`, `Bahut achha ${hon}! 🙏`) : S(`ज़रूर ${hon}! 🙏 अभय सिंह जी से मुलाक़ात की आपकी बात टीम तक पहुँचाऊँगी।`, `Zaroor ${hon}! 🙏 Abhay Singh ji se mulaqat ki aapki baat team tak pahunchaungi.`);
    return askNextMulaqat(ctx, rec.id, lead);
}

function askNextMulaqat(ctx, id, lead = '') {
    const { l, user } = ctx;
    const { mulaqatStore: ms } = stores();
    const r = ms.get(id);
    const f = getFlow(user) || {};
    const ask = (step) => { setFlow(user, { type: 'mulaqat', step, recordId: id, asked: (f.asked || 0) + 1, skipped: f.skipped || [] }); return { text: (lead ? lead + ' ' : '') + q(step, l), flow: true, mulaqatId: id }; };
    const skipped = new Set(f.skipped || []);
    if (!r.preferredWhen && !skipped.has('when')) return ask('when');
    if (!r.place && !skipped.has('place')) return ask('place');
    if (!r.familyMembers && !skipped.has('family')) return ask('family');
    if (!r.purpose && !skipped.has('purpose')) return ask('purpose');
    return finalizeMulaqat(ctx, id, lead);
}

function finalizeMulaqat(ctx, id, lead = '') {
    const { l, hon, user } = ctx;
    const S = (h, e) => (l === 'hi' ? h : e);
    const { mulaqatStore: ms } = stores();
    const r = ms.update(id, { detailsComplete: true }, 'bot');
    setFlow(user, null);
    const ok = s => s && (l === 'hi' || !hasDev(s));
    const parts = [];
    if (ok(r.preferredWhen)) parts.push(r.preferredWhen);
    if (ok(r.place)) parts.push(r.place.slice(0, 60));
    if (r.ward && !(ok(r.place) && /(ward|वार्ड)\s*\d/i.test(r.place))) parts.push(S(`वार्ड ${r.ward}`, `ward ${r.ward}`));
    if (ok(r.purpose) && !/^samasya S-/.test(r.purpose) && !/^(ok+|okay|theek|thik|haan|ha|ji|जी|हाँ|ठीक)[\s\p{L}]{0,10}$/iu.test(String(r.purpose).trim())) parts.push(S(`विषय: ${r.purpose.slice(0, 50)}`, `vishay: ${r.purpose.slice(0, 50)}`));
    voterMemory.ensure(user).lastMulaqat = { id, at: new Date().toISOString() };
    { const fm = String(r.familyMembers || '').match(/\d+(\s*-\s*\d+)?/); if (fm) parts.push(S(`परिवार के ${fm[0].replace(/\s+/g, '')} लोग`, `parivar ke ${fm[0].replace(/\s+/g, '')} log`)); }
    const sum = parts.length ? '—' + parts.join(', ') : '';
    if (/^(जी, नोट किया।|Ji, note kiya\.)$/.test(lead)) lead = '';
    const text = (lead ? lead + ' ' : '') + S(`नोट कर लिया ${hon} 🙏${sum}। अभय सिंह जी की टीम समय पक्का करके आपको फ़ोन करेगी। आपके बुलावे के लिए दिल से धन्यवाद!`, `Note kar liya ${hon} 🙏${sum}. Abhay Singh ji ki team samay pakka karke aapko phone karegi. Aapke bulawe ke liye dil se dhanyavad!`);
    return { text, flow: true, mulaqatId: id, ask: false };
}

/** The one question an open (parked) flow is still waiting for — used to resume after answering a detour. */
function pendingQuestion(user, l) {
    const f = getFlow(user);
    if (!f || f.type !== 'samasya' || !f.recordId) return null;
    const { samasyaStore: ss } = stores();
    const rec = ss.get(f.recordId);
    if (!rec) return null;
    const label = kb.topicLabel(rec.topic, l);
    if (!rec.ward && !rec.location) return l === 'hi' ? `और आपकी ${label} वाली दिक्कत किस वार्ड या गली में है?` : `Aur aapki ${label} wali dikkat kis ward ya gali me hai?`;
    if (!rec.since) return l === 'hi' ? `और ${label} वाली दिक्कत कब से है?` : `Aur ${label} wali dikkat kab se hai?`;
    return null;
}

/** "gaon ki baat karni hai" right after a visit request was noted -> it is the purpose: update the record. */
function mulaqatPurposeFollowUp(ctx) {
    const { user, message, l, hon } = ctx;
    const m = voterMemory.ensure(user);
    const last = m.lastMulaqat;
    if (!last || Date.now() - Date.parse(last.at || 0) > 2 * 3600e3) return null;
    const t = clean(message);
    if (t.length > 160 || isQuestion(t)) return null;
    const { mulaqatStore: ms } = stores();
    const r = ms.get(last.id);
    if (!r) return null;
    if (!PURPOSE_RX.test(t)) {
        if (!(parseWhen(t) || (parseLocation(t) || {}).place || (/(log|jane|लोग|जने)/i.test(t) && parseCount(t)))) return null;
        absorbMulaqatFields({ ...r, preferredWhen: null, place: null, familyMembers: null, purpose: r.purpose }, t, ms);
        const ji0 = /^(जी|ji)$/i.test(hon);
        return { text: l === 'hi' ? `जी${ji0 ? '' : ' ' + hon}, ये बदलाव भी नोट कर लिया 🙏 टीम इसी हिसाब से समय पक्का करेगी।` : `Ji${ji0 ? '' : ' ' + hon}, ye badlav bhi note kar liya 🙏 Team isi hisaab se samay pakka karegi.`, flow: true, ask: false, mulaqatId: r.id };
    }
    const generic = !r.purpose || /^(samasya S-|milna-julna|मिलना-जुलना)/i.test(r.purpose);
    ms.update(r.id, { purpose: generic ? t.slice(0, 200) : (r.purpose + ' | ' + t).slice(0, 300) }, 'bot');
    m.lastMulaqat = null;
    const ji = /^(जी|ji)$/i.test(hon);
    return { text: l === 'hi' ? `जी${ji ? '' : ' ' + hon}, ये भी जोड़ दिया—"${t.slice(0, 60)}"। अभय सिंह जी को पहले से पता रहेगा कि किस बारे में बात करनी है 🙏` : `Ji${ji ? '' : ' ' + hon}, ye bhi jod diya—"${t.slice(0, 60)}". Abhay Singh ji ko pehle se pata rahega ki kis baare me baat karni hai 🙏`, flow: true, ask: false, mulaqatId: r.id };
}

/** Pull every field a voter packs into one message ("shiv mandir ke paas, 8 log hai ghar me"). */
function absorbMulaqatFields(rec, t, ms) {
    const patch = {};
    const w = parseWhen(t);
    if (w && !rec.preferredWhen) { patch.preferredWhen = w.text; patch.preferredDate = w.date; }
    const loc = parseLocation(t);
    if (loc && loc.place && !rec.place && !(w && loc.place === t.slice(0, 80))) patch.place = loc.place;
    if (loc && loc.ward && !rec.ward) patch.ward = loc.ward;
    if (loc && loc.village && !rec.village) patch.village = loc.village;
    const n = /(log|jane|jan\b|member|sadasya|लोग|जने|सदस्य)/i.test(t) ? parseCount(t) : null;
    if (n && !rec.familyMembers) patch.familyMembers = n;
    if (PURPOSE_RX.test(t) && !/(ghar bula|ghar par bula|घर बुला)/i.test(t) && (!rec.purpose || /^samasya S-/.test(rec.purpose))) patch.purpose = t.slice(0, 200);
    if (Object.keys(patch).length) ms.update(rec.id, patch, 'bot');
    return patch;
}

// ---------------- continue an open flow ----------------
/**
 * @returns result | null   (null = the message is not an answer to the open flow; the brain answers it normally)
 */
function continueFlow(ctx) {
    const { user, message, cls, l, hon } = ctx;
    const S = (h, e) => (l === 'hi' ? h : e);
    const f = getFlow(user);
    if (!f) return mulaqatPurposeFollowUp(ctx);
    const t = clean(message);
    const { samasyaStore: ss, mulaqatStore: ms } = stores();

    if (f.type === 'mulaqat_offer') {
        const bareAck = /^(ok+|okay|theek( hai)?|thik( hai)?|ठीक है|achha|accha|अच्छा|hmm+)[\s!.🙏👍]*$/i.test(t);
        if (cls.intent === 'commit' || cls.intent === 'family_votes') { setFlow(user, null); return null; } // "vote pakka" is not a yes to the visit
        if (cls.intent === 'meeting' || parseWhen(t) || (isYes(t) && !NO.test(t) && !bareAck && !THANKS_ACK.test(t))) return startMulaqat(ctx, { fromOffer: true });
        if (bareAck || THANKS_ACK.test(t) || cls.intent === 'thanks') {
            setFlow(user, null);
            const m = voterMemory.ensure(user);
            m.told.mulaqatOffer = null; m.told.mulaqatDeferredAt = new Date().toISOString();
            const ji = /^(जी|ji)$/i.test(hon);
            return { text: S(`आपका भी दिल से धन्यवाद${ji ? '' : ' ' + hon} 🙏 जब भी अभय सिंह जी को घर बुलाना हो, बस यहाँ लिख दीजिएगा।`, `Aapka bhi dil se dhanyavad${ji ? '' : ' ' + hon} 🙏 Jab bhi Abhay Singh ji ko ghar bulana ho, bas yahan likh dijiyega.`), flow: true, ask: false };
        }
        if (isNo(t)) {
            setFlow(user, null);
            const ji = /^(जी|ji)$/i.test(hon);
            return { text: S(`कोई बात नहीं${ji ? '' : ' ' + hon} 🙏 जब भी मन हो, बस यहाँ लिख दीजिएगा।`, `Koi baat nahi${ji ? '' : ' ' + hon} 🙏 Jab bhi mann ho, bas yahan likh dijiyega.`), flow: true, ask: false };
        }
        setFlow(user, null);
        return null;
    }

    // round 4: "raat ko light nahi rehti ward 10" answering "किस वार्ड/गली में?" is the location, not a new 'works' question
    const wardGiven = f.type === 'samasya' && f.step === 'where' && /(ward|वार्ड)\s*(no\.?|नं\.?|number|नंबर)?\s*\d{1,2}\b/i.test(t) && !isQuestion(t);
    const breaker = BREAKERS.has(cls.intent) && !(f.type === 'samasya' && f.step === 'what' && cls.intent === 'works') && !wardGiven;
    if (f.type === 'samasya') {
        if (cls.intent === 'meeting') { setFlow(user, null); return startMulaqat(ctx, { purpose: f.recordId ? 'samasya ' + f.recordId : null }); }
        if (f.step === 'what') {
            const topic = kb.primaryTopic(t, null);
            if (breaker && !topic) { setFlow(user, null); return null; }
            if (topic) return startSamasya(ctx, { topic });
            if (t.length >= 6 && !isQuestion(t)) {
                // a real problem without a known category -> log as "other"
                const meta = metaOf(ctx);
                const loc = parseLocation(t) || {};
                const rec = ss.create({ phone: meta.phone, name: meta.name, village: loc.village || meta.village, ward: loc.ward || null, category: 'other', topic: null, description: t.slice(0, 300), location: loc.place || null, since: parseSince(t), line: meta.line, test: meta.test, source: 'whatsapp' });
                const m = voterMemory.ensure(user); m.samasyaIds = (m.samasyaIds || []).concat([rec.id]).slice(-10);
                if (!rec.ward && !rec.location && !rec.village) { setFlow(user, { type: 'samasya', step: 'where', recordId: rec.id, asked: 1 }); return { text: S(`समझ गई ${hon}, ये नोट कर रही हूँ। `, `Samajh gayi ${hon}, ye note kar rahi hoon. `) + q('where', l), flow: true, samasyaId: rec.id }; }
                if (!rec.since) { setFlow(user, { type: 'samasya', step: 'since', recordId: rec.id, asked: 1 }); return { text: S(`समझ गई ${hon}, ये नोट कर रही हूँ। `, `Samajh gayi ${hon}, ye note kar rahi hoon. `) + q('since', l), flow: true, samasyaId: rec.id }; }
                return finalizeSamasya(ctx, rec.id);
            }
            setFlow(user, null);
            return null;
        }
        const rec = ss.get(f.recordId);
        if (!rec) { setFlow(user, null); return null; }
        // An answer we can't use (a question about something else, a new topic) "parks" the flow: the brain answers
        // that message normally and the flow stays open for the next message (max 2 parked messages).
        const park = () => { const n = (f.parked || 0) + 1; setFlow(user, n > 2 ? null : { ...f, parked: n }); return null; };
        if (f.step === 'where') {
            const loc = (['short_reply', 'unclear', 'gave_ward', 'introduce', 'topic_mention', 'complaint'].includes(cls.intent) || wardGiven) && !isQuestion(t) ? parseLocation(t, { loose: true }) : null;
            const short = t.split(/\s+/).length <= 8 && !isQuestion(t);
            const otherTopic = kb.primaryTopic(t, null);
            const sinceAns = parseSince(t);
            if (sinceAns && !(loc && (loc.ward || loc.village))) {
                ss.update(rec.id, { since: sinceAns }, 'bot');
                if ((f.asked || 1) < 2) { setFlow(user, { ...f, asked: (f.asked || 1) + 1 }); return { text: S('जी, नोट कर लिया। ', 'Ji, note kar liya. ') + whereQ(rec.topic, l, rec.village), flow: true, samasyaId: rec.id }; }
                return finalizeSamasya(ctx, rec.id);
            }
            if (loc || /^\d{1,2}$/.test(t)) {
                const ward = loc && loc.ward ? loc.ward : (/^\d{1,2}$/.test(t) && Number(t) <= 11 ? Number(t) : null);
                ss.update(rec.id, { ward: ward || rec.ward, village: (loc && loc.village) || (ward ? voterMemory.WARD_VILLAGE[ward] : null) || rec.village, location: (loc && loc.place) || rec.location }, 'bot');
                if (ward) { const m = voterMemory.ensure(user); if (!m.ward) m.ward = ward; if (!user.ward) user.ward = ward; }
                const since = parseSince(t);
                if (since) ss.update(rec.id, { since }, 'bot');
            } else if (WHAT_NEXT.test(t) && !f.reassured) {
                setFlow(user, { ...f, reassured: true, parked: 0 });
                const sk = rec.sankalpId ? kb.getItem(rec.sankalpId) : null;
                return { text: S(`${hon}, पक्की तारीख़ का वादा मैं नहीं करूँगी, पर आपकी बात अभय सिंह जी के रजिस्टर में दर्ज है और उन तक पहुँचेगी 🙏`, `${hon}, pakki tareekh ka vaada main nahi karungi, par aapki baat Abhay Singh ji ke register me darj hai aur un tak pahunchegi 🙏`) + ' ' + whereQ(rec.topic, l, rec.village).replace(/^Ye /, 'Bas ye bata dijiye, ye ').replace(/^ये /, 'बस ये बता दीजिए, ये '), flow: true, samasyaId: rec.id };
            } else if (isAck(t) && (f.parked || 0) > 0) {
                if (f.resumed) {
                    // we already re-asked the place after the detour: close quietly, never "log" it again
                    setFlow(user, null);
                    ss.update(rec.id, { detailsComplete: true }, 'bot');
                    return { text: S(`कोई बात नहीं${/^(जी|ji)$/i.test(hon) ? ' जी' : ' ' + hon}, आपकी ${kb.topicLabel(rec.topic, l)} वाली बात अभय सिंह जी के रजिस्टर में है 🙏 गली याद आए तो बस यहाँ लिख दीजिएगा।`, `Koi baat nahi${/^(जी|ji)$/i.test(hon) ? ' ji' : ' ' + hon}, aapki ${kb.topicLabel(rec.topic, l)} wali baat Abhay Singh ji ke register me hai 🙏 Gali yaad aaye to bas yahan likh dijiyega.`), flow: true, ask: false, samasyaId: rec.id };
                }
                if ((f.asked || 1) < 2) { setFlow(user, { ...f, asked: (f.asked || 1) + 1, parked: 0 }); return { text: S(`${hon}, आपकी ${kb.topicLabel(rec.topic, l)} वाली बात नोट है 🙏 बस इतना बता दीजिए—ये किस गली या वार्ड में है, ताकि सही जगह पहुँचे?`, `${hon === 'ji' ? 'Ji' : hon}, aapki ${kb.topicLabel(rec.topic, l)} wali baat note hai 🙏 Bas itna bata dijiye—ye kis gali ya ward me hai, taaki sahi jagah pahunche?`), flow: true, samasyaId: rec.id }; }
                return finalizeSamasya(ctx, rec.id); // an "ok" after a detour is not an answer: confirm with what we have
            } else if (isSkip(t) || isAck(t)) {
                // fine, move on without a place
                if (!ss.get(rec.id).since) { setFlow(user, { ...f, step: 'since', asked: (f.asked || 1) + 1, parked: 0 }); return { text: q('since', l), flow: true, samasyaId: rec.id }; }
            } else if (cls.intent === 'complaint' && otherTopic === rec.topic) {
                // more detail about the same problem: keep it, ask the place once more
                ss.update(rec.id, { description: (rec.description + ' | ' + t).slice(0, 400) }, 'bot');
                if ((f.asked || 1) < 2) { setFlow(user, { ...f, asked: (f.asked || 1) + 1 }); return { text: S('जी, ये भी नोट कर लिया। ', 'Ji, ye bhi note kar liya. ') + whereQ(rec.topic, l), flow: true, samasyaId: rec.id }; }
            } else if (breaker || !short || isQuestion(t) || (otherTopic && otherTopic !== rec.topic) || !['short_reply', 'unclear', 'gave_ward', 'introduce', 'topic_mention'].includes(cls.intent)) {
                return park();
            } else {
                ss.update(rec.id, { location: t.slice(0, 120) }, 'bot');
            }
            const cur = ss.get(rec.id);
            const b = cur.ward && !voterMemory.ensure(user).told.booth ? kb.boothForWard(cur.ward) : null;
            if (b) voterMemory.ensure(user).told.booth = true;
            const noted = cur.ward ? S(`जी, वार्ड ${cur.ward} नोट कर लिया${b ? ` (आपका बूथ ${b.booth}, कमरा ${b.room})` : ''}। `, `Ji, ward ${cur.ward} note kar liya${b ? ` (aapka booth ${b.booth}, room ${b.room})` : ''}. `) : S('जी, नोट कर लिया। ', 'Ji, note kar liya. ');
            if (!cur.since) { setFlow(user, { ...f, step: 'since', asked: (f.asked || 1) + 1, parked: 0 }); return { text: noted + q('since', l), flow: true, samasyaId: rec.id }; }
            return finalizeSamasya(ctx, rec.id);
        }
        if (f.step === 'since') {
            const since = parseSince(t);
            const short = t.split(/\s+/).length <= 8 && !isQuestion(t);
            const LOC_OK = ['short_reply', 'unclear', 'gave_ward', 'introduce', 'topic_mention', 'complaint'];
            const locAns = !since && LOC_OK.includes(cls.intent) && !isQuestion(t) ? parseLocation(t, { loose: true }) : null;
            if (locAns && (locAns.ward || locAns.place)) {
                ss.update(rec.id, { ward: locAns.ward || rec.ward, village: locAns.village || (locAns.ward ? voterMemory.WARD_VILLAGE[locAns.ward] : null) || rec.village, location: locAns.place || rec.location }, 'bot');
                const cur2 = ss.get(rec.id);
                const b2 = locAns.ward && !voterMemory.ensure(user).told.booth ? kb.boothForWard(locAns.ward) : null;
                if (b2) voterMemory.ensure(user).told.booth = true;
                const noted2 = locAns.ward ? S(`जी, वार्ड ${locAns.ward} नोट कर लिया${b2 ? ` (आपका बूथ ${b2.booth}, कमरा ${b2.room})` : ''}। `, `Ji, ward ${locAns.ward} note kar liya${b2 ? ` (aapka booth ${b2.booth}, room ${b2.room})` : ''}. `) : S('जी, नोट कर लिया। ', 'Ji, note kar liya. ');
                if ((f.asked || 1) < 2 && !cur2.since) { setFlow(user, { ...f, asked: (f.asked || 1) + 1 }); return { text: noted2 + q('since', l), flow: true, samasyaId: rec.id }; }
                return finalizeSamasya(ctx, rec.id);
            }
            if (!since && WHAT_NEXT.test(t) && !f.reassured) {
                setFlow(user, { ...f, reassured: true, parked: 0 });
                return { text: S(`${hon}, पक्की तारीख़ का वादा मैं नहीं करूँगी, पर आपकी बात अभय सिंह जी के रजिस्टर में दर्ज है और उन तक पहुँचेगी 🙏 बस ये बता दीजिए, दिक्कत कब से है?`, `${hon === 'ji' ? 'Ji' : hon}, pakki tareekh ka vaada main nahi karungi, par aapki baat Abhay Singh ji ke register me darj hai aur un tak pahunchegi 🙏 Bas ye bata dijiye, dikkat kab se hai?`), flow: true, samasyaId: rec.id };
            }
            if (since) ss.update(rec.id, { since }, 'bot');
            else if (isSkip(t) || isAck(t)) { /* move on without "since" */ }
            else return park();
            const loc = parseLocation(t);
            if (loc && !rec.ward && loc.ward) ss.update(rec.id, { ward: loc.ward }, 'bot');
            return finalizeSamasya(ctx, rec.id);
        }
    }

    if (f.type === 'mulaqat') {
        const rec = ms.get(f.recordId);
        if (!rec) { setFlow(user, null); return null; }
        const short = t.split(/\s+/).length <= 14 && !isQuestion(t);
        const skip = () => setFlow(user, { ...f, skipped: (f.skipped || []).concat([f.step]) });
        const restate = !parseWhen(t) && (cls.intent === 'meeting' || /(ghar bula|ghar par bula|ghar aa|घर बुला|घर आ)/i.test(t)) && !(f.reaskedWhen);
        if (f.step === 'when' && restate) {
            setFlow(user, { ...f, reaskedWhen: true });
            return { text: S(`ज़रूर${/^(जी|ji)$/i.test(hon) ? ' जी' : ' ' + hon}, घर पर ही मुलाक़ात की बात नोट कर रही हूँ 🙏 कौन-सा दिन और समय ठीक रहेगा?`, `Zaroor${/^(जी|ji)$/i.test(hon) ? ' ji' : ' ' + hon}, ghar par hi mulaqat ki baat note kar rahi hoon 🙏 Kaun sa din aur samay theek rahega?`), flow: true, mulaqatId: rec.id };
        }
        if (!breaker && !['thanks'].includes(cls.intent)) {
            const got = absorbMulaqatFields(rec, t, ms);
            const cur = ms.get(rec.id);
            const stepFilled = { when: !!cur.preferredWhen, place: !!cur.place, family: !!cur.familyMembers, purpose: !!cur.purpose }[f.step];
            if (Object.keys(got).length && stepFilled) {
                if (f.callFirst) ms.update(rec.id, { type: 'visit' }, 'bot');
                return askNextMulaqat(ctx, rec.id, S('जी, नोट किया।', 'Ji, note kiya.'));
            }
        }
        if (f.step === 'when') {
            const w = parseWhen(t);
            if (w) ms.update(rec.id, { preferredWhen: w.text, preferredDate: w.date }, 'bot');
            else if (isSkip(t) || /(team|टीम|aap|आप)\s*(bata|बता|tay|तय)/i.test(t)) { ms.update(rec.id, { preferredWhen: S('टीम तय करे', 'team tay kare') }, 'bot'); }
            else if (isNo(t) && f.callFirst) { setFlow(user, null); return { text: S(`ठीक है ${hon} 🙏 टीम आपसे फ़ोन पर बात कर लेगी।`, `Theek hai ${hon} 🙏 Team aapse phone par baat kar legi.`), flow: true, ask: false }; }
            else if (breaker || !short || ['thanks', 'short_reply', 'greeting', 'positive', 'unclear'].includes(cls.intent) && !/(din|दिन|samay|समय|time|baje|बजे|vaar|वार)/i.test(t)) { setFlow(user, null); return null; }
            else ms.update(rec.id, { preferredWhen: t.slice(0, 80) }, 'bot');
            if (f.callFirst) ms.update(rec.id, { type: 'visit' }, 'bot');
            const loc = parseLocation(t); if (loc && loc.place) ms.update(rec.id, { place: loc.place, ward: loc.ward || rec.ward }, 'bot');
            return askNextMulaqat(ctx, rec.id, S('जी, नोट किया।', 'Ji, note kiya.'));
        }
        if (f.step === 'place') {
            const loc = parseLocation(t);
            if (/^\[(location|लोकेशन)\]$/i.test(t)) ms.update(rec.id, { place: S('WhatsApp लोकेशन भेजी', 'WhatsApp location bheji') }, 'bot');
            else if (loc) ms.update(rec.id, { place: loc.place || t.slice(0, 120), ward: loc.ward || rec.ward, village: loc.village || rec.village }, 'bot');
            else if (isSkip(t)) skip();
            else if (breaker || !short) { setFlow(user, null); return null; }
            else ms.update(rec.id, { place: t.slice(0, 120) }, 'bot');
            const n = parseCount(t); if (n && /(log|jane|लोग|जने)/i.test(t)) ms.update(rec.id, { familyMembers: n }, 'bot');
            return askNextMulaqat(ctx, rec.id, S('ठीक है।', 'Theek hai.'));
        }
        if (f.step === 'family') {
            const n = parseCount(t);
            if (n) ms.update(rec.id, { familyMembers: n }, 'bot');
            else if (isSkip(t) || cls.intent === 'thanks') skip();
            else if (breaker || !short) { setFlow(user, null); return null; }
            else ms.update(rec.id, { familyMembers: t.slice(0, 40) }, 'bot');
            return askNextMulaqat(ctx, rec.id, '');
        }
        if (f.step === 'purpose') {
            if (breaker && cls.intent !== 'works') { setFlow(user, null); return null; }
            if (isSkip(t) || isNo(t)) ms.update(rec.id, { purpose: S('मिलना-जुलना', 'milna-julna') }, 'bot');
            else ms.update(rec.id, { purpose: t.slice(0, 200) }, 'bot');
            return finalizeMulaqat(ctx, rec.id);
        }
    }
    setFlow(user, null);
    return null;
}

module.exports = { pendingQuestion, mulaqatPurposeFollowUp, isQuestion, isAck, parseSince, parseLocation, parseWhen, parseCount, isYes, isNo, isSkip, startSamasya, finalizeSamasya, startMulaqat, continueFlow, offerMulaqat, canOfferMulaqat, inFlow, getFlow, setFlow, setStores, stores, OFFER };
