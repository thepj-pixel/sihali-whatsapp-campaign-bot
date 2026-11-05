/**
 * Vikas menu (6 Nov 2026, live fix): "Gram Vikas karya batao" was read as a NAME lookup ("*gram विकास karya* नाम से
 * सूची में पक्का नाम नहीं मिला"). Works questions are now a CATEGORY MENU:
 *   1. a generic works ask ("gram vikas", "vikas karya", "kya kaam kiye", "kaam batao", "विकास कार्य", "work done") ->
 *      the short menu below + a short-lived state `user.vikasMenu = { state: 'awaiting_vikas_category', at }`;
 *   2. the reply (number 1-8 or a Hindi/Hinglish/English word) -> that category's MAJOR done works from the parcha;
 *   3. a direct category question ("school me kya kaam hua") -> that category straight away.
 * Every line is parcha wording, looked up by id in rag_vault/parcha_facts.json (a fact edited out drops out of the reply).
 * No budgets, rupees, counts, ballot number, "पिछले कार्यकाल", sarpanch claim or vote ask; Amrit Sarovar is "चालू",
 * the mini stadium a "प्रयास", sankalp items are labelled "आगे का संकल्प". All lines are passive (no gendered verbs).
 * An open slip flow keeps its state: the menu answers this turn only, and slip_flow/nlu skip these replies when they
 * look for "the last bot question".
 */
const fs = require('fs');
const path = require('path');

const TTL_MS = 20 * 60e3;
const STATE = 'awaiting_vikas_category';
const MENU_HEAD = 'अभय सिंह जी की 40 साल की सच्ची समाज सेवा में हुए काम 🙏 किस बारे में जानना चाहेंगे?';
const END_LINE = 'और किसी विषय का जानना हो तो नंबर लिखिए 🙏';

let FACTS = null;
function facts() {
    if (FACTS) return FACTS;
    try { FACTS = JSON.parse(fs.readFileSync(path.join(__dirname, 'rag_vault', 'parcha_facts.json'), 'utf8')); } catch (e) { FACTS = {}; }
    return FACTS;
}
function byId(id) {
    const f = facts();
    for (const k of ['details', 'major', 'sankalp']) {
        const x = (f[k] || []).find(i => i && i.id === id);
        if (x) return x;
    }
    return null;
}

// Menu order -> categories. Lines: [emoji, parcha id]. D-K1 ("लगभग 75%") is left out: no figures in a voter reply.
const CATS = [
    { key: 'health', label: 'स्वास्थ्य', title: 'स्वास्थ्य', lines: [['🏥', 'D-H1'], ['🐄', 'D-H2']] },
    { key: 'road', label: 'सड़कें', title: 'सड़कें', lines: [['🛣️', 'D-R1'], ['🛤️', 'D-R4'], ['🚜', 'D-R3'], ['🧱', 'M6']] },
    { key: 'school', label: 'स्कूल/शिक्षा', title: 'स्कूल/शिक्षा', lines: [['📚', 'D-S1'], ['🏫', 'D-S2'], ['🛠️', 'D-S3'], ['🚻', 'D-S4'], ['🧱', 'D-S5']] },
    { key: 'sports', label: 'खेल मैदान', title: 'खेल मैदान', lines: [['🏃', 'D-K2'], ['🏀', 'D-K3'], ['💪', 'D-K4'], ['🧱', 'D-K5']] },
    { key: 'water', label: 'पानी (पेयजल/बोरवेल)', title: 'पानी (पेयजल/बोरवेल)', lines: [['💧', 'D-W1'], ['🚰', 'D-W2'], ['⛲', 'M11'], ['🌾', 'D-B2']] },
    { key: 'sewer', label: 'सीवरेज/सफ़ाई', title: 'सीवरेज/सफ़ाई', lines: [['🌊', 'M5'], ['🚧', 'D-N2'], ['🧱', 'D-N1'], ['🏫', 'D-N3']] },
    { key: 'moksh', label: 'मोक्षधाम/जोहड़/बाबा कुन्दनदास', title: 'मोक्षधाम/जोहड़/बाबा कुन्दनदास', lines: [['🕊️', 'M10'], ['🏞️', 'D-J1'], ['🛕', 'D-A1'], ['🧱', 'D-A2'], ['🌊', 'D-A3']] },
    { key: 'sankalp', label: 'आगे का संकल्प', title: 'आगे का संकल्प', future: true, lines: [['🏟️', 'F1'], ['💧', 'F2'], ['💡', 'F4'], ['🩺', 'F7'], ['🛣️', 'F9']] }
];

