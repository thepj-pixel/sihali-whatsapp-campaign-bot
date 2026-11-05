/**
 * Voter-slip (parchi) conversation state — one decision function shared by server.js and ai_assistant_service.js.
 *
 * Fixes from the owner's live test (4 Nov 2026 night):
 *   - "Krishan Kumar" must match the FULL name (कृष्ण कुमार), not every "कृष्ण"; a ward the voter mentioned for a
 *     complaint is only a tie-breaker, never a hard filter (only a ward written in the slip message filters).
 *   - When a numbered list is pending, a bare "1" / "pehla" / "1️⃣" selects that voter (never read as a ward).
 *   - "meri parchi bhejo" reuses the name already given (memory / last slip search / found voter).
 *   - "maine abhi bataya" continues the pending slip step instead of drifting to another topic.
 * Privacy rule (unchanged from voter_engine's design): a single name match is confirmed with the father/husband name
 * ("हाँ") before the slip goes; a list shows father/husband names and the voter picks their own entry.
 */
const voterEngine = require('./voter_engine.js');

const PENDING_TTL_MS = 2 * 3600 * 1000;
const lowerOf = s => String(s || '').toLowerCase().trim();

const YES_RX = /^(ha+n?|haa+n?|han|hn|ha ji|haan ji|haa ji|ji+|ji haan|jee|yes|yess?|yup|ok|okay|sahi|sahi (h|hai|he)|shi h|yahi|yahi (h|hai|he)|yehi|wahi|bilkul|theek|thik|theek (h|hai)|thik (h|hai)|correct|right|हाँ|हां|हा|जी|जी हाँ|जी हां|सही|सही है|यही|यही है|बिल्कुल|ठीक है)\b[\s!.,🙏👍]*((ji|जी|bhai|bhaiya|sahi|hai|h|yahi|wahi|mera|meri|naam|सही|है|यही|मेरा|बिल्कुल|bilkul)[\s!.,🙏👍]*){0,3}$/i;
const NO_RX = /^(nahi+|nhi|nahin|na+|no|galat|galat (h|hai)|ye nahi|yeh nahi|wo nahi|नहीं|ना|गलत|ग़लत)\b/i;
const RECALL_RX = /((maine|mene|meine|humne|मैंने|हमने)\s*(abhi|pehle|pahle|to|toh|अभी|पहले|तो)?\s*(to|toh|तो)?\s*(bataya|btaya|bata diya|bata to diya|bola|likha|बताया|बता दिया|बोला|लिखा)|bata (to )?diya|already bataya|upar (likha|bataya)|बता (तो )?दिया|ऊपर (लिखा|बताया))/i;
const SLIP_WORD_RX = /(parchi|parchee|parchii|voter slip|\bslip\b|voter card|voter id|\bepic\b|पर्ची|मतदाता पर्ची|पहचान पत्र|वोटर (स्लिप|कार्ड|आईडी))/i;
const IMPLICIT_NO = /(abhay|abhey|abhai|baba|अभय|बाबा|kutt|kamin|harami|chor|bekar|bakwas|chup|paise|paisa|kha gaya|kon h|kaun|elon|musk|zuckerberg|modi|news|कुत्त|कमीन|हरामी|चोर|बेकार|बकवास|चुप)/i;
const CONCERN_NO = /(naali|nali|sadak|paani|pani|bijli|light|toot|tuti|tooti|band|kharab|dikkat|problem|samasya|shikayat|gali|ghar ke|ke paas|ke saamne|mandir|school|johad|kichad|keechad|नाली|सड़क|पानी|बिजली|टूट|बंद|ख़राब|खराब|दिक्कत|समस्या|शिकायत|गली|के पास|मंदिर|स्कूल)/i;
const ORDINALS = [
    /^(1|one|ek|pehla|pahla|pehli|pahli|pehle|pahle|first|pehla wala|pehle wala|पहला|पहली|पहले|एक|१)$/i,
    /^(2|two|do|dusra|doosra|dusri|doosri|dusre|second|दूसरा|दूसरी|दूसरे|दो|२)$/i,
    /^(3|three|teen|teesra|tisra|teesri|third|तीसरा|तीसरी|तीन|३)$/i,
    /^(4|four|char|chaar|chautha|chauthi|चौथा|चौथी|चार|४)$/i,
    /^(5|five|paanch|panch|paanchva|पाँचवाँ|पांचवां|पाँच|पांच|५)$/i
];
const NON_NAME = new Set(('haa haan han hn ha ji jee arre arey are aree abhi maine mene meine bataya btaya batao bata diya mera meri mere mujhe ' +
    'hamari hamara humari naam nam name h hai he hain hu hoon bhi bhej bhejo bhejna bhejiye bhej do dena de dedo do dijiye chahiye chaiye ' +
    'parchi parchee slip voter card id epic wala wali wale number no nambar sahi yahi please plz bhai bhaiya na naa toh to ki ka ke ko ' +
    'apni apna apne meri sirf bas ek list me mein se se par pe nikalo nikal nikaal dikhao dekho dekhna check kar karo kardo de ' +
    'ab phir fir jaldi jldi jaldii yaar yr ok okay theek thik hello hi hii ram raam namaste').split(/\s+/));
