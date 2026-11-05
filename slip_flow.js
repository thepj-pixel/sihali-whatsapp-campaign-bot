const { relLabel } = require('./relation_label');
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
    'ab phir fir jaldi jldi jaldii yaar yr ok okay theek thik hello hi hii ram raam namaste ' +
    'dhanyavad dhanyawad dhanyavaad dhanywad dhanyabad shukriya sukriya thanks thank thankyou thanku thnx thx tq ty welcome achha acha accha badhiya shabash sahi mast good nice ' +
    'mil mila milegi milega jayegi jaegi jayega jaega jaayegi jaye sakti sakta sakte hogi hoga kya kab kaise kyu').split(/\s+/));
const NON_NAME_HI = /^(हाँ|हां|अरे|अभी|मैंने|बताया|मेरा|मेरी|मुझे|नाम|है|हूँ|भी|भेज|भेजो|भेजिए|दो|दीजिए|चाहिए|पर्ची|वोटर|स्लिप|कार्ड|वाला|नंबर|सही|यही|भाई|ना|तो|की|का|के|को|अपनी|अपना|सिर्फ|लिस्ट|में|से|पर|निकालो|दिखाओ|जी|जल्दी|धन्यवाद|शुक्रिया|अच्छा|बढ़िया|ठीक|मिल|मिलेगी|मिलेगा|जाएगी|जायेगी|जाएगा|सकती|सकता|होगी|होगा|क्या|कब|कैसे)$/;

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
const CANDIDATE_WORD = /^(abhay|abhey|abhai|abay|baba|अभय|बाबा)$/i;
function fatherGiven(text, v) {
    if (QUESTION_RX.test(String(text || ''))) return false;
    // v5: "baba ke 100 vote kam h" matched a voter whose father is अभय सिंह and leaked a slip. The candidate's
    // name / "baba" never counts as a father's name, and a long sentence about votes is never a slip answer.
    if (/(abhay|abhey|abhai|baba|अभय|बाबा)/i.test(String(text || '')) && !/(pita|pitaji|father|papa|पिता|पापा|s\/o)/i.test(String(text || ''))) return false;
    if (/(vote|वोट)/i.test(String(text || '')) && !/(pita|pitaji|father|papa|पिता|पापा)/i.test(String(text || ''))) return false;
    const low = lowerOf(text);
    const parts = [v.rel_name_hi, v.rel_name, v.rel_name_en, v.r_en].filter(Boolean).map(lowerOf).filter(x => x.length >= 3);
    if (parts.some(p => low.includes(p))) return true;
    // first word of the father's name in Roman/Devanagari ("Bhawani" for "भवानी राम") via the engine's transliteration
    const toks = nameQuery(text).toLowerCase().split(/\s+/).filter(w => w.length >= 3 && !CANDIDATE_WORD.test(w) && !SURNAME_TOK.test(w) && !SURNAME_TOK.test(voterEngine.translit ? voterEngine.translit(w) : w));
    const rel = relText(v).split(/\s+/).filter(w => w.length >= 3);
    const sk = x => String(x || '').toLowerCase().replace(/[aeiouy]/g, '').replace(/w/g, 'v').replace(/(.)\1+/g, '$1');
    // Roman spelling variants of the father's first name (bhawani ~ Bhavani) by consonant skeleton
    return toks.some(tk => rel.includes(tk) || (voterEngine.translit && rel.includes(voterEngine.translit(tk)))
        || (/^[a-z]{4,}$/.test(tk) && sk(tk).length >= 3 && rel.some(r => /^[a-z]+$/.test(r) && r[0] === tk[0] && sk(r) === sk(tk))));
}

