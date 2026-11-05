/**
 * NLU v5 (5 Nov 2026, production day) — understand the message BEFORE routing.
 *
 * understand(text, user, opts) -> {
 *   intent, target_person: 'self'|'other'|null, person_name_hi, person_name_roman, father_name, ward,
 *   sentiment, refers_to, wants_slip, wants_contact, complaint:{category,ward,since}|null, script, short_summary,
 *   confidence, source: 'llm'|'rules'
 * }
 *
 * 1. NVIDIA LLM (nemotron, the same keys as the reply brain) with the last ~12 turns, the voter memory summary and
 *    the pending slip state; strict JSON, ~4s budget, robust parse, whitelisted values.
 * 2. Rule-based parser (always computed): Hinglish filler stripping, transliteration of common names
 *    (parveen/pareven/praveen -> प्रवीण, babal -> बबल/बबलू, krishan -> कृष्ण), slip-for-self vs other person,
 *    contact ask, voter-card-not-received, political talk ("baba ke 100 vote kam h"), recall ("koin hu m").
 * The rules also act as guard-rails on the LLM verdict (e.g. a message naming the candidate is never a slip answer).
 */
const voterEngine = require('./voter_engine.js');

const INTENTS = ['slip_request', 'slip_answer', 'voter_card_issue', 'contact_request', 'political_talk', 'support', 'opposition',
    'complaint', 'question', 'greeting', 'chitchat', 'abuse', 'recall_self', 'thanks', 'other', 'unclear'];
const lowerOf = s => String(s || '').toLowerCase().trim();

// Hinglish filler: never part of a person's name
const FILLER = new Set(('acha accha achha are arey arre aree bhai bhaiya yaar yr ji jee haan han ha hn nahi nhi nahin na naa no ' +
    'kie kiee ki ka ke ko kii kaa bhi bi parchi parchee parchii slip voter list id card epic naam nam name h hai he hain hu hoon hun ' +
    'uska uski uske unka unki unke iska iski mera meri mere mujhe hamara hamari humara apna apni apne de do dedo doo dena dijiye ' +
    'dijie bhejo bhej bhejdo bhejna bhejiye chahiye chaiye chahie chaahiye chiye thi tha the wala wali wale vala bata bataya batao ' +
    'btaya bola likha diya abhi to toh tha me mein mai main m se par pe aur or ye yeh wo woh vo bas sirf plz please sir nikalo ' +
    'nikal nikaal dikhao dekho check karo kardo kar koi kon koin kaun konsa ward wahi yahi phir fir ek aap tum tumhara tumhare ' +
    'number nambar no ab jaldi la lao mil mila milegi milega gaya gayi aaya aayi tak abhi ok okay sahi theek thik ' +
    'dhanyavad dhanyawad dhanyavaad dhanywad dhanyabad shukriya sukriya thanks thank thankyou thanku thnx thx tq ty badhiya shabash mast good nice ' +
    'jayegi jaegi jayega jaega jaayegi jaayega jaye jaaye jayengi sakti sakta sakte skti skta hogi hoga ho kab kaise kya kyaa kyu').split(/\s+/));
const FILLER_HI = new Set(('अरे भाई जी हाँ हां नहीं ना की का के को भी पर्ची वोटर लिस्ट आईडी कार्ड नाम है हैं हूँ उसका उसकी उसके उनका उनकी ' +
    'उनके मेरा मेरी मेरे मुझे दे दो दीजिए भेजो भेज चाहिए थी था वाला वाली बताया बताओ अभी तो में मैं से पर और ये वो बस सिर्फ़ सिर्फ ' +
    'निकालो दिखाओ कौन वार्ड यही वही एक आप तुम नंबर तक आया मिला धन्यवाद शुक्रिया बढ़िया ठीक मिल मिलेगी मिलेगा जाएगी जायेगी जाएगा सकती सकता होगी होगा क्या कब कैसे').split(/\s+/));

