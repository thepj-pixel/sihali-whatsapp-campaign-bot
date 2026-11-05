/**
 * Reply Brain v3 — a campaign volunteer who listens, remembers and writes things down.
 *
 * Layers (owner's brief):
 *   1. FACTS      only the two parchas (knowledge_base.js -> rag_vault/parcha_facts.json)
 *   2. MAIN GOAL  move every voter, warmly, toward a committed vote for Abhay Singh ji
 *   3. DAILY GOAL today's focus from the dashboard (passed in as opts.goal)
 *   4. CONVERSATION answer the actual message first, use memory naturally, handle daily life
 *                 (health, crops, family, weather, festivals) like a caring village worker, one question max
 *   5. PROACTIVE  samasya logging, "अभय सिंह जी को घर बुलाना चाहेंगे?", follow-ups (followup_planner.js)
 *
 * Pipeline per message: memory update -> classify -> open flow (samasya / mulaqat) -> grounded template
 * -> optional LLM rewrite (validated; template kept on any rule break) -> no-repeat guard.
 *
 * Hard rules (code-enforced): never "बाबा जी" alone; never say he was sarpanch (works are "पिछले कार्यकाल में
 * पंचायत में करवाए गए", "उनके प्रयास से"); no budgets/rupees/work counts; no election-symbol claims; no promised
 * dates or fixes beyond the parcha sankalp; no threats, bribes, caste/religion; never attack opponents;
 * STOP/बंद/रुको handled upstream (engagement_policy) and permanent.
 */
const campaignProfile = require('./campaign_profile.js');
const replyQuality = require('./reply_quality.js');
const kb = require('./knowledge_base.js');
const voterMemory = require('./voter_memory.js');
const flows = require('./conversation_flows.js');

const STAGES = ['unknown', 'undecided', 'leaning', 'committed', 'opposed'];

// ---------------- language / person ----------------
const hasDevanagari = t => /[\u0900-\u097F]/.test(String(t || ''));
const emojiSense = require('./emoji_sense.js');
const MEDIA_RX = /^\[(voice note|audio|sticker|photo|फोटो[^\]]*|video|वीडियो|document|location|लोकेशन|contact card|gif)\]$/i;

// Script preference (owner, 5 Nov): default reply script is Hindi (Devanagari) even when the voter types Roman.
// memory.scriptPref = 'hindi' | 'hinglish' (asked once early, changeable any time). DEFAULT_SCRIPT=auto restores the
// old "follow the voter's script" behaviour (used by the legacy content suites).
const SCRIPT_ASK_HI = 'वैसे, आप हिंदी में बात करना पसंद करेंगे या Hinglish (Roman) में? 🙏';
const SCRIPT_ASK_RX = /हिंदी में बात करना पसंद करेंगे या Hinglish/;
const SCRIPT_SWITCH_RX = /((hinglish|roman|english|abc)\s*(me|mein|mai|में|letters|akshar|format)?\s*(hi\s*)?(baat|bol|likh|likho|karo|kijiye|chalega|बात|लिख|बोल))|((hindi|hindee|हिंदी|हिन्दी|devanagari|देवनागरी)\s*(me|mein|mai|में)\s*(hi\s*|ही\s*)?(baat|bol|likh|likho|karo|kijiye|बात|लिख|बोल|करो))/i;
const SCRIPT_ANS_HINDI = /^(hindi|hindee|हिंदी|हिन्दी|devanagari|देवनागरी|1|1️⃣)[\s\p{L}\p{M}!.,🙏👍]{0,25}$/iu;
const SCRIPT_ANS_HINGLISH = /^(hinglish|roman|english|abc|2|2️⃣)[\s\p{L}\p{M}!.,🙏👍]{0,25}$/iu;
const opCtl = require('./operator_control.js');
function scriptPrefOf(user) {
    const m = user && user.memory;
    if (m && (m.scriptPref === 'hindi' || m.scriptPref === 'hinglish')) return m.scriptPref;
    if (user && user.languagePreference === 'hinglish') return 'hinglish';
    if (user && user.languagePreference === 'hi') return 'hindi';
    return null;
}
function setScriptPref(user, pref, by = 'voter') {
    if (!user || !['hindi', 'hinglish'].includes(pref)) return;
    const m = voterMemory.ensure(user);
    m.scriptPref = pref; m.scriptPrefBy = by; m.scriptPrefAt = new Date().toISOString();
    if (!m.scriptAskedAt) m.scriptAskedAt = m.scriptPrefAt;
    user.languagePreference = pref === 'hinglish' ? 'hinglish' : 'hi';
}
function scriptMismatch(out, l) {
    const t = String(out || '');
    const dev = (t.match(/[\u0900-\u097F]/g) || []).length, lat = (t.match(/[a-z]/gi) || []).length;
    if (l === 'hi' && lat > dev) return 'wrong_script';
    if (l === 'en' && dev > 3) return 'wrong_script';
    return null;
}

function lang(text, user) {
    const sp = scriptPrefOf(user);
    if (sp === 'hinglish') return 'en';
    if (sp === 'hindi') return 'hi';
    if (process.env.DEFAULT_SCRIPT !== 'auto') return 'hi';
    const m = user && user.memory;
    if (MEDIA_RX.test(String(text || '').trim())) return m && m.language === 'en' ? 'en' : 'hi';
    if (emojiSense.analyze(text).emojiOnly) return m && m.language === 'en' ? 'en' : 'hi';
    if (hasDevanagari(text)) return 'hi';
    if (/[a-z]/i.test(String(text || ''))) return 'en';
    return m && m.language === 'hi' ? 'hi' : 'en';
}

const FEMALE_NAME = /(देवी|कुमारी|बाई|वती|रानी|ममता|सुनीता|अनीता|सरोज|कमला|शारदा|पूजा|प्रियंका|सुमन|संतोष देवी|\bdevi\b|kumari|\bbai\b|wati|vati|rani\b|sunita|anita|saroj|kamla|pooja|priyanka|suman|mamta|sharda)/i;
const SELF_FEMALE = /(main (ek )?(mahila|aurat|ladki|beti|bahu|gharwali)|मैं (एक )?(महिला|औरत|लड़की|बेटी|बहू)|hum (mahila|auratein)|bahan hoon|बहन हूँ)/i;

/** The voter's OWN roll record: voterProfile, or the last self slip (never a bare search hit / a relative's record: lastFoundVoterSelf === false). */
function selfVoter(user = {}) {
    if (!user) return null;
    if (user.voterProfile) return user.voterProfile;
    return user.lastFoundVoterSelf === false ? null : (user.lastFoundVoter || null);
}
function personOf(user = {}, text = '') {
    const v = selfVoter(user);
    const mem = user.memory || {};
    let gender = null, age = null, source = null;
    if (v) {
        const g = String(v.gender || v.g || v.gender_hi || '');
        if (/महिला|^f/i.test(g)) gender = 'F'; else if (/पुरुष|^m/i.test(g)) gender = 'M';
        age = Number(v.age || v.a) || null;
        if (gender) source = 'voter_record';
    }
    if (!gender && user.genderConfirmed) { gender = user.genderConfirmed; source = 'confirmed'; }
    if (!gender && mem.gender) { gender = mem.gender; source = mem.genderSource || 'memory'; }
    if (!gender && SELF_FEMALE.test(text)) { gender = 'F'; source = 'message'; }
    if (!gender && user.name && FEMALE_NAME.test(user.name)) { gender = 'F'; source = 'name'; }
    if (!gender && user.pushName && FEMALE_NAME.test(user.pushName)) { gender = 'F'; source = 'name'; }
    if (!age && Number(user.age)) age = Number(user.age);
    if (!age && Number(mem.age)) age = Number(mem.age);
    if (!age && mem.ageGroup) age = { elder: 65, middle: 45, young: 25 }[mem.ageGroup] || null;
    if (!age && /(\bbeta\b|bachch?a\b|बेटा|बच्चा|म्हारा छोरा|mhara chhora|\bbitiya\b|बिटिया)/i.test(text) && !/(mera|meri|mere|hamara|hamare|mhara|मेरा|मेरे|हमारा|हमारे|म्हारा)\s+(beta|bachch?a|बेटा|बच्चा|bitiya|बिटिया)/i.test(text)) age = 60;
    return { gender, age, source };
}

function honorific(person, l) {
    const { gender, age } = person;
    const H = l === 'hi'
        ? { mata: 'माता जी', tai: 'ताई जी', behan: 'बहन जी', dada: 'दादा जी', tau: 'ताऊ जी', bhai: 'भाई साहब', none: 'जी' }
        : { mata: 'Mata ji', tai: 'Tai ji', behan: 'Behan ji', dada: 'Dada ji', tau: 'Tau ji', bhai: 'Bhai sahab', none: 'ji' };
    if (gender === 'F') return age >= 60 ? H.mata : age >= 40 ? H.tai : H.behan;
    if (gender === 'M') return age >= 65 ? H.dada : age >= 45 ? H.tau : H.bhai;
    return H.none; // gender unknown: never guess ताऊ/ताई — a neutral "जी" is always respectful
}
const isJi = hon => /^(जी|ji)$/i.test(hon);

// words that are never a person's first name (stale/bad extractions must never be used to greet someone)
const NOT_A_NAME = /^(mera|meri|mere|mero|mhara|main|mai|hum|ham|aap|ap|tum|kya|nahi|haan|ha|ji|ok|okay|theek|thik|bhai|sab|koi|kaun|ye|wo|abhi|baad|bas|achha|accha|hello|hi|ram|baba|abhay|मेरा|मेरी|मेरे|म्हारा|मैं|हम|आप|तुम|क्या|नहीं|हाँ|जी|ठीक|भाई|सब|कोई|कौन|ये|वो|अभी|बस|अच्छा|राम|बाबा|अभय)$/i;
function nameFor(user, l) {
    if (!user) return '';
    const v = selfVoter(user) || {};
    const cands = [user.memory && user.memory.name, user.name, l === 'hi' ? v.name_hi : v.name_en, v.name].filter(Boolean)
        .filter(n => !/ग्रामवासी|contact|voter|समर्थक|self-test|test/i.test(n))
        .filter(n => !NOT_A_NAME.test(String(n).trim().split(/\s+/)[0]));
    const ok = cands.find(n => (l === 'hi' ? hasDevanagari(n) : !hasDevanagari(n)));
    if (ok) return String(ok).trim().split(/\s+/)[0];
    return l === 'hi' && cands.length ? scriptName(cands[0], 'hi').split(/\s+/)[0] : '';
}

/** A name in the reply's script: Roman "Krishan Kumar" -> "कृष्ण कुमार" for Hindi replies (never a mixed-script greeting). */
function scriptName(n, l) {
    n = String(n || '').trim();
    if (!n) return '';
    if (l === 'hi' && !hasDevanagari(n) && /^[a-z\s.]+$/i.test(n)) {
        try { const dv = require('./nlu.js').toDevanagari(n.split(/\s+/).filter(Boolean)); if (/^[\u0900-\u097F\s]+$/.test(dv)) return dv; } catch (e) {}
        return '';
    }
    if (l === 'en' && hasDevanagari(n)) return '';
    return n;
}