// Words that pick a category (Hindi, Hinglish, English). Order = priority when a message names more than one.
const CAT_RX = {
    sankalp: /(sankalp|sankalap|aage\s*(ka|ke|kya)|aage\b|future|aane wale|yojna|yojana|संकल्प|आगे|भविष्य|योजना)/i,
    health: /(swasth|swasthya|swastya|health|hospital|aspatal|aspataal|haspatal|dispensary|ilaaj|ilaj|doctor|daktar|pashu|chikitsa|स्वास्थ्य|स्वस्थ|अस्पताल|चिकित्सा|इलाज|डॉक्टर|पशु)/i,
    school: /(school|skool|scool|shiksha|siksha|padhai|padhayi|padai|library|librery|vidyalaya|education|स्कूल|शिक्षा|पढ़ाई|पढाई|लाइब्रेरी|विद्यालय)/i,
    sports: /(khel|stadium|gym|jim\b|ground|maidan|maidaan|running|track|sports?|खेल|स्टेडियम|जिम|मैदान)/i,
    sewer: /(sewer|sewerage|seweraj|seevar|naali|nali\b|naala|nala\b|drain|safai|safaai|gande paani|सीवर|सीवरेज|नाली|नाला|सफ़ाई|सफाई|निकासी)/i,
    moksh: /(moksh|mokshdham|shamshan|smashan|shmashan|samshan|johad|johar|jodh|mandir|ashram|aashram|kundan|sarovar|मोक्ष|श्मशान|शमशान|जोहड़|जोहड|मंदिर|आश्रम|कुन्दन|कुंदन|सरोवर)/i,
    water: /(paani|pani\b|tanki|borewell|bore\s*well|boring|\bjal\b|jjm|\bnal\b|water|पानी|टंकी|बोरवेल|बोरिंग|(?:^|\s)(?:जल|नल)(?:\s|$))/i,
    road: /(sadak|sadke|sadako|sadkon|road|damar|daamar|rasta|raste|interlocking|\bcc\b|सड़क|सडक|डामर|रास्त|इंटरलॉकिंग)/i
};