// Roman -> Devanagari for names the roll actually has (spelling variants included). First entry = best guess.
const NAME_TRANSLIT = {
    parveen: ['प्रवीण', 'परवीन'], pareven: ['प्रवीण', 'परवीन'], parvin: ['प्रवीण', 'परवीन'], pravin: ['प्रवीण'], praveen: ['प्रवीण'],
    prveen: ['प्रवीण'], parven: ['प्रवीण', 'परवीन'], parween: ['प्रवीण', 'परवीन'],
    babal: ['बबल', 'बबलू'], bablu: ['बबलू'], babloo: ['बबलू'], babbal: ['बबल'],
    krishan: ['कृष्ण'], krishna: ['कृष्ण'], krisan: ['कृष्ण'], kishan: ['किशन'], krshn: ['कृष्ण'],
    kumar: ['कुमार'], singh: ['सिंह'], yadav: ['यादव'], devi: ['देवी'], lal: ['लाल'], ram: ['राम'], sharma: ['शर्मा'],
    prince: ['प्रिंस'], manoj: ['मनोज'], rajesh: ['राजेश'], suresh: ['सुरेश'], ramesh: ['रमेश'], mukesh: ['मुकेश'], sunil: ['सुनील'],
    anil: ['अनिल'], sandeep: ['संदीप'], pradeep: ['प्रदीप'], deepak: ['दीपक'], vikas: ['विकास'], amit: ['अमित'], sumit: ['सुमित'],
    rohit: ['रोहित'], mohit: ['मोहित'], sonu: ['सोनू'], monu: ['मोनू'], babita: ['बबीता'], babli: ['बबली'], pooja: ['पूजा'], sunita: ['सुनीता'],
    ashok: ['अशोक'], vinod: ['विनोद'], mahesh: ['महेश'], naresh: ['नरेश'], dinesh: ['दिनेश'], satish: ['सतीश'], kailash: ['कैलाश']
};
const CANDIDATE_RX = /(abhay|abhey|abhai|abay|baba\b|bab[ao]\s*ji|अभय|बाबा)/i;
const CONTACT_RX = /((contact|kontact|cantact|संपर्क|कॉन्टैक्ट)\s*(details?|detail|no\.?|number|नंबर|card|कार्ड)?|(tumhara|tumhar|tumhare|aapka|apka|aapke|apke|team ka|office ka|तुम्हारा|आपका|आपके)\s*(mobile|phone|fone|number|nambar|no\.?|नंबर|मोबाइल)|(number|nambar|नंबर)\s*(do|de|dedo|bhejo|dena|dijiye|chahiye|दो|दीजिए|भेजो|चाहिए))/i;
const CARD_ISSUE_RX = /((voter|वोटर)\s*(id|card|kard|आईडी|कार्ड)|pehchan patra|पहचान पत्र|epic).{0,30}(nahi|nhi|nahin|नहीं|na)\s*(aaya|aya|aayi|mila|mili|bana|bani|पहुँचा|पहुंचा|आया|मिला|बना)|(kho gaya|kho gya|gum|lost|खो गया|गुम)/i;
const RECALL_SELF_RX = /(ko+i+n|kaun|kon|कौन)\s*(hu|hoon|hun|हूँ|हूं)\s*(m|main|mai|मैं)?|(main|mai|मैं)\s*(ko+i+n|kaun|kon|कौन)\s*(hu|hoon|हूँ)|(mera|मेरा)\s*(naam|नाम)\s*(yaad|याद|pata|पता|kya|क्या)/i;
const SLIP_RX = /(parchi|parchee|parchii|pqrchi|slip|voter\s*(list|id|card|slip)|वोटर\s*(लिस्ट|आईडी|कार्ड|पर्ची)|पर्ची|epic|list\s*(me|mein)\s*naam|naam\s*(dekh|check))/i;
const OTHER_PERSON_RX = /((uski|uska|uske|unki|unka|unke|iski|iska|उसकी|उसका|उनकी|उनका)\b)|(\b[a-z\u0900-\u097F]{3,}\s+(kie|ki|ka|ke|की|का|के)\s+(bhi\s+)?(parchi|voter|पर्ची|वोटर|naam|नाम|id))|(\b(bhai|bhaiya|papa|pitaji|mummy|maa|mata|chacha|tau|beta|beti|bahu|wife|patni|pati|dost|friend|बेटे|बेटी|भाई|पिताजी|माँ|पत्नी|दोस्त)\b.{0,12}(ki|ka|ke|की|का|के)\s+(bhi\s+)?(parchi|पर्ची|voter|वोटर))/i;
const POLITICAL_RX = /(\d+\s*(vote|vot|वोट)|vote\s*(kam|jyada|zyada|kat|denge|nahi|milenge|pakke)|(vote|वोट).{0,15}(kam|कम|ज़्यादा|ज्यादा)|jeet|jitenge|jeetenge|haar|harenge|support|saath|sath|समर्थन|साथ|जीत|हार|chunav|चुनाव|virodh|विरोध|takkar|टक्कर|mahaul|mahol|माहौल)/i;
const COMPLAINT_RX = /(naali|nali|sadak|paani|pani|bijli|light|toot|tuti|kharab|band\s+(h|hai|pada)|kichad|keechad|gandagi|safai|नाली|सड़क|पानी|बिजली|टूट|खराब|ख़राब|कीचड़|गंदगी|सफाई)/i;
const ABUSE_RX = /(kutt|kamin|harami|bsdk|bhosd|madarc|chutiy|nalayak|कुत्त|कमीन|हरामी|नालायक)/i;
const GREET_RX = /^(ram\s*ram|raam\s*raam|राम\s*राम|namaste|namaskar|नमस्ते|नमस्कार|pranam|प्रणाम|hi+|hello|hey|jai shree ram|जय श्री राम|radhe radhe)\b/i;
const THANKS_RX = /^(thanks?|thank you|shukriya|dhanyawad|dhanyavad|धन्यवाद|शुक्रिया)\b/i;
const FATHER_RX = /(?:pita|pitaji|papa|father|baap|पिता|पिताजी|पापा|s\/o)\s*(?:ji|जी)?\s*(?:ka|का)?\s*(?:naam|नाम)?\s*(?:h|hai|है|:)?\s*([a-z\u0900-\u097F]+(?:\s+[a-z\u0900-\u097F]+)?)/i;