/** Search the roll: full-name matches first; a ward typed in the message filters; the profile ward only breaks ties. */
function search(q, user, text, strict = false) {
    const ward = wardIn(text);
    const query = q + (ward ? ` ward ${ward}` : '');
    let found = voterEngine.searchVoters(query, 40, ward || null);
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
    if (strict) {
        // v5 (NLU-driven search): the first name must really match (exact, Devanagari, or same consonant skeleton);
        // a surname typed (yadav/sharma/...) must be in the voter's own name. Otherwise "not found" + ask father/ward.
        const sk = x => String(x || '').toLowerCase().replace(/[aeiouy]/g, '').replace(/w/g, 'v').replace(/(.)\1+/g, '$1');
        const first = toks.find(w => !SURNAME_TOK.test(w)) || toks[0];
        const hard = toks.filter(w => /^(yadav|sharma|saini|meena|gurjar|यादव|शर्मा|सैनी|मीणा|गुर्जर)$/i.test(w));
        found = found.filter(v => {
            const words = `${lowerOf(v.name_hi)} ${lowerOf(v.name_en || v.ne || '')}`.split(/\s+/);
            const okFirst = !first || nameHas(v, first) || words.includes(first) || (/^[a-z]+$/.test(first) && sk(first).length >= 3 && words.some(w => /^[a-z]+$/.test(w) && w[0] === first[0] && sk(w) === sk(first)));
            const okHard = hard.every(h => words.includes(h) || words.includes(tr(h)));
            return okFirst && okHard;
        });
        if (!found.length) return [];
    }
    // Keep only people whose OWN name carries the typed first name (relatives' names matched too, which inflated counts).
    {
        const sk2 = x => String(x || '').toLowerCase().replace(/[aeiouy]/g, '').replace(/w/g, 'v').replace(/(.)\1+/g, '$1');
        const f0 = toks[0];
        const own = f0 ? found.filter(v => {
            if (nameHas(v, f0)) return true;
            const words = `${lowerOf(v.name_hi)} ${lowerOf(v.name_en || v.ne || '')}`.split(/\s+/);
            return /^[a-z]+$/.test(f0) && sk2(f0).length >= 3 && words.some(w => /^[a-z]+$/.test(w) && w[0] === f0[0] && sk2(w) === sk2(f0));
        }) : found;
        if (own.length) found = own;
    }
    const pref = !ward && user ? (Number(user.ward) || (user.memory && Number(user.memory.ward)) || null) : null;
    if (pref) found = found.slice().sort((a, b) => (Number(b.ward) === pref) - (Number(a.ward) === pref));
    return found.slice(0, 40);
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
    const rel = relLabel(v);
    if (en) return `Voter list me *${v.name_hi || v.name}* naam mila hai 📋\n\nKya aapke ${relLabel(v, true)} ka naam *${v.rel_name_hi || '—'}* (ward ${v.ward}) hai?\n\nSahi ho to bas *'haan'* likh dijiye—parchi turant bhej dungi 🙏\n*(Agar ye aap nahi hain, to apna poora naam aur pita/pati ka naam likhiye)*`;
    return `वोटर लिस्ट में *${v.name_hi || v.name}* नाम मिला है 📋\n\nक्या आपके ${rel} का नाम *${v.rel_name_hi || '—'}* (वार्ड ${v.ward}) है?\n\nसही हो तो बस *'हाँ'* लिख दीजिए—पर्ची तुरंत भेज दूँगी 🙏\n*(अगर ये आप नहीं हैं, तो अपना पूरा नाम और पिता/पति का नाम लिखिए)*`;
}
const SHOW = 5;
function listText(matches, q, en) {
    if (en) {
        let e = `Voter list me *${q}* se milte ${matches.length} naam mile hain${matches.length > SHOW ? ` (pehle ${SHOW}; ward bata denge to turant mil jayega)` : ''}:\n\n`;
        matches.slice(0, SHOW).forEach((m, i) => { e += `${i + 1}️⃣ *${m.name_hi}* (${relLabel(m, true)}: ${m.rel_name_hi}) — ward ${m.ward}\n`; });
        return e + `\nAap inme se kaun hain? Bas number (*1*, *2*…) ya apne pita/pati ka naam bhej dijiye—aapki parchi turant bhej dungi 🙏`;
    }
    let t = `वोटर लिस्ट में *${q}* से मिलते ${matches.length} नाम मिले हैं${matches.length > SHOW ? ` (पहले ${SHOW}; वार्ड बता दें तो तुरंत मिल जाएगा)` : ''}:\n\n`;
    matches.slice(0, SHOW).forEach((m, i) => { t += `${i + 1}️⃣ *${m.name_hi}* (${relLabel(m)}: ${m.rel_name_hi}) — वार्ड ${m.ward}\n`; });
    return t + `\nआप इनमें से कौन हैं? बस नंबर (*1*, *2*…) या अपने पिता/पति का नाम भेज दीजिए—आपकी पर्ची तुरंत भेज दूँगी 🙏`;
}
function confirmOther(v, en) {
    const rel = relLabel(v, en);
    if (en) return `Voter list me *${v.name_hi || v.name}* naam mila hai 📋\n\nKya unke ${rel} ka naam *${v.rel_name_hi || '—'}* (ward ${v.ward}) hai? Sahi ho to *'haan'* likh dijiye—unki parchi bhej dungi 🙏`;
    return `वोटर लिस्ट में *${v.name_hi || v.name}* नाम मिला है 📋\n\nक्या उनके ${rel} का नाम *${v.rel_name_hi || '—'}* (वार्ड ${v.ward}) है? सही हो तो *'हाँ'* लिख दीजिए—उनकी पर्ची भेज दूँगी 🙏`;
}
function listOther(matches, q, en) {
    const rel = m => relLabel(m, en);
    const more = matches.length > SHOW;
    let t = en ? `Voter list me *${q}* naam ke ${matches.length} log mile hain${more ? ` (pehle ${SHOW}; ward bata denge to turant mil jayega)` : ''}:\n\n` : `वोटर लिस्ट में *${q}* नाम के ${matches.length} लोग मिले हैं${more ? ` (पहले ${SHOW}; वार्ड बता दें तो तुरंत मिल जाएगा)` : ''}:\n\n`;
    matches.slice(0, SHOW).forEach((m, i) => { t += `${i + 1}️⃣ *${m.name_hi}* (${rel(m)}: ${m.rel_name_hi}) — ${en ? 'ward' : 'वार्ड'} ${m.ward}\n`; });
    return t + (en ? `\nInme se ${q} ji kaun se hain? Number (*1*, *2*…) ya unke pita/pati ka naam bhej dijiye 🙏` : `\nइनमें से ${q} जी कौन से हैं? नंबर (*1*, *2*…) या उनके पिता/पति का नाम भेज दीजिए 🙏`);
}
const NOT_FOUND_OTHER = (q, en) => en ? `*${q}* naam se voter list me pakka naam nahi mila 🙏 Unke pita/pati ka naam ya ward bata dijiye, ya naam waise likhiye jaise voter card par hai—phir se dekh leti hoon.` : `*${q}* नाम से वोटर लिस्ट में पक्का नाम नहीं मिला 🙏 उनके पिता/पति का नाम या वार्ड बता दीजिए, या नाम वैसे लिखिए जैसे वोटर कार्ड पर है—फिर से देख लेती हूँ।`;
const ASK_OTHER = en => en ? 'Kiski parchi chahiye? Unka poora naam aur pita/pati ka naam bata dijiye 🙏' : 'किसकी पर्ची चाहिए? उनका पूरा नाम और पिता/पति का नाम बता दीजिए 🙏';
const ASK_NAME = 'पर्ची अभी निकाल देती हूँ 🙏 अपना पूरा नाम और पिता/पति का नाम लिख भेजिए (वार्ड पता हो तो वो भी)।';
const ASK_NAME_EN = 'Parchi abhi nikaal deti hoon 🙏 Apna poora naam aur pita/pati ka naam likh bhejiye (ward pata ho to wo bhi).';
const NOT_FOUND_EN = q => `*${q}* naam se list me pakka naam nahi mila 🙏 Apna poora naam waise likhiye jaise voter card par hai, saath me pita/pati ka naam ya ward bhi likh dijiye—phir se dekh leti hoon.`;
const NOT_FOUND = q => `*${q}* नाम से सूची में पक्का नाम नहीं मिला 🙏 अपना पूरा नाम वैसे लिखिए जैसे वोटर कार्ड पर है, साथ में पिता/पति का नाम या वार्ड भी लिख दीजिए—फिर से देख लेती हूँ।`;