const SLIP_RX = /(parchi|parchee|parchii|pqrchi|slip|voter\s*(list|id|card|slip)|वोटर\s*(लिस्ट|आईडी|कार्ड|पर्ची)|पर्ची|epic)/i;
// a taunt / complaint / future-date question is not a works menu ask ("kuch kaam nahi kiya", "kaam kab hoga")
const NEG_RX = /(\bnahi|\bnahin|\bnhi\b|\bnhai|\bnaa?\b|jhooth|jhoot|jhuth|bakwas|bekar|bekaar|shikayat|शिकायत|बेकार|\bkab\b|\bkabhi|\btoot|\btuti|\btooti|kharab|kharaab|\bband\b|नहीं|(?:^|\s)ना(?:\s|$)|झूठ|बकवास|(?:^|\s)कब(?:\s|$|\?)|टूट|खराब|ख़राब|(?:^|\s)बंद)/i;
const OFFICER_RX = /(adhikari|officer|vdo|अधिकारी)/i;
const VIKAS = '(?:vikas|vikaas|vikash|vkas|विकास)';
const WORK = '(?:karya|kary|kaarya|karyo|kaary|kaam|kaj|kaaj|works?|कार्य|कार्यों|काम|कामों)';
const DONE = '(?:kiye|kiya|kie|kia|kiyе|karaye|karwaye|karwaya|karaya|karvaye|karvaya|kraye|krwaye|krwaya|kra|hue|hua|huye|hoye|banwaye|banwaya|किए|किये|किया|करवाए|करवाये|करवाया|कराए|कराया|हुए|हुआ|बनवाए|बनवाया)';
const ASK = '(?:bata|batao|bataiye|bataye|batayiye|btao|bta|btaiye|batana|batado|bata do|gina|ginao|dikhao|list|बता|बताओ|बताइए|बताइये|बताएं|बताएँ|गिनाओ|गिनाइए|दिखाओ)';
const MENU_RX = new RegExp([
    `(?:gram|graam|gaon|gaav|gaanv|gaam|panchayat|ग्राम|गाँव|गांव|पंचायत)\\s*(?:ka|ke|ki|का|के|की|me|में)?\\s*${VIKAS}`,
    `${VIKAS}\\s*(?:ka|ke|ki|का|के|की)?\\s*${WORK}`,
    `${WORK}\\s*(?:ka|ke|ki|का|के|की)?\\s*${VIKAS}`,
    `(?:kya|kya kya|kaun|kon|konse|kaunse|kaun\\s*se|kon\\s*se|क्या|कौन|कौन\\s*से)\\s*(?:se\\s*)?(?:kaam|kam|karya|kaarya|काम|कार्य)\\s*(?:-?\\s*kaam\\s*)?(?:${DONE})`,
    `(?:kaam|karya|kaarya|works?|काम|कार्य)\\s*(?:kya|क्या)\\s*(?:${DONE})`,
    `(?:kaam|karya|kaarya|works?|काम|कार्य)\\s*(?:${ASK})`,
    // v9 (owner 03:04): "baba ke kaam ki poori list", "baba ke kaam", "kaam ki list", "abhay singh ne kya kaam kiye"
    `(?:baba|abhay|abhey|abhai|बाबा|अभय)\\s*(?:ji|जी|singh|सिंह)?\\s*(?:ji|जी)?\\s*(?:ne|ke|ka|ki|ne\\s*kya|के|का|की|ने)\\s*(?:kya\\s*(?:kya\\s*)?)?${WORK}`,
    `${WORK}\\s*(?:ki|ka|ke|की|का|के)?\\s*(?:poori|puri|pura|poora|sari|saari|sab|पूरी|पूरा|सारी)?\\s*(?:list|lisht|suchi|soochi|लिस्ट|सूची)`,
    `(?:what|which)\\s+(?:work|works|development)`, `works?\\s+done`, `development\\s+works?`, `list\\s+of\\s+works`
].join('|'), 'i');
// a direct category question needs a works marker next to the category word
const CAT_ASK_RX = new RegExp([
    `(?:kya|kya kya|kaun|kon|konse|kaunse|क्या|कौन)\\s*(?:se\\s*)?(?:kaam|karya|kaarya|काम|कार्य)`,
    `(?:kaam|karya|kaarya|काम|कार्य)\\s*(?:kya|क्या)?\\s*(?:${DONE})`,
    `(?:kya|क्या)\\s*(?:${DONE}|banaya|banwaya|बनाया|बनवाया)`,
    `(?:kaam|karya|kaarya|works?|काम|कार्य)\\s*(?:${ASK})`,
    `${VIKAS}`, `what\\s+(?:work|was\\s+done|has\\s+been\\s+done)`, `works?\\s+done`
].join('|'), 'i');

const low = s => String(s || '').toLowerCase().trim();
function catIn(text) {
    const t = String(text || '');
    let best = null, pos = Infinity;
    for (const k of Object.keys(CAT_RX)) {
        const m = t.match(CAT_RX[k]);
        if (m && m.index < pos) { pos = m.index; best = k; }
    }
    return best;
}
function lastBotText(user) {
    const h = (user && Array.isArray(user.history) ? user.history : []).filter(x => x && x.role === 'bot');
    return h.length ? String(h[h.length - 1].text || '') : null;
}
/** Is this one of our menu / category replies? (slip_flow / nlu look past them for the open slip question) */
function isVikasText(t) { const s = String(t || ''); return s.includes(MENU_HEAD) || s.includes(END_LINE); }
function awaiting(user) {
    const v = user && user.vikasMenu;
    if (!v || v.state !== STATE || !v.at || Date.now() - Date.parse(v.at) > TTL_MS) return false;
    const lb = lastBotText(user);
    // the menu (or a category answer) must still be our latest message; history without bot turns trusts the state
    return lb === null || isVikasText(lb);
}