function scriptOf(t) { return /[\u0900-\u097F]/.test(t) ? 'hindi' : (/[a-z]/i.test(t) ? 'roman' : null); }

function tokens(text) { return String(text || '').split(/[^a-zA-Z\u0900-\u097F]+/).filter(Boolean); }

/** Strip Hinglish filler -> the name words ("babal yadav kie bhi parchi de do" -> "babal yadav"). */
function nameWords(text) {
    let t = String(text || '');
    t = t.replace(/(?:ward|वार्ड)\s*(?:no\.?|नं\.?)?\s*\d{1,2}/ig, ' ');
    t = t.replace(FATHER_RX, ' ');
    return tokens(t).filter(w => w.length >= 2 && !FILLER.has(w.toLowerCase()) && !FILLER_HI.has(w) && !CANDIDATE_RX.test(w)
        && !/^(sihali|सिहाली|khurd|खुर्द|gaon|gaav|गाँव|vote|votes|वोट|kam|कम|jyada|zyada|bataya|batao|samjha|samjho|samajh|chiye|bol|bolo|kaha|suno|sun|kya|kyu|kyon|kab|kaise|kahan|where|why|what|who|daal|dalo)$/i.test(w));
}
function toDevanagari(words) {
    return words.map(w => {
        if (/[\u0900-\u097F]/.test(w)) return w;
        const k = w.toLowerCase();
        if (NAME_TRANSLIT[k]) return NAME_TRANSLIT[k][0];
        return voterEngine.translit ? voterEngine.translit(k) : k;
    }).join(' ');
}
function looksLikeName(words) {
    if (!words.length || words.length > 4) return false;
    return words.every(w => w.length >= 3 || /^(om|ram|lal)$/i.test(w));
}