// ---------------- intent ----------------
const RX = {
    visitWhen: /((chaupal|चौपाल|gali|गली|mohalle|मोहल्ले|ghar|घर)\s*(par|pe|me|में|पर)?\s*)?(kab aaoge|kab aaonge|kab aayenge|kab aaenge|kab aaoge|कब आओगे|कब आएँगे|कब आएंगे|कब आओगी)/i,
    commitYes: /(pakk?a\b|pakka vote|vote (dalne|daalne|dene) (zaroor )?(aaunga|aaungi|aunga|aungi|aayenge|aaenge)|वोट (डालने|देने) (ज़रूर |जरूर )?(आऊँगा|आऊंगा|आऊँगी|आऊंगी|आएँगे|आएंगे)|vote (to )?(denge|dunga|dungi|dege|de denge|karenge)|aap?ke sath|aapke saath|(hum|ham|main|mai) (to )?(abhay singh|aap|baba)[a-z ]{0,10}(ke )?sath|saath (hai|hain|h)\b|baba ko hi|abhay singh ko hi|support (hai|h|karenge)|hamara vote|mhara vote|पक्का|वोट (देंगे|दूंगा|दूँगा|दूंगी|देगें|दे देंगे|देगा|देगी)|साथ (हैं|है|हूँ|हूं|हु)|saath (hu|hoon|hun)\b|sath (hu|hoon|hun)\b|समर्थन (है|करेंगे)|आपको ही|अभय सिंह को ही)/i,
    opposed: /(nahi denge|nhi denge|nahi dunga|nahi dungi|vote nahi|vote nhi|kisi aur ko|dusre ko|doosre ko|(dusre|doosre|unke|uske|virodhi|samne wale) ke (saath|sath|supporter)|dusre ka supporter|against|virodh me|नहीं देंगे|नहीं दूंगा|वोट नहीं|किसी और को|दूसरे को|(दूसरे|उनके|उसके|विरोधी|सामने वाले) के साथ|खिलाफ)/i,
    bribe: /(daru|daaru|sharab|botal|bottle|kitna doge|kitne doge|paise doge|paisa doge|paise milenge|paisa milega|paise do|paisa do|note do|kuch (to )?milega|kya milega vote|vote ka kya milega|kuch (to )?doge|पैसे दो|पैसा दो|पैसे दोगे|पैसा दोगे|पैसे मिलेंगे|पैसा मिलेगा|कितना दोगे|कुछ (तो )?मिलेगा|क्या मिलेगा|दारू|शराब|बोतल)/i,
    taunt: /((40 saal|चालीस साल|40 साल|aaj tak|आज तक|5 saal|पाँच साल)[^?]{0,20}(kya kiya|क्या किया)|kuch nahi kiya|kuch nhi kiya|kuchh nahi kiya|kuch (bhi )?kaam nahi (karwaya|karaya|kiya|hua|kar(w)?aye)|koi kaam nahi (karwaya|kiya|hua)|kuch nahi karwaya|कुछ (भी )?काम नहीं (करवाया|किया|हुआ)|jhoot|jhooth|\bchor\b|farji|farzi|dhongi|bekar|bakwas|kaam hi nahi|koi kaam nahi|कुछ नहीं किया|झूठ|चोर|फर्जी|बेकार|बकवास|कोई काम नहीं)/i,
    abuse: /(\bmc\b|\bbc\b|\bmkc\b|bsdk|bhosd|madarc|behenc|bhenc|\bkutt?[aeiy]\b|kutton|kutiya|kamine|kamina|harami|haraami|saala|saale|chutiy|gandu|\blavd|\blaud|\blod[ue]\b|\bsuar\b|suwar|\bgadh[ae]\b|ullu ka|nalayak|naalayak|tatti|कुत्त[ाेी]|कुतिया|कमीन[ेा]|हरामी|साले|साला|भोस|मादर|चुतिय|गांडू|सूअर|गधे|नालायक)/i,
    corruption: /(\bchor (hai|h|he|hain|aadmi|insaan|log)\b|(abhay|baba|sarpanch|panchayat)[a-z ]{0,12}\bchor\b|चोर (है|हैं|आदमी)|kha (gaya|gye|gaye|gya|liya|liye|jayega|jaega)|kha (gaya|gye|gaye) (saare|sare|sab|saara|sara)?\s*(paise|paisa)|(paise|paisa|fund|funds|bajat|budget)\s*(kha|khaa|hadap|dakar|loot|lut)|kha (gaya|gye|gaye) (sab|saara|sare)|hadap (liya|liye|gaya)|ghotal|ghotaal|ghapla|ghaple|bhrasht|bhrashtachar|corrupt|commission khor|kamishan|\bloot (liya|liye|li|gaya|gaye|rahe)|lut (liya|liye)|lootera|lutera|chori (ki|kar|karke)|खा (गया|गए|गये|लिया|लिए)|पैसे खा|पैसा खा|हड़प|घोटाला|घपला|भ्रष्ट|लूट (लिया|लिए|ली|गया)|लुटेरा|कमीशन)/i,
    insult: /(sharam\s*(nahi|nhi|na)\s*(aati|aata|aai)|शर्म\s*नहीं\s*आती|bakwas\s*(band|mat|na)|bakwaas\s*(band|mat)|बकवास\s*(बंद|मत)|(tum|tum\s*log|aap\s*log|sab)\s*(sab\s*)?(chor|jhoothe|jhuthe|fraud|pagal|chor\s*log)\s*(ho|hain|h)\b|\bchup\b|chup (kar|kr|reh|raho)|\bbekar\b|bekaar|nikamm|faltu|faltoo|ghatiya|gatiya|wahiyat|\bdhongi\b|jhootha|jhutha|naatak|natak baaz|drama|chamcha|चुप|बेकार|निकम्म|फालतू|फ़ालतू|घटिया|वाहियात|ढोंगी|झूठा|नाटक)/i,
    wrongNumber: /(galat number|galat no|wrong number|wrong no|kaun hai ye|kon hai ye|kaun ho aap\b.*number|kisne (diya|di) (mera )?number|number kahan se|number kaha se|mera number kaise|main (is|us) gaon ka nahi|main yahan ka nahi|गलत नंबर|ये कौन है|नंबर कहाँ से|मेरा नंबर किसने|मैं इस गाँव का नहीं)/i,
    condolence: /(guzar gaye|guzar gayi|gujar gaye|gujar gayi|dehant|dehaant|nahi rahe|nhi rahe|swargwas|swargvas|maut ho|death ho|shant ho gaye|chal base|गुज़र गए|गुजर गए|गुज़र गईं|देहांत|नहीं रहे|स्वर्गवास|मृत्यु|मौत हो|चल बसे|शांत हो गए)/i,
    slip: /(parchi|parchee|voter slip|\bslip\b|\bepic\b|voter id|naam dekh|list me naam|पर्ची|मतदाता सूची|वोटर लिस्ट)/i,
    ballot: /(chunav chinh|chunav chinha|chinh|nishan|nishaan|symbol|nishani|kram sankhya|serial (number|no)|kaun sa number|konsa number|matpatra|ballot|mohar kaise|muhar kaise|mohar kahan|kaise vote (dal|daal)|vote kaise (dal|daal|de)|चिन्ह|चिह्न|निशान|मतपत्र|क्रम संख्या|मोहर कैसे|मुहर कैसे|कैसे वोट|वोट कैसे)/i,
    polling: /(when is (the )?(election|voting|vote|poll|polling)|election (date|day|kab)|voting (date|day|time|kab)|what time (is|for) (the )?(vote|voting|poll)|where (do|should|can) i vote|where is (my|the) (booth|polling)|(vote|matdan|matdaan|वोट|मतदान)\s*(kahan|kaha|kidhar|kab|कहाँ|कहां|किधर|कब)|kahan dena|kaha dena|कहाँ देना|कहां देना|kab hai|kab h\b|tarikh|tareekh|\bdate\b|booth|kahan (vote|dalna)|kidhar vote|kitne baje|time kya|kya le ?kar (jana|aana)|kaun sa card|aadhar|aadhaar|मतदान कब|कब है|तारीख|बूथ|कहाँ वोट|कितने बजे|क्या लेकर|आधार|16 nov)/i,
    callReq: /(phone (karo|kar do|karwa|karva|karaiye|karvao)|call (karo|kar do|karwa)|baat (karao|karwao|karvao|kara do|karwa do)|unka number|abhay singh (ji )?ka number|baba ka number|number (do|dijiye|bhejo|de do)|फोन (करो|करवा|कराओ)|बात (कराओ|करवाओ|करवा दो)|नंबर (दो|दीजिए|भेजो))/i,
    meeting: /(ghar\s*(pe|par|पर|पे)?\s*(aa\s*jayenge|aa\s*jaoge|aayenge|aaoge|aa jaiye|aa jao|aa sakte)|घर\s*(पर|पे)?\s*(आ\s*जाएँगे|आ\s*जाएंगे|आएँगे|आएंगे|आ\s*सकते)|milna (hai|chahta|chahti|chahte)|milne (aana|aao|aaiye|aayenge)|mulakat|mulaqat|mulaakat|ghar (aao|aaiye|aana|par aaiye|bulana|bulaana|bula)|ghar pe aao|(abhay singh|baba|unse|un se) (ji )?(se )?(milna|milwa|baat karni|baat karna)|baba se (milna|baat)|मिलना (है|चाहता|चाहती)|मिलने आइए|मुलाकात|मुलाक़ात|घर (आओ|आइए|बुलाना|पर आइए)|(अभय सिंह|बाबा|उनसे)( जी)? ?(से )?(मिलना|मिलवा|बात करनी))/i,
    samasyaExplicit: /(ek (problem|samasya|shikayat|dikkat)|shikayat (darj|likh|karni|karna)|complaint|samasya (batani|bataani|hai)|problem (batani|hai)|meri (shikayat|samasya)|एक (समस्या|शिकायत|दिक्कत|परेशानी)|शिकायत (दर्ज|लिख|करनी)|समस्या (बतानी|है))/i,
    future: /(aage kya|aage ka|sankalp|vaada|vada|wada|kya karoge|kya karenge|plan kya|manifesto|आगे क्या|संकल्प|वादा|क्या करोगे|क्या करेंगे)/i,
    worksAll: /((kaam|kam|kaary|works?|काम|कार्य)\s*(bata|batao|bataiye|btao|bta|gina|ginao|ginwao|dikhao|list|बता|बताओ|बताइए|गिनाओ|गिना)|(saare|sare|saara|sara|sab|sabhi|poore|pure|all|सारे|सारा|सब|सभी|पूरे)\s*(ke sab\s*)?(kaam|kam|kaary|works?|काम|कार्य)|(kaam|काम)[a-zऀ-ॿ ]{0,12}(saara ka saara|sara ka sara|saare ke saare|सारा का सारा|सारे के सारे)|what (work|works|development)|which works|works done|list of works)/i,
    works: /(what (has|did|have) [a-z ]{0,30}(done|do|did)\b|what work|work done|achievements?|development work|(usne|unhone|inhone|isne|baba ne|abhay ne|उसने|उन्होंने|इन्होंने|बाबा ने)\s+([a-z\u0900-\u097F]+\s+){0,2}(kya|क्या)\s*(kiya|kia|kra|kara|karwaya|karaya|banwaya|किया|करवाया|कराया|बनवाया)|kya kaam|kaam kya|kaam kaun|kaun kaun se kaam|काम क्या|ne kya kiya|ne kya karaya|ne kya karwaya|ne kya banwaya|ने क्या किया|ने क्या करवाया|kisne karwa|kisne kiya|kisne banwa|किसने करवा|किसने किया|किसने बनवा|vikas|vikaas|kaam kiya|kaam karwaya|kaam hua|कौन से काम|क्या काम|विकास|काम किया|काम करवाया|काम हुआ)/i,
    aboutBaba: /(who is abhay|about abhay|tell me about (him|abhay|the candidate)|kaun (hai|h|hain)|kon (hai|h)|parichay|baare me batao|bare me batao|abhay singh kaun|candidate kaun|moti aangli|मोटी आंगली|कौन हैं|कौन है|परिचय|के बारे में)/i,
    undecided: /(soch(enge| rahe| rhe|na padega| ke| kar)|sochke|sochkar|dekhenge|dekh lenge|dekhte hain|dekhte hai|dekhte h\b|dekhte he\b|dekhte\s*$|tay nahi|tay nhi|abhi pata nahi|decide nahi|faisla nahi|सोचेंगे|सोच रहे|सोचकर|देखेंगे|देखते हैं|तय नहीं|फ़ैसला नहीं)/i,
    positive: /(achha kaam|accha kaam|achha hai|accha hai|acha hai|अच्छा है|badhiya|sahi (hai|h)|bahut achha|achhe aadmi|achhe insaan|imandar|अच्छा काम|बढ़िया|सही है|बहुत अच्छा|अच्छे आदमी|ईमानदार|आशीर्वाद)/i,
    family: /(parivar|ghar (ke|wale)|family|biwi|patni|bete|परिवार|घर के|घरवाले)/i,
    thanks: /^(thanks a lot|thanks alot|thank you so much|thank you very much|thanks so much|thanku so much|bahut bahut dhanyavad|bahut dhanyavad|bahut dhanyawad|bahut shukriya|ok thanks|ok thank you|ok+|okay|thik|theek|thik hai|theek hai|thik h|theek h|chalo theek hai|chalo thik hai|dhanyavad|dhanyawad|shukriya|thanks|thank you|👍|🙏|ठीक है|चलो ठीक है|धन्यवाद|शुक्रिया|जी)[\s,!.🙏👍]*(beta|bete|bhai|bhaiya|ji|sa|bitiya|bahan|behan|didi|dhanyavad|dhanyawad|shukriya|thanks|thank you|thanku|tq|बेटा|भाई|भैया|जी|बिटिया|बहन|दीदी|धन्यवाद)?[\s!.🙏👍]*$/i,
    greet: /^(ram ram|raam raam|ram-ram|rm rm|namaste|namste|namastey|namastay|nmste|namaskar|namaskaar|hi+|hello|hlo|hey|jai shri ram|jai shree ram|pranam|radhe radhe|jai hind|good morning|gm\b|khamma ghani|khamma gani|ram ram sa|raam raam sa|padharo|खम्मा घणी|राम राम सा|पधारो|राम राम|राम-राम|नमस्ते|नमस्कार|प्रणाम|जय श्री राम|राधे राधे|जय हिंद)[\s\p{L}\p{M}!.,🙏]{0,24}$/iu,
    howAreYou: /(how are you|how r u|how's it going|kaise ho|kese ho|kaisa hai|kya haal|kya hal|sab badhiya|kya scene|kya scn|kya chal (raha|rha|rahi)|kya khabar|ke haal|kai haal|ke hal sai|kya haal chaal|kaisa chal|कैसे हो|क्या हाल|क्या चल रहा|के हाल|कैसा चल)/i,
    whoAreYou: /(^\s*(kon|kaun|kon h|kaun h|kon hai|kaun hai|kon ho|kaun ho|कौन|कौन है|कौन हो|aap kon|ap kon|aap kaun|ap kaun|tu kon|tu kaun|kon bhai|kaun bhai|kon ji|kaun ji)\s*(bhai|ji|जी|भाई)?\s*[?.!]*\s*$|(kiska|kis ka|kiska ye|किसका|किस का)\s*(number|numbr|nmbr|no\.?|नंबर|नम्बर)|(number|नंबर)\s*(kiska|किसका)|kahan se (bol|baat)|kaha se (bol|baat)|कहाँ से बोल|who is this|who r you|who r u|are you (a )?(bot|human|robot)|tum kaun|tum kon|aap kaun ho|ap kaun ho|aap kon ho|kaun bol (raha|rahi|rha|rhi)|kon bol (raha|rahi|rha|rhi)|\bkaun ho\b|\bkon ho\b|bot ho|robot|insaan ho|insan ho|real ho|machine ho|\bai ho|तुम कौन|आप कौन हो|कौन बोल रहा|कौन बोल रही|कौन हो|रोबोट|बॉट हो)/i,
    joke: /(joke|haha|hehe|\blol\b|chutkula|chutkule|mazak|mazaak|majak|hasao|hansao|हँसाओ|हंसाओ|चुटकुला|मज़ाक|मजाक|😂|🤣)/i,
    offTopic: /(elon|musk|zuckerberg|zukerberg|trump|putin|biden|bill gates|ambani|adani|share market|stock market|bitcoin|crypto|\bnews\b|\bkhabar(en)?\b(?! (hai|h)\b)|world cup|hollywood|bollywood|salman|shahrukh|virat|dhoni|cricket match|match (kaun|kon|kab)|\bipl\b|movie|film|picture (dekh|kab)|gaana|song|modi|rahul gandhi|\bbjp\b|congress|bhajpa|petrol|diesel ka|सिनेमा|आईपीएल|फिल्म|गाना|मोदी|राहुल गांधी|भाजपा|कांग्रेस)/i,
    opponentGeneric: /(virodhi|विरोधी|dusra candidate|doosra candidate|dusre candidate|dusra ummeedwar|dusre ummidwar|samne wala|saamne wala|सामने वाला|दूसरा उम्मीदवार|दूसरे उम्मीदवार|opposition|vipaksh|विपक्ष)/i,
    memoryCheck: /(yaad hai|yaad h\b|yad hai|yaad rakha|याद है|याद रखा|bhool gaye|bhul gaye|भूल गए|maine kya bataya|मैंने क्या बताया|pichli baar (kya|bataya)|पिछली बार)/i,
    wasSarpanch: /((pehle|pahle|पहले|purane|पुराने|already|kabhi)[^?]{0,25}(sarpanch|सरपंच)[^?]{0,15}(the|thi|rahe|reh chuke|रहे|थे|रह चुके|bane)|(sarpanch|सरपंच)\s*(the|thi|rahe|reh chuke|रहे थे|थे|रह चुके|ban chuke))/i,
    // daily life
    dlHealth: /(bimar|beemar|bukhar|bukhaar|tabiyat|tabiat|tabeeyat|operation hua|operation hai|chot lag|admit|sir dard|khansi|zukam|बीमार|बुखार|तबीयत|तबियत|ऑपरेशन|चोट लग|भर्ती|खांसी|जुकाम)/i,
    dlCrop: /(fasal|buvai|buai|bowai|katai|sarson|gehu|gehun|bajra|kapas|ola pad|ole pad|pala pad|फसल|बुवाई|कटाई|सरसों|गेहूं|गेहूँ|बाजरा|कपास|ओला|पाला)/i,
    dlFamily: /(shaadi|shadi|byah|biyah|vivah|sagai|beta hua|beti hui|pota hua|poti hui|naukri lag|job lag|pass ho ga|selection ho|bharti ho gay|शादी|ब्याह|विवाह|सगाई|बेटा हुआ|बेटी हुई|पोता हुआ|पोती हुई|नौकरी लग|पास हो ग|सिलेक्शन|भर्ती हो गय)/i,
    dlWeather: /(garmi|sardi|thand|dhund|kohra|kohara|mausam|baarish|barish|barsaat|गर्मी|सर्दी|ठंड|धुंध|कोहरा|मौसम|बारिश|बरसात)/i,
    dlFestival: /(diwali|deepawali|dipawali|bhai dooj|bhaidooj|govardhan|chhath|holi|teej|ekadashi|dev uthani|tyohar|tyohaar|happy diwali|दिवाली|दीपावली|भाई दूज|गोवर्धन|छठ|होली|तीज|एकादशी|देवउठनी|त्योहार|त्यौहार)/i,
    // v3.1: opponent support (incl. "dusre candidate ke saath", "unko vote", "X ko denge"), others giving bribes,
    // grievance ("chunav me hi yaad karte ho"), money asks, invitations, "what is special about him"
    opposeSupport: /((dusr[eia]|doosr[eia]|unk[eia]|usk[eia]|virodhi|samne wal[eia]|saamne wal[eia]|dusri party|doosri party|विरोधी|दूसर[ेीा]|उनक[ेीा]|उसक[ेीा]|सामने वाल[ेीा])\s*(candidate|ummeedwar|ummidwar|umeedwar|pratyashi|wal[eia]|log|party|उम्मीदवार|प्रत्याशी|वाल[ेीा])?\s*(ke|ka|ki|के|का|की)?\s*(saath|sath|supporter|samarthak|support|taraf|paksh|साथ|समर्थक|तरफ़|तरफ|पक्ष)|(unko|unhe|unhi ko|usko|use|dusre ko|doosre ko|उनको|उन्हें|उसको|दूसरे को)\s*(hi\s*)?(vote|वोट)?\s*(denge|dege|dunga|dungi|de rahe|dena hai|देंगे|दूंगा|दूँगा|दूंगी|देना है)|(abhay singh|abhay|baba|aap|aapko|अभय सिंह|अभय|बाबा|आपको)\s*(ji\s*|जी\s*)?(ko\s*|को\s*)?(vote\s*|वोट\s*)?(nahi|nhi|nahin|na|नहीं|ना)\s*(denge|dege|dunga|dungi|देंगे|दूंगा|दूँगा|दूंगी)|(abhay singh|abhay|baba|aap|अभय|बाबा|आप)\s*(ji\s*|जी\s*)?(ke\s*|के\s*)?(against|khilaf|khilaaf|virodh|ख़िलाफ़|खिलाफ|विरोध))/i,
    bribeOthers: /((dusr[eia]|doosr[eia]|samne wal[eia]|saamne wal[eia]|virodhi|unwale|un wale|दूसर[ेीा]|सामने वाल[ेीा]|विरोधी)\s*(wal[eia]|log|candidate|वाल[ेीा]|लोग)?\s*(to|toh|तो)?\s*(bhi\s*|भी\s*)?(\d+\s*(rs|rupaye|rupay|₹|रुपये)?\s*)?(paise|paisa|daaru|daru|sharab|botal|note|पैसे|पैसा|दारू|शराब|बोतल)?\s*(de|baant|bant|दे|बाँट|बांट)\s*(rahe|rhe|raha|rha|rahi|रहे|रहा|रही)|(wo log|woh log|baaki|sab|log|वो लोग|बाकी|सब|लोग)\s*(to|toh|तो)?\s*(bhi\s*|भी\s*)?(paise|paisa|daaru|daru|sharab|botal|पैसे|पैसा|दारू|शराब|बोतल)\s*(de|baant|bant|दे|बाँट|बांट)\s*(rahe|rhe|raha|rha|रहे|रहा)|(paise|paisa|daaru|daru|sharab|पैसे|पैसा|दारू|शराब)\s*(to\s*)?(sab|dusre|doosre|wo|सब|दूसरे|वो)\s*(de|baant|bant|दे|बाँट|बांट)\s*(rahe|rhe|रहे))/i,
    grievance: /((chunav|chunaav|election|vote|चुनाव|वोट)\s*(me|mein|ke (time|samay|waqt)|ke din|aate hi|में|के (समय|वक़्त|वक्त|टाइम))\s*(hi|ही)?\s*(yaad|याद|aate|aaye|dikhte|आते|आए|दिखते)|ab (yaad|याद) (aaye|aayi|aaya|aai)|अब याद (आए|आई|आया)|(5|paanch|पाँच|पांच) saal (kahan|kaha|kidhar) (the|thhe)|tab (kahan|kaha) the|तब कहाँ थे|पाँच साल कहाँ थे|koi (nahi|nhi) (aata|sunta|puchta|poochta|dekhta)|kisi ne (nahi|nhi) (suna|socha|poocha|dekha)|कोई (नहीं|नही) (आता|सुनता|पूछता)|kabhi (nahi|nhi) aate|कभी नहीं आते|sirf vote ke liye|सिर्फ़ वोट के लिए|सिर्फ वोट के लिए)/i,
    moneyAsk: /((kitn[aei]|कितन[ाेी])\s*(crore|karod|karor|lakh|paisa|paise|rupay[ae]?|rupe|kharch|kharcha|budget|fund|करोड़|लाख|पैसा|पैसे|रुपये|रुपए|खर्च|ख़र्च|बजट|फंड)|(crore|karod|lakh|paisa|paise|rupaye|budget|fund|करोड़|लाख|पैसा|बजट|फंड)\s*(kitn[aei]|कितन[ाेी])|kharch (kiye|kiya|hua|hue)|खर्च (किए|किया|हुआ|हुए)|budget kya|बजट क्या)/i,
    invite: /(aap (bhi )?aa(na|iye|iyega|ana|na zaroor)|zaroor aa(na|iyega|iye)|tum bhi aana|nyota|nyauta|nimantran|invite|card (dena|denge|bhejenge)|shaadi me aa|byah me aa|आप (भी )?आ(ना|इए|इएगा)|ज़रूर आ(ना|इएगा|इए)|जरूर आ(ना|इएगा|इए)|न्योता|न्यौता|निमंत्रण)/i,
    aboutSpecial: /((abhay|baba|un|in|aapke candidate|candidate|अभय|बाबा|उन|इन)[a-zऀ-ॿ ]{0,18}(me|mein|में)\s*(kya|क्या)\s*(khaas|khas|ख़ास|खास|achha|accha|अच्छा|special|baat)|(kya|क्या)\s*(khaas|khas|ख़ास|खास|special)\s*(hai|h|है)?[a-z\u0900-\u097F ]{0,12}(abhay|baba|unme|inme|candidate|अभय|बाबा|उनमें)|(kyu|kyon|kyun|kis liye|क्यों|किसलिए)\s*(de|dein|dena|dun|dein vote|chune|chunein|vote (de|dein|dun|karein))|(abhay singh|abhay|baba|अभय सिंह|अभय|बाबा)\s*(ji\s*|जी\s*)?(ko\s*|को\s*)?(hi\s*|ही\s*)?(kyu|kyon|kyun|क्यों)|kaise (aadmi|insaan|insan|vyakti) (hai|h|hain)|कैसे (आदमी|इंसान|व्यक्ति) (हैं|है)|kya khasiyat|क्या ख़ासियत|क्या खासियत)/i,
    dialectSwitch: /((haryanvi|hariyanvi|haryanavi|desi|हरियाणवी|देसी)\s*(me|mein|में)?\s*(bol|baat|likh|बोल|बात|लिख)|(rajasthani|marwari|marwadi|राजस्थानी|मारवाड़ी)\s*(me|mein|में)?\s*(bol|baat|likh|बोल|बात|लिख))/i,
    painHealth: /(ghutn[ae]|ghutno|kamar|jodo|jodon|joint|haddi|dard|पीठ|घुटन[ेा]|घुटनों|कमर|जोड़ों|जोड़|हड्डी|दर्द)/i,
    dlBusy: /((vote|chunav|baat|वोट|चुनाव|बात)[a-zऀ-ॿ ]{0,12}(baad me|baad mein|fir kabhi|phir kabhi|बाद में|फिर कभी)|abhi busy|busy hu|busy hoon|khet me hu|khet pe hu|kaam pe hu|baad me baat|baad me karte|abhi time nahi|abhi nahi baat|अभी व्यस्त|खेत में हूँ|बाद में बात|अभी समय नहीं)/i
};

// brain v7 (5 Nov live battery): everyday turns that fell to "अच्छा 🙏 कोई काम या सवाल हो…"
const V7 = {
    apology: /^(sorry|sory|soory|maaf|maafi|maaf karna|maaf kijiye|maaf karo|galti ho gayi|galti ho gai|गलती हो गई|माफ़|माफ|माफी|माफ़ी|सॉरी)\b|(gussa|गुस्सा)\s*(tha|thi|aa gaya|aa gya|था|थी|आ गया)|\bsorry\b/i,
    noPolitics: /((vote|chunav|chunaav|election|politics|siyasat|वोट|चुनाव|राजनीति)\s*(ki|ke|का|की|के)?\s*(baat|baatein|बात|बातें)\s*(mat|na|nahi|मत|ना|नहीं)\s*(karo|kro|kariye|करो|कीजिए)|(aaj|abhi|आज|अभी)\s*(vote|chunav|वोट|चुनाव)\s*(ki|की)?\s*(baat|बात)\s*(nahi|mat|नहीं|मत))/i,
    cynic: /(sab\s*(neta|leader|log)\s*(ek\s*(jaise|jese|hi)|same|aise hi)|neta\s*log\s*(sab|ek)|sab\s*ek\s*(jaise|jese)\s*(hote|hai|h)|jeet\s*(ke|kar|ne\s*ke\s*baad)\s*(koi|फिर)?\s*(nahi|nhi|na)\s*(aata|aate|dikhta|dikhte|puchta)|(vaade|vade|wade|waade|वादे)\s*(hi|ही)?\s*(karte|karo|kar|करते)|(sirf|bas|jhoothe|jhuthe|jhute|खाली|सिर्फ़|सिर्फ|झूठे)\s*(vaade|vade|wade|waade|वादे)|सब\s*नेता\s*एक\s*(जैसे|से)|जीत\s*(के|कर)\s*(कोई)?\s*नहीं\s*आता)/i,
    guarantee: /(gaarnti|gaaranti|garanti|guarantee|guaranty|garantee|गारंटी|likh\s*ke\s*do|likh\s*kar\s*do|लिख\s*के\s*दो|pakka\s*(karoge|hoga\s*na|karwaoge)|vada\s*karo|vaada\s*karo|वादा\s*करो)/i,
    mobility: /(chal\s*(nahi|nhi|na)\s*(paat[ai]|sakt[ai]|pata|pati)|kaise\s*(jaun|jaungi|jaunga|jaoon|aaun|aaungi|aaunga|pahunch)|vote\s*(dalne|daalne)\s*kaise\s*(jaun|jaungi|jaunga|aaun)|चल\s*नहीं\s*(पाती|पाता|सकती|सकता)|कैसे\s*(जाऊँगी|जाऊंगी|जाऊँगा|जाऊंगा|आऊँगी|आऊंगी|पहुँचूँ|पहुंचूं)|वोट\s*डालने\s*कैसे|wheelchair|व्हीलचेयर)/i,
    whatQ: /^(kya|kya\??|kya bola|kya kaha|kya matlab|matlab|samjha nahi|samjhi nahi|samajh nahi aaya|nahi samjha|क्या|क्या\?|क्या बोला|क्या मतलब|मतलब|समझा नहीं|समझी नहीं|समझ नहीं आया)\s*[?!.]*$/i,
    bareWhen: /^(kab|kab\s*(hai|h|he|tak)|kitne\s*baje(\s*tak)?|time\s*(kya|kitna)\s*(hai|h)?|कब|कब है|कब तक|कितने बजे(\s*तक)?)\s*[?!.]*$/i,
    more: /^(aur|or|और)\s*(kuch|kuchh|kya|kya\s*kya|batao|btao|bta|bataiye|bolo|kaam|कुछ|क्या|बताओ|बताइए|काम)?\s*(aur|or|और|bhi|भी)?\s*\??$/i
};
const NEG_COMMIT = /((pakk?a|vote|saath|sath|support|पक्का|वोट|साथ|समर्थन)[^.?!]{0,14}(nahi|nhi|nahin|मत|नहीं|नही)\b|(nahi|nhi|nahin|नहीं)\s*(pata|pakka|पता|पक्का))/i;
const THIRD_PARTY = /(dusr[eia]|doosr[eia]|virodhi|samne wal|saamne wal|dusri party|unk[eia] (saath|sath)|usk[eia] (saath|sath)|unko|unhe|usko|दूसर[ेीा]|विरोधी|सामने वाल|उनके साथ|उसके साथ|उनको|उन्हें|उसको)/i;
const THIRD_PARTY_PRAISE = /(\b(unka|unki|unke|uska|uski|uske|wo|woh|unhone)\b|उनका|उनकी|उनके|उसका|उसकी|वो|उन्होंने)/i;
const CONCERN_RX = /(भरता है|भरती है|भर रहा|भर जाता|जमा रहता|जमा हो जाता|bharta hai|bhar raha|jama rehta|bura haal|bura hal|buri haalat|haalat kharab|halat kharab|kharab haal|ghani dikkat|ghani pareshani|बुरा हाल|बुरी हालत|हालत ख़राब|हालत खराब|घणी दिक्कत|घणी परेशानी|problem|pareshani|samasya|samashya|shikayat|dikkat|dikat|takleef|kab lagegi|kab lagega|kab lagenge|कब लगेगी|कब लगेगा|nahi hai|nhi hai|nahi hua|nhi hua|nahi aata|nhi aata|nahi aati|nahi rehti|nahi rehta|nhi rehti|nahi rahti|nahi rahta|nahi chalti|nahi chalta|nahi milti|nahi milta|nhi milta|nahi mil rah|nahi mila|nhi mila|nahi aa rah|nhi aa rah|nahi aa ri|band ho gay|ruk gay|atak gay|atki|toot|tuta|tuti|tooti|ukhad|band (hai|h|pada)|kharab|kab hoga|kab banega|kab banegi|bhar jata|bharta|gandagi|gaddh|khadd|kichad|keechad|andhera|chakkar|pareshan|mehngi|mahangi|mehangi|band pad|jaam|\bjam\b|chok|chahiye|chaiye|समस्या|परेशानी|शिकायत|दिक्कत|तकलीफ|नहीं है|नहीं हुआ|नहीं आता|नहीं आती|नहीं रहती|नहीं रहता|नहीं चलती|नहीं मिल|नहीं आ रह|बंद हो गई|बंद हो गया|रुक गई|अटक|टूट|उखड़|खराब|ख़राब|बंद है|कब होगा|कब बनेगा|कब बनेगी|भर जाता|गड्ढ|खड्ड|कीचड़|अँधेरा|अंधेरा|चक्कर|परेशान|महंगी|महँगी|बंद पड़|जाम|चोक|चाहिए)/i;

function detectTopic(text) { return kb.primaryTopic(text, null); }

function opponentNames() {
    const p = campaignProfile.load();
    return (Array.isArray(p.opponentNames) ? p.opponentNames : []).map(s => String(s).trim()).filter(s => s.length >= 3);
}
function mentionsOpponent(t) {
    if (RX.opponentGeneric.test(t)) return true;
    const low = t.toLowerCase();
    return opponentNames().some(n => low.includes(n.toLowerCase()));
}

// a family update about a son/daughter's studies or job hunt (not a question about works): life talk, not a jobs pitch
const DL_FAMILY_EFFORT = /(beta|beti|bete|bachch?[ae]|ladka|ladki|bhai|बेटा|बेटी|बेटे|बच्च|लड़का|लड़की|भाई)[^?]{0,40}(naukri|job|kaam|padh|exam|taiyari|tayari|bharti|नौकरी|काम|पढ़|परीक्षा|तैयारी|भर्ती)[^?]{0,30}(dhoond|dhund|talash|kar raha|kar rahi|kar rahe|raha|rahi|rahe|ढूंढ|ढूँढ|तलाश|कर रहा|कर रही|रहा|रही)/i;
function dailyKind(t) {
    if (!/\?/.test(t) && DL_FAMILY_EFFORT.test(t) && !/(kya kiya|kya karenge|क्या किया|क्या करेंगे|kab|कब)/i.test(t)) return 'effort';
    if (RX.dlFestival.test(t)) return 'festival';
    if (RX.dlFamily.test(t)) return 'family';
    if (RX.dlHealth.test(t)) return 'health';
    if (RX.dlCrop.test(t)) return 'crop';
    if (RX.dlBusy.test(t)) return 'busy';
    if (RX.dlWeather.test(t)) return 'weather';
    return null;
}

const ASKED_VOTE = /(साथ देंगे ना\?|वोट देंगे ना\?|आशीर्वाद देंगे ना\?|पक्का रहा\?|देखेंगे ना\?|saath denge na\?|vote denge na\?|aashirwad denge na\?|pakka raha\?|dekhenge na\?)/i;
const ASKED_FAMILY_VOTES = /(कितने वोट|kitne vote)/i;
const ASKED_WELLBEING = /(कुशल-मंगल\?|राज़ी-ख़ुशी\?|सब ठीक\?|kushal-mangal\?|raazi-khushi\?|sab theek\?)/i;
const ASKED_DAILY = /(डॉक्टर को दिखा लिया\?|doctor ko dikha liya\?)/i;
const YES_SHORT = /^(ha+n?|haan ji|haa ji|ji+|ji haan|jee|yes|bilkul|zaroor|jaroor|jarur|pakka|kyon nahi|kyu nahi|हाँ|हां|जी|जी हाँ|जी हां|बिल्कुल|ज़रूर|जरूर|पक्का|क्यों नहीं)\b[\s\p{L}\p{M}!.,🙏👍]{0,30}$/iu;
const NO_SHORT = /^(nahi+|nhi|nahin|na\b|no\b|नहीं|ना\b)/i;
const WELL_SHORT = /^(sab (theek|thik|badhiya|achha|accha|kushal|mast|changa)|theek|thik|badhiya|mast|kushal|सब (ठीक|बढ़िया|कुशल|अच्छा)|ठीक|बढ़िया|कुशल|हाँ सब|haan sab|ha sab)/i;

/** A short answer to the question the bot just asked ("हाँ" to "साथ देंगे ना?", "4" to "कितने वोट हैं?"). */
function contextualIntent(t, user, topic) {
    if (!user || t.split(/\s+/).length > 8 || (topic && CONCERN_RX.test(t))) return null;
    const last = lastBotText(user);
    if (!last) return null;
    if (ASKED_FAMILY_VOTES.test(last)) {
        const n = (t.split(/\s+/).length <= 4 || /(vote|वोट|log|लोग|sadasy|सदस्य|member|jan|जन)/i.test(t)) ? (voterMemory.extractFamilyVotes(t) || (t.match(/^(\d{1,2})\b/) ? Number(t.match(/^(\d{1,2})\b/)[1]) : null) || flows.parseCount(t)) : null;
        if (n && n >= 1 && n <= 40) return { intent: 'family_votes', familyVotes: n };
    }
    if (ASKED_VOTE.test(last)) {
        if (YES_SHORT.test(t) && !NO_SHORT.test(t)) return { intent: 'commit', viaContext: true };
        if (NO_SHORT.test(t)) return { intent: 'undecided', viaContext: true };
    }
    if (ASKED_DAILY.test(last) && (YES_SHORT.test(t) || NO_SHORT.test(t) || /(theek|thik|dikha|ठीक|दिखा)/i.test(t))) return { intent: 'daily_followup', kind: 'health' };
    if (ASKED_WELLBEING.test(last) && (WELL_SHORT.test(t) || YES_SHORT.test(t)) && !RX.commitYes.test(t)) return { intent: 'wellbeing_reply' };
    return null;
}

function classify(text, user = {}) {
    const t = String(text || '').trim();
    const topic = detectTopic(t);
    const out = (intent, extra = {}) => ({ intent, topic, ...extra });
    if (!t) return out('unclear');
    if (opCtl.isPrivacyProbe(t)) return out('privacy_probe');
    // script preference: explicit switch any time, or a short answer to our one-time question
    if (SCRIPT_SWITCH_RX.test(t) && t.split(/\s+/).length <= 10) return out('script_pref', { script: /(hinglish|roman|english|abc)/i.test(t) && !/(hindi|हिंदी|हिन्दी|devanagari|देवनागरी)\s*(me|mein|में)/i.test(t) ? 'hinglish' : 'hindi' });
    // a bare "hinglish" / "hindi" / "हिंदी में" is a script choice whenever it comes
    if (/^(hinglish|हिंगलिश|roman|roman me|english me|hinglish (me|mein|mai)|in hinglish)\s*(please|plz|pls|ji|जी)?[\s!.🙏👍]*$/i.test(t)) return out('script_pref', { script: 'hinglish' });
    if (/^(hindi|हिंदी|हिन्दी|devanagari|देवनागरी|in hindi)(\s*(me|mein|mai|में))?\s*(please|plz|pls|ji|जी|ही)?[\s!.🙏👍]*$/i.test(t)) return out('script_pref', { script: 'hindi' });
    if (SCRIPT_ASK_RX.test(lastBotText(user)) && t.split(/\s+/).length <= 5) {
        if (/(hinglish|roman|english|abc)/i.test(t) || SCRIPT_ANS_HINGLISH.test(t)) return out('script_pref', { script: 'hinglish' });
        if (/(hindi|hindee|हिंदी|हिन्दी|devanagari|देवनागरी)/i.test(t) || SCRIPT_ANS_HINDI.test(t)) return out('script_pref', { script: 'hindi' });
    }
    // emoji-only replies (5 Nov): 👍/✅/🙏/❤️ after our vote ask = soft commit; otherwise a short human emoji reply by mood
    const emo = emojiSense.analyze(t);
    if (emo.emojiOnly) {
        if (['agree', 'pray', 'love'].includes(emo.kind) && ASKED_VOTE.test(lastBotText(user))) return out('commit', { viaContext: true, viaEmoji: true, emoji: emo.kind });
        return out('emoji', { emoji: emo.kind, emojis: emo.emojis });
    }
    const ci = !RX.bribe.test(t) && !RX.abuse.test(t) && !RX.condolence.test(t) ? contextualIntent(t, user, topic) : null;
    if (ci) return out(ci.intent, ci);
    // v7 everyday turns (live battery 5 Nov)
    if (V7.whatQ.test(t) && lastBotText(user)) return out('what_q');
    if (V7.bareWhen.test(t)) return out('polling', { short: true });
    // "kya le ke jana padega" / "kaun sa card chahiye vote ke liye": the ID line from the parcha
    if (/((kya|क्या)\s*(le\s*ke|leke|lekar|le\s*kar|लेकर|ले\s*के|ले\s*कर)\s*(jana|jaana|jaun|jaaun|aana|जाना|जाऊँ|जाऊं|आना)|(kaun\s*sa|konsa|kaunsa|कौन\s*सा|कौनसा)\s*(id|card|kagaz|kagaj|document|कार्ड|कागज़|कागज|पहचान)|(id|aadhar|aadhaar|आधार)\s*(chahiye|chaiye|चाहिए|zaroori|jaruri|ज़रूरी|जरूरी|lana|लाना))/i.test(t)) return out('polling', { idq: true });
    if (V7.apology.test(t) && !RX.abuse.test(t) && t.split(/\s+/).length <= 8 && !(topic && CONCERN_RX.test(t)) && !CONCERN_RX.test(t)) return out('apology');
    if (V7.noPolitics.test(t)) return out('no_politics');
    if (V7.mobility.test(t)) return out('mobility_help');
    if (V7.cynic.test(t) && !RX.abuse.test(t)) return out('grievance', { cynic: true });
    // "naraz hu" / "gussa hu" (often the first reply to a bulk message): ask what hurt, no pitch
    if (/^(main\s+|mai\s+|me\s+|hum\s+|ham\s+|मैं\s+|हम\s+)?(bahut\s+|bhot\s+|बहुत\s+)?(naraz|naraaz|naraj|gussa|gusse\s+me|khafa|dukhi|नाराज़|नाराज|गुस्सा|गुस्से में|ख़फ़ा|खफा|दुखी)\s*(hu|hoon|hun|h|hai|hain|हूँ|हूं|है|हैं)?\s*(aap\s*se|tum\s*se|आपसे|तुमसे|baba\s*se|बाबा\s*से)?\s*[.!🙏😠😡]*\s*$/i.test(t)) return out('grievance', { naraz: true });
    if (V7.guarantee.test(t)) return out('guarantee');
    // "fir kya karu" after a slip that was not found / did not match: what to do next (never a name search for "karu")
    if (/^(to\s+|ab\s+|fir\s+|phir\s+|तो\s+|अब\s+|फिर\s+)?(main\s+|mai\s+|मैं\s+)?(kya|क्या)\s*(karu|karun|karoon|kru|krun|करूँ|करूं|करू)\s*(ab|fir|phir|अब|फिर)?\s*[?.!]*$/i.test(t) && /(नहीं मिला|nahi mila|सूची में नहीं|EPIC)/i.test(recentBotText(user, 2))) return out('slip_help');
    if (/(stadium|स्टेडियम)/i.test(t) && !RX.abuse.test(t)) return out('works', { stadium: true });
    // "aurto ke liye kya kiya baba ne": the parcha has no women-only item — say so, then the two works that serve every home
    if (/(aurat|aurto|auraton|aurton|mahila|mahilao|mahilaon|women|ladies|behno|bahno|beti(yon|yo)|औरत|महिला|बहनों|बेटियों)[^?]{0,25}(ke liye|ke lie|के लिए|for)/i.test(t) && /(kya|क्या|what|kuch|कुछ)/i.test(t)) return out('women_works');
    if (MEDIA_RX.test(t)) return out('media', { media: t.replace(/[\[\]]/g, '').toLowerCase() });
    if (RX.abuse.test(t)) return out('abuse', { alsoTopic: topic && CONCERN_RX.test(t) });
    if (/(chor|jhoot|jhooth|bekar|चोर|झूठ|बेकार)\s*(nahi|nhi|nahin|नहीं)/i.test(t) && (RX.positive.test(t) || /(achha|accha|imandar|सच्चे|अच्छे)/i.test(t))) return out('positive');
    if (RX.corruption.test(t)) return out('corruption');
    if (/^[\s\p{Extended_Pictographic}\p{Emoji_Modifier}\u200d\ufe0f❤♥]+$/u.test(t) && !/^[\s🙏👍😂🤣]+$/u.test(t)) return out('emoji_only');
    if (RX.bribeOthers.test(t)) return out('bribe_others');
    if (RX.bribe.test(t)) return out('bribe');
    if (RX.wrongNumber.test(t)) return out('wrong_number');
    if (RX.condolence.test(t)) return out('condolence');
    if (RX.opposed.test(t) || RX.opposeSupport.test(t)) return out('opposed');
    if (RX.grievance.test(t)) return out('grievance');
    if (RX.moneyAsk.test(t) && !RX.bribe.test(t)) return out('money_ask');
    if (RX.dialectSwitch.test(t)) return out('dialect_switch', { dialect: /(rajasthani|marwari|marwadi|राजस्थानी|मारवाड़ी)/i.test(t) ? 'rajasthani' : 'haryanvi' });
    if (RX.wasSarpanch.test(t)) return out('was_sarpanch');
    // "kab banegi / kya hoga iska" about a concern they already told us: no date promised, it is in the register
    if (/((क्या|के|kya|ke)\s*(करैगा|करेगा|करेंगे|karega|karenge|karaiga|kar sakte)\s*(इसका|इसमें|iska|isme|is\s*ka)|(kab\s*(tak|talak)?\s*([a-z\u0900-\u097F]+\s+){0,2}(banegi|banega|bane gi|hogi|hoga|lagegi|lagega|sudhregi|sudhrega|khulegi|aayega|aayegi|aaega|aaegi|milega|milegi|बनेगी|बनेगा|होगी|होगा|लगेगी|लगेगा|आएगा|आएगी|मिलेगा|मिलेगी)|kab (tak )?(banegi|banega|bane gi|hogi|hoga|lagegi|lagega|thik hogi|theek hogi|sudhregi|khulegi)|kya hoga (iska|uska|is ka)|कब (तक )?(बनेगी|बनेगा|होगी|होगा|लगेगी|ठीक होगी)|क्या होगा (इसका|उसका)))/i.test(t) && user && user.memory && (user.memory.concerns || []).length && !kb.detectTopics(t).some(x => !(user.memory.concerns || []).some(c => c.topic === x))) return out('concern_when');
    if (RX.commitYes.test(t) && !/\?|kya\b|क्या/.test(t.slice(-8)) && !NEG_COMMIT.test(t) && !THIRD_PARTY.test(t)) return out('commit', { family: RX.family.test(t), familyVotes: voterMemory.extractFamilyVotes(t) });
    if (mentionsOpponent(t)) return out('opponent', { taunt: RX.taunt.test(t) });
    if (stageOf(user) === 'opposed' && THIRD_PARTY_PRAISE.test(t) && !RX.taunt.test(t)) return out('opponent', { praise: true });
    if (RX.aboutSpecial.test(t)) return out('about_baba', { special: true });
    if (RX.worksAll.test(t) && !(topic && CONCERN_RX.test(t))) return out('works', { all: !kb.detectTopics(t).length || /(saare|sare|saara|sara|sab|sabhi|all|सारे|सारा|सब|सभी)/i.test(t) });
    if (RX.offTopic.test(t) && !/(abhay|baba|अभय|बाबा|sihali|सिहाली|panchayat|पंचायत)/i.test(t)) return out('off_topic', { party: /(modi|rahul|bjp|congress|bhajpa|मोदी|राहुल|भाजपा|कांग्रेस)/i.test(t), news: /(news|khabar|ख़बर|खबर)/i.test(t), person: /(elon|musk|zuckerberg|zukerberg|trump|putin|biden|bill gates|ambani|adani|salman|shahrukh|virat|dhoni|kon h|kaun h|kon hai|kaun hai)/i.test(t) });
    if (/^[a-z ]{2,40}\s+(kon|kaun)\s*(h|hai|he|hain)?\s*\??$/i.test(t) && !/(abhay|baba|moti|aangli|angli|wale|wala|tum|aap|ap|tu|ye|yeh|wo|woh|candidate|pratyashi|sarpanch|neta|mukhiya|mai|main|hum|ham|mera|meri|tera|teri|sihali|hadahedi|haraheri)\b/i.test(t.replace(/\s+(kon|kaun)\b.*$/i, ''))) return out('off_topic', { person: true });
    if (RX.invite.test(t) || (/(aana|aaiye|aaiyega|आना|आइए|आइएगा)/i.test(t) && /(badhai|बधाई|shubhkamna|शुभकामना)/i.test(lastBotText(user)))) return out('invite');
    if (RX.painHealth.test(t) && (/(hospital|aspatal|doctor|daktar|ilaaj|ilaj|dawai|अस्पताल|डॉक्टर|डाक्टर|इलाज|दवाई)/i.test(t) || /(karta|karti|rehta|rehti|hota|hoti|ho raha|करता|करती|रहता|रहती|होता|होती)/i.test(t))) return out('health_concern', { doctor: /(hospital|aspatal|doctor|daktar|ilaaj|ilaj|अस्पताल|डॉक्टर|डाक्टर|इलाज)/i.test(t) });
    if (RX.taunt.test(t) || (RX.insult.test(t) && !/\?/.test(t) && !topic)) return out('taunt', { insult: RX.insult.test(t) && !/(kya kiya|क्या किया|kuch nahi kiya|kuch nhi kiya)/i.test(t) });
    if (RX.whoAreYou.test(t)) return out('who_are_you');
    if (RX.memoryCheck.test(t)) return out('memory_check');
    if (RX.callReq.test(t)) return out('meeting', { call: true });
    if (RX.meeting.test(t) || RX.visitWhen.test(t)) return out('meeting', { call: false });
    if (!/(parchi|parchee|slip|epic|voter id|list|पर्ची|सूची|लिस्ट)/i.test(t) && voterMemory.extractName(t) && !/\?/.test(t) && !(topic && CONCERN_RX.test(t))) return out('introduce', { name: voterMemory.extractName(t) });
    if (!/\?/.test(t) && !CONCERN_RX.test(t) && !/(chahiye|chaiye|चाहिए)/i.test(t) && /(\b(hu|hoon|hun)\b|हूँ|हूं)/i.test(t) && /(kisan|kheti|student|padhai|fauj|army|police|teacher|master|driver|dukan|naukri karta|job karta|se hu|se hoon|se bol|bol raha|bol rahi|umar|umr|saal ka|saal ki|से हूँ|से हूं|से बोल|बोल रहा|बोल रही|उम्र|साल का|साल की|किसान|छात्र|फौज)/i.test(t) && !RX.commitYes.test(t)) return out('introduce', { name: voterMemory.extractName(t) });
    if (!/\?/.test(t) && kb.detectVillages(t).length && /(mharo|mhara|mhari|mera|meri|hamara|hamari|apna|म्हारो|म्हारा|मेरा|मेरी|हमारा|हमारी|अपना)\s*(gaon|gaam|gam|ganv|गाँव|गांव|गाम)/i.test(t) && !(topic && CONCERN_RX.test(t))) return out('introduce', { name: null });
    if (RX.slip.test(t)) return out('voter_slip');
    if (RX.ballot.test(t)) return out('ballot', { symbolAsked: /(chinh|chinha|nishan|nishaan|symbol|nishani|चिन्ह|चिह्न|निशान)/i.test(t) });
    if (RX.polling.test(t)) return out('polling');
    if (RX.samasyaExplicit.test(t) && !topic) return out('samasya_explicit');
    if (topic && ['youth', 'education'].includes(topic) && /(chahiye|chaiye|चाहिए)/i.test(t) && !/(problem|dikkat|samasya|toot|kharab|band|nahi|नहीं|दिक्कत|समस्या|टूट|ख़राब|खराब|बंद)/i.test(t)) return out('works', { wish: true });
    if (topic && CONCERN_RX.test(t)) return out('complaint');
    const dk = dailyKind(t);
    if (dk && !(topic && CONCERN_RX.test(t))) return out('daily_life', { kind: dk });
    if (RX.positive.test(t) && !/\?/.test(t)) return out('positive');
    if (topic && ['jobs', 'pension', 'ration', 'bijli', 'housing'].includes(topic)) return out('works');
    if (/^(aur|or|और)\s*(kya|kya kya|batao|bataiye|kaam|क्या|बताओ|बताइए|काम)\s*\??$/i.test(t) || (V7.more.test(t) && t.trim().length > 2)) return out('works', { more: true });
    if (RX.future.test(t)) return out('future');
    if (RX.works.test(t) || (topic && /\?|kya|kaun|kahan|kidhar|batao|bataiye|bataao|baare|bare me|क्या|कौन|कहाँ|कहां|बताओ|बताइए|बारे/.test(t))) return out('works');
    if (RX.aboutBaba.test(t) && (!topic || /(abhay|baba|moti aangli|candidate|pratyashi|unke baare|aapke baare|अभय|बाबा|मोटी आंगली|प्रत्याशी)/i.test(t))) return out('about_baba');
    if (RX.undecided.test(t) || NEG_COMMIT.test(t)) return out('undecided');
    if (RX.samasyaExplicit.test(t)) return out('samasya_explicit');
    if (topic) return out('topic_mention');
    if (RX.joke.test(t)) return out('joke');
    if (RX.offTopic.test(t)) return out('off_topic', { party: /(modi|rahul|bjp|congress|bhajpa|मोदी|राहुल|भाजपा|कांग्रेस)/i.test(t) });
    if (voterMemory.extractFamilyVotes(t)) return out('family_votes', { familyVotes: voterMemory.extractFamilyVotes(t) });
    if (RX.positive.test(t)) return out('positive');
    if (RX.thanks.test(t)) return out('thanks');
    if (RX.greet.test(t) || RX.howAreYou.test(t)) return out('greeting', { howAreYou: RX.howAreYou.test(t) });
    const ward = t.match(/(?:ward|वार्ड|w)\s*[:#-]?\s*(\d{1,2})\b/i) || (/^\d{1,2}$/.test(t) ? [null, t] : null);
    if (ward) return out('gave_ward', { ward: Number(ward[1]) });
    const toks = t.toLowerCase().split(/\s+/).filter(Boolean);
    if (toks.length >= 2 && toks.every(w => /^[a-z]+$/.test(w)) && toks.filter(w => w.length >= 3 && (!/[aeiouy]/.test(w) || /(asdf|qwer|zxcv|sdfg|hjkl|wert|xcvb|uiop)/.test(w))).length >= Math.ceil(toks.length / 2)) return out('unclear', { gibberish: true });
    if (t.length <= 25 && !/\?/.test(t)) return out('short_reply');
    return out('unclear');
}

// ---------------- facts ----------------
function factsText() { return (campaignProfile.load().verifiedFacts || []).join('\n'); }
function boothForWard(ward) { return kb.boothForWard(ward); }
const PF = () => kb.facts();
const AUDIENCE_TOPICS = { F: ['water', 'health', 'safety', 'education'], M: ['road', 'water', 'youth', 'farming'], none: ['water', 'health', 'youth'] };

// ---------------- persuasion ----------------
function stageOf(user) { return (user && STAGES.includes(user.persuasionStage)) ? user.persuasionStage : 'unknown'; }

function nextStage(current, intent) {
    if (intent === 'commit') return 'committed';
    if (intent === 'opposed') return 'opposed';
    if (intent === 'family_votes') return current === 'opposed' ? current : 'committed';
    if (intent === 'undecided') return current === 'committed' ? 'committed' : 'undecided';
    if (intent === 'positive') return ['committed'].includes(current) ? current : 'leaning';
    if (current === 'unknown' && ['introduce', 'works', 'future', 'about_baba', 'complaint', 'polling', 'ballot', 'meeting', 'voter_slip', 'taunt', 'opponent', 'was_sarpanch', 'memory_check', 'samasya_explicit', 'topic_mention', 'grievance', 'money_ask', 'bribe_others', 'health_concern', 'corruption'].includes(intent)) return 'undecided';
    return current;
}

const CLOSERS = {
    unknown: { hi: ['16 नवंबर को अभय सिंह जी का साथ देंगे ना?', 'इस बार अभय सिंह जी को आशीर्वाद देंगे ना?', 'सोमवार 16 नवंबर को अपना वोट अभय सिंह जी को देंगे ना?'],
        en: ['16 November ko Abhay Singh ji ka saath denge na?', 'Is baar Abhay Singh ji ko aashirwad denge na?', 'Somvar 16 November ko apna vote Abhay Singh ji ko denge na?'] },
    undecided: { hi: ['बस इतना सोचिएगा—40 साल से गाँव के सुख-दुख में कौन साथ खड़ा रहा। 16 नवंबर को अभय सिंह जी का साथ देंगे ना?', 'सबसे ज़्यादा विकास कामों के लिए पंचायत को समिति स्तर पर सम्मान मिला है—इसी भरोसे पर अभय सिंह जी का साथ देंगे ना?', 'जो काम करके दिखाए, उसी पर भरोसा बनता है। इस बार अभय सिंह जी का साथ देंगे ना?'],
        en: ['Bas itna sochiyega—40 saal se gaon ke sukh-dukh me kaun saath khada raha. 16 Nov ko Abhay Singh ji ka saath denge na?', 'Sabse zyada vikas kaamon ke liye panchayat ko samiti star par samman mila hai—isi bharose par Abhay Singh ji ka saath denge na?', 'Jo kaam karke dikhaye, usi par bharosa banta hai. Is baar Abhay Singh ji ka saath denge na?'] },
    leaning: { hi: ['तो पक्का रहा? 16 नवंबर को अभय सिंह जी को वोट देंगे ना?', 'आपकी बात से हौसला मिला। पक्का वोट देंगे ना, और घर वालों को भी साथ लाएँगे?'],
        en: ['To pakka raha? 16 Nov ko Abhay Singh ji ko vote denge na?', 'Aapki baat se hausla mila. Pakka vote denge na, aur ghar walon ko bhi saath laayenge?'] },
    committed: { hi: ['घर के बाकी वोटरों को भी साथ लेकर आइएगा—सुबह 7:30 से शाम 5:30, राजकीय उच्च माध्यमिक विद्यालय, सिहाली खुर्द।', 'अपने परिवार और पड़ोस में भी अभय सिंह जी की बात पहुँचाइएगा, यही असली साथ है।', 'थारी उंगली से... मोटी आंगली वाले के नाम के आगे मुहर लगाइए! 🙏'],
        en: ['Ghar ke baaki voters ko bhi saath laaiyega—subah 7:30 se shaam 5:30, Govt. Sr. Sec. School, Sihali Khurd.', 'Apne parivar aur padosiyon tak bhi Abhay Singh ji ki baat pahunchaiyega, yahi asli saath hai.', 'Thari ungli se... Moti Aangli wale ke naam ke aage mohar lagaiye! 🙏'] },
    opposed: { hi: ['आपकी राय का सम्मान है। फिर भी कोई बात मन में हो तो बताइए, अभय सिंह जी तक सीधे पहुँचाऊँगी।'],
        en: ['Aapki raay ka samman hai. Phir bhi koi baat man me ho to bataiye, Abhay Singh ji tak seedhe pahunchaungi.'] }
};

function recentBotText(user, n = 4) {
    return (user && Array.isArray(user.history) ? user.history.filter(h => h.role === 'bot').slice(-n).map(h => h.text || '') : []).join(' \n ');
}
function lastBotText(user) {
    const h = (user && Array.isArray(user.history) ? user.history : []).filter(x => x.role === 'bot');
    return h.length ? String(h[h.length - 1].text || '') : '';
}

/** A closer tied to the voter's own concern, or a stage closer; never one used in the last 5 bot messages. */
function pickCloser(stage, l, user, concern = null) {
    const recent = recentBotText(user, 5).toLowerCase();
    const opts = [];
    // "आपकी X वाली बात … पहुँच गई है" only for a concern that was really logged and is about what they said (live: gym -> "आवास-मकान")
    const mm0 = (user && user.memory) || {};
    if (concern && !(concern.samasyaId || (mm0.samasyaIds || []).length)) concern = null;
    if (concern && ['unknown', 'undecided', 'leaning'].includes(stage)) {
        const label = kb.topicLabel(concern.topic, l);
        opts.push(l === 'hi'
            ? `आपकी ${label} वाली बात अभय सिंह जी तक पहुँच गई है—16 नवंबर को उनका साथ देंगे ना?`
            : `Aapki ${label} wali baat Abhay Singh ji tak pahunch gayi hai—16 Nov ko unka saath denge na?`);
    }
    opts.push(...((CLOSERS[stage] || CLOSERS.unknown)[l] || []));
    if (stage === 'opposed') return null; // an opposed voter gets respect, not a closer after every answer
    // vote-ask frequency follows the operator's mode / setting (normal: at most every other bot message)
    const gap = opCtl.voteAskGap(user);
    if (gap === Infinity) return null;
    // chill: relationship first — no vote ask in the first few exchanges at all
    if (opCtl.effectiveMode(user) === 'chill' && (user.history || []).filter(h => h.role === 'user').length < 5 && stage !== 'committed') return null;
    const askedRecently = gap > 0 && VOTE_ASK_ANY.test(recentBotText(user, gap));
    if (askedRecently && stage !== 'committed') return null;
    if (gap === 0 && opts.length && stage !== 'committed' && VOTE_ASK_RX.test(recentBotText(user, 1)) && AGGR_EXTRA[l]) opts.unshift(...AGGR_EXTRA[l]); // persistent mode: vary the ask
    const steer = opCtl.steerCloser(user, l);
    if (/(darj kar li|note kar liya|दर्ज कर ली|नोट कर लिया|bulawe ke liye|बुलावे के लिए)/i.test(recentBotText(user, 2))) return null;
    const mm = user && user.memory;
    if (mm && mm.grievanceOpenAt && Date.now() - Date.parse(mm.grievanceOpenAt) < 45 * 60e3) return null; // no vote ask right after anger
    if (mm && (mm.wrongNumberAt || (mm.condolenceAt && Date.now() - Date.parse(mm.condolenceAt) < 3 * 86400e3))) return null;
    if (steer && !recent.includes(steer.slice(0, 25).toLowerCase())) { opCtl.markSteer(user); markLine(user, steer); return steer; }
    const log = usedLines(user);
    const ok = opts.filter(o => !recent.includes(o.slice(0, 25).toLowerCase()));
    const pick = ok.find(o => !log.includes(lineKey(o))) || ok.slice().sort((a, b) => log.indexOf(lineKey(a)) - log.indexOf(lineKey(b)))[0] || null;
    if (pick) markLine(user, pick);
    return pick;
}

// any vote ask, template or model-written ("…समर्थन देंगे ना?", "वोट देकर साथ देंगे?") — used for the vote-ask frequency
const VOTE_ASK_ANY = /((साथ|वोट|समर्थन|आशीर्वाद|सपोर्ट|support|saath|sath|vote|samarthan|aashirwad|ashirwad)[^।?.!\n]{0,40}(देंगे|देंगी|दोगे|डालेंगे|डालेंगी|denge|dengi|doge|dalenge|dalengi)\s*(ना|न|na|naa)?\s*\?|वादा रहा\?|पक्का रहा\?|vaada raha\?|pakka raha\?|देखेंगे ना\?|dekhenge na\?)/i;
/** Drop vote-ask sentences when the operator's vote-ask frequency says it is too soon (or never, in gentle mode). */
function capVoteAsk(text, user, stage) {
    if (!text || !user || !VOTE_ASK_ANY.test(text)) return text;
    const gap = opCtl.voteAskGap(user);
    const tooSoon = gap === Infinity || (gap > 0 && VOTE_ASK_ANY.test(recentBotText(user, gap)));
    if (!tooSoon) return text;
    const parts = String(text).split(/(?<=[।?!.])\s+/);
    const kept = parts.filter(p => !VOTE_ASK_ANY.test(p));
    const out = kept.join(' ').trim();
    return out.length >= 12 ? out : text;
}
const VOTE_ASK_RX = /(साथ देंगे ना\?|वोट देंगे ना\?|आशीर्वाद देंगे ना\?|देखेंगे ना\?|वादा रहा\?|पक्का रहा\?|saath denge na\?|vote denge na\?|aashirwad denge na\?|dekhenge na\?|vaada raha\?|pakka raha\?)/i;
const AGGR_EXTRA = {
    hi: ['तो 16 नवंबर का वादा रहा? सुबह 7:30 से शाम 5:30 तक, एक वोट अभय सिंह जी को।', 'मन में कोई बात अटकी हो तो बताइए, वरना 16 नवंबर को अभय सिंह जी का साथ पक्का रहा?'],
    en: ['To 16 Nov ka vaada raha? Subah 7:30 se shaam 5:30 tak, ek vote Abhay Singh ji ko.', 'Man me koi baat atki ho to bataiye, warna 16 Nov ko Abhay Singh ji ka saath pakka raha?']
};
const HESITATE_RX = /(soch(enge|unga|ungi|te hain|na padega)|dekh(enge|te hain|unga)|abhi (decide|tay) nahi|pata nahi|सोच(ेंगे|ूँगा|ूंगा|ते हैं)|देख(ेंगे|ते हैं)|अभी तय नहीं|पता नहीं)/i;
// Lines used for this voter across days (keys = first 22 chars), so the same pitch/opener is not reused tomorrow either.
const lineKey = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 22);
function usedLines(user) { const m = user && user.memory; if (!m) return []; if (!Array.isArray(m.lineLog)) m.lineLog = []; return m.lineLog; }
function markLine(user, s) { if (!user || !user.memory) return; const log = usedLines(user); const k = lineKey(s); const i = log.indexOf(k); if (i >= 0) log.splice(i, 1); log.push(k); while (log.length > 60) log.shift(); }
function vary(user, variants) {
    const recent = recentBotText(user, 4).toLowerCase();
    const log = usedLines(user);
    const notRecent = variants.filter(v => !recent.includes(v.slice(0, 22).toLowerCase()));
    // never-used first, then the least recently used among those not in the last few replies
    const pick = notRecent.find(v => !log.includes(lineKey(v))) || notRecent.slice().sort((a, b) => log.indexOf(lineKey(a)) - log.indexOf(lineKey(b)))[0] ||
        variants[(((user && user.memory && user.memory.recall && user.memory.recall.turn) || 0)) % variants.length];
    markLine(user, pick);
    return pick;
}

/** Recall a remembered concern — but not right after we just confirmed/registered it (no reciting). */
function recall(user, l, opts = {}) {
    if (!opts.force && /(darj|दर्ज|note kar liya|नोट कर लिया)/i.test(recentBotText(user, 3))) return null;
    return voterMemory.recallPhrase(user, l, opts);
}

// ---------------- retrieval glue ----------------
function retrieveFor(message, cls, user, opts = {}) {
    const m = voterMemory.ensure(user);
    const hints = [cls.topic, ...(opts.topics || []), m.lastTopic, ...m.concerns.map(c => c.topic)].filter(Boolean);
    return kb.retrieve(message, { k: 5, exclude: m.toldItems, topics: hints, villages: m.village ? [m.village] : [], type: opts.type || null });
}

function factLines(items, l, user, max = 1) {
    const m = voterMemory.ensure(user);
    const toldLines = new Set(m.toldItems.map(id => kb.getItem(id)).filter(Boolean).map(i => kb.render(i, l)));
    const fresh = items.filter(i => i.landmark || (!m.toldItems.includes(i.id) && !toldLines.has(kb.render(i, l))));
    if (!fresh.length) return { text: '', used: [], fresh: false };
    const { lines, used } = kb.renderList(fresh, l, max);
    return { text: lines.join(' '), used, fresh: true };
}

function topicItems(topic, l, user, type = null) {
    const m = voterMemory.ensure(user);
    return kb.byTopic(topic, { type, exclude: m.toldItems, villages: m.village ? [m.village] : [] });
}

// ---------------- negative sentiment: varied, calm, never the same opener twice ----------------
const NEG_POOL = {
    abuse: [
        ['आपकी नाराज़गी सिर आँखों पर{H} 🙏 आपका काम पूरा हो, यही हमारी कोशिश है—बताइए क्या दिक्कत है, मैं आपकी बात सबसे पहले अभय सिंह जी तक पहुँचाती हूँ।', 'Aapki naraazgi sir aankhon par{H} 🙏 Aapka kaam poora ho, yahi hamari koshish hai—bataiye kya dikkat hai, main aapki baat sabse pehle Abhay Singh ji tak pahunchati hoon.'],
        ['आपकी नाराज़गी समझ सकती हूँ{H}। कोई दिक्कत है तो खुलकर बताइए—मैं सीधे अभय सिंह जी तक पहुँचाऊँगी 🙏', 'Aapki naraazgi samajh sakti hoon{H}. Koi dikkat hai to khulkar bataiye—main seedhe Abhay Singh ji tak pahunchaungi 🙏'],
        ['गुस्से में कही बात का बुरा नहीं मानती{H} 🙏 आराम से बताइए, किस बात से मन दुखा है?', 'Gusse me kahi baat ka bura nahi maanti{H} 🙏 Aaram se bataiye, kis baat se man dukha hai?'],
        ['मैं आपकी बात का सम्मान करती हूँ{H}, भले आप नाराज़ हों 🙏 गाँव का कोई काम अटका हो तो बताइए, नोट कर लूँगी।', 'Main aapki baat ka samman karti hoon{H}, bhale aap naraaz hon 🙏 Gaon ka koi kaam atka ho to bataiye, note kar lungi.'],
        ['ठीक है{H}, आपकी भावना टीम तक पहुँचा दूँगी 🙏 जब मन करे, अपनी असली परेशानी बताइएगा—सुनने के लिए यहीं हूँ।', 'Theek hai{H}, aapki bhavna team tak pahuncha dungi 🙏 Jab man kare, apni asli pareshani bataiyega—sunne ke liye yahin hoon.']
    ],
    insult: [
        ['आपकी भावना की पूरी कद्र करती हूँ{H} 🙏 मैं बहस नहीं करूँगी—बस इतना बताइए कि किस बात से मन दुखा है, सबसे पहले अभय सिंह जी तक पहुँचाऊँगी।', 'Aapki bhavna ki poori kadr karti hoon{H} 🙏 Main behes nahi karungi—bas itna bataiye ki kis baat se man dukha hai, sabse pehle Abhay Singh ji tak pahunchaungi.'],
        ['हर किसी की अपनी राय होती है{H}, आपकी राय का भी सम्मान है 🙏', 'Har kisi ki apni raay hoti hai{H}, aapki raay ka bhi samman hai 🙏'],
        ['आपकी नाराज़गी सिर-आँखों पर{H}—शायद कहीं कोई काम अटका है जिसने मन दुखाया।', 'Aapki naraazgi sir-aankhon par{H}—shayad kahin koi kaam atka hai jisne man dukhaya.'],
        ['आप जैसा महसूस कर रहे हैं, वो मैं टीम तक ज़रूर पहुँचाऊँगी{H} 🙏', 'Aap jaisa mehsoos kar rahe hain, wo main team tak zaroor pahunchaungi{H} 🙏'],
        ['मैं बहस नहीं करूँगी{H}—आपकी बात सुनना मेरा काम है 🙏', 'Main behes nahi karungi{H}—aapki baat sunna mera kaam hai 🙏']
    ],
    taunt: [
        ['आपकी शिकायत सिर आँखों पर{H} 🙏 जहाँ काम अधूरा लगा, वहाँ शिकायत बनती है।', 'Aapki shikayat sir aankhon par{H} 🙏 Jahan kaam adhoora laga, wahan shikayat banti hai.'],
        ['सवाल पूछना आपका हक़ है{H}।', 'Sawal poochna aapka haq hai{H}.'],
        ['आपकी नाराज़गी समझती हूँ{H}—जहाँ काम अटका हो वहाँ गुस्सा आना स्वाभाविक है।', 'Aapki naraazgi samajhti hoon{H}—jahan kaam atka ho wahan gussa aana swabhavik hai.'],
        ['आपने खुलकर कहा, अच्छा लगा{H} 🙏', 'Aapne khulkar kaha, achha laga{H} 🙏'],
        ['बात सीधी है{H}—काम ज़मीन पर दिखता है, आप खुद देख सकते हैं।', 'Baat seedhi hai{H}—kaam zameen par dikhta hai, aap khud dekh sakte hain.']
    ],
    corruption: [
        ['आपकी बात सिर आँखों पर{H} 🙏 अभय सिंह जी 40 साल से निष्कलंक सेवा में हैं, और पंचायत के काम ज़मीन पर दिखते हैं—', 'Aapki baat sir aankhon par{H} 🙏 Abhay Singh ji 40 saal se nishkalank seva me hain, aur panchayat ke kaam zameen par dikhte hain—'],
        ['आपकी चिंता समझती हूँ{H} 🙏 अभय सिंह जी 40 साल की निष्कलंक समाज सेवा के लिए जाने जाते हैं, और पंचायत में हुए काम ज़मीन पर दिखते हैं—', 'Aapki chinta samajhti hoon{H} 🙏 Abhay Singh ji 40 saal ki nishkalank samaj seva ke liye jaane jaate hain, aur panchayat me hue kaam zameen par dikhte hain—'],
        ['ऐसी बात सुनकर मन दुखता है{H}, पर आपकी बात का सम्मान है 🙏 गाँव ने 40 साल से अभय सिंह जी की सेवा देखी है, और काम सामने हैं—', 'Aisi baat sunkar man dukhta hai{H}, par aapki baat ka samman hai 🙏 Gaon ne 40 saal se Abhay Singh ji ki seva dekhi hai, aur kaam saamne hain—'],
        ['आपका सवाल जायज़ है{H}—भरोसा काम से बनता है 🙏 पंचायत में हुए काम आप खुद देख सकते हैं—', 'Aapka sawal jaayaz hai{H}—bharosa kaam se banta hai 🙏 Panchayat me hue kaam aap khud dekh sakte hain—']
    ]
};
function negLine(user, l, H, kind) {
    const recent = recentBotText(user, 8).toLowerCase();
    const pool = NEG_POOL[kind] || NEG_POOL.insult;
    const all = Object.values(NEG_POOL).flat();
    const txt = p => (l === 'hi' ? p[0] : p[1]).replace('{H}', H);
    const log = usedLines(user);
    const fresh = pool.filter(p => !recent.includes(txt(p).slice(0, 18).toLowerCase()));
    const pick = fresh.find(p => !log.includes(lineKey(txt(p)))) || fresh.slice().sort((a, b) => log.indexOf(lineKey(txt(a))) - log.indexOf(lineKey(txt(b))))[0] ||
        all.find(p => !recent.includes(txt(p).slice(0, 18).toLowerCase())) || pool[0];
    markLine(user, txt(pick));
    return txt(pick);
}

// ---------------- compose (grounded template) ----------------
function compose(cls, ctx) {
    const { l, hon, user, person, stage, message, items } = ctx;
    const hi = l === 'hi';
    const S = (h, e) => (hi ? h : e);
    const mem = voterMemory.ensure(user);
    const name = nameFor(user, l);
    const greetName = name ? `${name} ${hon}` : hon;
    const jiOnly = isJi(hon);
    const H = jiOnly ? '' : ' ' + hon; // " ताऊ जी" or ""
    let body = '', ask = true, needsAdmin = false, used = [];
    const anyConcern = mem.concerns.length ? mem.concerns[mem.concerns.length - 1] : null;
    const concernNow = mem.concerns.slice().reverse().find(c => c.topic === cls.topic) || null;
    const addFacts = (list, max = 1) => { const f = factLines(list, l, user, max); used.push(...f.used); return f.text; };
    const C = PF().candidate || {};
    const P = PF().poll || {};

    switch (cls.intent) {
        case 'media': {
            const k = cls.media || '';
            if (/voice|audio/.test(k)) body = vary(user, [S(`आपका वॉइस मैसेज मिला${H} 🙏 मैं अभी वॉइस नहीं सुन पाती—दो लाइन लिखकर बता देंगे?`, `Aapka voice message mila${H} 🙏 Main abhi voice nahi sun paati—do line likhkar bata denge?`), S(`वॉइस मिल गई${H}, धन्यवाद 🙏 लिखकर भेज देंगे तो मैं तुरंत नोट कर लूँगी।`, `Voice mil gayi${H}, dhanyavad 🙏 Likhkar bhej denge to main turant note kar lungi.`)]);
            else if (/sticker|gif/.test(k)) body = vary(user, [S('😊🙏', '😊🙏'), S(`🙏 राम राम${H}!`, `🙏 Ram Ram${H}!`)]);
            else if (/photo|फोटो/.test(k) && (mem.photoOpenAt = new Date().toISOString())) body = S(`फोटो मिल गई${H} 🙏 ये किस जगह की है और क्या दिक्कत है—दो शब्द लिख देंगे?`, `Photo mil gayi${H} 🙏 Ye kis jagah ki hai aur kya dikkat hai—do shabd likh denge?`);
            else if (/video|वीडियो/.test(k)) body = S(`वीडियो मिल गया${H}, धन्यवाद 🙏 इसके बारे में कुछ बताना हो तो लिख दीजिए।`, `Video mil gaya${H}, dhanyavad 🙏 Iske baare me kuch batana ho to likh dijiye.`);
            else if (/location|लोकेशन/.test(k)) body = S(`लोकेशन मिल गई${H}, धन्यवाद 🙏 यहाँ की कोई बात हो तो लिखकर बता दीजिए।`, `Location mil gayi${H}, dhanyavad 🙏 Yahan ki koi baat ho to likhkar bata dijiye.`);
            else if (/contact/.test(k)) body = S(`संपर्क मिल गया${H} 🙏 इनके बारे में कुछ बताना हो तो लिख दीजिए।`, `Contact mil gaya${H} 🙏 Inke baare me kuch batana ho to likh dijiye.`);
            else body = S(`आपका संदेश मिला${H} 🙏 लिखकर बताएँगे तो मैं ठीक से मदद कर पाऊँगी।`, `Aapka sandesh mila${H} 🙏 Likhkar batayenge to main theek se madad kar paungi.`);
            return { text: body, ask: false, used };
        }
        case 'abuse':
            mem.grievanceOpenAt = new Date().toISOString();
            return { text: negLine(user, l, H, 'abuse'), ask: false };
        case 'corruption': {
            const SHORT = { M2: ['जल जीवन मिशन की टंकियाँ और घर-घर नल', 'Jal Jeevan Mission ki tankiyan aur ghar-ghar nal'], 'D-H1': ['उनकी दान की ज़मीन पर बना उप-स्वास्थ्य केंद्र', 'unki daan ki zameen par bana up-swasthya kendra'], M1: ['खेल मैदान, रनिंग ट्रैक और ओपन जिम', 'khel maidan, running track aur open gym'], M8: ['सिहाली खुर्द की मॉड्यूलर लाइब्रेरी', 'Sihali Khurd ki modular library'], M4: ['जोहड़ों की गहरी खुदाई', 'johadon ki gehri khudai'] };
            const id = Object.keys(SHORT).find(k => !mem.toldItems.includes(k)) || 'M2';
            used.push(id);
            mem.grievanceOpenAt = new Date().toISOString();
            return { text: negLine(user, l, H, 'corruption') + S('जैसे ', 'jaise ') + SHORT[id][l === 'hi' ? 0 : 1] + S('। फिर भी किसी ख़ास काम को लेकर शिकायत हो तो बताइए, मैं सबसे पहले अभय सिंह जी तक पहुँचाती हूँ।', '. Phir bhi kisi khaas kaam ko lekar shikayat ho to bataiye, main sabse pehle Abhay Singh ji tak pahunchati hoon.'), ask: false, used };
        }
        case 'concern_when': {
            const c = (mem.concerns || []).slice(-1)[0];
            const label = c ? kb.topicLabel(c.topic, l) : S('आपकी', 'aapki');
            const sk = c ? kb.sankalpFor(c.topic, { village: mem.village }) : null;
            const skLine = sk && !mem.toldItems.includes(sk.id) ? S(' आगे का संकल्प भी यही है: ', ' Aage ka sankalp bhi yahi hai: ') + kb.render(sk, l) : '';
            if (skLine && sk) used.push(sk.id);
            return { text: S(`पक्की तारीख़ का वादा मैं नहीं करूँगी${H} 🙏 आपकी ${c && c.ward ? 'वार्ड ' + c.ward + ' की ' : ''}${label} वाली बात रजिस्टर में दर्ज है और अभय सिंह जी तक पहुँच चुकी है।`, `Pakki tareekh ka vaada main nahi karungi${H} 🙏 Aapki ${c && c.ward ? 'ward ' + c.ward + ' ki ' : ''}${label} wali baat register me darj hai aur Abhay Singh ji tak pahunch chuki hai.`) + skLine, ask: false, used };
        }
        case 'script_pref': {
            const pref = cls.script === 'hinglish' ? 'hinglish' : 'hindi';
            setScriptPref(user, pref, 'voter');
            ctx.l = pref === 'hinglish' ? 'en' : 'hi';
            return { text: pref === 'hinglish' ? 'Zaroor ji 🙏 Ab se Hinglish (Roman) me hi baat karungi. Bataiye, kya madad karun—parchi, booth ya gaon ka koi kaam?' : 'ज़रूर जी 🙏 अब से हिंदी में ही बात करूँगी। बताइए, क्या मदद करूँ—पर्ची, बूथ या गाँव का कोई काम?', ask: false };
        }
        case 'emoji': {
            const k = cls.emoji || 'other';
            if (k === 'upset') {
                mem.grievanceOpenAt = new Date().toISOString(); // next problem-like answer is logged; no vote ask for 45 min
                return { text: vary(user, [
                    S(`😔🙏 लगता है कोई बात बुरी लगी${H}। आपकी नाराज़गी सिर आँखों पर—बताइए क्या दिक्कत है, मैं सबसे पहले अभय सिंह जी तक पहुँचाती हूँ।`, `😔🙏 Lagta hai koi baat buri lagi${H}. Aapki naraazgi sir aankhon par—bataiye kya dikkat hai, main sabse pehle Abhay Singh ji tak pahunchati hoon.`),
                    S(`🙏 माफ़ी चाहती हूँ${H}, अगर कुछ ग़लत लगा हो। खुलकर बताइए क्या परेशानी है—आपकी बात ज़रूर आगे पहुँचेगी।`, `🙏 Maafi chahti hoon${H}, agar kuch galat laga ho. Khulkar bataiye kya pareshani hai—aapki baat zaroor aage pahunchegi.`)
                ]), ask: false };
            }
            // 👍 / 🙏 to a message that invited a slip ask (e.g. the bulk intro): thank + say how to get the slip
            if (['agree', 'pray', 'love'].includes(k) && /(पर्ची चाहिए तो|parchi chahiye to)/i.test(lastBotText(user)) && !user.slipDeliveredAt) return { text: S(`🙏 धन्यवाद${H}! अपनी पर्ची चाहिए तो बस अपना पूरा नाम और पिता/पति का नाम लिख दीजिए।`, `🙏 Dhanyavad${H}! Apni parchi chahiye to bas apna poora naam aur pita/pati ka naam likh dijiye.`), ask: false };
            if (k === 'sad') return { text: vary(user, [S(`😔 क्या हुआ${H}? सब ठीक तो है? कोई परेशानी हो तो बताइए, हम साथ हैं 🙏`, `😔 Kya hua${H}? Sab theek to hai? Koi pareshani ho to bataiye, hum saath hain 🙏`)]), ask: false };
            if (k === 'laugh') return { text: vary(user, [S(`😄🙏 आपकी हँसी से दिन बन गया${H}!`, `😄🙏 Aapki hansi se din ban gaya${H}!`), S(`😂🙏 ख़ुश रहिए${H}!`, `😂🙏 Khush rahiye${H}!`)]), ask: false };
            if (k === 'think') return { text: vary(user, [S(`🤔 कोई सवाल मन में है${H}? बेझिझक पूछिए—काम, पर्ची या बूथ, सब बताऊँगी।`, `🤔 Koi sawaal man me hai${H}? Bejhijhak poochhiye—kaam, parchi ya booth, sab bataungi.`)]), ask: false };
            if (k === 'love') return { text: vary(user, [S(`🙏❤️ आपका प्यार और आशीर्वाद ही हमारी ताकत है${H}!`, `🙏❤️ Aapka pyaar aur aashirwad hi hamari taakat hai${H}!`), S(`🙏😊 बहुत-बहुत धन्यवाद${H}, आपका साथ बना रहे!`, `🙏😊 Bahut-bahut dhanyavad${H}, aapka saath bana rahe!`)]), ask: false };
            if (k === 'wow') return { text: vary(user, [S(`🙏🚩 धन्यवाद${H}! आपका जोश देखकर हौसला बढ़ गया।`, `🙏🚩 Dhanyavad${H}! Aapka josh dekhkar hausla badh gaya.`)]), ask: false };
            if (k === 'agree' || k === 'pray') return { text: vary(user, [S(`🙏😊 धन्यवाद${H}! कुछ और पूछना हो—पर्ची, बूथ या गाँव का कोई काम—तो बेझिझक लिखिए।`, `🙏😊 Dhanyavad${H}! Kuch aur poochhna ho—parchi, booth ya gaon ka koi kaam—to bejhijhak likhiye.`), S(`👍🙏 जी${H}, साथ बना रहे!`, `👍🙏 Ji${H}, saath bana rahe!`), S(`🙏 राम राम${H}! कोई काम हो तो बताइएगा।`, `🙏 Ram Ram${H}! Koi kaam ho to bataiyega.`)]), ask: false };
            return { text: vary(user, [S(`🙏 राम राम${H}! बताइए, क्या सेवा करूँ—पर्ची, बूथ या गाँव का कोई काम?`, `🙏 Ram Ram${H}! Bataiye, kya seva karun—parchi, booth ya gaon ka koi kaam?`), S(`😊🙏 आपका संदेश मिला${H}। कुछ पूछना हो तो लिख दीजिए।`, `😊🙏 Aapka sandesh mila${H}. Kuch poochna ho to likh dijiye.`)]), ask: false };
        }
        case 'emoji_only':
            return { text: vary(user, [S(`🙏 राम राम${H}! बताइए, क्या सेवा करूँ—पर्ची, बूथ या गाँव का कोई काम?`, `🙏 Ram Ram${H}! Bataiye, kya seva karun—parchi, booth ya gaon ka koi kaam?`), S(`😊🙏 आपका संदेश मिला${H}। कुछ पूछना हो तो लिख दीजिए।`, `😊🙏 Aapka sandesh mila${H}. Kuch poochna ho to likh dijiye.`)]), ask: false };
        case 'bribe':
            return { text: vary(user, [
                S(`नहीं${H}, यहाँ कोई पैसा या दारू नहीं मिलती—ये कानून के ख़िलाफ़ भी है 🙏 अभय सिंह जी की यही बात है: "${C.selfRespect_hi}"`, `Nahi${H}, yahan koi paisa ya daaru nahi milti—ye kanoon ke khilaf bhi hai 🙏 Abhay Singh ji ki yahi baat hai: "${C.selfRespect_en}"`),
                S(`${jiOnly ? 'जी' : hon}, वोट आपका स्वाभिमान है, उसका कोई मोल नहीं। ${C.notBuy_hi} 🙏`, `${jiOnly ? 'Ji' : hon}, vote aapka swabhimaan hai, uska koi mol nahi. ${C.notBuy_en} 🙏`),
                S(`बिल्कुल नहीं${H} 🙏 चंद दिनों के लालच से गाँव का भविष्य नहीं संवरता—फ़ैसला काम और भरोसे पर कीजिए।`, `Bilkul nahi${H} 🙏 Chand dino ke laalach se gaon ka bhavishya nahi sanwarta—faisla kaam aur bharose par kijiye.`)
            ]), ask: false };
        case 'wrong_number':
            mem.wrongNumberAt = new Date().toISOString();
            return { text: S(`माफ़ कीजिए${H} 🙏 ये संदेश ग्राम पंचायत सिहाली खुर्द के चुनाव के लिए अभय सिंह जी की टीम की तरफ़ से है। अगर आप यहाँ के नहीं हैं या संदेश नहीं चाहते, तो बस STOP लिख दीजिए—फिर कोई संदेश नहीं आएगा।`, `Maaf kijiye${H} 🙏 Ye sandesh Gram Panchayat Sihali Khurd ke chunav ke liye Abhay Singh ji ki team ki taraf se hai. Agar aap yahan ke nahi hain ya sandesh nahi chahte, to bas STOP likh dijiye—phir koi sandesh nahi aayega.`), ask: false };
        case 'condolence':
            mem.condolenceAt = new Date().toISOString();
            return { text: S(`बहुत दुख हुआ सुनकर${H} 🙏 भगवान दिवंगत आत्मा को शांति दें और परिवार को यह दुख सहने की हिम्मत दें। किसी भी चीज़ की ज़रूरत हो तो बताइएगा।`, `Bahut dukh hua sunkar${H} 🙏 Bhagwan divangat aatma ko shanti dein aur parivar ko ye dukh sehne ki himmat dein. Kisi bhi cheez ki zaroorat ho to bataiyega.`), ask: false };
        case 'opposed': {
            const asked = user && user.context && user.context.askedOpposedReason;
            if (user) { user.context = user.context || {}; user.context.askedOpposedReason = true; }
            body = asked
                ? S(`ठीक है${H}, आपकी राय का पूरा सम्मान है 🙏 गाँव का कोई भी काम हो तो बेझिझक यहीं लिखिएगा—हम सबकी सेवा में हैं।`, `Theek hai${H}, aapki raay ka poora samman hai 🙏 Gaon ka koi bhi kaam ho to bejhijhak yahin likhiyega—hum sabki seva me hain.`)
                : S(`आपकी राय का पूरा सम्मान है${H}—वोट आपका हक़ है, और गाँव में सब अपने हैं 🙏 बस इतना पूछना चाहूँगी: आपके लिए गाँव में सबसे ज़रूरी काम कौन-सा है? अभय सिंह जी के काम भी एक बार ज़रूर देखिएगा।`, `Aapki raay ka poora samman hai${H}—vote aapka haq hai, aur gaon me sab apne hain 🙏 Bas itna poochna chahungi: aapke liye gaon me sabse zaroori kaam kaun sa hai? Abhay Singh ji ke kaam bhi ek baar zaroor dekhiyega.`);
            return { text: body, ask: false };
        }
        case 'bribe_others':
            return { text: vary(user, [
                S(`कौन क्या करता है, उस पर मैं कुछ नहीं कहूँगी${H} 🙏 पर वोट आपका स्वाभिमान है—चंद रुपयों या एक बोतल के बदले पाँच साल का गाँव का भविष्य नहीं बिकना चाहिए। फ़ैसला काम और भरोसे पर कीजिए।`, `Kaun kya karta hai, us par main kuch nahi kahungi${H} 🙏 Par vote aapka swabhimaan hai—chand rupayon ya ek botal ke badle paanch saal ka gaon ka bhavishya nahi bikna chahiye. Faisla kaam aur bharose par kijiye.`),
                S(`दूसरों की बात दूसरे जानें${H} 🙏 अभय सिंह जी का रास्ता साफ़ है—न पैसा, न दारू, सिर्फ़ काम और भरोसा। आपका वोट आपकी इज़्ज़त है, उसे सोच-समझकर दीजिए।`, `Doosron ki baat doosre jaanein${H} 🙏 Abhay Singh ji ka rasta saaf hai—na paisa, na daaru, sirf kaam aur bharosa. Aapka vote aapki izzat hai, use soch-samajh kar dijiye.`)
            ]).replace(/रुपयों/g, 'पैसों').replace(/rupayon/g, 'paison'), ask: false };
        case 'apology':
            body = vary(user, [S(`अरे कोई बात नहीं${H} 🙏 गुस्सा आना जायज़ है, आपकी बात दिल पर नहीं ली। बताइए, क्या मदद करूँ?`, `Are koi baat nahi${H} 🙏 Gussa aana jaayaz hai, aapki baat dil par nahi li. Bataiye, kya madad karun?`),
                S(`बिल्कुल कोई बात नहीं${H} 🙏 आप खुलकर बोले, अच्छा लगा। कोई काम हो तो बताइए।`, `Bilkul koi baat nahi${H} 🙏 Aap khulkar bole, achha laga. Koi kaam ho to bataiye.`)]);
            ask = false;
            break;
        case 'no_politics':
            mem.told.noPoliticsAt = new Date().toISOString();
            body = vary(user, [S(`ठीक है${H}, आज वोट की कोई बात नहीं 🙏 सब ठीक तो है?`, `Theek hai${H}, aaj vote ki koi baat nahi 🙏 Sab theek to hai?`), S(`जी, बिल्कुल${H} 🙏 जब मन हो तब बात करेंगे।`, `Ji, bilkul${H} 🙏 Jab mann ho tab baat karenge.`)]);
            ask = false;
            break;
        case 'mobility_help': {
            // an elder who can't walk to the booth: empathy + note it for the team (needsAdmin) — no promise of a vehicle
            needsAdmin = true;
            const first = !mem.told.mobilityAt;
            mem.told.mobilityAt = new Date().toISOString();
            body = first ? S(`आप चिंता मत कीजिए${H} 🙏 आपकी बात नोट कर ली है और टीम को बता दी है—वोट वाले दिन बूथ तक आने-जाने के बारे में टीम का कोई साथी आपसे बात करेगा। अपना वार्ड बता दीजिए।`, `Aap chinta mat kijiye${H} 🙏 Aapki baat note kar li hai aur team ko bata di hai—vote wale din booth tak aane-jaane ke baare me team ka koi saathi aapse baat karega. Apna ward bata dijiye.`)
                : S(`जी${H}, आपकी बात टीम तक पहुँच चुकी है 🙏 वोट वाले दिन आने-जाने के लिए टीम से कोई आपसे बात करेगा।`, `Ji${H}, aapki baat team tak pahunch chuki hai 🙏 Vote wale din aane-jaane ke liye team se koi aapse baat karega.`);
            ask = false;
            break;
        }
        case 'guarantee':
            body = vary(user, [S(`सच कहूँ${H}, किसी काम की गारंटी या पक्की तारीख़ मैं नहीं दूँगी—झूठा वादा नहीं करेंगे 🙏 पर अभय सिंह जी की 40 साल की समाज सेवा और पिछले कार्यकाल के काम सबके सामने हैं। आपके यहाँ कौन-सा काम ज़रूरी है, बताइए—सीधे उन तक पहुँचाऊँगी।`, `Sach kahun${H}, kisi kaam ki guarantee ya pakki tareekh main nahi dungi—jhootha vaada nahi karenge 🙏 Par Abhay Singh ji ki 40 saal ki samaj seva aur pichhle karyakal ke kaam sabke saamne hain. Aapke yahan kaun sa kaam zaroori hai, bataiye—seedhe un tak pahunchaungi.`),
                S(`गारंटी वाली बात मैं नहीं कहूँगी${H} 🙏 जो काम हुए वो ज़मीन पर दिखते हैं, और आगे का संकल्प भी लिखकर सामने है। आपकी जो ज़रूरत है वो बताइए, नोट करके पहुँचाऊँगी।`, `Guarantee wali baat main nahi kahungi${H} 🙏 Jo kaam hue wo zameen par dikhte hain, aur aage ka sankalp bhi likhkar saamne hai. Aapki jo zaroorat hai wo bataiye, note karke pahunchaungi.`)]);
            ask = false;
            break;
        case 'slip_help':
            body = S(`कोई बात नहीं${H} 🙏 वोटर कार्ड पर जैसा नाम छपा है बिल्कुल वैसा लिख दीजिए, या कार्ड का EPIC नंबर (जैसे CYN1234567) भेज दीजिए। फिर भी न मिले तो टीम का कोई साथी आपकी मदद करेगा।`, `Koi baat nahi${H} 🙏 Voter card par jaisa naam chhapa hai bilkul waisa likh dijiye, ya card ka EPIC number (jaise CYN1234567) bhej dijiye. Phir bhi na mile to team ka koi saathi aapki madad karega.`);
            needsAdmin = true; ask = false;
            break;
        case 'women_works': {
            const w1 = kb.getItem('M2'), w2 = kb.getItem('D-H1');
            const facts = [w2, w1].filter(Boolean).filter(i => !mem.toldItems.includes(i.id)).slice(0, 1);
            used.push(...facts.map(i => i.id));
            body = S(`सच कहूँ${H}, पर्चे में महिलाओं के लिए अलग से कोई काम दर्ज नहीं है, इसलिए गढ़कर नहीं बताऊँगी 🙏`, `Sach kahun${H}, parche me mahilaon ke liye alag se koi kaam darj nahi hai, isliye gadhkar nahi bataungi 🙏`)
                + (facts.length ? S(' पर जो काम हर घर के काम आए: ', ' Par jo kaam har ghar ke kaam aaye: ') + facts.map(i => kb.render(i, l)).join(' ') : '')
                + S(' आपके मोहल्ले में महिलाओं की कोई ख़ास दिक्कत हो तो बताइए, नोट करके अभय सिंह जी तक पहुँचाऊँगी।', ' Aapke mohalle me mahilaon ki koi khaas dikkat ho to bataiye, note karke Abhay Singh ji tak pahunchaungi.');
            ask = false;
            break;
        }
        case 'what_q': {
            // "kya?" after our question: say it again, simpler — never a new topic
            const lb = lastBotText(user);
            const q = (lb.match(/[^.?!।\n]*\?/g) || []).pop() || ((lb.match(/[^.?!।\n]*(अपना|अपने|अपनी|apna|apne|apni)[^.?!।\n]*(बताइए|बता दीजिए|लिख दीजिए|bataiye|bata dijiye|likh dijiye)[^.?!।\n]*[।.]?/i) || [])[0] || '').trim() || null;
            body = q ? S(`मेरा मतलब था${H}—`, `Mera matlab tha${H}—`) + q.trim().replace(/^[—\-\s]+/, '') : S(`जी${H}, बस इतना पूछ रही थी—आपकी कोई मदद करूँ? पर्ची, बूथ या गाँव का कोई काम?`, `Ji${H}, bas itna pooch rahi thi—aapki koi madad karun? Parchi, booth ya gaon ka koi kaam?`);
            ask = false;
            break;
        }
        case 'grievance': {
            if (cls.cynic) {
                body = vary(user, [S(`आपकी बात में दम है${H} 🙏 भरोसा बातों से नहीं, काम से बनता है। अभय सिंह जी 40 साल से गाँव के बीच हैं और पिछले कार्यकाल के काम ज़मीन पर दिखते हैं। आपके यहाँ क्या अटका है, बताइए—सीधे उन तक पहुँचाऊँगी।`, `Aapki baat me dam hai${H} 🙏 Bharosa baaton se nahi, kaam se banta hai. Abhay Singh ji 40 saal se gaon ke beech hain aur pichhle karyakal ke kaam zameen par dikhte hain. Aapke yahan kya atka hai, bataiye—seedhe un tak pahunchaungi.`),
                    S(`आप सही कह रहे हैं, ऐसा बहुत लोगों के साथ हुआ है${H} 🙏 इसीलिए झूठे वादे नहीं करूँगी—जो काम हुए वो सामने हैं। आपकी जो बात है, वो मुझे बताइए।`, `Aap sahi keh rahe hain, aisa bahut logon ke saath hua hai${H} 🙏 Isiliye jhoothe vaade nahi karungi—jo kaam hue wo saamne hain. Aapki jo baat hai, wo mujhe bataiye.`)]);
                mem.grievanceOpenAt = new Date().toISOString();
                ask = false;
                break;
            }
            if (cls.naraz) {
                body = vary(user, [S(`आपकी नाराज़गी सिर आँखों पर${H} 🙏 किस बात से मन दुखा है? बताइए, मैं सीधे अभय सिंह जी तक पहुँचाऊँगी।`, `Aapki naraazgi sir aankhon par${H} 🙏 Kis baat se man dukha hai? Bataiye, main seedhe Abhay Singh ji tak pahunchaungi.`),
                    S(`माफ़ी चाहती हूँ अगर किसी बात से ठेस पहुँची${H} 🙏 क्या बात है, खुलकर बताइए—आपकी बात ज़रूर आगे पहुँचेगी।`, `Maafi chahti hoon agar kisi baat se thes pahunchi${H} 🙏 Kya baat hai, khulkar bataiye—aapki baat zaroor aage pahunchegi.`)]);
                mem.grievanceOpenAt = new Date().toISOString();
                ask = false;
                break;
            }
            body = vary(user, [
                S(`आपकी नाराज़गी जायज़ है${H}, और आपने साफ़ कहा—अच्छा लगा 🙏 अभय सिंह जी 40 साल से गाँव के सुख-दुख में साथ रहे हैं, सिर्फ़ चुनाव में नहीं। आपके यहाँ कौन-सी दिक्कत है? मैं सीधे उन तक पहुँचाऊँगी।`, `Aapki naraazgi jaayaz hai${H}, aur aapne saaf kaha—achha laga 🙏 Abhay Singh ji 40 saal se gaon ke sukh-dukh me saath rahe hain, sirf chunav me nahi. Aapke yahan kaun si dikkat hai? Main seedhe unke tak pahunchaungi.`),
                S(`आपकी शिकायत सिर आँखों पर${H} 🙏 जहाँ कोई नहीं पहुँचा, वो बात मुझे बताइए—नोट करके अभय सिंह जी तक पहुँचाऊँगी।`, `Aapki shikayat sir aankhon par${H} 🙏 Jahan koi nahi pahuncha, wo baat mujhe bataiye—note karke Abhay Singh ji tak pahunchaungi.`)
            ]).replace('unke tak', 'un tak');
            ask = false;
            break;
        }
        case 'money_ask': {
            body = S(`${jiOnly ? 'जी' : hon}, कामों पर कितना ख़र्च हुआ, ये आँकड़े अभियान की तरफ़ से नहीं बताए जाते—काम ज़मीन पर दिखते हैं, आप खुद देख सकते हैं 🙏 चाहें तो आपके वार्ड या पानी, सड़क, पढ़ाई जैसे किसी काम की जानकारी दे दूँ?`, `${jiOnly ? 'Ji' : hon}, kaamon par kitna kharcha hua, ye aankde campaign ki taraf se nahi bataye jaate—kaam zameen par dikhte hain, aap khud dekh sakte hain 🙏 Chahein to aapke ward ya paani, sadak, padhai jaise kisi kaam ki jankari de doon?`);
            ask = false;
            break;
        }
        case 'invite': {
            body = S(`आपके न्योते के लिए दिल से धन्यवाद${H}! 🙏 बेटी/परिवार की ख़ुशी में आपने याद किया, ये बड़ी बात है। आपका न्योता अभय सिंह जी की टीम तक पहुँचा दूँगी—ढेरों शुभकामनाएँ!`, `Aapke nyote ke liye dil se dhanyavad${H}! 🙏 Khushi ke mauke par aapne yaad kiya, ye badi baat hai. Aapka nyota Abhay Singh ji ki team tak pahuncha dungi—dheron shubhkamnayein!`);
            if (/(shaadi|shadi|byah|vivah|शादी|ब्याह|विवाह)/i.test(recentBotText(user, 2) + ' ' + ((user.history || []).filter(h => h.role === 'user').slice(-3).map(h => h.text).join(' ')))) body = body.replace('बेटी/परिवार की ख़ुशी में', 'शादी की ख़ुशी में').replace('Khushi ke mauke par', 'Shaadi ki khushi me');
            mem.told.inviteThanked = true;
            ask = false;
            break;
        }
        case 'dialect_switch': {
            mem.dialect = cls.dialect || 'haryanvi';
            if (user) user.dialectPref = mem.dialect;
            body = mem.dialect === 'rajasthani'
                ? S('खम्मा घणी सा! 🙏 अब म्हें थारी भाषा में ही बात करांगी। बताओ सा, के सेवा करूँ?', 'Khamma ghani sa! 🙏 Ab mhe thaari bhasha me hi baat karaangi. Batao sa, ke seva karun?')
                : S(`ठीक सै${H}! 😄 इब ठेठ हरियाणवी में बात करांगी। बता, थारे गाम में के काम सबतै ज़रूरी सै?`, `Theek sai${H}! 😄 Ib theth Haryanvi me baat karaangi. Bata, thaare gaam me ke kaam sabte zaroori sai?`);
            ask = false;
            break;
        }
        case 'health_concern': {
            const pain = /(ghutn|घुटन)/i.test(message) ? S('घुटने का दर्द', 'ghutne ka dard') : (/(kamar|कमर)/i.test(message) ? S('कमर का दर्द', 'kamar ka dard') : S('ये दर्द', 'ye dard'));
            body = S(`अरे${H}, ${pain} बहुत तकलीफ़ देता है—अपना ध्यान रखिए, भगवान जल्दी आराम दें 🙏`, `Arre${H}, ${pain} bahut takleef deta hai—apna dhyan rakhiye, Bhagwan jaldi aaram dein 🙏`);
            if (cls.doctor) {
                const sk = kb.sankalpFor('health');
                const centre = !mem.toldItems.includes('D-H1') ? S(' गाँव में अभय सिंह जी की दान की ज़मीन पर उप-स्वास्थ्य केंद्र का भवन बना है।', ' Gaon me Abhay Singh ji ki daan ki zameen par up-swasthya kendra ka bhawan bana hai.') : '';
                if (centre) used.push('D-H1');
                body += centre;
                if (sk && !mem.toldItems.includes(sk.id)) { body += S(' और संकल्प है: ', ' Aur sankalp hai: ') + kb.render(sk, l); used.push(sk.id); }
            } else body += S(' डॉक्टर को दिखा लिया?', ' Doctor ko dikha liya?');
            ask = false;
            break;
        }
        case 'commit':
        case 'family_votes': {
            const fv = cls.familyVotes || voterMemory.extractFamilyVotes(message) || null;
            if (fv) mem.familyVotes = fv;
            body = fv
                ? S(`दिल से धन्यवाद ${greetName}! 🙏 घर के ${fv} वोट नोट कर लिए—आपका यही भरोसा अभय सिंह जी की असली ताकत है।`, `Dil se dhanyavad ${greetName}! 🙏 Ghar ke ${fv} vote note kar liye—aapka yahi bharosa Abhay Singh ji ki asli taakat hai.`)
                : (stageOf(user) === 'committed' && mem.told.familyAsk
                    ? vary(user, [S(`आपका साथ है तो हौसला दोगुना है${H} 🙏`, `Aapka saath hai to hausla doguna hai${H} 🙏`), S(`बहुत-बहुत धन्यवाद${H} 🙏`, `Bahut-bahut dhanyavad${H} 🙏`)])
                    : S(`दिल से धन्यवाद ${greetName}! 🙏 आपका यही भरोसा अभय सिंह जी की असली ताकत है।`, `Dil se dhanyavad ${greetName}! 🙏 Aapka yahi bharosa Abhay Singh ji ki asli taakat hai.`));
            const ward = (user && user.ward) || mem.ward;
            const b = boothForWard(ward);
            if (b && !mem.told.booth) { body += S(` आपका बूथ ${b.booth}, कमरा ${b.room} है।`, ` Aapka booth ${b.booth}, room ${b.room} hai.`); mem.told.booth = true; }
            if (!fv && !mem.familyVotes && !mem.told.familyAsk) {
                body += S(' घर में कुल कितने वोट हैं?', ' Ghar me kul kitne vote hain?');
                mem.told.familyAsk = true; ask = false;
            } else if (!user.lastFoundVoter && !mem.told.slipOffer) {
                body += S(' पर्ची चाहिए तो अपना पूरा नाम और पिता/पति का नाम भेज दीजिए।', ' Parchi chahiye to apna poora naam aur pita/pati ka naam bhej dijiye.');
                mem.told.slipOffer = true; ask = false;
            } else if (!mem.told.ballotTip) {
                body += S(` एक बात याद रखिएगा: मतपत्र में अभय सिंह जी (मोटी आंगली वाले) का नाम देखकर मुहर लगाइए, और मुहर के बाद मतपत्र सिर्फ़ लंबाई में मोड़िएगा।`, ` Ek baat yaad rakhiyega: matpatra me Abhay Singh ji (Moti Aangli wale) ka naam dekhkar mohar lagaiye, aur mohar ke baad matpatra sirf lambai me modiyega.`);
                mem.told.ballotTip = true; ask = false;
            }
            break;
        }
        case 'taunt': {
            if (cls.insult) {
                // a plain insult ("bekar aadmi hai", "chup kar") gets calm respect and an open door, not a works pitch
                mem.grievanceOpenAt = new Date().toISOString();
                const op = negLine(user, l, H, 'insult');
                body = /(बताइए|bataiye)/i.test(op) ? op : op + ' ' + vary(user, [
                    S('कोई ख़ास बात या काम जो आपको खटकता हो, वो बताइए—मैं सीधे टीम तक पहुँचाऊँगी।', 'Koi khaas baat ya kaam jo aapko khatakta ho, wo bataiye—main seedhe team tak pahunchaungi.'),
                    S('अगर गाँव का कोई काम अटका है, तो बस वार्ड और जगह बता दीजिए, नोट कर लूँगी।', 'Agar gaon ka koi kaam atka hai, to bas ward aur jagah bata dijiye, note kar lungi.'),
                    S('आपकी बात सुनने के लिए मैं यहीं हूँ, जब चाहें लिखिए।', 'Aapki baat sunne ke liye main yahin hoon, jab chahein likhiye.')
                ].filter(x => !(/(atka|अटका)/i.test(op) && /(atka|अटका)/i.test(x))));
                ask = false;
                break;
            }
            if (!mem.told.tauntAck) {
                // first allegation: no argument, no works list—acknowledge and ask what is wrong (logged as a samasya next)
                mem.told.tauntAck = true;
                mem.grievanceOpenAt = new Date().toISOString();
                body = negLine(user, l, H, 'taunt') + S(' बताइए आपके यहाँ कौन-सा काम अटका है—वार्ड और जगह के साथ, मैं सबसे पहले अभय सिंह जी तक पहुँचाती हूँ।', ' Bataiye aapke yahan kaun sa kaam atka hai—ward aur jagah ke saath, main sabse pehle Abhay Singh ji tak pahunchati hoon.');
                ask = false;
                break;
            }
            const t = cls.topic || (anyConcern && anyConcern.topic) || (AUDIENCE_TOPICS[person.gender || 'none'] || [])[0];
            const done = items.filter(i => i.type === 'done');
            const sn = addFacts(done.length ? done : topicItems(t, l, user, 'done'), 1);
            body = negLine(user, l, H, cls.insult ? 'insult' : 'taunt') +
                (sn ? S(' पिछले कार्यकाल में पंचायत में ये काम ज़मीन पर हुआ है: ', ' Pichhle karyakal me panchayat me ye kaam zameen par hua hai: ') + sn : '') +
                (!sn && !mem.told.honour ? S(` ${C.honour_hi}`, ` ${C.honour_en}`) : '') +
                S(' जहाँ काम अधूरा लगे, वो गली/वार्ड बताइए—मैं नोट करके आगे पहुँचाऊँगी।', ' Jahan kaam adhoora lage, wo gali/ward bataiye—main note karke aage pahunchaungi.');
            if (!sn) mem.told.honour = true;
            ask = false;
            break;
        }
        case 'opponent': {
            const done = items.filter(i => i.type === 'done');
            const sn = addFacts(done.length ? done : topicItems((anyConcern && anyConcern.topic) || 'water', l, user, 'done'), 1);
            if (cls.praise) {
                body = S(`बिल्कुल${H}, उनका भी पूरा सम्मान है—गाँव में सब अपने हैं 🙏 बस फ़ैसला करते वक़्त एक बार काम ज़रूर देखिएगा:`, `Bilkul${H}, unka bhi poora samman hai—gaon me sab apne hain 🙏 Bas faisla karte waqt ek baar kaam zaroor dekhiyega:`) + (sn ? ' ' + sn : S(' अभय सिंह जी 40 साल से गाँव की सेवा में हैं।', ' Abhay Singh ji 40 saal se gaon ki seva me hain.'));
                ask = false;
                break;
            }
            body = vary(user, [
                S(`हम किसी उम्मीदवार के बारे में बुरा नहीं कहते${H}—सबका सम्मान है। फ़ैसला काम देखकर कीजिए:`, `Hum kisi ummeedwar ke baare me bura nahi kehte${H}—sabka samman hai. Faisla kaam dekh kar kijiye:`),
                S(`दूसरों पर टिप्पणी करना हमारा तरीका नहीं है${H}। अभय सिंह जी अपने काम और 40 साल की सेवा से पहचाने जाते हैं:`, `Doosron par tippani karna hamara tareeka nahi hai${H}. Abhay Singh ji apne kaam aur 40 saal ki seva se pehchaane jaate hain:`)
            ]) + (sn ? ' ' + sn : S(' 40 साल की निष्कलंक समाज सेवा।', ' 40 saal ki nishkalank samaj seva.'));
            break;
        }
        case 'works':
        case 'topic_mention': {
            if (cls.all) {
                const ids = ['M2', 'D-H1', 'M1', 'M8', 'M4', 'M11', 'M5', 'M7', 'M9'];
                used.push(...ids.filter(id => kb.getItem(id)));
                body = S('पिछले कार्यकाल में पंचायत में हुए मुख्य काम:\n• जल जीवन मिशन—पानी की टंकियाँ और घर-घर नल\n• उप-स्वास्थ्य केंद्र भवन (अभय सिंह जी की दान की ज़मीन पर)\n• खेल मैदान—रनिंग ट्रैक, कोर्ट और ओपन जिम\n• सिहाली खुर्द में मॉड्यूलर लाइब्रेरी\n• जोहड़ों की गहरी खुदाई और नए बोरवेल\n• सीवरेज-नाली, डामर सड़कें और स्कूलों में नए कमरे\nकिसी एक काम के बारे में विस्तार से जानना हो तो बताइए 🙏',
                    'Pichhle karyakal me panchayat me hue mukhya kaam:\n• Jal Jeevan Mission—paani ki tankiyan aur ghar-ghar nal\n• Up-swasthya kendra bhawan (Abhay Singh ji ki daan ki zameen par)\n• Khel maidan—running track, court aur open gym\n• Sihali Khurd me modular library\n• Johadon ki gehri khudai aur naye borewell\n• Sewerage-naali, damar sadkein aur schoolon me naye kamre\nKisi ek kaam ke baare me vistaar se jaanna ho to bataiye 🙏');
                ask = false;
                break;
            }
            // mini stadium is only a प्रयास in the sankalp (parcha F1) — never say it was built
            if (/(stadium|स्टेडियम)/i.test(message) && kb.getItem('F1')) {
                used.push('F1');
                body = vary(user, [S(`मिनी स्टेडियम आगे का संकल्प है${H} 🙏 सिहाली खुर्द के खेल मैदान में मिनी स्टेडियम बनाने का *प्रयास* किया जाएगा, और हाड़ाहेड़ी व सिहाली कलां के खेल मैदानों का विकास होगा।`, `Mini stadium aage ka sankalp hai${H} 🙏 Sihali Khurd ke khel maidan me mini stadium banane ka *prayas* kiya jayega, aur Hadahedi va Sihali Kalan ke khel maidanon ka vikas hoga.`),
                    S(`जी${H}, मिनी स्टेडियम अभी आगे के संकल्प में है—सिहाली खुर्द के खेल मैदान में इसे बनाने का *प्रयास* किया जाएगा 🙏`, `Ji${H}, mini stadium abhi aage ke sankalp me hai—Sihali Khurd ke khel maidan me ise banane ka *prayas* kiya jayega 🙏`)]);
                break;
            }
            const kt = kb.primaryTopic(message, cls.topic) || (AUDIENCE_TOPICS[person.gender || 'none'] || [])[0];
            // "library kab khulegi Haraheri me": a village's own sankalp answers it (never another village's done work), no date
            {
                const vil = kb.detectVillages(message)[0];
                const sk = vil ? kb.sankalpFor(kt, { village: vil, text: message }) : null;
                if (sk && (sk.villages || []).includes(vil) && /(kab|कब|banega|banegi|banenge|khulegi|khulega|lagegi|lagega|hoga|hogi|बनेगा|बनेगी|खुलेगी|खुलेगा|लगेगी|होगा|होगी|milegi|मिलेगी)/i.test(message)) {
                    used.push(sk.id);
                    body = S(`${kb.villageName(vil, 'hi')} के लिए ये आगे का संकल्प है${H} 🙏 ${kb.render(sk, 'hi')} पक्की तारीख़ का वादा मैं नहीं करूँगी।`, `${kb.villageName(vil, 'en')} ke liye ye aage ka sankalp hai${H} 🙏 ${kb.render(sk, 'en')} Pakki tareekh ka vaada main nahi karungi.`);
                    break;
                }
            }
            const msgTopics = kb.detectTopics(message);
            const lm = items.filter(i => i.landmark);
            const onTopic = items.filter(i => i.topics.some(x => x === kt || msgTopics.includes(x)));
            let list = lm.length ? lm : (onTopic.length ? onTopic : (items.length ? items : topicItems(kt, l, user)));
            // "kya kaam karwaye?" asks about work DONE: never answer it with a future sankalp
            const askedPast = /(karw?a(ye|ya|yi|e)|kiy[ae]|kiye|banw?a(ye|ya|yi)|\bhu(a|e)\b|\bban[ae]\b|करवा(ए|या|ई)|किया|किए|बनवा(ए|या|ई)|हुआ|हुए|बना|बने|vikas|विकास)/i.test(message);
            if (cls.intent === 'works' && !cls.wish && !lm.length && !cls.topic && askedPast) {
                const major = ['M2', 'M8', 'M1', 'D-H1', 'M7', 'M5', 'M9', 'M4', 'M11'].map(id => kb.getItem(id)).filter(i => i && !mem.toldItems.includes(i.id));
                if (major.length) list = major;
            } else if (cls.intent === 'works' && !cls.wish && !lm.length && askedPast && list.some(i => i.type === 'done')) list = list.filter(i => i.type === 'done');
            const maxN = (cls.topic || cls.intent === 'works') && !cls.wish && !['jobs', 'pension', 'ration', 'bijli', 'housing'].includes(kt) ? 2 : 1;
            let sn;
            const doneL = list.filter(i => i.type === 'done').sort((a, b) => (/^M\d/.test(b.id) ? 1 : 0) - (/^M\d/.test(a.id) ? 1 : 0)), futL = list.filter(i => i.type === 'future');
            if (!cls.wish && !lm.length && doneL.length && futL.length) {
                // never present a sankalp as if it were done: done work first, then the sankalp clearly labelled
                sn = addFacts(doneL, askedPast ? maxN : 1);
                if (!askedPast) { const f = addFacts(futL, 1); if (f) sn = (sn ? sn + ' ' : '') + S('आगे का संकल्प: ', 'Aage ka sankalp: ') + f; }
            } else if (!cls.wish && !lm.length && !doneL.length && futL.length) {
                const f = addFacts(futL, 1);
                sn = f ? S('आगे का संकल्प: ', 'Aage ka sankalp: ') + f : '';
            } else sn = addFacts(cls.wish ? doneL : list, maxN);
            const KEY = [[/(gym|जिम)/i, /(open gym|ओपन जिम)/i], [/(library|लाइब्रेरी)/i, /(library|लाइब्रेरी)/i], [/(running|track|ट्रैक|रनिंग)/i, /(running track|रनिंग ट्रैक)/i], [/(court|basketball|badminton|kho|कोर्ट)/i, /(court|कोर्ट)/i],
                    [/(tanki|टंकी)/i, /(tanki|टंकी|टंकियाँ)/i], [/(bore|बोर)/i, /(borewell|बोरवेल)/i], [/(hospital|aspatal|swasthya|अस्पताल|स्वास्थ्य)/i, /(up-swasthya|उप-स्वास्थ्य)/i], [/(pashu|पशु)/i, /(pashu|पशु)/i], [/(meeting hall|मीटिंग हॉल)/i, /(meeting hall|मीटिंग हॉल)/i], [/(sarovar|सरोवर)/i, /(sarovar|सरोवर)/i]];
            const kKey = !lm.length && !cls.wish ? KEY.find(([q]) => q.test(message)) : null;
            const askWhere = /(kahan|kaha\b|kidhar|kaun si jagah|कहाँ|कहां|किधर)/i.test(message);
            if ((kKey || askWhere) && !lm.length && !cls.wish) {
                const all = kb.load().items.filter(i => i.type === 'done' && !i.laneOnly);
                const hit = kKey ? (all.filter(i => kKey[1].test(i.hi + ' ' + i.roman)).sort((a, b) => (b.villages.length - a.villages.length) || ((b.kind === 'detail') - (a.kind === 'detail')))[0]) : null;
                const pool = hit ? [hit] : (askWhere ? items.concat(kb.byTopic(kt, { type: 'done' })).filter(i => i.type === 'done' && (!kt || i.topics.includes(kt)) && i.villages.length) : []);
                const loc = pool.find(i => i.kind === 'detail') || pool[0];
                if (loc) { used.length = 0; sn = kb.render(loc, l); used.push(loc.id); }
            }
            if (cls.wish) {
                const sk = kb.sankalpFor(kt, { village: mem.village });
                if (sk && !mem.toldItems.includes(sk.id) && !used.includes(sk.id)) { sn = (sn ? sn + ' ' : '') + S('आगे के लिए संकल्प: ', 'Aage ke liye sankalp: ') + kb.render(sk, l); used.push(sk.id); }
            }
            if (/(kitn[ie]|कितनी|कितने|ginti|गिनती)/i.test(message) && !/(baje|बजे|vote|वोट|din|दिन)/i.test(message)) {
                used.length = 0;
                sn = S(`गिनती मैं नहीं बताऊँगी${H}, पर पिछले कार्यकाल में पंचायत के अलग-अलग मोहल्लों और मुख्य रास्तों पर ये काम ज़रूरत के हिसाब से हुआ है। अपनी गली बताइए, उसकी जानकारी देख देती हूँ।`, `Ginti main nahi bataungi${H}, par pichhle karyakal me panchayat ke alag-alag mohallon aur mukhya raston par ye kaam zaroorat ke hisaab se hua hai. Apni gali bataiye, uski jankari dekh deti hoon.`);
                ask = false;
            }
            if (['jobs', 'pension', 'ration', 'bijli', 'housing'].includes(kt)) {
                ask = false;
                sn = S(`सच कहूँ तो ${kb.topicLabel(kt, 'hi')} पर पर्चे में अलग से कोई संकल्प दर्ज नहीं है, इसलिए झूठा वादा नहीं करूँगी। आपके घर में इसकी कोई दिक्कत हो तो बताइए—नोट करके अभय सिंह जी तक पहुँचाऊँगी।`, `Sach kahun to ${kb.topicLabel(kt, 'en')} par parche me alag se koi sankalp darj nahi hai, isliye jhootha vaada nahi karungi. Aapke ghar me iski koi dikkat ho to bataiye—note karke Abhay Singh ji tak pahunchaungi.`) +
                    (kt === 'jobs' && !mem.toldItems.includes('M8') ? S(' युवाओं की पढ़ाई के लिए सिहाली खुर्द में मॉड्यूलर लाइब्रेरी बनी है।', ' Yuvaon ki padhai ke liye Sihali Khurd me modular library bani hai.') : '');
                if (kt === 'jobs') used.push('M8');
            }
            if (!sn && list.length) {
                const told = list[0];
                sn = S('जैसा बताया था—', 'Jaisa bataya tha—') + (kb.render(told, l) || '');
            }
            body = sn || S('इस बारे में पक्की जानकारी टीम से लेकर बताती हूँ।', 'Is baare me pakki jankari team se lekar batati hoon.');
            const allTold = list.length && list.every(i => mem.toldItems.includes(i.id)) && !used.length;
            if (allTold) { body = S('जो काम पहले बताए, उनके अलावा आपके लिए सबसे ज़रूरी क्या है—पानी, सड़क, पढ़ाई, इलाज या कुछ और?', 'Jo kaam pehle bataye, unke alawa aapke liye sabse zaroori kya hai—paani, sadak, padhai, ilaaj ya kuch aur?'); ask = false; }
            if (cls.intent === 'topic_mention' && sn && !allTold && ask) { body += S(' आपके यहाँ इसमें कोई दिक्कत हो तो बताइए।', ' Aapke yahan isme koi dikkat ho to bataiye.'); ask = false; }
            if (!sn) needsAdmin = true;
            break;
        }
        case 'future': {
            const fut = items.filter(i => i.type === 'future');
            const t = cls.topic || (person.gender === 'F' ? 'health' : 'youth');
            const list = fut.length ? fut : topicItems(t, l, user, 'future');
            const sn = addFacts(list, 2);
            body = sn ? S('आगे के संकल्प: ', 'Aage ke sankalp: ') + sn : (list[0] ? S('जैसा बताया था—', 'Jaisa bataya tha—') + kb.render(list[0], l) : S('आगे के सभी संकल्प अभय सिंह जी के पर्चे में हैं—किस बारे में जानना चाहेंगे?', 'Aage ke sabhi sankalp Abhay Singh ji ke parche me hain—kis baare me jaanna chahenge?'));
            if (!sn && !list[0]) ask = false;
            break;
        }
        case 'about_baba':
            if (cls.special) {
                body = S(`${jiOnly ? 'जी' : hon}, अभय सिंह जी की सबसे बड़ी पहचान है 40 साल की सच्ची, निष्कलंक समाज सेवा—गाँव के हर सुख-दुख में साथ।`, `${jiOnly ? 'Ji' : hon}, Abhay Singh ji ki sabse badi pehchaan hai 40 saal ki sachchi, nishkalank samaj seva—gaon ke har sukh-dukh me saath.`);
                if (!mem.toldItems.includes('D-H1')) { body += S(' अपनी निजी भूमि दान देकर उन्होंने गाँव में उप-स्वास्थ्य केंद्र खुलवाया और उसका भवन बनवाया।', ' Apni niji bhoomi daan dekar unhone gaon me up-swasthya kendra khulwaya aur uska bhawan banwaya.'); used.push('D-H1'); }
                const key = ['M2', 'M8', 'M1'].map(id => kb.getItem(id)).find(i => i && !mem.toldItems.includes(i.id));
                if (key) { body += S(' पिछले कार्यकाल में उनके प्रयास से: ', ' Pichhle karyakal me unke prayas se: ') + kb.render(key, l); used.push(key.id); }
                break;
            }
            body = S(`अभय सिंह जी (मोटी आंगली वाले) ग्राम पंचायत सिहाली खुर्द से सरपंच पद प्रत्याशी हैं—40 साल की निष्कलंक समाज सेवा और अटूट भाईचारे के लिए जाने जाते हैं।`, `Abhay Singh ji (Moti Aangli wale) Gram Panchayat Sihali Khurd se sarpanch pad pratyashi hain—40 saal ki nishkalank samaj seva aur atoot bhaichare ke liye jaane jaate hain.`);
            if (!mem.toldItems.includes('D-H1')) { body += S(' उन्होंने अपनी निजी भूमि दान देकर गाँव में उप-स्वास्थ्य केंद्र खुलवाया और उसका भवन बनवाया।', ' Unhone apni niji bhoomi daan dekar gaon me up-swasthya kendra khulwaya aur uska bhawan banwaya.'); used.push('D-H1'); }
            else if (!mem.told.quote) { body += S(` उनका कहना है: "हार-जीत अपनी जगह है, पर प्रयास में कभी कमी नहीं छोड़ी।"`, ` Unka kehna hai: "Haar-jeet apni jagah hai, par prayas me kabhi kami nahi chhodi."`); mem.told.quote = true; }
            break;
        case 'was_sarpanch':
            body = S(`नहीं${H}, अभय सिंह जी खुद पहले सरपंच नहीं रहे—इस बार वे सरपंच पद के प्रत्याशी हैं। पिछले कार्यकाल के 5 सालों में पंचायत में जो काम हुए, उनमें उनका पूरा प्रयास रहा, और वे 40 साल से समाज सेवा में लगे हैं।`, `Nahi${H}, Abhay Singh ji khud pehle sarpanch nahi rahe—is baar wo sarpanch pad ke pratyashi hain. Pichhle karyakal ke 5 saalon me panchayat me jo kaam hue, unme unka poora prayas raha, aur wo 40 saal se samaj seva me lage hain.`);
            ask = false;
            break;
        case 'ballot': {
            if (mem.told.ballotTip && !cls.symbolAsked) {
                body = /(mod|मोड़|मोड)/i.test(message) ? S('मुहर लगाकर मतपत्र को लंबाई में, यानी ऊपर से नीचे की तरफ़ मोड़िए—आड़ा मोड़ने से मुहर दूसरे खाने में छप सकती है और वोट ख़राब हो सकता है 🙏', 'Mohar lagakar matpatra ko lambai me, yaani upar se neeche ki taraf modiye—aada modne se mohar doosre khaane me chhap sakti hai aur vote kharab ho sakta hai 🙏') : S(`${jiOnly ? 'जी' : hon}, मतपत्र में अभय सिंह जी (मोटी आंगली वाले) का नाम देखकर उनके आगे मुहर लगाइए, फिर मतपत्र लंबाई में मोड़कर डालिएगा 🙏`, `${jiOnly ? 'Ji' : hon}, matpatra me Abhay Singh ji (Moti Aangli wale) ka naam dekhkar unke aage mohar lagaiye, phir matpatra lambai me modkar daaliyega 🙏`);
                ask = false;
                break;
            }
            body = S(`${jiOnly ? 'जी' : hon}, मतपत्र में अभय सिंह जी (मोटी आंगली वाले) का नाम देखकर उनके आगे मुहर लगाइए 🙏`, `${jiOnly ? 'Ji' : hon}, Matpatra me Abhay Singh ji (Moti Aangli wale) ka naam dekhkar unke aage mohar lagaiye 🙏`)
                + ' ' + S(P.fold_hi, P.fold_en);
            mem.told.ballotTip = true;
            ask = false;
            break;
        }
        case 'polling': {
            // v7: focused follow-ups — "kitne baje tak" gets the time, "ye/unka booth kahan" right after a slip gets THAT
            // person's booth, and a repeat never collapses into a generic redirect
            const ld = user && user.lastSlipDelivered && Date.now() - Date.parse(user.lastSlipDelivered.at) < 6 * 3600e3 ? user.lastSlipDelivered : null;
            const askBooth = /(booth|बूथ|kahan|kaha|kidhar|कहाँ|कहां|kamra|कमरा|room)/i.test(message);
            const askTime = /(baje|बजे|time|टाइम|samay|समय|kab tak|कब तक)/i.test(message);
            const toldPoll = mem.told.pollDate;
            if (cls.idq) { body = S(`${P.id_hi || 'आधार या वोटर आईडी साथ लाएँ।'} मतदान ${P.time_hi || 'सुबह 7:30 से शाम 5:30 बजे तक'} है 🙏`, `${P.id_en || 'Aadhaar ya voter ID saath laaiye.'} Matdaan ${P.time_en || 'subah 7:30 se shaam 5:30 tak'} hai 🙏`); ask = false; break; }
            if (ld && askBooth && ld.booth) {
                const bn = String(ld.booth).match(/(\d+)/), rn = String(ld.room || ld.booth).match(/कमरा\s*(?:नं\.?)?\s*(\d+)/) || String(ld.room || '').match(/(\d+)/);
                const bt = bn ? bn[1] : ld.booth, rt = rn ? rn[1] : null;
                body = S(`${ld.other ? `*${ld.name}* जी का` : 'आपका'} बूथ ${bt}${rt ? `, कमरा ${rt}` : ''} है—राजकीय उच्च माध्यमिक विद्यालय, सिहाली खुर्द 🙏`, `${ld.other ? `${ld.name} ji ka` : 'Aapka'} booth ${bt}${rt ? `, room ${rt}` : ''} hai—Govt. Sr. Sec. School, Sihali Khurd 🙏`);
                if (askTime) body += S(' मतदान सुबह 7:30 से शाम 5:30 तक है।', ' Matdaan subah 7:30 se shaam 5:30 tak hai.');
                ask = false; break;
            }
            if ((toldPoll || ld) && askTime && !askBooth) { body = S(`सुबह 7:30 से शाम 5:30 तक${H}—सोमवार, 16 नवंबर 🙏`, `Subah 7:30 se shaam 5:30 tak${H}—Somvar, 16 November 🙏`); ask = false; break; }
            if (toldPoll && askBooth) {
                const b0 = boothForWard((user && user.ward) || mem.ward);
                body = b0 ? S(`आपका बूथ ${b0.booth}, कमरा ${b0.room}—राजकीय उच्च माध्यमिक विद्यालय, सिहाली खुर्द 🙏`, `Aapka booth ${b0.booth}, room ${b0.room}—Govt. Sr. Sec. School, Sihali Khurd 🙏`)
                    : S('सारे बूथ राजकीय उच्च माध्यमिक विद्यालय, सिहाली खुर्द में हैं 🙏 अपना वार्ड नंबर बता दीजिए, आपका बूथ-कमरा बता दूँगी।', 'Saare booth Govt. Sr. Sec. School, Sihali Khurd me hain 🙏 Apna ward number bata dijiye, aapka booth-room bata dungi.');
                ask = false; break;
            }
            if (cls.short && toldPoll) { body = S(`सोमवार, 16 नवंबर को सुबह 7:30 से शाम 5:30 तक${H} 🙏`, `Somvar, 16 November ko subah 7:30 se shaam 5:30 tak${H} 🙏`); ask = false; break; }
            const b = boothForWard((user && user.ward) || mem.ward);
            const wantsId = /(card|aadhar|aadhaar|kya le|आधार|क्या लेकर|कौन सा कार्ड)/i.test(message);
            body = S(`मतदान सोमवार, 16 नवंबर 2026 को सुबह 7:30 से शाम 5:30 तक राजकीय उच्च माध्यमिक विद्यालय, सिहाली खुर्द में है।`, `Matdaan Somvar, 16 November 2026 ko subah 7:30 se shaam 5:30 tak Govt. Sr. Sec. School, Sihali Khurd me hai.`) +
                (b ? S(` आपका बूथ ${b.booth}, कमरा ${b.room}।`, ` Aapka booth ${b.booth}, room ${b.room}.`) : '') +
                (wantsId || !mem.told.idTip ? ' ' + S(P.id_hi, P.id_en) : '') +
                (b ? '' : S(' अपना वार्ड बताइए, बूथ-कमरा भी बता दूँगी।', ' Apna ward bataiye, booth-room bhi bata doongi.'));
            mem.told.pollDate = true; mem.told.idTip = true; if (b) mem.told.booth = true;
            ask = !!b;
            break;
        }
        case 'introduce': {
            const nm = nameFor(user, l) || scriptName(cls.name, l) || '';
            const ward = (user && user.ward) || mem.ward;
            const b = boothForWard(ward);
            body = vary(user, [S(`राम राम ${nm ? nm + ' ' : ''}${hon}! 🙏 आपसे जुड़कर बहुत अच्छा लगा।`, `Ram Ram ${nm ? nm + ' ' : ''}${hon}! 🙏 Aapse judkar bahut achha laga.`), S(`${nm ? nm + ' ' : ''}${hon}, आपसे बात करके अच्छा लगा 🙏`, `${nm ? nm + ' ' : ''}${hon}, aapse baat karke achha laga 🙏`)]);
            if (ward) body += S(` वार्ड ${ward} नोट है`, ` Ward ${ward} note hai`) + (b ? S(`—आपका बूथ ${b.booth}, कमरा ${b.room} रहेगा।`, `—aapka booth ${b.booth}, room ${b.room} rahega.`) : S('।', '.'));
            if (b) mem.told.booth = true;
            if (!mem.concerns.length) { body += S(' आपके मोहल्ले में सबसे ज़रूरी काम कौन-सा है—पानी, सड़क, नाली या कुछ और?', ' Aapke mohalle me sabse zaroori kaam kaun sa hai—paani, sadak, naali ya kuch aur?'); ask = false; }
            break;
        }
        case 'voter_slip':
            body = S(`पर्ची अभी निकाल देती हूँ${H}—अपना पूरा नाम और पिता/पति का नाम लिख भेजिए।`, `Parchi abhi nikaal deti hoon${H}—apna poora naam aur pita/pati ka naam likh bhejiye.`);
            ask = false;
            break;
        case 'undecided': {
            body = vary(user, [S(`कोई बात नहीं${H}, सोच-समझकर फ़ैसला करना ही सही है।`, `Koi baat nahi${H}, soch-samajh kar faisla karna hi sahi hai.`), S(`बिल्कुल${H}, आराम से सोचिए—वोट आपका हक़ है।`, `Bilkul${H}, aaram se sochiye—vote aapka haq hai.`)]);
            const tlist = [anyConcern && anyConcern.topic, ...(AUDIENCE_TOPICS[person.gender || 'none'] || []), 'water', 'health', 'road', 'youth', 'education'].filter(Boolean);
            let sn = '';
            for (const t of tlist) { sn = addFacts(topicItems(t, l, user, 'done'), 1); if (sn) break; }
            if (sn) body += S(' एक बात याद रखिएगा: ', ' Ek baat yaad rakhiyega: ') + sn;
            break;
        }
        case 'positive':
            body = vary(user, [S(`आपके आशीर्वाद के लिए धन्यवाद ${greetName}! 🙏`, `Aapke aashirwad ke liye dhanyavad ${greetName}! 🙏`), S(`आपकी बात सुनकर अच्छा लगा ${greetName}! 🙏`, `Aapki baat sunkar achha laga ${greetName}! 🙏`)]);
            break;
        case 'thanks': {
            const r = recall(user, l);
            const elder = (person.age || 0) >= 60;
            body = vary(user, elder
                ? [S(`जी${H} 🙏 अपना और घर वालों का ध्यान रखिएगा, आपका आशीर्वाद बना रहे।`, `Ji${H} 🙏 Apna aur ghar walon ka dhyan rakhiyega, aapka aashirwad bana rahe.`), S(`आपका आशीर्वाद ही हमारी ताकत है${H} 🙏 सेहत का ध्यान रखिएगा।`, `Aapka aashirwad hi hamari taakat hai${H} 🙏 Sehat ka dhyan rakhiyega.`)]
                : [S(`आपका भी धन्यवाद${H} 🙏 कोई भी काम हो तो बेझिझक यहीं लिखिएगा।`, `Aapka bhi dhanyavad${H} 🙏 Koi bhi kaam ho to bejhijhak yahin likhiyega.`), S(`हमेशा आपकी सेवा में${H} 🙏`, `Hamesha aapki seva me${H} 🙏`), S(`जी${H}, बात करके अच्छा लगा 🙏`, `Ji${H}, baat karke achha laga 🙏`)]) + (r ? ' ' + r : '');
            if (!['unknown', 'undecided'].includes(stage) || r) ask = false;
            break;
        }
        case 'greeting': {
            const greeted = user && user.context && user.context.greetedOnce;
            const returning = greeted || (mem.concerns.length > 0) || (user && user.interactionCount > 3);
            if (cls.howAreYou && /(scene|scn|chal (raha|rha)|khabar|चल रहा)/i.test(message)) {
                body = S(`सब बढ़िया${/(bhai|भाई)/i.test(message) ? ' भाई' : H}, आपकी दुआ है 🙏 आप सुनाओ, गाँव में क्या चल रहा है?`, `Sab badhiya${/(bhai|भाई)/i.test(message) ? ' bhai' : H}, aapki dua hai 🙏 Aap sunao, gaon me kya chal raha hai?`); ask = false;
            } else if (cls.howAreYou) {
                body = S(`मैं ठीक हूँ${H}, आपकी कृपा है 🙏 आप सुनाइए, घर में सब राज़ी-ख़ुशी?`, `Main theek hoon${H}, aapki kripa hai 🙏 Aap sunaiye, ghar me sab raazi-khushi?`); ask = false;
            } else if (returning) {
                const r = recall(user, l, { force: false });
                body = vary(user, [
                    S(`राम राम ${greetName}! 🙏 फिर से बात करके अच्छा लगा।`, `Ram Ram ${greetName}! 🙏 Phir se baat karke achha laga.`),
                    S(`राम राम ${greetName}! 🙏 घर में सब राज़ी-ख़ुशी?`, `Ram Ram ${greetName}! 🙏 Ghar me sab raazi-khushi?`),
                    S(`प्रणाम ${greetName}! 🙏 बताइए, आज क्या सेवा करूँ?`, `Pranam ${greetName}! 🙏 Bataiye, aaj kya seva karun?`)
                ]) + (r ? ' ' + r : '');
                ask = false;
            } else {
                body = S(`राम राम ${greetName}! 🙏 घर-परिवार में सब कुशल-मंगल?`, `Ram Ram ${greetName}! 🙏 Ghar-parivar me sab kushal-mangal?`);
                ask = false;
            }
            if (user) { user.context = user.context || {}; user.context.greetedOnce = true; }
            break;
        }
        case 'who_are_you':
            if (/(kiska|kis ka|किसका|किस का|number|नंबर|नम्बर|kahan se|kaha se|कहाँ से)/i.test(message) && !/(bot|robot|insaan|insan|रोबोट|बॉट|इंसान)/i.test(message)) {
                body = S(`जी${H}, ये *अभय सिंह (मोटी आंगली वाले)* की टीम का नंबर है—वो ग्राम पंचायत सिहाली खुर्द से सरपंच पद के प्रत्याशी हैं 🙏 पर्ची, बूथ या गाँव का कोई काम हो तो यहीं लिखिए।`, `Ji${H}, ye *Abhay Singh (Moti Aangli wale)* ki team ka number hai—wo Gram Panchayat Sihali Khurd se sarpanch pad ke pratyashi hain 🙏 Parchi, booth ya gaon ka koi kaam ho to yahin likhiye.`);
            } else if (mem.told.whoAmI || /(bot|robot|insaan|insan|real|machine|\bai\b|रोबोट|बॉट|इंसान)/i.test(message)) {
                body = S(`जी${H}, मैं AI से चलने वाला डिजिटल साथी हूँ, इंसान नहीं—पर आपकी हर बात अभय सिंह जी की टीम तक पहुँचती है। ज़रूरत हो तो टीम का कोई साथी खुद फ़ोन कर लेगा।`, `Ji${H}, main AI se chalne wala digital saathi hoon, insaan nahi—par aapki har baat Abhay Singh ji ki team tak pahunchti hai. Zaroorat ho to team ka koi saathi khud phone kar lega.`);
            } else {
                body = S(`मैं अभय सिंह जी की टीम का डिजिटल साथी हूँ${H} 🙏 गाँव के काम, वोटर पर्ची, बूथ की जानकारी देती हूँ और आपकी हर बात या शिकायत टीम तक पहुँचाती हूँ।`, `Main Abhay Singh ji ki team ka digital saathi hoon${H} 🙏 Gaon ke kaam, voter parchi, booth ki jankari deti hoon aur aapki har baat ya shikayat team tak pahunchati hoon.`);
            }
            mem.told.whoAmI = true; ask = false;
            break;
        case 'joke':
            body = vary(user, [
                S(`😄 हँसी-मज़ाक से ही तो चौपाल में रौनक है${H}! आप ऐसे ही मुस्कुराते रहिए।`, `😄 Hansi-mazaak se hi to chaupal me raunak hai${H}! Aap aise hi muskurate rahiye.`),
                S(`😄 आप तो बड़े ज़िंदादिल हैं${H}! बस 16 नवंबर को वोट डालना मत भूलिएगा।`, `😄 Aap to bade zindadil hain${H}! Bas 16 November ko vote daalna mat bhooliyega.`)
            ]);
            ask = false;
            break;
        case 'off_topic':
            if (cls.person || cls.news) {
                body = vary(user, [
                    S(`माफ़ कीजिए${H}, इसकी जानकारी मैं नहीं देती 🙂 मैं सिर्फ़ ग्राम पंचायत सिहाली खुर्द और अभय सिंह जी के कामों व चुनाव से जुड़ी बातों में मदद करती हूँ। गाँव का कोई सवाल हो तो पूछिए।`, `Maaf kijiye${H}, iski jankari main nahi deti 🙂 Main sirf Gram Panchayat Sihali Khurd aur Abhay Singh ji ke kaamon va chunav se judi baaton me madad karti hoon. Gaon ka koi sawal ho to poochiye.`),
                    S(`😊 ये तो दुनिया की बात हो गई${H}! मेरा काम गाँव की बात है—सिहाली खुर्द पंचायत, अभय सिंह जी के काम, पर्ची या बूथ। इनमें कुछ पूछना हो तो बताइए।`, `😊 Ye to duniya ki baat ho gayi${H}! Mera kaam gaon ki baat hai—Sihali Khurd panchayat, Abhay Singh ji ke kaam, parchi ya booth. Inme kuch poochna ho to bataiye.`),
                    S(`इस बारे में मैं कुछ नहीं बता पाऊँगी${H} 🙏 गाँव की कोई ख़बर या काम जानना हो, तो ज़रूर पूछिए।`, `Is baare me main kuch nahi bata paungi${H} 🙏 Gaon ki koi khabar ya kaam jaanna ho, to zaroor poochiye.`)
                ]);
                ask = false;
                break;
            }
            body = cls.party
                ? S(`${jiOnly ? 'जी' : hon}, ये पंचायत का चुनाव है—इसमें पार्टी की नहीं, गाँव के काम और भरोसे की बात है।`, `${jiOnly ? 'Ji' : hon}, ye panchayat ka chunav hai—isme party ki nahi, gaon ke kaam aur bharose ki baat hai.`)
                : S(`इसकी पक्की जानकारी मेरे पास नहीं है${H} 🙏 मैं गाँव के काम, वोटर पर्ची और चुनाव की जानकारी में मदद करती हूँ।`, `Iski pakki jankari mere paas nahi hai${H} 🙏 Main gaon ke kaam, voter parchi aur chunav ki jankari me madad karti hoon.`);
            body += S(' आपके घर-मोहल्ले में सबसे ज़रूरी काम क्या है?', ' Aapke ghar-mohalle me sabse zaroori kaam kya hai?');
            ask = false;
            break;
        case 'daily_life': {
            const k = cls.kind;
            ask = false;
            if (k === 'health') {
                body = vary(user, [S(`अरे, ध्यान रखिए${H}—भगवान जल्दी ठीक करें 🙏 डॉक्टर को दिखा लिया?`, `Arre, dhyan rakhiye${H}—Bhagwan jaldi theek karein 🙏 Doctor ko dikha liya?`), S(`ये सुनकर चिंता हुई${H}। आराम कीजिए, दवाई समय पर लीजिए 🙏 किसी मदद की ज़रूरत हो तो बताइएगा।`, `Ye sunkar chinta hui${H}. Aaram kijiye, dawai samay par lijiye 🙏 Kisi madad ki zaroorat ho to bataiyega.`)]);
            } else if (k === 'crop') {
                const f = mem.toldItems.includes('F11') ? '' : S(' किसानों के लिए पंचायत में किसान सेवा केंद्र बनवाने का संकल्प भी है, ताकि खाद-बीज यहीं सही दाम पर मिले।', ' Kisanon ke liye panchayat me kisan seva kendra banwane ka sankalp bhi hai, taaki khaad-beej yahin sahi daam par mile.');
                if (f) used.push('F11');
                body = S(`भगवान करे इस बार फ़सल बढ़िया हो${H} 🌾`, `Bhagwan kare is baar fasal badhiya ho${H} 🌾`) + f;
            } else if (k === 'family') {
                body = vary(user, [S(`वाह, बहुत-बहुत बधाई${H}! 🎉 भगवान परिवार को ख़ूब ख़ुशियाँ दें।`, `Waah, bahut-bahut badhai${H}! 🎉 Bhagwan parivar ko khoob khushiyan dein.`), S(`ये तो बड़ी ख़ुशी की बात है${H}! 🎉 हमारी तरफ़ से ढेरों शुभकामनाएँ।`, `Ye to badi khushi ki baat hai${H}! 🎉 Hamari taraf se dheron shubhkamnayein.`)]);
            } else if (k === 'effort') {
                body = vary(user, [S(`भगवान करे जल्दी अच्छी जगह बात बने${H} 🙏 मेहनत करने वालों को देर-सवेर फल ज़रूर मिलता है।`, `Bhagwan kare jaldi achhi jagah baat bane${H} 🙏 Mehnat karne walon ko der-saver phal zaroor milta hai.`), S(`मेहनत रंग लाएगी${H}, हमारी शुभकामनाएँ साथ हैं 🙏`, `Mehnat rang laayegi${H}, hamari shubhkamnayein saath hain 🙏`)]);
            } else if (k === 'festival') {
                body = S(`आपको और पूरे परिवार को त्योहार की राम-राम और ढेरों शुभकामनाएँ${H} 🪔🙏`, `Aapko aur poore parivar ko tyohar ki Ram-Ram aur dheron shubhkamnayein${H} 🪔🙏`);
                if (stage !== 'committed' && stage !== 'opposed') { body += S(' इस बार 16 नवंबर का दिन भी गाँव के लिए त्योहार जैसा है—अभय सिंह जी का साथ देंगे ना?', ' Is baar 16 November ka din bhi gaon ke liye tyohar jaisa hai—Abhay Singh ji ka saath denge na?'); }
            } else if (k === 'busy') {
                const shaadi = /(shaadi|shadi|byah|शादी|ब्याह)/i.test((user.history || []).filter(h => h.role === 'user').slice(-4).map(h => h.text).join(' '));
                body = S(`बिल्कुल${H}, कोई जल्दी नहीं—जब फ़ुर्सत हो तब बात करेंगे 🙏`, `Bilkul${H}, koi jaldi nahi—jab fursat ho tab baat karenge 🙏`) + (shaadi ? S(' अभी तो शादी की तैयारी अच्छे से हो, यही दुआ है।', ' Abhi to shaadi ki taiyari achhe se ho, yahi dua hai.') : '');
            } else {
                body = S(`मौसम का ध्यान रखिएगा${H}, ख़ासकर बच्चों और बुज़ुर्गों का 🙏 और सुनाइए, घर में सब ठीक?`, `Mausam ka dhyan rakhiyega${H}, khaaskar bachchon aur buzurgon ka 🙏 Aur sunaiye, ghar me sab theek?`);
            }
            break;
        }
        case 'memory_check': {
            const asked = kb.primaryTopic(message, cls.topic);
            const r = voterMemory.recallPhrase(user, l, { allowSame: true, force: true, preferTopic: asked });
            const extra = [];
            if (mem.ward) extra.push(S(`वार्ड ${mem.ward}`, `ward ${mem.ward}`));
            if (mem.familyVotes) extra.push(S(`घर के ${mem.familyVotes} वोट`, `ghar ke ${mem.familyVotes} vote`));
            let reg = '';
            try {
                const ss = flows.stores().samasyaStore;
                const ids = (mem.samasyaIds || []).filter(id => ss.get(id));
                if (ids.length) { const rec = ss.get(ids[ids.length - 1]); reg = S(` (रजिस्टर नंबर ${rec.id})`, ` (register number ${rec.id})`); }
            } catch (e) {}
            if (!/(register|registr|number|nambar|token|\bid\b|रजिस्टर|नंबर)/i.test(message)) reg = '';
            const askedWho = /(naam|name|नाम|ward|वार्ड|kaun hu|कौन हूँ)/i.test(message);
            if (askedWho && (mem.name || mem.ward)) {
                const nm = mem.name && !NOT_A_NAME.test(String(mem.name).split(/\s+/)[0]) ? String(mem.name).split(/\s+/)[0] : '';
                const nmL = nm && (l === 'hi' ? hasDevanagari(nm) : !hasDevanagari(nm)) ? nm : (nm ? nm : '');
                body = S(`हाँ${nmL ? ' ' + nmL + ' जी' : H}, बिल्कुल याद है 🙏`, `Haan${nmL ? ' ' + nmL + ' ji' : H}, bilkul yaad hai 🙏`) +
                    (mem.ward ? S(` आप वार्ड ${mem.ward} से हैं`, ` Aap ward ${mem.ward} se hain`) : '') +
                    (/(naam|name|नाम)/i.test(message) && !nmL ? S('—नाम अभी नहीं बताया था, बता देंगे?', '—naam abhi nahi bataya tha, bata denge?') : '') +
                    (r ? S(', और ', ', aur ') + r.charAt(0).toLowerCase() + r.slice(1) : (mem.ward ? S('।', '.') : ''));
                ask = false;
                break;
            }
            const extraNew = extra.filter(x => !(r || '').toLowerCase().includes(x.toLowerCase()));
            body = r ? S(`बिल्कुल याद है${H}! `, `Bilkul yaad hai${H}! `) + r.replace(/।$|\.$/, '') + reg + S('।', '.') + (extraNew.length ? S(` ${extraNew.join(', ')} भी नोट है।`, ` ${extraNew.join(', ')} bhi note hai.`) : '')
                : (mem.name || mem.ward || mem.familyVotes ? S(`याद है${H} 🙏 ${[mem.name ? 'आपका नाम ' + mem.name : '', ...extra].filter(Boolean).join(', ')} नोट है। कोई समस्या हो तो बताइए, वो भी दर्ज कर लूँगी।`, `Yaad hai${H} 🙏 ${[mem.name ? 'aapka naam ' + mem.name : '', ...extra].filter(Boolean).join(', ')} note hai. Koi samasya ho to bataiye, wo bhi darj kar lungi.`)
                    : S(`अभी तक आपने कोई ख़ास समस्या नहीं बताई${H}—बताइए, नोट करके अभय सिंह जी तक पहुँचाऊँगी।`, `Abhi tak aapne koi khaas samasya nahi batayi${H}—bataiye, note karke Abhay Singh ji tak pahunchaungi.`));
            ask = false;
            break;
        }
        case 'gave_ward': {
            if (user && cls.ward) user.ward = cls.ward;
            if (cls.ward) mem.ward = cls.ward;
            const b = boothForWard(cls.ward);
            body = S(`वार्ड ${cls.ward} नोट कर लिया${H}।`, `Ward ${cls.ward} note kar liya${H}.`) +
                (b ? S(` आपका बूथ ${b.booth}, कमरा ${b.room} रहेगा।`, ` Aapka booth ${b.booth}, room ${b.room} rahega.`) : '');
            if (b) mem.told.booth = true;
            break;
        }
        case 'short_reply': {
            const r = recall(user, l);
            body = vary(user, [S(`अच्छा${H} 🙏`, `Achha${H} 🙏`), S(`जी${H} 🙏`, `Ji${H} 🙏`)]) + (r ? ' ' + r : '');
            // v5: the canned "घर-गाँव में सब ठीक?" fallback is gone (owner: #1 dumb reply). An open slip search gets a
            // specific question about it; otherwise one plain open line.
            let clar = null;
            try { clar = require('./nlu_router.js').clarify(user); } catch (e) {}
            if (!r && clar) { body = clar; ask = false; }
            else if (!r) { body += ' ' + vary(user, [S('कोई काम या सवाल हो तो बेझिझक बताइए।', 'Koi kaam ya sawal ho to bejhijhak bataiye.'), S('आपके मोहल्ले में किस काम की सबसे ज़्यादा ज़रूरत है?', 'Aapke mohalle me kis kaam ki sabse zyada zaroorat hai?'), S('पर्ची, बूथ या गाँव का कोई काम—जो भी हो, बताइए।', 'Parchi, booth ya gaon ka koi kaam—jo bhi ho, bataiye.')]); ask = false; }
            break;
        }
        case 'daily_followup':
            body = vary(user, [S(`चलो, ये सुनकर तसल्ली हुई${H} 🙏 अपना और परिवार का ध्यान रखिएगा।`, `Chalo, ye sunkar tasalli hui${H} 🙏 Apna aur parivar ka dhyan rakhiyega.`), S(`भगवान सब ठीक रखें${H} 🙏 कोई ज़रूरत हो तो बेझिझक बताइएगा।`, `Bhagwan sab theek rakhein${H} 🙏 Koi zaroorat ho to bejhijhak bataiyega.`)]);
            ask = false;
            break;
        case 'wellbeing_reply':
            body = vary(user, [S(`बहुत बढ़िया${H}, भगवान सबको राज़ी-ख़ुशी रखें 🙏`, `Bahut badhiya${H}, Bhagwan sabko raazi-khushi rakhein 🙏`), S(`सुनकर अच्छा लगा${H} 🙏`, `Sunkar achha laga${H} 🙏`)]);
            const relFirst = ['chill', 'gentle'].includes(opCtl.effectiveMode(user)) || opCtl.hasBrief(user);
            if (relFirst && !mem.told.lifeAsk) { body += S(' और सुनाइए, घर में बच्चे सब ठीक हैं?', ' Aur sunaiye, ghar me bachche sab theek hain?'); mem.told.lifeAsk = true; ask = false; }
            else if (!mem.concerns.length && !mem.told.mahaulAsk) { body += S(' आपके मोहल्ले में इस बार चुनाव का क्या माहौल है?', ' Aapke mohalle me is baar chunav ka kya mahaul hai?'); mem.told.mahaulAsk = true; ask = false; }
            break;
        default: {
            const words = String(message || '').trim().split(/\s+/).length;
            if (!cls.gibberish && words <= 6 && !/\?/.test(message) && !/^[^a-z\u0900-\u097F]*$/i.test(message)) {
                // a normal short remark we have no rule for: acknowledge like a person, ask one open question at most
                const r = recall(user, l);
                let clar = null;
                try { clar = require('./nlu_router.js').clarify(user); } catch (e) {}
                if (clar) { needsAdmin = true; return { needsAdmin, text: clar, ask: false, used }; }
                needsAdmin = true; return { needsAdmin, text: vary(user, [S(`अच्छा${H} 🙏`, `Achha${H} 🙏`), S(`जी${H} 🙏`, `Ji${H} 🙏`)]) + (r ? ' ' + r : S(' थोड़ा खुलकर बताइए—पर्ची चाहिए, कोई काम है या कुछ और पूछना है?', ' Thoda khulkar bataiye—parchi chahiye, koi kaam hai ya kuch aur poochhna hai?')), ask: false, used };
            }
        }
            needsAdmin = true;
            return {
                text: vary(user, [
                    S(`माफ़ कीजिए${H}, ठीक से समझ नहीं पाई। वोटर पर्ची चाहिए, कोई समस्या बतानी है, या अभय सिंह जी के बारे में कुछ पूछना है?`, `Maaf kijiye${H}, theek se samajh nahi paayi. Voter parchi chahiye, koi samasya batani hai, ya Abhay Singh ji ke baare me kuch poochna hai?`),
                    S(`थोड़ा खुलकर बताएँगे${H}? पर्ची, बूथ, या गाँव का कोई काम—किस बारे में बात करें?`, `Thoda khulkar batayenge${H}? Parchi, booth, ya gaon ka koi kaam—kis baare me baat karein?`)
                ]),
                ask: false, needsAdmin, used
            };
    }
    const recalled = /(बताई थी|batayi thi)/.test(body);
    return { text: body, ask, needsAdmin, used, concern: recalled ? null : (concernNow || anyConcern) };
}

// ---------------- LLM writing + validation ----------------
const BANNED = /(बाबा जी|बाबाजी|\bbaba ji\b|\bbabaji\b|पैसे देंगे|पैसा देंगे|दारू देंगे|paise denge|daru denge|देख लेंगे तुम्हें|अंजाम|धमकी|dhamki|जाति|धर्म के नाम|हिंदू|मुसलमान|जाट|यादव|गुर्जर|मेघवाल|ब्राह्मण|\bjaat\b|as an ai|i'm sorry|i cannot)/i;
const SARPANCH_CLAIM = /((पहले|पूर्व|पिछले कार्यकाल में)\s*(भी\s*)?(वे\s*|वो\s*)?सरपंच\s*(रहे|थे|रह चुके)|सरपंच\s*(रहते|रहे थे|रह चुके)|सरपंच के रूप में|सरपंच रहकर|सरपंच प्रतिनिधि|former sarpanch|ex[- ]sarpanch|(pehle|purv|pichhle)\s*(bhi\s*)?(wo\s*)?sarpanch\s*(rahe|the|reh chuke)|sarpanch (rehte|reh chuke|rehkar)|sarpanch ke roop me|sarpanch pratinidhi)/i;
const OPPONENT_ATTACK = /(उनके (झूठ|चोर)|वो (चोर|झूठे)|wo (chor|jhoothe)|unke jhooth|किस बिल में|kis bil me|बिकाऊ|bikau|निकम्मे|nikamme)/i;
const MONEY = /(₹|रुपये|रुपए|लाख|करोड़|\blakh\b|crore|rupees?|rupaye|budget|बजट|लागत)/i;
const FAKE_DELIVERY = /(पर्ची भेज दी|parchi bhej di|slip bhej di)/i;
const WORK_COUNT = /(\d+\s*\+?\s*(काम|कार्य|संकल्प|सड़कें|kaam|sankalp|works))/i;
// Prince 5 Nov 19:04: never state a ballot serial number (क्रम संख्या 1 / क्रमांक 1 / "number 1 par") voter-facing
const BALLOT_NUMBER = /((क्रम\s*संख्या|क्रमांक|क्रम\s*सं\.?|kram\s*sankhya|kramank|serial\s*(number|no\.?)?)\s*[:\-]?\s*(नं\.?\s*)?[0-9०-९]|(number|nambar|no\.?|नंबर|नम्बर)\s*[0-9०-९]\s*(par|pe|पर|पे|wale|वाले)|(पहले|first|pehle)\s*(नंबर|number)\s*(पर|par))/i;
const SYMBOL = /(चुनाव चिन्ह|चिन्ह|चिह्न|स्वस्तिक|卐|निशान पर|symbol|chunav chinh|nishan par|swastik)/i;
const PROMISED_DATE = /(\d+\s*(din|दिन|hafte|हफ्ते|हफ़्ते|mahine|महीने)\s*(me|में|ke andar|के अंदर)|jald(i)?\s*(hi\s*)?(ban|ho|lag|thik|theek)\s*(jayegi|jayega|jaegi|jaega)|जल्द(ी)?\s*(ही\s*)?(बन|हो|लग|ठीक)\s*(जाएगी|जाएगा|जायेगी|जायेगा)|pakka (ban|ho|lag) jayeg|पक्का (बन|हो|लग) जाएग|guarantee|गारंटी|chunav ke baad turant|चुनाव के बाद तुरंत)/i;

function validateLLM(reply, { allowedText, user, l } = {}) {
    if (!reply) return 'empty';
    const r = String(reply).trim();
    if (r.length > 420) return 'too_long';
    if (BANNED.test(r)) return 'banned';
    if (SARPANCH_CLAIM.test(r)) return 'sarpanch_claim';
    if (OPPONENT_ATTACK.test(r)) return 'opponent_attack';
    if (MONEY.test(r)) return 'money';
    if (FAKE_DELIVERY.test(r)) return 'fake_slip_delivery';
    if (WORK_COUNT.test(r)) return 'work_count';
    if (SYMBOL.test(r)) return 'symbol_claim';
    if (PROMISED_DATE.test(r)) return 'promised_date';
    if (BALLOT_NUMBER.test(r)) return 'ballot_number';
    if (/(स्टेडियम|stadium)/i.test(r) && !/(प्रयास|prayas|संकल्प|sankalp)/i.test(r)) return 'stadium_claim';
    if (/(सरोवर|sarovar)/i.test(r) && /(बन गया|बन चुका|बनवाया गया|पूरा हो गया|पूरा हुआ|तैयार हो|ban gaya|ban chuka|banwaya gaya|poora ho gaya|pura ho gaya)/i.test(r)) return 'sarovar_claim';
    if (/(आज|aaj)\s*(ही\s*|hi\s*)?(मतदान|वोट|matdan|vote|polling|booth|बूथ)/i.test(r)) return 'wrong_poll_day';
    if ((r.match(/\?/g) || []).length > 1) return 'multi_question';
    if (/[,;:—\-]\s*$/.test(r) || (!/[.?!।🙏😊🙂)\]]\s*$/u.test(r) && r.length > 60)) return 'truncated';
    if (l === 'hi' && !hasDevanagari(r)) return 'wrong_script';
    if (l === 'en' && hasDevanagari(r)) return 'wrong_script';
    if (/[०-९]/.test(r)) return 'devanagari_digits';
    const nums = r.match(/\d+(?:[.:]\d+)?/g) || [];
    for (const n of nums) if (!String(allowedText || '').includes(n)) return 'new_number:' + n;
    if (user && replyQuality.isRepeated(r, user)) return 'repeated';
    return null;
}

function historyTurns(user, opts, n = 10) {
    const h = (user && Array.isArray(user.history) && user.history.length ? user.history : []).filter(x => x && x.text);
    const turns = h.length ? h.map(x => ({ role: x.role === 'bot' ? 'assistant' : 'user', content: String(x.text).slice(0, 400) })) : (opts.history || []);
    const trimmed = turns.slice();
    if (trimmed.length && trimmed[trimmed.length - 1].role === 'user') trimmed.pop();
    return trimmed.slice(-n);
}

function buildLLMPrompt(cls, ctx, draft) {
    const { l, hon, person, stage, goal, user, items } = ctx;
    const C = PF().candidate || {};
    const card = voterMemory.buildCard(user);
    const summary = voterMemory.summaryText(user);
    const told = (user.memory && user.memory.toldItems) || [];
    const factLinesTxt = (items || []).slice(0, 5).map(i => `- [${i.type === 'future' ? 'FUTURE SANKALP (not done yet)' : (i.status === 'ongoing' ? 'ONGOING' : 'DONE in the last term')}] ${l === 'hi' ? (i.landmark && i.hiFull ? i.hiFull : i.hi) : (i.landmark && i.romanFull ? i.romanFull : i.roman)}${told.includes(i.id) ? ' (already told — do not repeat)' : ''}`);
    return [
        `You are a warm, respectful campaign volunteer from Gram Panchayat Sihali Khurd (Sihali Khurd, Sihali Kalan/Badi Sihali, Hadahedi), texting on WhatsApp for Abhay Singh ji (Moti Aangli wale), सरपंच पद प्रत्याशी. You are "अभय सिंह जी की टीम का डिजिटल साथी" and use feminine verbs (करती हूँ / karti hoon). Poll: Monday 16 Nov 2026, 7:30 AM-5:30 PM, Govt. Sr. Sec. School Sihali Khurd.`,
        `Write ONE short WhatsApp reply: 1-3 short sentences, under 300 characters. Language: ${l === 'hi' ? 'Devanagari Hindi (no English words, no Roman letters)' : 'simple Roman Hinglish (NO Devanagari)'}, warm and natural, the way a caring person of the village talks—not a bureaucrat, not a robot${user.dialectPref === 'haryanvi' ? '. The voter ASKED for Haryanvi: write in theth Haryanvi (थारा/थारे/म्हारा, सै, के, इब, कड़ै / thara, thaare, mhara, sai, ke, ib, kade)' : (user.dialectPref === 'rajasthani' ? '. The voter ASKED for Rajasthani/Marwari: write in Marwari style (थारो/म्हारो, सा, कोनी / tharo, mharo, sa, koni)' : (user.memory && user.memory.dialect ? ` (light ${user.memory.dialect} touch, the voter uses it)` : ''))}. Address the voter as "${hon}". Never reply with just "Ji"/"Achha"—always say something that answers or acknowledges what they said.`,
        `Intent: ${cls.intent}${cls.topic ? ' (topic ' + cls.topic + ')' : ''}${cls.kind ? ' (' + cls.kind + ')' : ''}. Stage: ${stage}. Gender: ${person.gender || 'unknown'}.`,
        goal && !opCtl.lockedToday() ? `Today's campaign focus (use only if it fits naturally): ${goal}` : '',
        opCtl.promptBlock(user),
        'WHAT THIS VOTER TOLD US BEFORE (use naturally, never recite):', card || '(new voter)',
        summary ? 'OLDER CONVERSATION SUMMARY: ' + summary : '',
        'NEVER repeat an opener, greeting, fact or question already used in the history; never ask again for something the memory already has (name, ward, family, father).',
        (user.history || []).some(h => h.role === 'bot') ? 'Do NOT introduce yourself again ("मैं अभय सिंह जी की टीम से हूँ / आपकी सहायता करती हूँ") — talk like someone they already know.' : '',
        opCtl.hasBrief(user) ? 'If the operator\'s "how to talk" asks you to bring up something (e.g. ask about a family member), do it in a light chat turn like this one, naturally and only once in the conversation — never as if you read it somewhere.' : '',
        'HOW TO TALK: answer exactly what they said first. Listen; if they talk about life (health, crops, family, weather, festivals) respond like a human first. At most ONE question in the whole reply. Never preachy, no speeches, no lists, never repeat a pitch or work from the history. Ask for the vote only when it fits; if committed, thank and talk family votes / booth / slip instead.',
        `HARD RULES: use ONLY the facts below — no other works, numbers, dates, names or promises. Works were "पिछले कार्यकाल में पंचायत में करवाए गए" / "उनके प्रयास से" — NEVER say Abhay Singh was sarpanch (he was not) and never call him "सरपंच प्रतिनिधि". Say "अभय सिंह जी", never just "बाबा जी". No budgets/rupees, no counts of works, never mention an election symbol (ballot: name at serial no. 1). Never promise a date or that something will surely be fixed. Never attack or mock opponents. No caste/religion, no money/liquor/gifts, no threats. Never claim a voter slip was sent. Bribe/liquor asks: politely refuse with "${C.selfRespect_hi || ''}".`,
        'FACTS (from the parchas):', ...factLinesTxt,
        `- ${C.service_hi || ''}; ${C.honour_hi || ''}`,
        `STYLE: keep every fact of the draft (you may shorten wording, never drop the work/sankalp it names). Do NOT add a vote request if the draft has none. ${person.gender ? '' : 'The voter\'s gender is unknown: never use gendered verbs or titles for them (say "aap ... chahenge", not chahti/chahte).'} You (the bot) speak with feminine verbs (karti hoon / करती हूँ).`,
        `SAFE DRAFT (grounded; improve the wording to sound natural, keep its facts, do not add new ones): ${draft}`
    ].filter(Boolean).join('\n');
}

// Sensitive or fact-exact intents (opposition, bribes, money, sarpanch question, dialect switch, memory) stay on the
// reviewed templates; the LLM rewrites the conversational ones.
// Short, exact replies (greeting, thanks, intro with booth, commitment/family votes, who-are-you) also stay on templates:
// live runs showed the model appending broken sentences to them.
const STEER_SKIP = new Set(['apology', 'no_politics', 'mobility_help', 'guarantee', 'what_q', 'abuse', 'condolence', 'wrong_number', 'corruption', 'grievance', 'opposed', 'privacy_probe', 'bribe', 'bribe_others', 'emoji', 'script_pref', 'stop', 'insult', 'taunt', 'health_concern', 'memory_check']);
const AGGR_OK = new Set(['positive', 'thanks', 'short_reply', 'works', 'topic_mention', 'future', 'about_baba', 'undecided', 'wellbeing_reply', 'family_votes', 'greeting']);
// voters with an operator brief/style or a non-normal mode: the LLM also writes the small-talk turns so the brief can shape them
const LLM_INTENTS_BRIEF = new Set(['short_reply', 'thanks', 'positive', 'wellbeing_reply', 'greeting', 'commit', 'family_votes']);
const LLM_INTENTS = new Set(['grievance', 'health_concern', 'works', 'topic_mention', 'future', 'about_baba', 'taunt', 'undecided', 'positive', 'off_topic', 'joke', 'unclear', 'daily_life']);

const STOPW = new Set('aur ke ki ka ko me mein se par hai hain gaye gayi gaya gayi. liye jaane wali wale abhay singh panchayat pichhle karyakal tahat jayegi jayega karwayi karwaya banwayi banwaya banwaye lagwayi kiya kiye sabhi unke unhone apni apne aapke aapki aapka और के की का को में से पर है हैं गए गई गया लिए वाली वाले अभय सिंह पंचायत पिछले कार्यकाल तहत जाएगी जाएगा करवाई करवाया बनवाई बनवाया बनवाए लगवाई किया किए उनके उन्होंने अपनी अपने आपके आपकी आपका'.split(/\s+/));
const keyTokens = s => String(s || '').toLowerCase().replace(/[^a-z\u0900-\u097F\s]/g, ' ').split(/\s+/).filter(w => w.length >= 4 && !STOPW.has(w));
/** Extra checks on the LLM against the grounded draft: facts kept, no new vote push, no guessed gender, dialect honoured. */
function validateAgainstDraft(out, draft, { used = [], l, person = {}, user = {}, intent = null } = {}) {
    const r = String(out || '');
    const low = r.toLowerCase();
    if (used.length) {
        const factToks = [...new Set(used.map(id => kb.getItem(id)).filter(Boolean).flatMap(i => keyTokens(kb.render(i, l))))];
        if (factToks.length >= 3) {
            const hit = factToks.filter(w => low.includes(w)).length;
            if (hit / factToks.length < 0.35) return 'dropped_facts';
        }
    }
    if ((!intent || ['grievance', 'taunt', 'undecided'].includes(intent)) && /\?/.test(draft) && !/\?/.test(r)) return 'dropped_question';
    if (opCtl.effectiveMode(user) === 'aggressive' && VOTE_ASK_RX.test(draft) && !/(साथ देंगे|वोट देंगे|वादा|पक्का|saath denge|vote denge|vaada|pakka|सोच रहे|शंका|soch rahe|shanka)/i.test(r)) return 'dropped_vote_ask'; // the draft's one question (e.g. "aapke yahan kya dikkat hai?") is the point of the turn
    if (!ASKED_VOTE.test(draft) && /(साथ देंगे ना|वोट देंगे ना|saath denge na|vote denge na|vote denge\b|वोट देंगे\b|(मतदान|वोट)[^।?]{0,40}(आएंगी|आएँगी|आएंगे|आएँगे|देंगे|डालेंगे|देंगी)\s*\?|(vote|matdan|matdaan)[^.?]{0,40}(aayenge|aayengi|aaoge|denge|dalenge|dengi)\s*\?)/i.test(r)) return 'unasked_vote_push';
    if (person.gender !== 'F' && /(chahti hain|chahti ho|sakti hain|rahi hain|karti hain|aayi hain|bolti hain|चाहती हैं|सकती हैं|रही हैं|करती हैं|आई हैं|बहन जी|behan ji|mata ji|माता जी)/i.test(r) && !/(behan ji|mata ji|बहन जी|माता जी|tai ji|ताई जी)/i.test(draft)) return 'gender_guess';
    if (person.gender !== 'M' && /(bhai sahab|भाई साहब|dada ji|दादा जी|tau ji|ताऊ जी)/i.test(r) && !/(bhai sahab|भाई साहब|dada ji|दादा जी|tau ji|ताऊ जी)/i.test(draft)) return 'gender_guess';
    if (/(\bmonday\b|\bsunday\b|\bvote dalna\b)/i.test(r) && l === 'hi') return 'wrong_script';
    if (/(kad़ै|कड़ै|kade)\s*(वोट|vote)/i.test(r)) return 'bad_dialect';
    if (/(आपका[^।?!]{0,25}ध्यान रख|aapka[^.?!]{0,25}dhyan rakh|नौकरी[^।?!]{0,20}बनेगी|naukri[^.?!]{0,20}banegi)/i.test(r)) return 'grammar';
    if (/((नौकरी|काम)[^।?!]{0,25}ज़रूर (लगेगी|मिलेगी|बनेगी|लगेगा|मिलेगा)|(naukri|kaam)[^.?!]{0,25}(zaroor|jarur|zarur) (lagegi|milegi|banegi|lagega|milega))/i.test(r)) return 'self_promise';
    if (/((करवा|बनवा|लगवा|खुलवा|दिलवा|पूरी करवा|पूरा करवा)(ती|ऊँगी|ऊंगी|उँगी|ुंगी)\s*(हूँ|हूं)?|(कार्य|काम|विकास|निर्माण)\s+(करती|करूँगी|करूंगी)\s*(हूँ|हूं)|\b(karwati|banwati|lagwati|khulwati|dilwati)\s+(hoon|hu|hun)\b|\b(karwaungi|banwaungi|lagwaungi|khulwaungi)\b)/i.test(r)) return 'self_promise';
    if (/(अपडेट\s*(करती|करूँगी|करूंगी|दूँगी|दूंगी|देती)|\bupdate\s*(karti|karungi|dungi|deti)\b)/i.test(r)) return 'self_promise'; // "मैं आपको अपडेट करती हूँ" — the bot can not follow up on its own
    if (/\b(hum|ham)\b[^.?!]{0,30}\b(samajhti|samajhta|karti|karta|rahi|raha|sunti|janti)\s+(hoon|hu|hun)\b|\bहम\b[^।?!]{0,30}(समझती|करती|रही|सुनती|जानती)\s+हूँ/i.test(r)) return 'grammar';
    if (/((prayas|koshish|vaada|wada)\s+(karti|karungi|karta)\s*(hoon|hu|hun)?|(khulwa|banwa|karwa|lagwa|dila)\w*\s+(dungi|deti hoon|deti hu|karungi)|(प्रयास|कोशिश|वादा)\s+(करती|करूँगी|करूंगी)|(खुलवा|बनवा|करवा|लगवा|दिला)\S*\s+(दूँगी|दूंगी|देती हूँ|करूँगी))/i.test(r)) return 'self_promise';
    if (user && user.dialectPref === 'haryanvi' && !/(thar[aei]|thaar[aei]|mhar[aei]|\bsai\b|\bse\b|\bib\b|kade|\bke\b|थार|म्हार|सै|इब|कड़ै|के )/i.test(r)) return 'no_dialect';
    return null;
}

function redirectVariants(user, l, message) {
    const hon = honorific(personOf(user, message), l);
    const H = isJi(hon) ? '' : ' ' + hon;
    const ci = classify(message, user).intent;
    if (['abuse', 'taunt', 'corruption', 'grievance', 'opposed'].includes(ci)) return Object.values(NEG_POOL).flat().map(p => (l === 'hi' ? p[0] : p[1]).replace('{H}', H).replace(/—$/, '।'));
    const c = voterMemory.concernToRecall(user, { allowSame: true });
    const label = c ? kb.topicLabel(c.topic, l) : null;
    return l === 'hi'
        ? [label ? `आपकी ${label} वाली बात मेरे पास दर्ज है${H}। और किसी बात में मदद करूँ—पर्ची, बूथ या घर के वोट?` : `बताइए${H}, और किस बात में मदद करूँ—पर्ची, बूथ या गाँव का कोई काम?`,
            `जी${H}, आपकी बात समझ ली। कोई नया सवाल हो तो बेझिझक पूछिए 🙏`,
            `मैं यहीं हूँ${H}—जो भी जानना हो, लिख दीजिए।`]
        : [label ? `Aapki ${label} wali baat mere paas darj hai${H}. Aur kisi baat me madad karun—parchi, booth ya ghar ke vote?` : `Bataiye${H}, aur kis baat me madad karun—parchi, booth ya gaon ka koi kaam?`,
            `Ji${H}, aapki baat samajh li. Koi naya sawal ho to bejhijhak poochiye 🙏`,
            `Main yahin hoon${H}—jo bhi jaanna ho, likh dijiye.`];
}

// ---------------- the turn ----------------
/**
 * Synchronous core: classify, flows, grounded draft, closer. (Memory rules already merged when memoryDone.)
 * @returns { text, cls, stage, previousStage, ctx, c, flowResult }
 */
function think(message, user, opts = {}, memoryDone = false) {
    if (user && !user.history) user.history = [];
    const facts = factsText();
    const l = lang(message, user);
    const cls = opts.cls || classify(message, user);
    if (!memoryDone) {
        voterMemory.updateFromVoterMessage(user, message, { lastBotText: lastBotText(user), intent: cls.intent, topic: cls.topic });
        voterMemory.rollSummary(user);
        voterMemory.tickTurn(user);
    }
    const mem = user.memory;
    if (cls.viaEmoji && mem) mem.commitment = Object.assign({}, mem.commitment || {}, { status: 'committed', soft: true, via: 'emoji', quote: String(message).slice(0, 20), at: new Date().toISOString() });
    const person = personOf(user, message);
    const hon = honorific(person, l);
    const previousStage = stageOf(user);
    const stage = nextStage(previousStage, cls.intent);
    if (user) {
        user.persuasionStage = stage;
        if (stage !== previousStage) user.persuasionHistory = (user.persuasionHistory || []).concat([{ from: previousStage, to: stage, at: new Date().toISOString(), intent: cls.intent }]).slice(-20);
        if (person.gender && person.source !== 'name') user.genderDetected = person.gender;
        if (person.gender) user.genderGuess = person.gender;
        if (mem.ward && !user.ward) user.ward = mem.ward;
        const vr = user.lastFoundVoter || user.voterProfile;
        if (!user.ward && vr && Number(vr.ward || vr.w)) user.ward = Number(vr.ward || vr.w);
        if (person.age >= 60 && !mem.ageGroup && !mem.age) { mem.ageGroup = 'elder'; mem.ageSource = 'cue(beta)'; }
    }
    const wantsFacts = ['works', 'topic_mention', 'future', 'taunt', 'opponent', 'undecided', 'memory_check'].includes(cls.intent);
    const items = wantsFacts ? retrieveFor(message, cls, user, { type: cls.intent === 'future' ? 'future' : null }) : [];
    const ctx = { l, hon, facts, user, person, stage, goal: opts.goal || '', message, items, cls, meta: opts.meta || {} };

    // 1. an open flow (samasya / mulaqat) gets the message first
    let fr = null;
    try {
        fr = flows.continueFlow(ctx);
        if (!fr) {
            if (cls.intent === 'complaint' || (cls.intent === 'abuse' && cls.alsoTopic)) fr = flows.startSamasya(ctx, { topic: kb.primaryTopic(message, cls.topic) });
            else if (cls.intent === 'samasya_explicit') fr = flows.startSamasya(ctx, { topic: null, explicit: true });
            else if (cls.intent === 'meeting') fr = flows.startMulaqat(ctx, { type: cls.call ? 'call' : 'visit' });
            // after an angry message we asked "kya dikkat hai?": the next problem-like answer is logged as a samasya
            else if (mem.grievanceOpenAt && Date.now() - Date.parse(mem.grievanceOpenAt) < 45 * 60e3 && ['topic_mention', 'short_reply', 'unclear', 'gave_ward', 'works'].includes(cls.intent) && (cls.topic || CONCERN_RX.test(message)) && !/\?/.test(message)) {
                fr = flows.startSamasya(ctx, { topic: kb.primaryTopic(message, cls.topic) });
                if (fr) mem.grievanceOpenAt = null;
            }
            // after a photo we could not read we asked "ye kis baare me hai?": a problem-like answer is logged as a samasya with the photo noted
            else if (mem.photoOpenAt && Date.now() - Date.parse(mem.photoOpenAt) < 60 * 60e3 && ['topic_mention', 'short_reply', 'unclear', 'gave_ward', 'works', 'grievance'].includes(cls.intent) && (cls.topic || CONCERN_RX.test(message)) && !/\?/.test(message)) {
                fr = flows.startSamasya(ctx, { topic: kb.primaryTopic(message, cls.topic) });
                if (fr) {
                    mem.photoOpenAt = null;
                    try { if (fr.samasyaId) { const ss = require('./samasya_store.js'); const r = ss.get(fr.samasyaId); ss.update(fr.samasyaId, { notes: ((r && r.notes) ? r.notes + ' | ' : '') + 'photo received', description: ('📷 ' + ((r && r.description) || '')).slice(0, 300) }, 'bot'); } } catch (e) {}
                }
            }
            if (fr && cls.intent === 'complaint') mem.grievanceOpenAt = null;
        }
    } catch (e) { console.error('[Brain] flow error:', e.message); fr = null; }

    const mourning = mem.condolenceAt && Date.now() - Date.parse(mem.condolenceAt) < 3 * 86400e3;
    const quietIntents = ['short_reply', 'thanks', 'unclear', 'greeting', 'positive', 'wellbeing_reply'];
    if (!fr && (mourning || mem.wrongNumberAt) && quietIntents.includes(cls.intent)) {
        const pool = mourning
            ? (l === 'hi' ? ['🙏', 'ईश्वर परिवार को धैर्य दें 🙏', 'भगवान आपको हिम्मत दें 🙏', 'हम आपके साथ हैं 🙏'] : ['🙏', 'Ishwar parivar ko dhairya dein 🙏', 'Bhagwan aapko himmat dein 🙏', 'Hum aapke saath hain 🙏'])
            : (l === 'hi' ? ['जी, धन्यवाद 🙏', 'ठीक है जी 🙏', '🙏'] : ['Ji, dhanyavad 🙏', 'Theek hai ji 🙏', '🙏']);
        const last = lastBotText(user);
        const text = pool.find(p => p !== last) || pool[0];
        return { text, cls, stage, previousStage, ctx, c: { text, ask: false, used: [] }, flowResult: { quiet: true }, l, person, hon };
    }
    if (!fr && cls.intent === 'privacy_probe') {
        const text = opCtl.probeReply(user, message ? l : l, message);
        return { text, cls, stage, previousStage, ctx, c: { text, ask: false, used: [] }, flowResult: null, l, person, hon };
    }
    let c, text, pendingQ = null;
    if (fr) {
        c = { text: fr.text, ask: fr.ask === true, used: fr.used || [], needsAdmin: !!(fr.samasyaId || fr.mulaqatId), concern: fr.concernTopic ? { topic: fr.concernTopic } : null };
        text = c.text;
        if (c.ask && !/\?/.test(text) && text.length < 230) { const cl = pickCloser(stage, l, user, c.concern); if (cl) text += ' ' + cl; }
    } else {
        c = compose(cls, ctx);
        text = c.text;
        // proactive mulaqat invite at the right moment (engaged + leaning/committed), only when no other question
        const userTurns = (user.history || []).filter(h => h.role === 'user').length;
        const offerMoment = ['commit', 'family_votes', 'positive', 'thanks'].includes(cls.intent) && ['leaning', 'committed'].includes(stage) && userTurns >= 3;
        if (mourning) {
            // no vote asks / invitations while the family is grieving
        } else if (offerMoment && !/\?/.test(text) && flows.canOfferMulaqat(user)) {
            text += ' ' + flows.offerMulaqat(ctx);
        } else if (flows.inFlow(user) && (mem.flow.parked || 0) === 1 && !mem.flow.resumed && !mem.flow.reassured && (mem.flow.asked || 1) < 2 && !/\?/.test(text) && text.length < 300) {
            const pq = flows.pendingQuestion(user, l);
            if (pq) { pendingQ = pq; mem.flow.resumed = true; }
        } else if (c.ask && !/\?/.test(text) && text.length < 230) {
            const closer = pickCloser(stage, l, user, c.concern || null);
            if (closer) text += ' ' + closer;
        } else if (opCtl.effectiveMode(user) === 'aggressive' && !/\?/.test(text) && text.length < 150 && AGGR_OK.has(cls.intent) && stage !== 'opposed') {
            // persistent mode: a respectful vote step after most safe replies; a hesitation gets "what is holding you back?"
            const hes = HESITATE_RX.test(message) && stage !== 'committed';
            const closer = hes ? vary(user, l === 'hi' ? ['किस बात पर सोच रहे हैं—बताइए, मैं साफ़ कर दूँ?', 'कोई शंका हो तो खुलकर बताइए, जवाब दूँगी—फिर 16 नवंबर को साथ देंगे ना?'] : ['Kis baat par soch rahe hain—bataiye, main saaf kar doon?', 'Koi shanka ho to khulkar bataiye, jawab dungi—phir 16 Nov ko saath denge na?']) : pickCloser(stage, l, user, c.concern || null);
            if (closer) text += ' ' + closer;
        } else if (opCtl.effectiveMode(user) === 'chill' && c.ask && /\?/.test(text) === false) {
            // chill: no extra push
        }
    }
    // v6 daily lock: the operator's line for today, once per voter, on a calm turn that asks nothing else (kept verbatim)
    let steered = false;
    if (!fr && !mourning && !pendingQ && !/\?/.test(text) && text.length < 230 && !STEER_SKIP.has(cls.intent)) {
        const st = opCtl.steerCloser(user, l);
        if (st) { text += ' ' + st; opCtl.markSteer(user); markLine(user, st); steered = true; }
    }
    if (require('./contact_tags.js').isVirodhiUser(user)) text = require('./contact_tags.js').gentle(text, l); // विरोधी: gentle mode, no vote asks
    return { text, steered, pendingQ, cls, stage, previousStage, ctx, c, flowResult: fr, l, person, hon };
}

/**
 * @param {string} message
 * @param {object} user  user_memory record (mutated)
 * @param {object} [opts] { llm, llmJson, goal, history, meta: { phone, line, test } }
 */
async function respond(message, user = {}, opts = {}) {
    if (user && !user.history) user.history = [];
    const cls = classify(message, user);
    voterMemory.updateFromVoterMessage(user, message, { lastBotText: lastBotText(user), intent: cls.intent, topic: cls.topic });
    if (opts.llmJson && !flows.inFlow(user)) await voterMemory.llmExtract(user, message, opts.llmJson, 2500, { intent: cls.intent });
    voterMemory.rollSummary(user);
    voterMemory.tickTurn(user);
    const t = think(message, user, { ...opts, cls }, true);
    let { text } = t;
    let source = t.flowResult ? 'flow' : 'template';
    let rejected = null;
    const briefed = opCtl.hasBrief(user) || opCtl.effectiveMode(user) !== 'normal' || !!opCtl.lockedToday();
    if (!t.flowResult && !t.steered && opts.llm && (LLM_INTENTS.has(cls.intent) || (briefed && LLM_INTENTS_BRIEF.has(cls.intent) && !(cls.intent === 'greeting' && !(user.history || []).some(h => h.role === 'bot')))) && !cls.all && !cls.person && !cls.news && !cls.insult && !cls.gibberish && !/(घर बुलाना चाहेंगे|ghar bulana chahenge)/i.test(text)) {
        try {
            const sys = buildLLMPrompt(cls, t.ctx, text);
            let out = cleanLLM(await opts.llm(sys, historyTurns(user, opts, 10), message));
            // the model may not add its own question when the draft asks none (or when we re-ask a pending flow question)
            if (out && (!/\?/.test(text) || t.pendingQ)) { const cut = out.replace(/[^.?!।]*\?\s*(😊|🙏)?\s*$/, '').trim(); if (cut.length >= 20) out = cut; }
            const allowed = t.ctx.facts + ' ' + kb.allowedTextFor(t.ctx.items) + ' ' + message + ' ' + text + ' ' + opCtl.lockText(opCtl.lockedToday()) + ' 2026 16 7:30 5:30 40 1';
            const check = (o) => {
                let w = validateLLM(o, { allowedText: allowed, user, l: t.l }) || validateAgainstDraft(o, text, { used: t.c.used || [], l: t.l, person: t.person, user, intent: cls.intent });
                if (!w && t.pendingQ && /\?/.test(String(o))) w = 'extra_question';
                if (!w) w = scriptMismatch(o, t.l);
                if (!w) w = opCtl.leakCheck(o, user, { allowedText: text + ' ' + t.ctx.facts + ' ' + kb.allowedTextFor(t.ctx.items) + ' ' + opCtl.lockText(opCtl.lockedToday()), message });
                return w;
            };
            let why = check(out);
            if (why && /^leak/.test(why)) {
                // one regeneration with a sharper warning, then the template
                const out2 = cleanLLM(await opts.llm(sys + `\nYOUR LAST DRAFT REVEALED THE PRIVATE BRIEF ("${String(out).slice(0, 120)}"). Rewrite WITHOUT any fact, name or place from the brief and without saying you know/were told anything.`, historyTurns(user, opts, 10), message));
                const w2 = out2 ? check(out2) : 'empty';
                if (!w2) { out = out2; why = null; } else why = why + '|retry:' + w2;
            }
            if (!why) { text = String(out).trim(); source = 'llm'; }
            else { source = 'template(llm_rejected:' + why + ')'; rejected = { why, out: String(out || '').slice(0, 300) }; }
        } catch (e) { source = 'template(llm_error)'; }
    }
    if (cls.intent === 'script_pref') t.l = cls.script === 'hinglish' ? 'en' : 'hi';
    if (!t.flowResult && cls.intent !== 'script_pref' && user && replyQuality.isRepeated(text, user)) {
        const alt = redirectVariants(user, t.l, message).find(v => !replyQuality.isRepeated(v, user));
        text = alt || text;
        source += '+redirect';
    }
    // instruction mode: the operator's one-time pending point is woven into this reply, then cleared
    let instrUsed = null;
    if (!t.flowResult && user && user.memory && user.memory.op && user.memory.op.pendingInstr) {
        try {
            const im = require('./instruction_mode.js');
            const w = await im.weavePending(text, user, { llm: opts.llm || null, intent: cls.intent, message, allowedText: t.ctx.facts });
            if (w.used) { text = w.text; source += '+instruction(' + w.how + ')'; instrUsed = w.how; }
        } catch (e) {}
    }
    if (t.pendingQ) text += ' ' + t.pendingQ;
    if (!t.flowResult) text = capVoteAsk(text, user, t.stage);
    if (BALLOT_NUMBER.test(text)) text = text.split(/(?<=[।?!.])\s+/).filter(x => !BALLOT_NUMBER.test(x)).join(' ').trim() || 'मतपत्र में अभय सिंह जी (मोटी आंगली वाले) का नाम देखकर उनके आगे मुहर लगाइए 🙏';
    if (source !== 'llm') text = dialectize(text, user, t.l);
    text = maybeAskScript(text, user, cls, t);
    text = text.charAt(0).toUpperCase() + text.slice(1);
    if (user) voterMemory.markTold(user, t.c.used || []);
    if (t.c.needsAdmin && user) user.needsAdmin = { at: new Date().toISOString(), text: String(message).slice(0, 200), intent: cls.intent };
    return { text, intent: cls.intent, topic: cls.topic, stage: t.stage, previousStage: t.previousStage, needsAdmin: !!t.c.needsAdmin, source, rejected, honorific: t.hon, gender: t.person.gender, facts: t.ctx.items.map(i => i.id), used: t.c.used || [], samasyaId: t.flowResult && t.flowResult.samasyaId, mulaqatId: t.flowResult && t.flowResult.mulaqatId, instructionUsed: instrUsed };
}

/** One-time, early "Hindi or Hinglish?" question (1st or 2nd bot reply). Ignored -> stays Hindi, never asked again. */
function maybeAskScript(text, user, cls, t) {
    if (!user || process.env.SCRIPT_ASK === 'off') return text;
    const m = voterMemory.ensure(user);
    if (m.scriptPref || m.scriptAskedAt || scriptPrefOf(user) || cls.intent === 'script_pref') return text;
    const botTurns = (user.history || []).filter(h => h.role === 'bot').length;
    if (botTurns >= 3) { m.scriptAskedAt = m.scriptAskedAt || 'skipped'; return text; }
    const sensitive = ['abuse', 'condolence', 'wrong_number', 'corruption', 'grievance', 'opposed', 'emoji', 'privacy_probe', 'taunt', 'bribe', 'bribe_others', 'apology', 'no_politics', 'mobility_help', 'guarantee', 'what_q', 'opponent', 'concern_when'].includes(cls.intent) || (cls.intent === 'emoji' && cls.emoji === 'upset');
    const busy = /\?/.test(text) || /((अपना|अपने|अपनी|उनका|उनके|उनकी)[^।?.!]{0,30}(बताइए|बता दीजिए|लिख दीजिए|भेज दीजिए)|\b(apna|apne|apni|unka|unke|unki)\b[^.?!]{0,30}(bataiye|bata dijiye|likh dijiye|bhej dijiye))/i.test(text) || (t && t.flowResult) || flows.inFlow(user) || sensitive;
    // never stack it as a second question: a reply that already asks something defers it (1st-3rd reply), then it is dropped
    if (busy) { if (botTurns >= 2) m.scriptAskedAt = 'skipped'; return text; }
    m.scriptAskedAt = new Date().toISOString();
    return text + (text.length > 160 ? '\n\n' : ' ') + SCRIPT_ASK_HI;
}

/** Strip model artefacts: <think> blocks, wrapping quotes, "Reply:" labels, markdown. */
function cleanLLM(out) {
    if (!out) return out;
    let r = String(out).replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*<\/think>/i, '');
    // generic robotic tail questions ("Kya aapko aur kuch jaanna hai?") add nothing
    r = r.replace(/\s*(kya\s+)?(aap|aapko)\s+[^.?!]{0,40}\b(aur|kuch)\b[^.?!]{0,40}(jaan|jankari|jaankari|madad)[^.?!]*\?\s*(😊|🙏)?\s*$/i, '').replace(/\s*(क्या\s+)?(आप|आपको)\s+[^।?!]{0,40}(और|कुछ)[^।?!]{0,40}(जान|जानकारी|मदद)[^।?!]*\?\s*(😊|🙏)?\s*$/, '');
    r = r.replace(/([.?!।]\s+)([a-z])/g, (m, a, b) => a + b.toUpperCase()).replace(/\babhay singh\b/g, 'Abhay Singh');
    r = r.replace(/^\s*(reply|answer|response|jawab|जवाब|उत्तर)\s*[:：-]\s*/i, '').replace(/\*\*/g, '').replace(/^\s*["“'](.*)["”']\s*$/s, '$1').trim();
    return r;
}

/** Light Haryanvi / Marwari touch on template replies once the voter asked for it. */
function dialectize(text, user, l) {
    const d = user && user.dialectPref;
    if (!d || !text) return text;
    if (d === 'haryanvi') {
        if (l === 'hi') return text.replace(/आपका/g, 'थारा').replace(/आपकी/g, 'थारी').replace(/आपके/g, 'थारे').replace(/ है([।?!])/g, ' सै$1').replace(/ हैं([।?!])/g, ' सैं$1').replace(/अभी /g, 'इब ').replace(/कहाँ/g, 'कड़ै');
        return text.replace(/\b[Aa]apka\b/g, m => (m[0] === 'A' ? 'Thara' : 'thara')).replace(/\b[Aa]apki\b/g, m => (m[0] === 'A' ? 'Thari' : 'thari')).replace(/\b[Aa]apke\b/g, m => (m[0] === 'A' ? 'Thaare' : 'thaare')).replace(/ hai([.?!])/g, ' sai$1').replace(/ hain([.?!])/g, ' sain$1').replace(/\babhi\b/g, 'ib').replace(/\bkahan\b/g, 'kade');
    }
    if (d === 'rajasthani') {
        if (l === 'hi') return text.replace(/आपका/g, 'थारो').replace(/आपकी/g, 'थारी').replace(/आपके/g, 'थारे');
        return text.replace(/\b[Aa]apka\b/g, m => (m[0] === 'A' ? 'Tharo' : 'tharo')).replace(/\b[Aa]apki\b/g, m => (m[0] === 'A' ? 'Thaari' : 'thaari')).replace(/\b[Aa]apke\b/g, m => (m[0] === 'A' ? 'Thaare' : 'thaare'));
    }
    return text;
}

/** Synchronous grounded reply (no LLM, no network) — the backstop used by server.js. */
function respondSync(message, user = {}, opts = {}) {
    const t = think(message, user, opts, false);
    let text = t.text + (t.pendingQ ? ' ' + t.pendingQ : '');
    if (!t.flowResult && replyQuality.isRepeated(text, user)) text = redirectVariants(user, t.l, message).find(v => !replyQuality.isRepeated(v, user)) || text;
    text = dialectize(text, user, t.l);
    voterMemory.markTold(user, t.c.used || []);
    return text.charAt(0).toUpperCase() + text.slice(1);
}

function buildPersuasionNudge(user = {}, goal = {}, now = new Date()) {
    try {
        const planner = require('./followup_planner.js');
        const plan = planner.planFor(user, { goal, now });
        return plan ? plan.text : null;
    } catch (e) { return null; }
}

const SNIPPETS = {};
const KB_TOPIC = {};
module.exports = { BALLOT_NUMBER, scriptPrefOf, setScriptPref, scriptMismatch, maybeAskScript, SCRIPT_ASK_HI, validateAgainstDraft, cleanLLM, dialectize, buildPersuasionNudge, respond, respondSync, classify, personOf, honorific, nameFor, nextStage, boothForWard, validateLLM, pickCloser, buildLLMPrompt, think, inFlow: flows.inFlow, STAGES, SNIPPETS, KB_TOPIC, BANNED, SARPANCH_CLAIM, SYMBOL, PROMISED_DATE, MEDIA_RX };