function setPending(user, kind, payload, who) {
    if (!user) return;
    delete user.pendingParchiCandidate; delete user.disambiguationMatches; delete user.slipAwaitWard;
    if (kind === 'confirm') user.pendingParchiCandidate = payload;
    if (kind === 'choose') user.disambiguationMatches = payload;
    user.slipPendingAt = new Date().toISOString();
    user.slipPendingWho = who || 'self';
}
function deliverTo(user, v, other = false) {
    if (user) { delete user.slipAwaitWard; delete user.slipAwaitWardPrev; delete user.slipWardAsks; }
    if (user && other) {
        delete user.pendingParchiCandidate; delete user.disambiguationMatches; delete user.slipPendingAt;
        try {
            const m = require('./voter_memory.js').ensure(user);
            m.familySlips = (Array.isArray(m.familySlips) ? m.familySlips : []).concat([{ name: v.name_hi || v.name, relName: v.rel_name_hi || null, ward: Number(v.ward) || null, at: new Date().toISOString() }]).slice(-10);
        } catch (e) {}
        if (user.slipTarget) user.slipTarget.done = true;
        return { kind: 'deliver', voter: v, other: true };
    }
    if (user) {
        delete user.pendingParchiCandidate; delete user.disambiguationMatches; delete user.slipPendingAt;
        user.lastFoundVoter = v;
        if (user.slipTarget) user.slipTarget.done = true;
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
// ---- ward first (Prince, 5 Nov): several people with this name -> ask the ward before listing; then confirm father/husband ----
const WARD_MAX = 11;
const DONT_KNOW_WARD = /(पता\s*नहीं|नहीं\s*पता|मालूम\s*नहीं|pata\s*nahi|nahi\s*pata|pta\s*nhi|nhi\s*pta|maloom\s*nahi|malum\s*nahi|don'?t\s*know|^(?:सूची|लिस्ट|list)(?:\s+(?:भेजो|bhejo|do|दो|dikhao|दिखाओ))?$|(?<!(?:voter|वोटर)\s*)\b(?:list|सूची|लिस्ट)\s+(?:भेजो|bhejo|dikhao|दिखाओ|de do|दे दो)|naam\s*bhejo|नाम\s*भेजो)/i;
function wardAnswer(text) {
    const w = wardIn(text); if (w) return w;
    const m = String(text || '').trim().match(/^(?:मेरा|mera|हमारा|hamara)?\s*(?:वार्ड|ward)?\s*(?:नं\.?|no\.?|number|नंबर)?\s*(\d{1,2})\s*(?:है|hai|h|में|me|mein|वार्ड|ward)?\s*[।.!🙏]*$/i);
    return m && Number(m[1]) >= 1 && Number(m[1]) <= WARD_MAX ? Number(m[1]) : null;
}
function askWardText(matches, shown, other, en) {
    const n = matches.length;
    if (matches[0] && matches[0].name_hi && /[a-z]/i.test(shown || '') && matches.every(m => m.name_hi === matches[0].name_hi)) shown = matches[0].name_hi;
    else if (/^[a-z\s]+$/i.test(shown || '') && voterEngine.translit) shown = String(shown).split(/\s+/).map(w => voterEngine.translit(w)).join(' ');
    const wards = Array.from(new Set(matches.map(m => Number(m.ward)))).sort((a, b) => a - b).join(', ');
    if (askWardText.user && askWardText.user.slipWardAsks > 1) {
        const i = askWardText.user.slipWardAsks;
        const altHi = [`जी, *${shown}* की ही पर्ची ढूँढ रही हूँ 🙏 ये नाम वार्ड ${wards} में है—${other ? 'वो' : 'आप'} कौन से वार्ड ${other ? 'में रहते हैं' : 'से हैं'}? बस नंबर लिख दीजिए।`,
                       `${n} *${shown}* हैं, इसलिए गलत पर्ची न जाए 🙏 ${other ? 'उनके' : 'अपने'} पिता/पति का नाम या वार्ड नंबर बता दीजिए।`,
                       `समझ गई जी 🙏 *${shown}* का वार्ड नंबर नहीं पता तो "सूची" लिख दीजिए—मैं सारे नाम भेज दूँगी, उनमें से चुन लीजिए।`];
        const altEn = [`Ji, *${shown}* ki hi parchi dhoondh rahi hoon 🙏 Ye naam ward ${wards} me hai—${other ? 'wo' : 'aap'} kaun se ward ${other ? 'me rehte hain' : 'se hain'}? Bas number likh dijiye.`,
                       `${n} *${shown}* hain, isliye galat parchi na jaye 🙏 ${other ? 'Unke' : 'Apne'} pita/pati ka naam ya ward number bata dijiye.`,
                       `Samajh gayi ji 🙏 *${shown}* ka ward number nahi pata to "list" likh dijiye—saare naam bhej dungi, unme se chun lijiye.`];
        altHi.push(`माफ़ कीजिए, बार-बार पूछ रही हूँ 🙏 पर *${shown}* नाम के ${n} लोग हैं। ${other ? 'उनके' : 'आपके'} पिता/पति का नाम क्या है?`, `ठीक है जी 🙏 *${shown}* ${other ? 'के' : 'आपके'} घर के किसी बड़े (पिता/पति) का नाम या वार्ड नंबर लिख दीजिए, फिर पक्की पर्ची तुरंत भेजती हूँ।`);
        altEn.push(`Maaf kijiye, baar-baar pooch rahi hoon 🙏 par *${shown}* naam ke ${n} log hain. ${other ? 'Unke' : 'Aapke'} pita/pati ka naam kya hai?`, `Theek hai ji 🙏 *${shown}* ke ghar ke kisi bade (pita/pati) ka naam ya ward number likh dijiye, phir pakki parchi turant bhejti hoon.`);
        return (en ? altEn : altHi)[(i - 2) % altHi.length];
    }
    if (en) return other ? `*${shown}* naam ke ${n} voter list me hain 🙏 Sahi parchi ke liye bataiye—wo kis *ward* me rehte hain? (Ward na pata ho to unke pita/pati ka naam likh dijiye)`
        : `*${shown}* naam ke ${n} voter list me hain 🙏 Sahi parchi ke liye bataiye—aap kis *ward* se hain? (Ward na pata ho to apne pita/pati ka naam likh dijiye)`;
    return other ? `*${shown}* नाम के ${n} वोटर सूची में हैं 🙏 सही पर्ची के लिए बताइए—वो किस *वार्ड* में रहते हैं? (वार्ड न पता हो तो उनके पिता/पति का नाम लिख दीजिए)`
        : `*${shown}* नाम के ${n} वोटर सूची में हैं 🙏 सही पर्ची के लिए बताइए—आप किस *वार्ड* से हैं? (वार्ड न पता हो तो अपने पिता/पति का नाम लिख दीजिए)`;
}
function needWard(matches, text) {
    if (!Array.isArray(matches) || matches.length < 2 || wardIn(text)) return false;
    return new Set(matches.map(v => Number(v.ward))).size > 1;
}
// ---- family card offer (same ward + same house no.) ----
function familyOf(v) {
    const h = String(v.house_no || v.h || '').trim();
    if (!h || /^(0+|-|--|na)$/i.test(h)) return [];
    const all = voterEngine.getAllVoters ? voterEngine.getAllVoters() : [];
    const fam = all.filter(x => Number(x.ward) === Number(v.ward) && String(x.house_no || x.h || '').trim() === h && Number(x.sr_no) !== Number(v.sr_no));
    return fam.length >= 1 && fam.length <= 9 ? fam : []; // a very common house no. (e.g. "1") is not one family
}
const FAMILY_RX = /^(?:हाँ|हां|haan|han|ha|ji|जी|ok|okay)?\s*,?\s*(?:परिवार|पूरे परिवार|सब|सबकी|सभी|parivar|pariwar|family|sabki|sab ki|sabhi|ghar wal\w*|घर वाल\w*)(?:\s+(?:की|ki|का|ka|के|ke|वालों|walo\w*))?(?:\s+(?:पर्ची|parchi|card|कार्ड))?(?:\s+(?:भेज\w*|bhej\w*|chahiye|चाहिए|do|दो|de do|दे दो|dijiye|दीजिए))*\s*[।.!🙏]*$/i;
function familyTail(user, v, en) {
    const fam = familyOf(v);
    if (!fam.length) return FAMILY_TAIL;
    if (user) { user.familyOffer = { ward: Number(v.ward), sr: Number(v.sr_no), at: new Date().toISOString() }; }
    return en ? `\n\n🏠 Aapke ghar (makan no. ${v.house_no}, ward ${v.ward}) se ${fam.length} aur voter list me hain. Sabki parchi ek card me chahiye to *parivar* likhiye 🙏`
        : `\n\n🏠 आपके घर (मकान नं. ${v.house_no}, वार्ड ${v.ward}) से ${fam.length} और वोटर सूची में हैं। सबकी पर्ची एक कार्ड में चाहिए तो *परिवार* लिखिए 🙏`;
}
/** Runs BEFORE the NLU: answers to our own slip questions (ward asked, family offered) never go elsewhere. */
function preempt(text, user) {
    if (!user || !text) return null;
    const t = String(text).trim();
    if (user.familyOffer && Date.now() - Date.parse(user.familyOffer.at) < 6 * 3600 * 1000 && FAMILY_RX.test(t)) {
        const all = voterEngine.getAllVoters ? voterEngine.getAllVoters() : [];
        const head = all.find(x => Number(x.ward) === user.familyOffer.ward && Number(x.sr_no) === user.familyOffer.sr);
        if (head) { delete user.familyOffer; return { kind: 'family', voter: head, members: [head].concat(familyOf(head)) }; }
    }
    if (user.slipAwaitWard && fresh(user, 'disambiguationMatches') && t.split(/\s+/).length <= 8) {
        const list = user.disambiguationMatches || [];
        if (wardAnswer(t) || DONT_KNOW_WARD.test(t) || list.some(v => fatherGiven(t, v))) return decide(t, user, { slipIntent: true, fromPreempt: true });
    }
    return null;
}

function decide(body, user, opts = {}) {
    const text = String(body || '').trim();
    if (!text) return null;
    // v5: the NLU said this message is about something else (votes, contact, voter-card, complaint...): no slip step
    if (opts.noSlip) return null;
    const fatherText = `${text} ${opts.father ? 'pita ' + opts.father : ''}`.trim();
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
    const pendingOther = user && user.slipPendingWho === 'other';
    if (opts.slipIntent && !opts.nlu && !asked && (IMPLICIT_NO.test(text) || /\?/.test(text) || CONCERN_NO.test(text) || text.split(/\s+/).length > 6)) opts = { ...opts, slipIntent: false };

    // 1. a numbered list is pending
    if (fresh(user, 'disambiguationMatches') && Array.isArray(user.disambiguationMatches) && user.disambiguationMatches.length) {
        const list = user.disambiguationMatches;
        if (user.slipAwaitWard) {
            const who = pendingOther ? 'other' : 'self';
            let nm = (list[0] && list.every(m => m.name_hi === list[0].name_hi) && list[0].name_hi) || (pendingOther && user.slipTarget && user.slipTarget.nameHi) || user.lastSlipQuery || '';
            if (/^[a-z\s]+$/i.test(nm) && voterEngine.translit) nm = nm.split(/\s+/).map(w => voterEngine.translit(w)).join(' ');
            const byRel0 = list.filter(v => fatherGiven(fatherText, v));
            const w = wardAnswer(text);
            const pool = w ? byRel0.filter(v => Number(v.ward) === w) : byRel0;
            if (pool.length === 1) { delete user.slipAwaitWard; return deliverTo(user, pool[0], pendingOther); }
            if (w) {
                delete user.slipAwaitWard;
                const inW = list.filter(v => Number(v.ward) === w);
                if (inW.length === 1) { setPending(user, 'confirm', inW[0], who); return { kind: 'confirm', voter: inW[0], text: pendingOther ? confirmOther(inW[0], en) : confirmText(inW[0], en) }; }
                if (inW.length > 1) { setPending(user, 'choose', inW, who); return { kind: 'choose', matches: inW, text: pendingOther ? listOther(inW, nm, en) : listText(inW, nm, en) }; }
                setPending(user, 'choose', list, who);
                return { kind: 'choose', matches: list, text: (en ? `Ward ${w} me *${nm}* naam se koi nahi mila 🙏 Ye log mile hain—\n\n` : `वार्ड ${w} में *${nm}* नाम से कोई नहीं मिला 🙏 ये लोग मिले हैं—\n\n`) + (pendingOther ? listOther(list, nm, en) : listText(list, nm, en)) };
            }
            if (DONT_KNOW_WARD.test(text)) { setPending(user, 'choose', list, who); return { kind: 'choose', matches: list, text: (en ? 'Koi baat nahi 🙏 ' : 'कोई बात नहीं 🙏 ') + (pendingOther ? listOther(list, nm, en) : listText(list, nm, en)) }; }
            if (byRel0.length > 1) { delete user.slipAwaitWard; setPending(user, 'choose', byRel0, who); return { kind: 'choose', matches: byRel0, text: pendingOther ? listOther(byRel0, nm, en) : listText(byRel0, nm, en) }; }
        }
        const idx = user.slipAwaitWard ? -1 : choiceIndex(text, list.length);
        if (idx >= 0) return deliverTo(user, list[idx], pendingOther);
        const byRel = list.find(v => fatherGiven(fatherText, v));
        if (byRel) return deliverTo(user, byRel, pendingOther);
        if (recall || (asked && !q) || (slipPromptLast && isYes(text))) return pendingOther
            ? { kind: 'choose', matches: list, text: listOther(list, (user.slipTarget && user.slipTarget.nameHi) || user.lastSlipQuery || '', en) }
            : { kind: 'choose', matches: list, text: (en ? 'Upar wali list me se apna number bhej dijiye 🙏\n\n' : 'ऊपर वाली सूची में से अपना नंबर भेज दीजिए 🙏\n\n') + listText(list, user.lastSlipQuery || (en ? 'is naam' : 'इस नाम'), en) };
        if (!(asked || opts.slipIntent) || !q) return null; // something else: the brain answers; the list stays open for a while
    }
    // 2. a single candidate waits for "हाँ"
    if (fresh(user, 'pendingParchiCandidate')) {
        const v = user.pendingParchiCandidate;
        if (fatherGiven(fatherText, v)) return deliverTo(user, v, pendingOther);
        if (isYes(text) && (slipPromptLast || recall)) return deliverTo(user, v, pendingOther);
        if (isNo(text) && slipPromptLast) { setPending(user, null); delete user.slipPendingAt; return { kind: 'ask_name', text: en ? 'Koi baat nahi 🙏 Apna poora naam aur pita/pati ka naam likhiye, sahi parchi dhoondh deti hoon.' : 'कोई बात नहीं 🙏 अपना पूरा नाम और पिता/पति का नाम लिखिए, सही पर्ची ढूँढ देती हूँ।' }; }
        if (recall || (asked && !q)) return { kind: 'confirm', voter: v, text: pendingOther ? confirmOther(v, en) : confirmText(v, en) };
        if (!(asked || opts.slipIntent) || !q) return null;
    }
    if (opts.blocked && !asked && !slipPromptLast) return null;
    // 3. "maine abhi bataya" right after we asked for the name: use what they told
    const wantSlip = asked || opts.slipIntent || (recall && slipPromptLast) || (slipPromptLast && q && /(नाम|naam|name)/i.test(lastBot(user)) && !/\?/.test(text) && text.split(/\s+/).length <= 6);
    if (!wantSlip) return null;
    const other = opts.target === 'other';
    let query = q;
    if (other) {
        if (!query && user && user.slipTarget && user.slipTarget.who === 'other' && !user.slipTarget.done) query = nameQuery(user.slipTarget.nameHi || user.slipTarget.name || '');
        if (!query) { if (user) user.slipAskedAt = new Date().toISOString(); return { kind: 'ask_name', text: ASK_OTHER(en) }; }
    } else if (!query || (recall && !asked && !q)) {
        if (user && user.lastFoundVoter && recall && !asked) {
            const v = user.lastFoundVoter;
            if (en) return { kind: 'recall', voter: v, text: `Ji, yaad hai 🙏 Aap *${v.name_hi}* (${v.rel_type === 'H' ? 'pati' : 'pita'}: ${v.rel_name_hi}, ward ${v.ward}) hain—aapki parchi upar isi chat me hai. Dobara chahiye to "parchi" likh dijiye, ya parivar ke kisi aur ka naam bhejiye.` };
            return { kind: 'recall', voter: v, text: `जी, याद है 🙏 आप *${v.name_hi}* (${relLabel(v)}: ${v.rel_name_hi}, वार्ड ${v.ward}) हैं—आपकी पर्ची ऊपर इसी चैट में है। दोबारा चाहिए तो "पर्ची" लिख दीजिए, या परिवार के किसी और का नाम भेजिए।` };
        }
        if (user && user.lastFoundVoter && asked) return { kind: 'deliver', voter: user.lastFoundVoter, again: true };
        query = rememberedName(user);
    }
    if (!query) { if (user) user.slipAskedAt = new Date().toISOString(); return { kind: 'ask_name', text: en ? ASK_NAME_EN : ASK_NAME }; }
    const matches = search(query, user, opts.searchText || text, !!opts.nlu);
    if (user) { user.lastSlipQuery = query; user.lastSearchedQuery = query; }
    const shown = (opts.displayName || query);
    if (!matches.length) {
        if (other) {
            const again = lastBot(user).includes(`*${shown}*`) && /(नहीं मिला|nahi mila)/.test(lastBot(user));
            if (again) return { kind: 'not_found', text: en ? `*${shown}* naam abhi bhi list me nahi dikh raha 🙏 Ho sakta hai voter card par naam thoda alag likha ho. Unke pita/pati ka naam bata dijiye, usse dhoondh lungi.` : `*${shown}* नाम अभी भी सूची में नहीं दिख रहा 🙏 हो सकता है वोटर कार्ड पर नाम थोड़ा अलग लिखा हो। उनके पिता/पति का नाम बता दीजिए, उससे ढूँढ लूँगी।` };
            return { kind: 'not_found', text: NOT_FOUND_OTHER(shown, en) };
        }
        return (asked || recall || opts.nlu || (opts.slipIntent && slipPromptLast)) ? { kind: 'not_found', text: en ? NOT_FOUND_EN(shown) : NOT_FOUND(shown) } : null;
    }
    if (other) {
        const withRel = matches.find(v => fatherGiven(fatherText, v));
        if (withRel) return deliverTo(user, withRel, true);
        if (matches.length > 1 && needWard(matches, opts.searchText || text)) {
            const asks = (user && user.slipAwaitWardPrev ? user.slipWardAsks || 0 : 0) + 1;
            setPending(user, 'choose', matches, 'other'); if (user) { user.slipAwaitWard = true; user.slipAwaitWardPrev = true; user.slipWardAsks = asks; }
            askWardText.user = user; const t0 = askWardText(matches, shown, true, en); askWardText.user = null;
            return { kind: 'choose', matches, text: t0 };
        }
        if (matches.length > 1) {
            const prevList = user && fresh(user, 'disambiguationMatches') && pendingOther && Array.isArray(user.disambiguationMatches) ? user.disambiguationMatches : null;
            const same = prevList && prevList.length === matches.length && prevList.every((v, i) => (v.id || v.epic) === (matches[i].id || matches[i].epic));
            setPending(user, 'choose', matches, 'other');
            if (same) {
                // the same list is already on screen: don't paste it again, ask for the pick in one line
                user.slipListRepeat = (user.slipListRepeat || 0) + 1;
                const lines = en
                    ? [`Ji, ${shown} ji ki hi parchi dhoondh rahi hoon 🙏 List me is naam ke ${matches.length} log hain—upar wali list me se unka number bhej dijiye, ya unke pita/pati ka naam ya ward bata dijiye.`,
                       `${shown} naam ke ${matches.length} log hain, isliye pakka karna zaroori hai 🙏 Unke pita/pati ka naam ya ward bata dijiye, turant parchi bhej dungi.`,
                       `Samajh rahi hoon, aapko ${shown} ji ki parchi chahiye 🙏 Bas ye bata dijiye ki unke pita kaun hain—${matches.map(m => m.rel_name_hi).filter(Boolean).join(', ')}? Usi se pakki parchi niklegi.`,
                       `Koi baat nahi ji 🙏 ${shown} ji kis ward ya mohalle me rehte hain? Itna bata dein to sahi parchi chhaant dungi.`]
                    : [`जी, ${shown} जी की ही पर्ची ढूँढ रही हूँ 🙏 सूची में इस नाम के ${matches.length} लोग हैं—ऊपर वाली सूची में से उनका नंबर भेज दीजिए, या उनके पिता/पति का नाम या वार्ड बता दीजिए।`,
                       `${shown} नाम के ${matches.length} लोग हैं, इसलिए पक्का करना ज़रूरी है 🙏 उनके पिता/पति का नाम या वार्ड बता दीजिए, तुरंत पर्ची भेज दूँगी।`,
                       `समझ रही हूँ, आपको ${shown} जी की पर्ची चाहिए 🙏 बस ये बता दीजिए कि उनके पिता कौन हैं—${matches.map(m => m.rel_name_hi).filter(Boolean).join(', ')}? उसी से पक्की पर्ची निकलेगी।`,
                       `कोई बात नहीं जी 🙏 ${shown} जी किस वार्ड या मोहल्ले में रहते हैं? इतना बता दें तो सही पर्ची छाँट दूँगी।`];
                return { kind: 'choose', matches, text: lines[(user.slipListRepeat - 1) % lines.length] };
            }
            user.slipListRepeat = 0;
            return { kind: 'choose', matches, text: listOther(matches, shown, en) };
        }
        setPending(user, 'confirm', matches[0], 'other');
        return { kind: 'confirm', voter: matches[0], text: confirmOther(matches[0], en) };
    }
    if (user) {
        try { const m = require('./voter_memory.js').ensure(user); if (!m.name && q && /[a-z\u0900-\u097F]{3,}/i.test(q)) { m.name = q.split(/\s+/)[0]; m.nameSource = 'slip_query'; } } catch (e) {}
    }
    if (matches.length > 1) {
        const withRel = matches.find(v => fatherGiven(fatherText, v));
        if (withRel) return deliverTo(user, withRel);
        setPending(user, 'choose', matches, 'self');
        if (needWard(matches, opts.searchText || text)) {
            user.slipWardAsks = (user.slipAwaitWardPrev ? user.slipWardAsks || 0 : 0) + 1; user.slipAwaitWard = true; user.slipAwaitWardPrev = true;
            askWardText.user = user; const t1 = askWardText(matches, shown, false, en); askWardText.user = null;
            return { kind: 'choose', matches, text: t1 };
        }
        return { kind: 'choose', matches, text: listText(matches, query, en) };
    }
    const v = matches[0];
    if (fatherGiven(fatherText, v)) return deliverTo(user, v);
    setPending(user, 'confirm', v, 'self');
    return { kind: 'confirm', voter: v, text: confirmText(v, en) };
}

const FAMILY_TAIL = '\n\n👨‍👩‍👧 परिवार के किसी और सदस्य की पर्ची चाहिए तो उनका नाम और पिता/पति का नाम भेज दीजिए 🙏';
module.exports = { preempt, familyTail, familyOf, wardAnswer, setPending, deliverTo, fatherGiven, decide, confirmOther, listOther, ASK_OTHER, NOT_FOUND_OTHER, choiceIndex, nameQuery, isYes, isNo, isRecall, isSlipAsk, search, confirmText, listText, FAMILY_TAIL, ASK_NAME };