function memorySummary(user) {
    const m = (user && user.memory) || {};
    const parts = [];
    if (m.name) parts.push(`voter's own name (told by them): ${m.name}`);
    if (m.ward || user.ward) parts.push(`ward ${m.ward || user.ward}`);
    if (m.slip && m.slip.name) parts.push(`slip already delivered for self: ${m.slip.name}`);
    if (Array.isArray(m.concerns) && m.concerns.length) parts.push('concerns: ' + m.concerns.slice(-3).map(c => c.topic || c.text || c).join(', '));
    if (m.stance) parts.push('stance: ' + m.stance);
    return parts.join('; ') || 'nothing yet';
}
function pendingSummary(user) {
    if (!user) return 'none';
    const st = user.slipTarget;
    const bits = [];
    if (st && st.name) bits.push(`slip being searched for ${st.who === 'other' ? 'ANOTHER person' : 'the voter themself'}: "${st.name}"`);
    if (Array.isArray(user.disambiguationMatches) && user.disambiguationMatches.length) bits.push(`numbered list shown: ${user.disambiguationMatches.map((v, i) => `${i + 1}) ${v.name_hi} (father/husband ${v.rel_name_hi})`).join(' ')}`);
    if (user.pendingParchiCandidate) bits.push(`waiting for yes/no: is father/husband "${user.pendingParchiCandidate.rel_name_hi}" for "${user.pendingParchiCandidate.name_hi}"`);
    return bits.join('; ') || 'none';
}