const NON_NAME_HI = /^(हाँ|हां|अरे|अभी|मैंने|बताया|मेरा|मेरी|मुझे|नाम|है|हूँ|भी|भेज|भेजो|भेजिए|दो|दीजिए|चाहिए|पर्ची|वोटर|स्लिप|कार्ड|वाला|नंबर|सही|यही|भाई|ना|तो|की|का|के|को|अपनी|अपना|सिर्फ|लिस्ट|में|से|पर|निकालो|दिखाओ|जी|जल्दी)$/;

/** 0-based index the voter picked from a pending list of n, or -1. */
function choiceIndex(text, n) {
    let t = lowerOf(text).replace(/[\u20e3\ufe0f]/g, '').replace(/[.)\]!,🙏👍]+$/g, '').replace(/^(no\.?|number|nambar|नंबर|option|opshan|wala)\s*/i, '').replace(/\s*(number|nambar|no|wala|wali|vala|वाला|वाली|नंबर|वाला है|hai|h|है|ji|जी|bhai)\s*$/i, '').trim();
    t = t.replace(/\s*(wala|wali|vala|वाला|वाली)\s*$/i, '').trim();
    for (let i = 0; i < Math.min(n, ORDINALS.length); i++) if (ORDINALS[i].test(t)) return i;
    const d = t.match(/^(\d{1,2})$/);
    if (d && Number(d[1]) >= 1 && Number(d[1]) <= n) return Number(d[1]) - 1;
    return -1;
}
const EMOJI_YES_RX = /^[\s👍🙏✅👌☑✔\ufe0f\u{1F3FB}-\u{1F3FF}]+$/u; // 👍 / ✅ / 🙏 to "is this your father's name?" = yes
const isYes = t => (YES_RX.test(lowerOf(t)) && !NO_RX.test(lowerOf(t))) || (EMOJI_YES_RX.test(String(t || '').trim()) && /[👍🙏✅👌☑✔]/u.test(String(t || '')));
const isNo = t => NO_RX.test(lowerOf(t)) && lowerOf(t).split(/\s+/).length <= 4;
const isRecall = t => RECALL_RX.test(String(t || ''));
const isSlipAsk = t => SLIP_WORD_RX.test(String(t || ''));