/** Pure check: what would this message be? -> { kind: 'menu' } | { kind: 'category', cat } | null. No state change. */
function detect(text, user) {
    const t = String(text || '').trim();
    if (!t || t.length > 160) return null;
    if (SLIP_RX.test(t) || OFFICER_RX.test(t)) return null;
    if (awaiting(user)) {
        const num = t.match(/^\s*(?:no\.?|number|nambar|नंबर)?\s*([1-8१-८])\s*(?:no\.?|number|नंबर)?\s*[.)।!🙏]*\s*$/i);
        if (num) {
            const d = Number(String(num[1]).replace(/[१-८]/, c => '१२३४५६७८'.indexOf(c) + 1));
            return { kind: 'category', cat: CATS[d - 1].key };
        }
        if (/^\s*(?:ward|वार्ड)\b/i.test(t)) return null; // "ward 3" answers the slip, never the menu
        const c = catIn(t);
        if (c && t.split(/\s+/).length <= 7 && !(NEG_RX.test(t) && c !== 'sankalp')) return { kind: 'category', cat: c };
    }
    if (NEG_RX.test(t) && !/(aage|आगे|sankalp|संकल्प)/i.test(t)) return null;
    const c = catIn(t);
    if (c && CAT_ASK_RX.test(t)) return { kind: 'category', cat: c };
    if (MENU_RX.test(t)) return { kind: 'menu' };
    return null;
}

function slipOpenLine(user) {
    try { if (require('./slip_flow.js').openSlipQuestion(user)) return "\n(पर्ची वाली बात भी चालू है—वार्ड बताना हो तो 'वार्ड' लिखकर नंबर भेजिए 🙏)"; } catch (e) {}
    return '';
}
function menuText(user) {
    return MENU_HEAD + '\n' + CATS.map((c, i) => `${i + 1}. ${c.label}`).join('\n') + '\nनंबर या विषय लिख दीजिए।' + slipOpenLine(user);
}
function categoryText(key) {
    const c = CATS.find(x => x.key === key);
    if (!c) return null;
    const rows = c.lines.map(([e, id]) => { const f = byId(id); return f && f.hi ? `${e} ${f.hi}` : null; }).filter(Boolean).slice(0, 5);
    if (!rows.length) return null;
    const head = c.future ? '*आगे का संकल्प* (ये काम आगे करवाए जाएँगे):' : `*${c.title}* — पंचायत में करवाए गए मुख्य काम:`;
    return [head].concat(rows, [END_LINE]).join('\n');
}

/** Output check with the brain's own hard-rule patterns (length / digits of the menu numbering are fine here). */
function guard(text) {
    let rb = null; try { rb = require('./reply_brain.js'); } catch (e) {}
    const r = String(text || '');
    if (!rb) return null;
    if (rb.BANNED.test(r)) return 'banned';
    if (rb.SARPANCH_CLAIM.test(r) || /पिछले कार्यकाल/.test(r)) return 'sarpanch_claim';
    if (/(₹|रुपये|रुपए|लाख|करोड़|\blakh\b|crore|rupees?|budget|बजट|लागत|%)/i.test(r)) return 'money';
    if (/(\d+\s*\+?\s*(काम|कार्य|संकल्प|सड़कें|kaam|sankalp|works))/i.test(r)) return 'work_count';
    if (rb.BALLOT_NUMBER.test(r)) return 'ballot_number';
    if (rb.SYMBOL.test(r)) return 'symbol';
    if (rb.PROMISED_DATE.test(r)) return 'promised_date';
    if (/(वोट|vote|मुहर|mohar)/i.test(r)) return 'vote_ask';
    if (/(स्टेडियम|stadium)/i.test(r) && !/(प्रयास|prayas)/i.test(r)) return 'stadium_claim';
    if (/(सरोवर|sarovar)/i.test(r) && !/(चालू|chalu)/i.test(r)) return 'sarovar_claim';
    return null;
}

/** Stateful: build the reply for a detect() verdict and set/refresh the menu state. Slip state is never touched. */
function reply(v, user) {
    if (!v) return null;
    let text = v.kind === 'menu' ? menuText(user) : categoryText(v.cat);
    if (!text) return null;
    const bad = guard(text);
    if (bad) { console.warn('[vikas_menu] guard refused', bad); text = menuText(user); if (guard(text)) return null; }
    if (user) user.vikasMenu = { state: STATE, at: new Date().toISOString(), last: v.kind === 'menu' ? 'menu' : v.cat };
    return { intent: v.kind === 'menu' ? 'vikas_menu' : 'vikas_category', cat: v.cat || null, text };
}
function clear(user) { if (user && user.vikasMenu) delete user.vikasMenu; }

module.exports = { detect, reply, clear, awaiting, isVikasText, menuText, categoryText, guard, CATS, STATE, MENU_HEAD, END_LINE, catIn };