/** Rule-based understanding (always available; also the guard-rail for the LLM). */
function rules(text, user) {
    const t = String(text || '').trim();
    const low = lowerOf(t);
    const out = { intent: 'unclear', target_person: null, person_name_hi: null, person_name_roman: null, father_name: null, ward: null,
        sentiment: 'neutral', refers_to: null, wants_slip: false, wants_contact: false, complaint: null, script: scriptOf(t), short_summary: '', confidence: 0.5, source: 'rules' };
    const wm = t.match(/(?:ward|वार्ड)\s*(?:no\.?|नं\.?)?\s*(\d{1,2})\b/i);
    if (wm && Number(wm[1]) >= 1 && Number(wm[1]) <= 11) out.ward = Number(wm[1]);
    const fm = t.match(FATHER_RX);
    if (fm && !CANDIDATE_RX.test(fm[1])) out.father_name = fm[1];
    const words = nameWords(t);
    const slipWord = SLIP_RX.test(t);
    const st = user && user.slipTarget && user.slipTarget.at && (Date.now() - Date.parse(user.slipTarget.at) < 3 * 3600 * 1000) ? user.slipTarget : null;
    const pendingList = user && ((Array.isArray(user.disambiguationMatches) && user.disambiguationMatches.length) || user.pendingParchiCandidate);
    const lastBot = (((user && user.history) || []).filter(h => h.role === 'bot').slice(-1)[0] || {}).text || '';
    const botAskedName = /(नाम|naam).{0,40}(बता|लिख|bata|likh)|पिता.{0,10}नाम|pita.{0,10}naam/i.test(lastBot);

    if (ABUSE_RX.test(t)) { out.intent = 'abuse'; out.sentiment = 'angry'; return out; }
    if (CONTACT_RX.test(t) && !slipWord) { out.intent = 'contact_request'; out.wants_contact = true; out.confidence = 0.9; return out; }
    if (CARD_ISSUE_RX.test(t)) {
        out.intent = 'voter_card_issue'; out.target_person = OTHER_PERSON_RX.test(t) ? 'other' : 'self'; out.confidence = 0.85;
        if (RECALL_SELF_RX.test(t)) out.refers_to = 'self_name';
        return out;
    }
    if (CANDIDATE_RX.test(t) && !slipWord && !/^(1|2|3|4|5|haan|ha|हाँ)$/i.test(low)) {
        // anything about Baba/Abhay Singh is talk about the campaign, never a slip answer
        out.intent = POLITICAL_RX.test(t) ? 'political_talk' : (/(nahi|nhi|नहीं|khilaf|against)/i.test(t) && /(saath|sath|साथ|vote|वोट)/i.test(t) ? 'opposition' : 'political_talk');
        if (/(saath|sath|साथ)\s*(h|hai|हैं|है|hain)/i.test(t) && !/(nahi|nhi|nhai|नहीं)/i.test(t)) out.intent = 'support';
        if (/(kam|कम|haar|हार|nahi|nhi|nhai|नहीं)/i.test(t)) out.sentiment = 'concerned';
        out.confidence = 0.75;
        return out;
    }
    if (RECALL_SELF_RX.test(t)) { out.intent = 'recall_self'; out.target_person = 'self'; out.refers_to = 'self_name'; out.confidence = 0.8; return out; }
    if (POLITICAL_RX.test(t) && !slipWord && !COMPLAINT_RX.test(t)) { out.intent = 'political_talk'; out.confidence = 0.6; return out; }
    if (COMPLAINT_RX.test(t) && !slipWord) { out.intent = 'complaint'; out.complaint = { category: null, ward: out.ward, since: null }; out.sentiment = 'concerned'; out.confidence = 0.6; return out; }
    if (THANKS_RX.test(low) && words.length <= 1) { out.intent = 'thanks'; return out; }
    if (GREET_RX.test(low) && !slipWord && words.length <= 3) { out.intent = 'greeting'; return out; }

    const genitiveEnd = /\b(kie|kii|ki|ka|ke|की|का|के)\s*(bhi|भी)?\s*[.!?]*$/i.test(t) || /\b(kie|ki|ka|ke|की|का|के)\s+(bhi|भी)\b/i.test(t);
    const isOther = OTHER_PERSON_RX.test(t) || (genitiveEnd && !/(meri|mera|मेरी|मेरा)/i.test(t)) || /\b(bhi)\b.{0,15}(parchi|पर्ची)|(kie|ki|ka|ke)\s+(bhi\s+)?(parchi|voter)/i.test(t)
        || (st && st.who === 'other' && !/(meri|mera|apni|मेरी|मेरा|अपनी)/i.test(t));
    const nameOk = looksLikeName(words);
    if (slipWord) {
        out.intent = 'slip_request'; out.wants_slip = true; out.confidence = 0.8;
        out.target_person = /(meri|mera|apni|apna|मेरी|मेरा|अपनी|अपना)\s*(parchi|पर्ची|voter|वोटर|naam|नाम)/i.test(t) && !isOther ? 'self' : (isOther || (nameOk && !/(meri|mera|मेरी|मेरा)/i.test(t)) ? 'other' : 'self');
    } else if (nameOk && (st || pendingList || botAskedName)) {
        // a bare name while a slip search is open = the answer to it ("parveen kumar", "are pareven kumar h naam h uska")
        out.intent = 'slip_answer'; out.wants_slip = true; out.confidence = 0.7;
        out.target_person = isOther ? 'other' : (st ? st.who : 'self');
    } else if (/(bataya|btaya|bata diya|बताया)/i.test(t) && st) {
        out.intent = 'slip_answer'; out.wants_slip = true; out.refers_to = 'pending_slip'; out.target_person = st.who; out.confidence = 0.6;
    } else if (nameOk && words.length >= 2 && /(kie|ki|ka|ke|की|का|के)\s*$/i.test(t)) {
        out.intent = 'slip_request'; out.wants_slip = true; out.target_person = 'other'; out.confidence = 0.55;
    } else if (/(\?|kya|kyu|kaise|kab|kahan|kaun|kon|क्या|कब|कैसे|कहाँ)/i.test(t)) {
        out.intent = 'question';
    } else if (words.length === 0) {
        out.intent = 'chitchat';
    }
    if (out.wants_slip) {
        if (nameOk) { out.person_name_roman = words.filter(w => /[a-z]/i.test(w)).join(' ') || null; out.person_name_hi = toDevanagari(words); }
        else if (st && st.name) { out.person_name_hi = st.nameHi || st.name; out.person_name_roman = st.nameRoman || null; out.refers_to = out.refers_to || 'pending_slip'; }
    }
    return out;
}