/** The name part of a message ("Haa Krishan Kumar naam h mera" -> "Krishan Kumar"); '' when there is none. */
function nameQuery(text) {
    const toks = String(text || '').replace(/(?:ward|वार्ड|w)\s*(?:no\.?|नं\.?)?\s*[:#-]?\s*\d{1,2}/ig, ' ').split(/[^a-zA-Z\u0900-\u097F]+/).filter(Boolean);
    return toks.filter(w => w.length >= 2 && !NON_NAME.has(w.toLowerCase()) && !NON_NAME_HI.test(w)).join(' ').trim();
}
function wardIn(text) {
    const m = String(text || '').match(/(?:ward|वार्ड)\s*(?:no\.?|नं\.?|number)?\s*[:#-]?\s*(\d{1,2})\b/i);
    return m && Number(m[1]) >= 1 && Number(m[1]) <= 11 ? Number(m[1]) : null;
}
const relText = v => lowerOf(`${v.rel_name_hi || ''} ${v.rel_name || ''} ${v.rel_name_en || ''} ${v.r_en || ''}`);
const SURNAME_TOK = /^(singh|kumar|kumari|devi|yadav|ram|lal|chand|chandra|prasad|sharma|saini|meena|gurjar|सिंह|कुमार|कुमारी|देवी|यादव|राम|लाल|चन्द|चंद|प्रसाद|शर्मा)$/i;
const QUESTION_RX = /(\?|\bwho\b|\bwhat\b|kaun|kon\b|kya\b|kyu|kaise|कौन|क्या|क्यों|कैसे)/i;
function fatherGiven(text, v) {
    if (QUESTION_RX.test(String(text || ''))) return false;
    const low = lowerOf(text);
    const parts = [v.rel_name_hi, v.rel_name, v.rel_name_en, v.r_en].filter(Boolean).map(lowerOf).filter(x => x.length >= 3);
    if (parts.some(p => low.includes(p))) return true;
    // first word of the father's name in Roman/Devanagari ("Bhawani" for "भवानी राम") via the engine's transliteration
    const toks = nameQuery(text).toLowerCase().split(/\s+/).filter(w => w.length >= 3 && !SURNAME_TOK.test(w) && !SURNAME_TOK.test(voterEngine.translit ? voterEngine.translit(w) : w));
    const rel = relText(v).split(/\s+/).filter(w => w.length >= 3);
    return toks.some(tk => rel.includes(tk) || (voterEngine.translit && rel.includes(voterEngine.translit(tk))));
}

/** Search the roll: full-name matches first; a ward typed in the message filters; the profile ward only breaks ties. */
function search(q, user, text) {
    const ward = wardIn(text);
    const query = q + (ward ? ` ward ${ward}` : '');
    let found = voterEngine.searchVoters(query, 8, ward || null);
    if (!found.length) return [];
    const toks = q.toLowerCase().split(/\s+/).filter(w => w.length >= 2);
    const tr = w => (voterEngine.translit ? voterEngine.translit(w) : w);
    const nameHas = (v, w) => { const nh = lowerOf(v.name_hi), ne = lowerOf(v.name); const h = tr(w); return nh.split(/\s+/).includes(h) || ne.split(/\s+/).includes(w) || nh.split(/\s+/).includes(w); };
    const full = toks.length >= 2 ? found.filter(v => toks.every(w => nameHas(v, w))) : [];
    if (full.length) found = full;
    else if (toks.length === 1) {
        const exact = found.filter(v => nameHas(v, toks[0]));
        if (exact.length) found = exact;
    }
    const pref = !ward && user ? (Number(user.ward) || (user.memory && Number(user.memory.ward)) || null) : null;
    if (pref) found = found.slice().sort((a, b) => (Number(b.ward) === pref) - (Number(a.ward) === pref));
    return found.slice(0, 5);
}

function rememberedName(user) {
    if (!user) return '';
    const m = user.memory || {};
    const cands = [user.lastSlipQuery, m.name, user.lastSearchedQuery].map(nameQuery).filter(Boolean);
    return cands[0] || '';
}

function lastBot(user) {
    const h = (user && Array.isArray(user.history) ? user.history : []).filter(x => x.role === 'bot');
    return h.length ? String(h[h.length - 1].text || '') : '';
}
const fresh = (user, key) => user && user[key] && (!user.slipPendingAt || Date.now() - Date.parse(user.slipPendingAt) < PENDING_TTL_MS);

function confirmText(v, en) {
    const rel = v.rel_type === 'H' ? 'पति' : 'पिताजी';
    if (en) return `Voter list me *${v.name_hi || v.name}* naam mila hai 📋\n\nKya aapke ${v.rel_type === 'H' ? 'pati' : 'pitaji'} ka naam *${v.rel_name_hi || '—'}* (ward ${v.ward}, makan no. ${v.house_no || '—'}) hai?\n\nSahi ho to bas *'haan'* likh dijiye—parchi turant bhej dungi 🙏\n*(Agar ye aap nahi hain, to apna poora naam aur pita/pati ka naam likhiye)*`;
    return `वोटर लिस्ट में *${v.name_hi || v.name}* नाम मिला है 📋\n\nक्या आपके ${rel} का नाम *${v.rel_name_hi || '—'}* (वार्ड ${v.ward}, मकान नं. ${v.house_no || '—'}) है?\n\nसही हो तो बस *'हाँ'* लिख दीजिए—पर्ची तुरंत भेज दूँगी 🙏\n*(अगर ये आप नहीं हैं, तो अपना पूरा नाम और पिता/पति का नाम लिखिए)*`;
}
function listText(matches, q, en) {
    if (en) {
        let e = `Voter list me *${q}* se milte ${matches.length} naam mile hain:\n\n`;
        matches.forEach((m, i) => { e += `${i + 1}️⃣ *${m.name_hi}* (${m.rel_type === 'H' ? 'pati' : 'pita'}: ${m.rel_name_hi}) — ward ${m.ward}, makan no. ${m.house_no || '—'}\n`; });
        return e + `\nAap inme se kaun hain? Bas number (*1*, *2*…) ya apne pita/pati ka naam bhej dijiye—aapki parchi turant bhej dungi 🙏`;
    }
    let t = `वोटर लिस्ट में *${q}* से मिलते ${matches.length} नाम मिले हैं:\n\n`;
    matches.forEach((m, i) => { t += `${i + 1}️⃣ *${m.name_hi}* (${m.rel_type === 'H' ? 'पति' : 'पिता'}: ${m.rel_name_hi}) — वार्ड ${m.ward}, मकान नं. ${m.house_no || '—'}\n`; });
    return t + `\nआप इनमें से कौन हैं? बस नंबर (*1*, *2*…) या अपने पिता/पति का नाम भेज दीजिए—आपकी पर्ची तुरंत भेज दूँगी 🙏`;
}
const ASK_NAME = 'पर्ची अभी निकाल देती हूँ 🙏 अपना पूरा नाम और पिता/पति का नाम लिख भेजिए (वार्ड पता हो तो वो भी)।';
const ASK_NAME_EN = 'Parchi abhi nikaal deti hoon 🙏 Apna poora naam aur pita/pati ka naam likh bhejiye (ward pata ho to wo bhi).';
const NOT_FOUND_EN = q => `*${q}* naam se list me pakka naam nahi mila 🙏 Apna poora naam waise likhiye jaise voter card par hai, saath me pita/pati ka naam ya ward bhi likh dijiye—phir se dekh leti hoon.`;
const NOT_FOUND = q => `*${q}* नाम से सूची में पक्का नाम नहीं मिला 🙏 अपना पूरा नाम वैसे लिखिए जैसे वोटर कार्ड पर है, साथ में पिता/पति का नाम या वार्ड भी लिख दीजिए—फिर से देख लेती हूँ।`;

function setPending(user, kind, payload) {
    if (!user) return;
    delete user.pendingParchiCandidate; delete user.disambiguationMatches;
    if (kind === 'confirm') user.pendingParchiCandidate = payload;
    if (kind === 'choose') user.disambiguationMatches = payload;
    user.slipPendingAt = new Date().toISOString();
}
function deliverTo(user, v) {
    if (user) {
        delete user.pendingParchiCandidate; delete user.disambiguationMatches; delete user.slipPendingAt;
        user.lastFoundVoter = v;
        user.ward = user.ward || Number(v.ward) || user.ward;
        // never wipe or overwrite what the voter told us: only fill blanks, and keep the slip facts alongside
        try {
            const m = require('./voter_memory.js').ensure(user);
            if (!m.name && v.name_hi) { m.name = String(v.name_hi).replace(/^कृ\s+/, ''); m.nameSource = 'voter_slip'; }
            if (!m.ward && Number(v.ward)) m.ward = Number(v.ward);
            if (!m.village && Number(v.ward)) m.village = require('./voter_memory.js').WARD_VILLAGE[Number(v.ward)] || null;
            if (!m.gender && v.gender) m.gender = /महिला|^f/i.test(String(v.gender)) ? 'F' : (/पुरुष|^m/i.test(String(v.gender)) ? 'M' : null);
            m.slip = { name: v.name_hi || v.name, relation: v.rel_type === 'H' ? 'husband' : 'father', relName: v.rel_name_hi || null, ward: Number(v.ward) || null, booth: v.booth || null, at: new Date().toISOString() };
        } catch (e) {}
    }
    return { kind: 'deliver', voter: v };
}

/**
 * Decide the slip step for one incoming message.
 * @param {string} body
 * @param {object} user user_memory record (mutated: pending list/candidate, lastSlipQuery, lastFoundVoter)
 * @param {object} opts { slipIntent: the server's own "this is a slip ask" verdict, searchText, blocked: e.g. inside a samasya flow }
 * @returns null | { kind: 'deliver'|'confirm'|'choose'|'ask_name'|'not_found', text?, voter?, matches? }
 */
function decide(body, user, opts = {}) {
    const text = String(body || '').trim();
    if (!text) return null;
    const asked = isSlipAsk(text);
    const recall = isRecall(text);
    const q = nameQuery(opts.searchText || text);
    const slipPromptLast = /(पर्ची|parchi)/i.test(lastBot(user));
    // reply in the voter's script (a bare "1" follows their earlier messages)
    const scriptOf = x => (/[\u0900-\u097F]/.test(x) ? 'hi' : (/[a-z]/i.test(x) ? 'en' : null));
    const prevUser = (user && Array.isArray(user.history) ? user.history : []).filter(h => h.role === 'user').map(h => scriptOf(h.text || '')).filter(Boolean);
    const sp = user && user.memory && user.memory.scriptPref;
    const en = sp ? sp === 'hinglish' : (process.env.DEFAULT_SCRIPT === 'auto' ? (scriptOf(text) || prevUser[prevUser.length - 1] || (user && user.memory && user.memory.language === 'en' ? 'en' : 'hi')) === 'en' : (user && user.languagePreference === 'hinglish'));
    // the server's name-like guess never fires on abuse, the candidate's own name or a question
    if (opts.slipIntent && !asked && (IMPLICIT_NO.test(text) || /\?/.test(text) || CONCERN_NO.test(text) || text.split(/\s+/).length > 6)) opts = { ...opts, slipIntent: false };

    // 1. a numbered list is pending
    if (fresh(user, 'disambiguationMatches') && Array.isArray(user.disambiguationMatches) && user.disambiguationMatches.length) {
        const list = user.disambiguationMatches;
        const idx = choiceIndex(text, list.length);
        if (idx >= 0) return deliverTo(user, list[idx]);
        const byRel = list.find(v => fatherGiven(text, v));
        if (byRel) return deliverTo(user, byRel);
        if (recall || (asked && !q) || (slipPromptLast && isYes(text))) return { kind: 'choose', matches: list, text: (en ? 'Upar wali list me se apna number bhej dijiye 🙏\n\n' : 'ऊपर वाली सूची में से अपना नंबर भेज दीजिए 🙏\n\n') + listText(list, user.lastSlipQuery || (en ? 'is naam' : 'इस नाम'), en) };
        if (!(asked || opts.slipIntent) || !q) return null; // something else: the brain answers; the list stays open for a while
    }
    // 2. a single candidate waits for "हाँ"
    if (fresh(user, 'pendingParchiCandidate')) {
        const v = user.pendingParchiCandidate;
        if (fatherGiven(text, v)) return deliverTo(user, v);
        if (isYes(text) && (slipPromptLast || recall)) return deliverTo(user, v);
        if (isNo(text) && slipPromptLast) { setPending(user, null); delete user.slipPendingAt; return { kind: 'ask_name', text: en ? 'Koi baat nahi 🙏 Apna poora naam aur pita/pati ka naam likhiye, sahi parchi dhoondh deti hoon.' : 'कोई बात नहीं 🙏 अपना पूरा नाम और पिता/पति का नाम लिखिए, सही पर्ची ढूँढ देती हूँ।' }; }
        if (recall || (asked && !q)) return { kind: 'confirm', voter: v, text: confirmText(v, en) };
        if (!(asked || opts.slipIntent) || !q) return null;
    }
    if (opts.blocked && !asked && !slipPromptLast) return null;
    // 3. "maine abhi bataya" right after we asked for the name: use what they told
    const wantSlip = asked || opts.slipIntent || (recall && slipPromptLast) || (slipPromptLast && q && /(नाम|naam|name)/i.test(lastBot(user)) && !/\?/.test(text) && text.split(/\s+/).length <= 6);
    if (!wantSlip) return null;
    let query = q;
    if (!query || (recall && !asked && !q)) {
        if (user && user.lastFoundVoter && recall && !asked) {
            const v = user.lastFoundVoter;
            if (en) return { kind: 'recall', voter: v, text: `Ji, yaad hai 🙏 Aap *${v.name_hi}* (${v.rel_type === 'H' ? 'pati' : 'pita'}: ${v.rel_name_hi}, ward ${v.ward}) hain—aapki parchi upar isi chat me hai. Dobara chahiye to "parchi" likh dijiye, ya parivar ke kisi aur ka naam bhejiye.` };
            return { kind: 'recall', voter: v, text: `जी, याद है 🙏 आप *${v.name_hi}* (${v.rel_type === 'H' ? 'पति' : 'पिता'}: ${v.rel_name_hi}, वार्ड ${v.ward}) हैं—आपकी पर्ची ऊपर इसी चैट में है। दोबारा चाहिए तो "पर्ची" लिख दीजिए, या परिवार के किसी और का नाम भेजिए।` };
        }
        if (user && user.lastFoundVoter && asked) return { kind: 'deliver', voter: user.lastFoundVoter, again: true };
        query = rememberedName(user);
    }
    if (!query) { if (user) user.slipAskedAt = new Date().toISOString(); return { kind: 'ask_name', text: en ? ASK_NAME_EN : ASK_NAME }; }
    const matches = search(query, user, opts.searchText || text);
    if (user) { user.lastSlipQuery = query; user.lastSearchedQuery = query; }
    if (!matches.length) return (asked || recall || (opts.slipIntent && slipPromptLast)) ? { kind: 'not_found', text: en ? NOT_FOUND_EN(query) : NOT_FOUND(query) } : null;
    if (user) {
        try { const m = require('./voter_memory.js').ensure(user); if (!m.name && q && /[a-z\u0900-\u097F]{3,}/i.test(q)) { m.name = q.split(/\s+/)[0]; m.nameSource = 'slip_query'; } } catch (e) {}
    }
    if (matches.length > 1) {
        const withRel = matches.find(v => fatherGiven(opts.searchText || text, v));
        if (withRel) return deliverTo(user, withRel);
        setPending(user, 'choose', matches);
        return { kind: 'choose', matches, text: listText(matches, query, en) };
    }
    const v = matches[0];
    if (fatherGiven(opts.searchText || text, v)) return deliverTo(user, v);
    setPending(user, 'confirm', v);
    return { kind: 'confirm', voter: v, text: confirmText(v, en) };
}

const FAMILY_TAIL = '\n\n👨‍👩‍👧 परिवार के किसी और सदस्य की पर्ची चाहिए तो उनका नाम और पिता/पति का नाम भेज दीजिए 🙏';
module.exports = { decide, choiceIndex, nameQuery, isYes, isNo, isRecall, isSlipAsk, search, confirmText, listText, FAMILY_TAIL, ASK_NAME };