function parseJson(raw) {
    if (!raw) return null;
    let s = String(raw).replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/```(?:json)?/gi, '').trim();
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a < 0 || b <= a) return null;
    s = s.slice(a, b + 1);
    try { return JSON.parse(s); } catch (e) {
        try { return JSON.parse(s.replace(/,\s*([}\]])/g, '$1').replace(/'/g, '"')); } catch (e2) { return null; }
    }
}

const SYSTEM = `You are the understanding module of a WhatsApp campaign helper for Gram Panchayat Sihali Khurd (candidate: Abhay Singh ji, called "Baba"). Voters write Hindi, Hinglish (Roman), Haryanvi or Rajasthani, with typos.
Read the conversation and output ONLY one JSON object, no prose:
{"intent": one of ${JSON.stringify(INTENTS)},
 "target_person": "self"|"other"|null,   // whose voter slip / voter card the message is about
 "person_name_hi": Devanagari name or null, "person_name_roman": Roman name or null,  // ONLY a real person's name, filler removed (kie/ki/ka/bhi/parchi/de do/chahiye/naam h uska/h are NOT names)
 "father_name": string|null, "ward": number|null,
 "sentiment": "positive"|"neutral"|"concerned"|"angry",
 "refers_to": short text: which earlier item this refers to (e.g. "pending slip for Parveen Kumar") or null,
 "wants_slip": true|false, "wants_contact": true|false,
 "complaint": {"category": string, "ward": number|null, "since": string|null} | null,
 "script": "hindi"|"roman", "short_summary": "<=15 words English"}
Rules:
- "slip_request"/"slip_answer" ONLY when the voter asks for a voter slip/parchi/voter list entry/voter id details of someone, or gives a name/father name/choice in answer to an open slip search. Talk about Baba/Abhay Singh, votes, winning/losing ("baba ke 100 vote kam h") is "political_talk", never a slip.
- "voter_card_issue": the physical voter ID card has not arrived / lost.
- "contact_request": they want our phone number / contact details.
- "recall_self": they ask who they are / whether we remember their name.
- If an open slip search is for another person and the voter repeats or corrects that name ("are bhai bataya naa", "pareven kumar h naam h uska"), it is "slip_answer" with target "other" and that person's name.
- Transliterate common names: parveen/pareven/praveen -> प्रवीण, babal -> बबल, krishan -> कृष्ण.`;

async function llm(text, user, opts) {
    const call = opts.callLLM;
    if (!call) return null;
    let hist = ((user && user.history) || []).filter(h => h && h.text);
    if (hist.length && hist[hist.length - 1].role !== 'bot' && String(hist[hist.length - 1].text).trim() === String(text).trim()) hist = hist.slice(0, -1);
    const lastTurns = hist.slice(-12).map(h => `${h.role === 'bot' ? 'BOT' : 'VOTER'}: ${String(h.text).slice(0, 220)}`).join('\n');
    let opBlock = ''; try { opBlock = require('./operator_control.js').nluBlock(user || {}); } catch (e) {}
    const prompt = `${opBlock ? opBlock + '\n' : ''}Voter memory: ${memorySummary(user || {})}\nPending slip state: ${pendingSummary(user)}\nLast turns:\n${lastTurns || '(none)'}\n\nNEW VOTER MESSAGE: ${text}\n\nJSON:`;
    const budget = Number(process.env.NLU_BUDGET_MS || 4000);
    try {
        const raw = await Promise.race([call(SYSTEM, prompt, budget), new Promise(r => setTimeout(() => r(null), budget + 200))]);
        const j = parseJson(raw);
        return j && typeof j === 'object' ? j : null;
    } catch (e) { return null; }
}

function clean(j) {
    const o = {};
    o.intent = INTENTS.includes(j.intent) ? j.intent : 'unclear';
    o.target_person = ['self', 'other'].includes(j.target_person) ? j.target_person : null;
    const nm = v => (typeof v === 'string' && v.trim() && v.trim().length <= 40 && !/^(null|none|unknown)$/i.test(v.trim())) ? v.trim() : null;
    o.person_name_hi = nm(j.person_name_hi); o.person_name_roman = nm(j.person_name_roman); o.father_name = nm(j.father_name);
    // filler the model may have kept
    for (const k of ['person_name_hi', 'person_name_roman', 'father_name']) {
        if (o[k]) { const w = nameWords(o[k]); o[k] = w.length ? w.join(' ') : null; }
    }
    o.ward = Number(j.ward) >= 1 && Number(j.ward) <= 11 ? Number(j.ward) : null;
    o.sentiment = ['positive', 'neutral', 'concerned', 'angry'].includes(j.sentiment) ? j.sentiment : 'neutral';
    o.refers_to = nm(j.refers_to) ? String(j.refers_to).slice(0, 80) : null;
    o.wants_slip = j.wants_slip === true;
    o.wants_contact = j.wants_contact === true;
    o.complaint = j.complaint && typeof j.complaint === 'object' && j.complaint.category ? { category: String(j.complaint.category).slice(0, 40), ward: Number(j.complaint.ward) || null, since: j.complaint.since ? String(j.complaint.since).slice(0, 30) : null } : null;
    o.script = ['hindi', 'roman'].includes(j.script) ? j.script : null;
    o.short_summary = typeof j.short_summary === 'string' ? j.short_summary.slice(0, 120) : '';
    return o;
}

/** Is this name actually in the message (any token, Roman/Devanagari/variant)? Stops the LLM copying a name or a
 *  father's name out of the history/list ("are bhai bataya naa" -> father "लाल सिंह" would deliver a slip). */
let HI2EN = null;
function hiToEn() {
    // Devanagari name word -> Roman spellings, learned from the roll itself (भवानी -> bhavani)
    if (HI2EN) return HI2EN;
    HI2EN = new Map();
    try {
        const V = require(process.env.VOTERS_PATH || './voters_cleaned.json');
        const add = (hi, en) => {
            const h = String(hi || '').split(/\s+/), e = String(en || '').toLowerCase().split(/\s+/);
            if (h.length !== e.length) return;
            h.forEach((w, i) => { if (!HI2EN.has(w)) HI2EN.set(w, new Set()); HI2EN.get(w).add(e[i]); });
        };
        for (const v of V) { add(v.name_hi, v.name_en || v.ne); add(v.rel_name_hi, v.rel_name_en || v.re); }
    } catch (e) {}
    return HI2EN;
}
function grounded(name, text, user) {
    if (!name) return false;
    const sk = x => String(x || '').toLowerCase().replace(/[aeiouy]/g, '').replace(/w/g, 'v').replace(/(.)\1+/g, '$1');
    const tt = tokens(text).map(w => w.toLowerCase());
    const forms = new Set();
    for (const w of tt) {
        forms.add(w);
        if (NAME_TRANSLIT[w]) NAME_TRANSLIT[w].forEach(x => forms.add(x));
        if (voterEngine.translit && /[a-z]/.test(w)) forms.add(String(voterEngine.translit(w)).toLowerCase());
    }
    const generic = /^(kumar|singh|devi|lal|ram|yadav|कुमार|सिंह|देवी|लाल|राम|यादव)$/i;
    const nt = tokens(name).map(w => w.toLowerCase()).filter(w => !generic.test(w));
    if (!nt.length) return false;
    const romanMatch = w => /^[a-z]{3,}$/.test(w) && tt.some(x => /^[a-z]{3,}$/.test(x) && x[0] === w[0] && sk(x) === sk(w));
    return nt.some(w => forms.has(w) || romanMatch(w) || (/[\u0900-\u097F]/.test(w) && [...(hiToEn().get(w) || [])].some(romanMatch)));
}
const sameAsTarget = (name, user) => {
    const st = user && user.slipTarget;
    if (!st || !name) return false;
    const n = String(name).toLowerCase().trim();
    return [st.nameHi, st.nameRoman, st.name].filter(Boolean).some(x => String(x).toLowerCase().trim() === n);
};

/** Merge: LLM leads, rules guard (privacy + obvious patterns). */
function merge(r, l, text, user) {
    if (!l) return r;
    // the LLM shrugged but the rules saw something specific: trust the rules
    if (['unclear', 'chitchat', 'other', 'greeting', 'thanks'].includes(l.intent) && !['unclear', 'chitchat', 'greeting', 'thanks', 'question'].includes(r.intent) && r.confidence >= 0.55) {
        return { ...r, source: 'rules', llm_intent: l.intent };
    }
    // a slip ask the rules are sure of (a name + "ki parchi"/"kie", or a name while a slip search is open) stands
    // unless the model also reads it as a slip (then the model's richer fields are used)
    if (['slip_request', 'slip_answer'].includes(r.intent) && r.confidence >= 0.55 && (r.person_name_hi || r.person_name_roman) && !['slip_request', 'slip_answer', 'contact_request', 'voter_card_issue'].includes(l.intent)) {
        return { ...r, source: 'rules', llm_intent: l.intent };
    }
    // names must come from the message itself (or be the person already being searched)
    if (l.father_name && !grounded(l.father_name, text, user)) l.father_name = null;
    if (l.person_name_hi && !grounded(l.person_name_hi, text, user) && !sameAsTarget(l.person_name_hi, user)) l.person_name_hi = null;
    if (l.person_name_roman && !grounded(l.person_name_roman, text, user) && !sameAsTarget(l.person_name_roman, user)) l.person_name_roman = null;
    const o = { ...r, ...l, source: 'llm', rules_intent: r.intent, confidence: 0.85 };
    o.script = l.script || r.script;
    // guard-rails
    if (CANDIDATE_RX.test(text) && !SLIP_RX.test(text)) { if (['slip_request', 'slip_answer'].includes(o.intent)) o.intent = r.intent; o.wants_slip = false; }
    if (r.intent === 'contact_request') { o.intent = 'contact_request'; o.wants_contact = true; }
    if (r.intent === 'voter_card_issue' && !['voter_card_issue'].includes(o.intent)) { o.intent = 'voter_card_issue'; }
    if (['slip_request', 'slip_answer'].includes(o.intent)) o.wants_slip = true;
    if (!['slip_request', 'slip_answer'].includes(o.intent)) o.wants_slip = false;
    if (o.wants_slip && !o.person_name_hi && !o.person_name_roman) { o.person_name_hi = r.person_name_hi; o.person_name_roman = r.person_name_roman; }
    // the model sometimes drops a word ("बबल" for "babal yadav"): keep the fuller name the rules read from the same message
    if (o.wants_slip && r.person_name_hi && o.person_name_hi && r.person_name_hi !== o.person_name_hi && r.person_name_hi.includes(o.person_name_hi)) { o.person_name_hi = r.person_name_hi; o.person_name_roman = r.person_name_roman || o.person_name_roman; }
    if (o.wants_slip && !o.target_person) o.target_person = r.target_person || 'self';
    if (!o.father_name) o.father_name = r.father_name;
    // a ward must be written in this message (the model copied "वार्ड 1" out of the list once)
    if (o.ward && !new RegExp('(^|\\D)' + o.ward + '(\\D|$)').test(text)) o.ward = null;
    if (!o.ward) o.ward = r.ward;
    if (o.intent === 'unclear' && r.intent !== 'unclear') o.intent = r.intent;
    return o;
}

/**
 * @param {string} text
 * @param {object} user  user_memory record (read only here)
 * @param {object} opts  { callLLM: async (system, prompt, budgetMs) => string|null }  — omit/null = rules only
 */
async function understand(text, user, opts = {}) {
    const r = rules(text, user);
    if (process.env.NLU_LLM === 'off' || !opts.callLLM) return r;
    const raw = await llm(text, user, opts);
    if (!raw) return { ...r, llm_failed: true };
    return merge(r, clean(raw), String(text || ''), user);
}

/** Search text for slip_flow from an NLU verdict (Devanagari first, else Roman). */
function searchTextOf(n) {
    if (!n) return '';
    const name = n.person_name_hi || n.person_name_roman || '';
    return [name, n.father_name ? `pita ${n.father_name}` : '', n.ward ? `ward ${n.ward}` : ''].filter(Boolean).join(' ').trim();
}

module.exports = { grounded, understand, rules, nameWords, toDevanagari, parseJson, clean, merge, searchTextOf, NAME_TRANSLIT, CANDIDATE_RX, SYSTEM, INTENTS };
