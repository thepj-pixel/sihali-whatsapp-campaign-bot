/**
 * Reply Brain v2 — a campaign worker with memory.
 *
 *   1. update the voter's long-term memory from this message (voter_memory.js: rules, + LLM JSON if available)
 *   2. classify intent (greeting, works, complaint, commit, opponent, who-are-you, joke, off-topic, …)
 *   3. retrieve the 3-5 most relevant fact-sheet items (knowledge_base.js) — the ONLY source of claims
 *   4. answer the actual question first, from those items, in the voter's script, with a gender/age honorific,
 *      referencing what the voter told us earlier (memory card), never re-telling a work already told
 *   5. close with ONE short persuasive step tied to the voter's own concern (stage-aware, never repeated)
 *   6. if an LLM is configured it writes the reply from the full context (memory card + rolling summary +
 *      last 10 turns + retrieved facts + stage + goal); its output is validated (script, length, numbers,
 *      banned claims, repetition) and the grounded template is used when it fails
 *
 * Hard rules: never "बाबा जी"; never claim Abhay Singh was sarpanch before (40 साल की सच्ची समाज सेवा /
 * सरपंच प्रतिनिधि); no budgets/rupees, no work counts; no threats, bribes, caste/religion appeals, no attacks
 * on opponents; STOP/बंद/रुको is handled before this module (engagement_policy) and is permanent.
 */
const campaignProfile = require('./campaign_profile.js');
const replyQuality = require('./reply_quality.js');
const kb = require('./knowledge_base.js');
const voterMemory = require('./voter_memory.js');

const STAGES = ['unknown', 'undecided', 'leaning', 'committed', 'opposed'];

// ---------------- language / person ----------------
const hasDevanagari = t => /[\u0900-\u097F]/.test(String(t || ''));

function lang(text, user) {
    if (user && user.languagePreference === 'hinglish') return 'en';
    if (user && user.languagePreference === 'hi') return 'hi';
    if (hasDevanagari(text)) return 'hi';
    if (/[a-z]/i.test(String(text || ''))) return 'en';
    // emoji / digits only: follow what the voter usually writes
    const m = user && user.memory;
    return m && m.language === 'hi' ? 'hi' : 'en';
}

const FEMALE_NAME = /(देवी|कुमारी|बाई|वती|रानी|ममता|सुनीता|अनीता|सरोज|कमला|शारदा|पूजा|प्रियंका|सुमन|\bdevi\b|kumari|\bbai\b|wati|vati|rani\b|sunita|anita|saroj|kamla|pooja|priyanka|suman|mamta|sharda)/i;
const SELF_FEMALE = /(main (ek )?(mahila|aurat|ladki|beti|bahu)|मैं (एक )?(महिला|औरत|लड़की|बेटी|बहू)|hum (mahila|auratein)|didi bol|bahan hoon|बहन हूँ)/i;

function personOf(user = {}, text = '') {
    const v = user.voterProfile || user.lastFoundVoter || null;
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
    // Elder cues in the message ("beta", "bachcha" from elders)
    if (!age && /(\bbeta\b|bachch?a|बेटा|बच्चा|म्हारा छोरा|mhara chhora)/i.test(text) && !/(mera|meri|mere|hamara|hamare|mhara|मेरा|मेरे|हमारा|हमारे|म्हारा)\s+(beta|bachch?a|बेटा|बच्चा)/i.test(text)) age = 60;
    return { gender, age, source };
}

function honorific(person, l) {
    const { gender, age } = person;
    const H = l === 'hi'
        ? { mata: 'माता जी', tai: 'ताई जी', behan: 'बहन जी', dada: 'दादा जी', tau: 'ताऊ जी', bhai: 'भाई साहब', none: 'जी' }
        : { mata: 'Mata ji', tai: 'Tai ji', behan: 'Behan ji', dada: 'Dada ji', tau: 'Tau ji', bhai: 'Bhai sahab', none: 'ji' };
    if (gender === 'F') return age >= 60 ? H.mata : age >= 40 ? H.tai : H.behan;
    if (gender === 'M') return age >= 65 ? H.dada : age >= 45 ? H.tau : H.bhai;
    return age >= 60 ? (l === 'hi' ? 'ताऊ जी' : 'Tau ji') : H.none;
}

/** First name in the reply's script only (a Devanagari name never goes into a Hinglish reply and vice versa). */
function nameFor(user, l) {
    if (!user) return '';
    const v = user.lastFoundVoter || user.voterProfile || {};
    const cands = [user.memory && user.memory.name, user.name, l === 'hi' ? v.name_hi : v.name_en, v.name].filter(Boolean)
        .filter(n => !/ग्रामवासी|contact|voter|समर्थक/i.test(n));
    const ok = cands.find(n => (l === 'hi' ? hasDevanagari(n) : !hasDevanagari(n)));
    return ok ? String(ok).trim().split(/\s+/)[0] : '';
}

// ---------------- intent ----------------
const RX = {
    commitYes: /(pakk?a\b|pakka vote|vote (dalne|daalne|dene) (zaroor )?(aaunga|aaungi|aunga|aungi|aayenge|aaenge)|वोट (डालने|देने) (ज़रूर |जरूर )?(आऊँगा|आऊंगा|आऊँगी|आऊंगी|आएँगे|आएंगे)|vote (to )?(denge|dunga|dungi|dege|de denge|karenge)|aap?ke sath|aapke saath|saath (hai|hain|h)\b|baba ko hi|abhay singh ko hi|support (hai|h|karenge)|hamara vote|mhara vote|पक्का|वोट (देंगे|दूंगा|दूँगा|दूंगी|देगें|दे देंगे|देगा|देगी)|साथ (हैं|है)|समर्थन (है|करेंगे)|आपको ही|अभय सिंह को ही)/i,
    opposed: /(nahi denge|nhi denge|nahi dunga|vote nahi|vote nhi|kisi aur ko|dusre ko|doosre ko|against|virodh me|नहीं देंगे|वोट नहीं|किसी और को|दूसरे को|खिलाफ)/i,
    bribe: /(daru|daaru|sharab|botal|bottle|kitna doge|kitne doge|paise doge|paisa doge|paisa do|note do|पैसे दो|पैसा दो|पैसे दोगे|पैसा दोगे|कितना दोगे|दारू|शराब|बोतल)/i,
    taunt: /((40 saal|चालीस साल|40 साल|aaj tak|आज तक|5 saal|पाँच साल)[^?]{0,20}(kya kiya|क्या किया)|kuch nahi kiya|kuch nhi kiya|kuchh nahi|jhoot|jhooth|chor|farji|farzi|dhongi|bekar|bakwas|kaam hi nahi|कुछ नहीं किया|झूठ|चोर|फर्जी|बेकार|बकवास)/i,
    abuse: /(\bmc\b|\bbc\b|bhosd|madarc|behenc|kutt?e\b|harami|saala|saale|कुत्ते|हरामी|साले|भोस|मादर)/i,
    slip: /(parchi|parchee|voter slip|slip|epic|voter id|mera naam|naam dekh|list me naam|पर्ची|मतदाता सूची|वोटर लिस्ट|मेरा नाम)/i,
    polling: /(kab hai|kab h\b|tarikh|tareekh|date|booth|kahan (vote|dalna)|kidhar vote|kitne baje|time kya|मतदान कब|कब है|तारीख|बूथ|कहाँ वोट|कितने बजे|16 nov)/i,
    meeting: /(milna|milne|mulakat|mulaqat|ghar aao|ghar aa|chaupal|meeting|baat karni|baat karao|phone karo|call karo|मिलना|मुलाकात|घर आओ|चौपाल|बात करनी|बात कराओ|फोन करो)/i,
    future: /(aage kya|aage ka|sankalp|vaada|vada|wada|kya karoge|kya karenge|plan kya|manifesto|आगे क्या|संकल्प|वादा|क्या करोगे|क्या करेंगे)/i,
    works: /(kya kaam|kaun kaun se kaam|ne kya kiya|ne kya karaya|ne kya karwaya|ne kya banwaya|ने क्या किया|ने क्या करवाया|kisne karwa|kisne kiya|kisne banwa|किसने करवा|किसने किया|किसने बनवा|vikas|vikaas|kaam kiya|kaam karwaya|kaam hua|कौन से काम|क्या काम|विकास|काम किया|काम करवाया|काम हुआ)/i,
    aboutBaba: /(kaun (hai|h|hain)|kon (hai|h)|parichay|baare me batao|bare me batao|abhay singh kaun|candidate kaun|कौन हैं|कौन है|परिचय|के बारे में)/i,
    undecided: /(soch(enge| rahe| rhe|na padega| ke| kar)|sochke|sochkar|dekhenge|dekh lenge|tay nahi|tay nhi|abhi pata nahi|pata nhi|decide nahi|सोचेंगे|सोच रहे|सोचकर|देखेंगे|तय नहीं|पता नहीं)/i,
    positive: /(achha kaam|accha kaam|achha hai|accha hai|acha hai|अच्छा है|badhiya|sahi (hai|h)|bahut achha|अच्छा काम|बढ़िया|सही है|बहुत अच्छा|आशीर्वाद)/i,
    family: /(parivar|ghar (ke|wale)|family|biwi|patni|bete|परिवार|घर के|घरवाले)/i,
    thanks: /^(ok+|okay|thik|theek|thik hai|theek hai|dhanyavad|dhanyawad|shukriya|thanks|thank you|👍|🙏|ठीक है|धन्यवाद|शुक्रिया|जी)[\s!.🙏👍]*$/i,
    greet: /^(ram ram|raam raam|namaste|namaskar|hi+|hello|hlo|hey|jai shri ram|pranam|राम राम|नमस्ते|नमस्कार|प्रणाम|जय श्री राम)[\s\w!.🙏]{0,20}$/i,
    howAreYou: /(kaise ho|kese ho|kaisa hai|kya haal|kya hal|sab badhiya|कैसे हो|क्या हाल)/i,
    whoAreYou: /(tum kaun|tum kon|aap kaun ho|ap kaun ho|aap kon ho|kaun bol (raha|rahi|rha|rhi)|kon bol (raha|rahi|rha|rhi)|\bkaun ho\b|\bkon ho\b|bot ho|robot|insaan ho|insan ho|real ho|machine ho|ai ho|तुम कौन|आप कौन हो|कौन बोल रहा|कौन बोल रही|कौन हो|रोबोट|बॉट हो)/i,
    joke: /(joke|chutkula|chutkule|mazak|mazaak|majak|hasao|hansao|हँसाओ|हंसाओ|चुटकुला|मज़ाक|मजाक|😂|🤣)/i,
    offTopic: /(cricket match|match (kaun|kon|kab)|ipl|movie|film|picture (dekh|kab)|mausam|weather|barish kab|baarish kab|gaana|song|modi|rahul gandhi|\bbjp\b|congress|bhajpa|petrol|diesel ka|सिनेमा|आईपीएल|मौसम|बारिश कब|फिल्म|गाना|मोदी|राहुल गांधी|भाजपा|कांग्रेस)/i,
    opponentGeneric: /(virodhi|विरोधी|dusra candidate|doosra candidate|dusre candidate|dusra ummeedwar|dusre ummidwar|samne wala|saamne wala|सामने वाला|दूसरा उम्मीदवार|दूसरे उम्मीदवार|opposition|vipaksh|विपक्ष|vikas purush|विकास पुरुष)/i,
    memoryCheck: /(yaad hai|yaad h\b|yad hai|yaad rakha|याद है|याद रखा|bhool gaye|bhul gaye|भूल गए|maine kya bataya|मैंने क्या बताया|pichli baar (kya|bataya)|पिछली बार)/i,
    wasSarpanch: /((pehle|pahle|पहले|purane|पुराने|already|kabhi)[^?]{0,25}(sarpanch|सरपंच)[^?]{0,15}(the|thi|rahe|reh chuke|रहे|थे|रह चुके|bane)|(sarpanch|सरपंच)\s*(the|thi|rahe|reh chuke|रहे थे|थे|रह चुके|ban chuke))/i
};

const TOPIC_RX = {
    water: /(pani|paani|water|tanki|nal\b|jjm|boring|borewell|पानी|टंकी|नल|बोरवेल)/i,
    drainage: /(nali|naali|drain|sewer|gandagi|safai|kachra|नाली|सीवर|गंदगी|सफाई|कचरा)/i,
    road: /(sadak|road|rasta|raasta|gaddha|kichad|सड़क|रास्ता|गड्ढा|कीचड़)/i,
    electricity: /(bijli|light|khamba|andhera|बिजली|लाइट|खंभा|अंधेरा)/i,
    health: /(hospital|aspatal|doctor|davai|dawai|ilaj|ambulance|अस्पताल|डॉक्टर|दवा|इलाज|एम्बुलेंस)/i,
    youth: /(yuva|naujawan|naukri|job|rozgar|berozgar|khel|ground|gym|stadium|युवा|नौकरी|रोजगार|खेल|मैदान|जिम)/i,
    education: /(school|college|library|padhai|kitab|student|स्कूल|कॉलेज|लाइब्रेरी|पढ़ाई|किताब)/i,
    farming: /(kisan|kheti|khet|fasal|khad|beej|pashu|किसान|खेती|खेत|फसल|खाद|बीज|पशु)/i,
    pension: /(pension|budhape|buzurg|bujurg|पेंशन|बुढ़ापे|बुजुर्ग)/i,
    safety: /(suraksha|safety|chori|cctv|darr|ladkiyon|betiyon|सुरक्षा|चोरी|डर|बेटियों|लड़कियों)/i,
    cremation: /(shmashan|smashan|mokshdham|श्मशान|मोक्षधाम)/i,
    pond: /(johad|talab|talaab|pond|जोहड़|तालाब)/i
};
// brain topic -> knowledge-base topic
const KB_TOPIC = { water: 'water', drainage: 'drainage', road: 'road', electricity: 'electricity', health: 'health', education: 'education', youth: 'youth', farming: 'farming', pension: 'seniors', safety: 'safety', cremation: 'cremation', pond: 'pond' };
const CONCERN_RX = /(problem|pareshani|samasya|samashya|shikayat|dikkat|kab lagegi|kab lagega|kab lagenge|कब लगेगी|कब लगेगा|nahi hai|nhi hai|nahi hua|nhi hua|nahi aata|nhi aata|toot|tuta|band (hai|h)|kharab|kab hoga|kab banega|kab banegi|समस्या|परेशानी|शिकायत|दिक्कत|नहीं है|नहीं हुआ|नहीं आता|टूट|खराब|बंद है|कब होगा|कब बनेगा|कब बनेगी)/i;

function detectTopic(text) {
    for (const [k, rx] of Object.entries(TOPIC_RX)) if (rx.test(text)) return k;
    // richer Hindi/Hinglish synonyms from the knowledge base (cc_lanes, patwar, medicine, ashram, …)
    const t = String(text || '');
    if (t.length >= 4) {
        const kt = kb.detectTopics(t).filter(x => !['community_hall', 'environment'].includes(x) || t.length > 12);
        if (kt.length) return kt[0];
    }
    return null;
}
const kbTopic = t => (t ? (KB_TOPIC[t] || t) : null);

function opponentNames() {
    const p = campaignProfile.load();
    return (Array.isArray(p.opponentNames) ? p.opponentNames : []).map(s => String(s).trim()).filter(s => s.length >= 3);
}
function mentionsOpponent(t) {
    if (RX.opponentGeneric.test(t)) return true;
    const low = t.toLowerCase();
    return opponentNames().some(n => low.includes(n.toLowerCase()));
}

function classify(text, user = {}) {
    const t = String(text || '').trim();
    const topic = detectTopic(t);
    const out = (intent, extra = {}) => ({ intent, topic, ...extra });
    if (!t) return out('unclear');
    if (RX.abuse.test(t)) return out('abuse');
    if (RX.bribe.test(t)) return out('bribe');
    if (RX.opposed.test(t)) return out('opposed');
    if (RX.wasSarpanch.test(t)) return out('was_sarpanch');
    if (RX.commitYes.test(t) && !/\?|kya|क्या/.test(t.slice(-8))) return out('commit', { family: RX.family.test(t) });
    if (mentionsOpponent(t)) return out('opponent', { taunt: RX.taunt.test(t) });
    if (RX.taunt.test(t)) return out('taunt');
    if (RX.whoAreYou.test(t)) return out('who_are_you');
    if (RX.memoryCheck.test(t)) return out('memory_check');
    if (!/(parchi|parchee|slip|epic|voter id|list|पर्ची|सूची|लिस्ट)/i.test(t) && voterMemory.extractName(t) && !/\?/.test(t)) return out('introduce', { name: voterMemory.extractName(t) });
    if (!/\?/.test(t) && !CONCERN_RX.test(t) && !/(chahiye|chaiye|चाहिए)/i.test(t) && /(\b(hu|hoon|hun)\b|हूँ|हूं)/i.test(t) && /(kisan|kheti|student|padhai|fauj|army|police|teacher|master|driver|dukan|naukri karta|job karta|se hu|se hoon|se bol|bol raha|bol rahi|umar|umr|saal ka|saal ki|से हूँ|से हूं|से बोल|बोल रहा|बोल रही|उम्र|साल का|साल की|किसान|छात्र|फौज)/i.test(t) && !RX.commitYes.test(t)) return out('introduce', { name: voterMemory.extractName(t) });
    if (RX.slip.test(t)) return out('voter_slip');
    if (RX.polling.test(t)) return out('polling');
    if (RX.meeting.test(t)) return out('meeting');
    if (topic && CONCERN_RX.test(t)) return out('complaint');
    if (RX.positive.test(t) && !/\?/.test(t)) return out('positive');
    if (RX.future.test(t)) return out('future');
    if (RX.works.test(t) || (topic && /\?|kya|kaun|क्या|कौन/.test(t))) return out('works');
    if (RX.aboutBaba.test(t)) return out('about_baba');
    if (RX.undecided.test(t)) return out('undecided');
    if (topic) return out('complaint');
    if (RX.joke.test(t)) return out('joke');
    if (RX.offTopic.test(t)) return out('off_topic', { party: /(modi|rahul|bjp|congress|bhajpa|मोदी|राहुल|भाजपा|कांग्रेस)/i.test(t) });
    if (voterMemory.extractFamilyVotes(t)) return out('family_votes', { familyVotes: voterMemory.extractFamilyVotes(t) });
    if (RX.positive.test(t)) return out('positive');
    if (RX.thanks.test(t)) return out('thanks');
    if (RX.greet.test(t) || RX.howAreYou.test(t)) return out('greeting');
    // Answer to a question the bot just asked (ward / name / short reply)
    const ward = t.match(/(?:ward|वार्ड|w)\s*[:#-]?\s*(\d{1,2})\b/i) || (/^\d{1,2}$/.test(t) ? [null, t] : null);
    if (ward) return out('gave_ward', { ward: Number(ward[1]) });
    if (t.length <= 25 && !/\?/.test(t)) return out('short_reply');
    return out('unclear');
}

// ---------------- facts ----------------
function factsText() { return (campaignProfile.load().verifiedFacts || []).join('\n'); }
const has = (facts, needle) => facts.toLowerCase().includes(needle.toLowerCase());

/** Legacy one-liners (kept as a last-resort fallback if the fact-sheet vault is missing). Gated on campaign_profile.json. */
const SNIPPETS = {
    water: [{ need: 'JJM water tanks', hi: 'सिहाली खुर्द और सिहाली कलां में JJM की पानी की टंकियाँ, घर-घर नल कनेक्शन और पाइपलाइन का काम हुआ है।', en: 'Sihali Khurd aur Sihali Kalan me JJM ki tankiyan, ghar-ghar nal connection aur pipeline ka kaam hua hai.' }],
    road: [{ need: 'Sihali Kalan-Hadahedi main road', hi: 'सिहाली कलां–हाड़ाहेड़ी मुख्य सड़क पक्की डामर बनी, और आश्रम से सिहाली कलां का रास्ता भी दोबारा बना।', en: 'Sihali Kalan–Hadahedi main road pakki damar bani, aur Ashram se Sihali Kalan ka rasta bhi dobara bana.' }],
    health: [{ need: 'sub-health-centre building', hi: 'अभय सिंह जी ने अपनी पुश्तैनी ज़मीन दान देकर सिहाली खुर्द में उप-स्वास्थ्य केंद्र का भवन बनवाया।', en: 'Abhay Singh ji ne apni pushtaini zameen daan karke Sihali Khurd me up-swasthya kendra ka bhawan banwaya.' }]
};
const AUDIENCE_TOPICS = { F: ['water', 'safety', 'pension', 'education'], M: ['road', 'farming', 'youth', 'water'], none: ['water', 'health', 'youth'] };

function boothForWard(ward, facts) {
    if (!ward) return null;
    const lines = facts.split('\n').filter(f => /^Booth \d+/.test(f));
    for (const f of lines) {
        const wards = (f.match(/wards? ([\d, and]+)/i) || [])[1] || '';
        const nums = (wards.match(/\d+/g) || []).map(Number);
        const extra = (f.match(/plus ward (\d+)/i) || [])[1];
        if (extra) nums.push(Number(extra));
        if (nums.includes(Number(ward))) {
            const m = f.match(/Booth (\d+), room (\d+)/i);
            if (m) return { booth: m[1], room: m[2] };
        }
    }
    return null;
}

// ---------------- persuasion ----------------
function stageOf(user) { return (user && STAGES.includes(user.persuasionStage)) ? user.persuasionStage : 'unknown'; }

function nextStage(current, intent) {
    if (intent === 'commit') return 'committed';
    if (intent === 'opposed') return 'opposed';
    if (intent === 'family_votes') return current === 'opposed' ? current : 'committed';
    if (intent === 'undecided') return current === 'committed' ? 'committed' : 'undecided';
    if (intent === 'positive') return ['committed'].includes(current) ? current : 'leaning';
    if (current === 'unknown' && ['introduce', 'works', 'future', 'about_baba', 'complaint', 'polling', 'meeting', 'voter_slip', 'taunt', 'opponent', 'was_sarpanch', 'memory_check'].includes(intent)) return 'undecided';
    return current;
}

const CLOSERS = {
    unknown: { hi: ['16 नवंबर को अभय सिंह जी का साथ देंगे ना?', 'इस बार अभय सिंह जी को आशीर्वाद देंगे ना?', 'सोमवार 16 नवंबर को अपना वोट अभय सिंह जी को देंगे ना?'],
        en: ['16 November ko Abhay Singh ji ka saath denge na?', 'Is baar Abhay Singh ji ko aashirwad denge na?', 'Somvar 16 November ko apna vote Abhay Singh ji ko denge na?'] },
    undecided: { hi: ['बस इतना सोचिएगा—40 साल से गाँव के सुख-दुख में कौन साथ खड़ा रहा। 16 नवंबर को अभय सिंह जी का साथ देंगे ना?', 'गाँव की इज़्ज़त और काम दोनों देखकर फ़ैसला कीजिए। अभय सिंह जी पर भरोसा करके देखेंगे ना?', 'जो काम करके दिखाए, उसी पर भरोसा बनता है। इस बार अभय सिंह जी का साथ देंगे ना?'],
        en: ['Bas itna sochiyega—40 saal se gaon ke sukh-dukh me kaun saath khada raha. 16 Nov ko Abhay Singh ji ka saath denge na?', 'Gaon ki izzat aur kaam dono dekh kar faisla kijiye. Abhay Singh ji par bharosa karke dekhenge na?', 'Jo kaam karke dikhaye, usi par bharosa banta hai. Is baar Abhay Singh ji ka saath denge na?'] },
    leaning: { hi: ['तो पक्का रहा? 16 नवंबर को अभय सिंह जी को वोट देंगे ना?', 'आपकी बात से हौसला मिला। पक्का वोट देंगे ना, और घर वालों को भी साथ लाएँगे?'],
        en: ['To pakka raha? 16 Nov ko Abhay Singh ji ko vote denge na?', 'Aapki baat se hausla mila. Pakka vote denge na, aur ghar walon ko bhi saath laayenge?'] },
    committed: { hi: ['घर के बाकी वोटरों को भी साथ लेकर आइएगा—सुबह 7:30 से शाम 5:30, राजकीय उच्च माध्यमिक विद्यालय, सिहाली खुर्द।', 'अपने परिवार और पड़ोस में भी अभय सिंह जी की बात पहुँचाइएगा, यही असली साथ है।'],
        en: ['Ghar ke baaki voters ko bhi saath laaiyega—subah 7:30 se shaam 5:30, Govt. Sr. Sec. School, Sihali Khurd.', 'Apne parivar aur padosiyon tak bhi Abhay Singh ji ki baat pahunchaiyega, yahi asli saath hai.'] },
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

/** A closer tied to the voter's own concern, or a stage closer; never one used in the last 4 bot messages. */
function pickCloser(stage, l, user, concern = null) {
    const recent = recentBotText(user, 4).toLowerCase();
    const opts = [];
    if (concern && ['unknown', 'undecided', 'leaning'].includes(stage)) {
        const label = kb.topicLabel(concern.topic, l);
        opts.push(l === 'hi'
            ? `आपकी ${label} वाली बात पर काम अभय सिंह जी ही करवाएँगे—16 नवंबर को उनका साथ देंगे ना?`
            : `Aapki ${label} wali baat par kaam Abhay Singh ji hi karwayenge—16 Nov ko unka saath denge na?`);
    }
    opts.push(...((CLOSERS[stage] || CLOSERS.unknown)[l] || []));
    return opts.find(o => !recent.includes(o.slice(0, 25).toLowerCase())) || null; // null => don't repeat the ask
}

/** Choose the first variant not used in the last few bot messages (canned replies never repeat back-to-back). */
function vary(user, variants) {
    const recent = recentBotText(user, 3).toLowerCase();
    return variants.find(v => !recent.includes(v.slice(0, 22).toLowerCase())) || variants[(((user && user.memory && user.memory.recall && user.memory.recall.turn) || 0)) % variants.length];
}

// ---------------- retrieval glue ----------------
function retrieveFor(message, cls, user, opts = {}) {
    const m = voterMemory.ensure(user);
    const hints = [kbTopic(cls.topic), ...(opts.topics || []), m.lastTopic, ...m.concerns.map(c => c.topic)].filter(Boolean);
    return kb.retrieve(message, { k: 5, exclude: m.toldItems, topics: hints, villages: m.village ? [m.village] : [], type: opts.type || null });
}

/** Render up to `max` lines, preferring items not yet told; marks them told. Returns { text, used, items }. */
function factLines(items, l, user, max = 1) {
    const m = voterMemory.ensure(user);
    // "told" is judged on what the voter actually read: a detail item whose rendering equals a told line is told too
    const toldLines = new Set(m.toldItems.map(id => kb.getItem(id)).filter(Boolean).map(i => kb.render(i, l)));
    const fresh = items.filter(i => !m.toldItems.includes(i.id) && !toldLines.has(kb.render(i, l)));
    if (!fresh.length) return { text: '', used: [], fresh: false }; // never re-tell the same work
    const { lines, used } = kb.renderList(fresh, l, max);
    return { text: lines.join(' '), used, fresh: fresh.length > 0 };
}

function topicItems(topic, l, user, type = null) {
    const m = voterMemory.ensure(user);
    const kt = kbTopic(topic);
    return kb.byTopic(kt, { type, exclude: m.toldItems, villages: m.village ? [m.village] : [] });
}

// ---------------- compose (grounded template) ----------------
function compose(cls, ctx) {
    const { l, hon, facts, user, person, stage, message, items } = ctx;
    const hi = l === 'hi';
    const S = (h, e) => (hi ? h : e);
    const mem = voterMemory.ensure(user);
    const name = nameFor(user, l);
    const greetName = name ? `${name} ${hon}` : hon;
    let body = '', ask = true, needsAdmin = false, used = [];
    const concernNow = mem.concerns.slice().reverse().find(c => c.topic === (kbTopic(cls.topic))) || null;
    const anyConcern = mem.concerns.length ? mem.concerns[mem.concerns.length - 1] : null;
    const addFacts = (list, max = 1) => { const f = factLines(list, l, user, max); used.push(...f.used); return f.text; };

    switch (cls.intent) {
        case 'abuse':
            return { text: vary(user, [
                S(`आपकी नाराज़गी समझ सकती हूँ ${hon}। गाली-गलौज से बात नहीं बनेगी—कोई असली शिकायत हो तो बताइए, सीधे अभय सिंह जी तक पहुँचाऊँगी। 🙏`, `Aapki narazgi samajh sakti hoon ${hon}. Gaali se baat nahi banegi—koi asli shikayat ho to bataiye, seedhe Abhay Singh ji tak pahunchaungi. 🙏`),
                S(`${hon}, गुस्से में कही बात का बुरा नहीं मानती। आराम से बताइए क्या परेशानी है, मैं नोट करके आगे पहुँचाऊँगी। 🙏`, `${hon}, gusse me kahi baat ka bura nahi maanti. Aaram se bataiye kya pareshani hai, main note karke aage pahunchaungi. 🙏`)
            ]), ask: false };
        case 'bribe':
            return { text: vary(user, [
                S(`${hon}, यहाँ कोई पैसा, दारू या लालच नहीं दिया जाता—ये कानून के खिलाफ़ भी है। अभय सिंह जी 40 साल की सेवा और काम के भरोसे पर वोट माँगते हैं। 🙏`, `${hon}, yahan koi paisa, daaru ya laalach nahi diya jata—ye kanoon ke khilaf bhi hai. Abhay Singh ji 40 saal ki seva aur kaam ke bharose vote maangte hain. 🙏`),
                S(`नहीं ${hon}, 5 दिन की दारू से गाँव का भविष्य नहीं संवरता। अभय सिंह जी का साफ़ नियम है—शराब और प्रलोभन मुक्त चुनाव। 🙏`, `Nahi ${hon}, 5 din ki daru se gaon ka bhavishya nahi sanwarta. Abhay Singh ji ka saaf niyam hai—sharab aur pralobhan mukt chunav. 🙏`),
                S(`${hon}, वोट आपका स्वाभिमान है, उसका कोई मोल नहीं। फ़ैसला काम और भरोसे पर कीजिए। 🙏`, `${hon}, vote aapka swabhimaan hai, uska koi mol nahi. Faisla kaam aur bharose par kijiye. 🙏`)
            ]), ask: false };
        case 'opposed': {
            const asked = user && user.context && user.context.askedOpposedReason;
            if (user) { user.context = user.context || {}; user.context.askedOpposedReason = true; }
            body = asked
                ? S(`ठीक है ${hon}, आपकी राय का पूरा सम्मान है। कभी भी कोई काम या बात हो तो यहीं लिखिएगा। 🙏`, `Theek hai ${hon}, aapki raay ka poora samman hai. Kabhi bhi koi kaam ya baat ho to yahin likhiyega. 🙏`)
                : S(`आपकी राय का सम्मान है ${hon}। बस इतना बता दीजिए—कौन-सी बात आपको खटक रही है? सही बात सीधे अभय सिंह जी तक पहुँचेगी।`, `Aapki raay ka samman hai ${hon}. Bas itna bata dijiye—kaun si baat aapko khatak rahi hai? Sahi baat seedhe Abhay Singh ji tak pahunchegi.`);
            return { text: body, ask: false };
        }
        case 'commit':
        case 'family_votes': {
            const fv = cls.familyVotes || voterMemory.extractFamilyVotes(message) || null;
            body = fv
                ? S(`दिल से धन्यवाद ${greetName}! 🙏 घर के ${fv} वोट नोट कर लिए—आपका यही भरोसा अभय सिंह जी की असली ताकत है।`, `Dil se dhanyavad ${greetName}! 🙏 Ghar ke ${fv} vote note kar liye—aapka yahi bharosa Abhay Singh ji ki asli taakat hai.`)
                : S(`दिल से धन्यवाद ${greetName}! 🙏 आपका यही भरोसा अभय सिंह जी की असली ताकत है।`, `Dil se dhanyavad ${greetName}! 🙏 Aapka yahi bharosa Abhay Singh ji ki asli taakat hai.`);
            if (anyConcern) {
                const r = voterMemory.recallPhrase(user, l, { allowSame: true });
                if (r) body += ' ' + r;
            }
            const ward = (user && user.ward) || mem.ward;
            const b = boothForWard(ward, facts);
            if (b && !mem.told.booth) { body += S(` आपका बूथ ${b.booth}, कमरा ${b.room} है।`, ` Aapka booth ${b.booth}, room ${b.room} hai.`); mem.told.booth = true; }
            if (!fv && !mem.familyVotes && !mem.told.familyAsk) {
                body += S(' घर में कितने वोट हैं? सबको 16 नवंबर को साथ लेकर आइएगा।', ' Ghar me kitne vote hain? Sabko 16 November ko saath lekar aaiyega.');
                mem.told.familyAsk = true; ask = false;
            } else if (!user.lastFoundVoter && !mem.told.slipOffer) {
                body += S(' पर्ची चाहिए तो अपना पूरा नाम और पिता/पति का नाम भेज दीजिए।', ' Parchi chahiye to apna poora naam aur pita/pati ka naam bhej dijiye.');
                mem.told.slipOffer = true; ask = false;
            }
            break;
        }
        case 'taunt': {
            const t = cls.topic || (anyConcern && anyConcern.topic) || (AUDIENCE_TOPICS[person.gender || 'none'] || [])[0];
            const list = items.filter(i => i.type === 'done').length ? items.filter(i => i.type === 'done') : topicItems(t, l, user, 'done');
            const sn = addFacts(list, 1);
            body = vary(user, [S(`सवाल पूछना आपका हक़ है ${hon}।`, `Sawal poochna aapka haq hai ${hon}.`), S(`आपकी नाराज़गी समझती हूँ ${hon}—जहाँ काम अटका हो वहाँ गुस्सा आना स्वाभाविक है।`, `Aapki narazgi samajhti hoon ${hon}—jahan kaam atka ho wahan gussa aana swabhavik hai.`)]) +
                (sn ? S(' पर ज़मीन पर ये काम हुआ है: ', ' Par zameen par ye kaam hua hai: ') + sn : '') +
                S(' जहाँ काम अधूरा लगे, वो गली/वार्ड बताइए—प्राथमिकता पर लिखवाऊँगी।', ' Jahan kaam adhoora lage, wo gali/ward bataiye—priority par likhwaungi.');
            ask = false; // the "which lane/ward?" question is the engagement step here
            break;
        }
        case 'opponent': {
            const list = items.filter(i => i.type === 'done');
            const sn = addFacts(list.length ? list : topicItems((anyConcern && anyConcern.topic) || 'water', l, user, 'done'), 1);
            body = vary(user, [
                S(`${hon}, हम किसी उम्मीदवार के बारे में बुरा नहीं कहते—सबका सम्मान है। फ़ैसला काम देखकर कीजिए:`, `${hon}, hum kisi ummeedwar ke baare me bura nahi kehte—sabka samman hai. Faisla kaam dekh kar kijiye:`),
                S(`${hon}, दूसरों पर टिप्पणी करना हमारा तरीका नहीं है। अभय सिंह जी अपने काम से पहचाने जाते हैं:`, `${hon}, doosron par tippani karna hamara tareeka nahi hai. Abhay Singh ji apne kaam se pehchaane jaate hain:`)
            ]) + (sn ? ' ' + sn : S(' 40 साल की सच्ची समाज सेवा।', ' 40 saal ki sachchi samaj seva.'));
            break;
        }
        case 'complaint': {
            const kt = kb.primaryTopic(message, kbTopic(cls.topic)) || (kb.detectTopics(message)[0]);
            const onTopic = items.filter(i => i.topics.includes(kt));
            const ranked = (onTopic.length ? onTopic : items).slice().sort((a, b) => ((b.topics[0] === kt) - (a.topics[0] === kt)) || ((b.type === 'future') - (a.type === 'future')));
            const list = ranked.length ? ranked : topicItems(kt, l, user);
            let sn = addFacts(list, 1);
            if (kt === 'cc_lanes') sn = kb.render(kb.getItem('M10'), l) + (sn && !/jaanch|जाँच/.test(sn) ? ' ' + sn : '');
            if (user) { user.context = user.context || {}; user.context.openComplaint = { topic: cls.topic, at: new Date().toISOString() }; }
            const ward = (user && user.ward) || mem.ward;
            const repeatConcern = concernNow && (concernNow.count || 1) > 1 && concernNow.prevText &&
                (replyQuality.similarity(concernNow.prevText, concernNow.text) >= 0.35 || /(phir se|fir se|dobara|again|फिर से|दोबारा|abhi tak|अभी तक)/i.test(message));
            body = (repeatConcern
                ? S(`${hon}, ${kb.topicLabel(kt, 'hi')} वाली बात आप पहले भी बता चुके हैं—वो दर्ज है, और मैं इसे दोबारा याद दिलाकर ऊपर भिजवा रही हूँ।`, `${hon}, ${kb.topicLabel(kt, 'en')} wali baat aap pehle bhi bata chuke hain—wo darj hai, aur main ise dobara yaad dilakar upar bhijwa rahi hoon.`)
                : S(`आपकी बात नोट कर ली है ${hon}, इसे सीधे अभय सिंह जी की प्राथमिकता सूची में डाल रही हूँ।`, `Aapki baat note kar li hai ${hon}, ise seedhe Abhay Singh ji ki priority list me daal rahi hoon.`)) +
                (sn ? ' ' + sn : '') +
                (ward ? '' : S(' किस वार्ड/गली की बात है, बता देंगे?', ' Kis ward/gali ki baat hai, bata denge?'));
            ask = !!ward;
            if (!sn) needsAdmin = true;
            break;
        }
        case 'works': {
            const t = cls.topic || (AUDIENCE_TOPICS[person.gender || 'none'] || [])[0];
            const kt = kb.primaryTopic(message, kbTopic(cls.topic));
            const msgTopics = kb.detectTopics(message);
            const onTopic = items.filter(i => i.topics.some(x => x === kt || msgTopics.includes(x)));
            const list = onTopic.length ? onTopic : (items.length ? items : topicItems(t, l, user));
            const isJobs = kt === 'jobs';
            let sn = addFacts(list, cls.topic && !isJobs ? 2 : 1);
            if (/(kahan|kaha\b|kidhar|कहाँ|कहां|किधर)/i.test(message)) {
                // only completed works can answer "where is it?" (a sankalp is not a place yet)
                const pool = items.concat(kb.byTopic(kt || t, { type: 'done' })).filter(i => i.type === 'done' && !i.held && (!kt || i.topics.includes(kt)));
                const kw = ((message.match(kb.TOPIC_SYNONYMS[kt || t] || /$^/) || [])[0] || '').toLowerCase();
                const loc = pool.find(i => i.kind === 'detail' && i.location && kw && i.text.toLowerCase().includes(kw)) || pool.find(i => i.kind === 'detail' && i.location) || pool.find(i => i.villages.length);
                if (loc) {
                    const vs = (loc.villages.length ? loc.villages : kb.detectVillages(loc.location)).map(v => kb.villageName(v, l));
                    const noun = ((message.match(kb.TOPIC_SYNONYMS[kt || t] || /$^/) || [])[0] || '').trim();
                    sn = S(`${loc.title.split(' — ')[0]} — ${loc.location || vs.join(', ')} में।`, !vs.length ? `Ye ${kb.topicLabel(kt || t, 'en')} ka kaam panchayat star par hua hai.` : noun ? `${noun.charAt(0).toUpperCase() + noun.slice(1)} ${vs.join(', ')} me hai.` : `Ye ${kb.topicLabel(kt || t, 'en')} wala kaam ${vs.join(', ')} me hua hai.`);
                    used.push(loc.id);
                }
            }
            if (!sn && list.length) {
                const told = list.find(i => !i.held);
                if (told) sn = S('जैसा बताया था—', 'Jaisa bataya tha—') + (l === 'hi' ? told.title : (kb.render(told, 'en') || '').split(/[,.]/)[0]) + S('।', '.');
            }
            if (kt === 'cc_lanes') sn = kb.render(kb.getItem('M10'), l) + S(' अपनी गली/वार्ड बताइए, नोट करके अभय सिंह जी तक पहुँचाऊँगी।', ' Apni gali/ward bataiye, note karke Abhay Singh ji tak pahunchaungi.');
            if (isJobs) { ask = false; sn = S('सच कहूँ तो रोज़गार पर अलग से कोई संकल्प हमारी सूची में दर्ज नहीं है, इसलिए झूठा वादा नहीं करूँगी।', 'Sach kahun to rozgar par alag se koi sankalp hamari list me darj nahi hai, isliye jhootha vaada nahi karungi.') + (sn ? S(' युवाओं के लिए: ', ' Yuvaon ke liye: ') + sn : ''); }
            const allTold = list.length && list.every(i => mem.toldItems.includes(i.id)) && !used.length;
            body = sn || S('इस बारे में पक्की जानकारी टीम से लेकर भेजती हूँ।', 'Is baare me pakki jankari team se lekar bhejti hoon.');
            if (allTold) body = S('जो काम पहले बताए थे, उनके अलावा आपके लिए सबसे ज़रूरी क्या है—पानी, सड़क, पढ़ाई, इलाज या कुछ और?', 'Jo kaam pehle bataye the, unke alawa aapke liye sabse zaroori kya hai—paani, sadak, padhai, ilaj ya kuch aur?');
            if (!sn) needsAdmin = true;
            break;
        }
        case 'future': {
            const fut = items.filter(i => i.type === 'future');
            const t = cls.topic || (person.gender === 'F' ? 'safety' : 'youth');
            const list = fut.length ? fut : topicItems(t, l, user, 'future');
            const ft = kb.primaryTopic(message, kbTopic(cls.topic));
            const onT = ft ? list.filter(i => i.topics.includes(ft)) : [];
            let sn = addFacts(onT.length ? onT : list, 2);
            if (onT.length && !onT.some(i => used.includes(i.id))) {
                const told = onT[0];
                const head = S('जैसा बताया था—', 'Jaisa bataya tha—') + (l === 'hi' ? told.title : (kb.render(told, 'en') || '').split(/[,.]/)[0]) + S('।', '.');
                sn = head + (sn && !onT.length ? ' ' + sn : '');
            }
            body = sn || S('आगे के संकल्पों की पूरी सूची जल्द भेजती हूँ।', 'Aage ke sankalpon ki poori list jaldi bhejti hoon.');
            break;
        }
        case 'about_baba':
            body = S(`अभय सिंह जी (मोटी आंगली वाले) ग्राम पंचायत सिहाली खुर्द से सरपंच प्रत्याशी हैं—40 साल की सच्ची समाज सेवा और भाईचारे के लिए जाने जाते हैं।`, `Abhay Singh ji (Moti Aangli wale) Gram Panchayat Sihali Khurd se Sarpanch pratyashi hain—40 saal ki sachchi samaj seva aur bhaichare ke liye jaane jaate hain.`);
            if (!mem.toldItems.includes('M1')) { body += S(' अपनी निजी ज़मीन दान देकर गाँव का उप-स्वास्थ्य केंद्र बनवाया।', ' Apni niji zameen daan karke gaon ka up-swasthya kendra banwaya.'); used.push('M1'); }
            break;
        case 'was_sarpanch':
            body = S(`नहीं ${hon}, अभय सिंह जी खुद पहले सरपंच नहीं रहे। पिछले कार्यकाल में सरपंच प्रतिनिधि के तौर पर और 40 साल की सच्ची समाज सेवा में उन्होंने गाँव के काम करवाए—इस बार वे खुद सरपंच प्रत्याशी हैं।`, `Nahi ${hon}, Abhay Singh ji khud pehle sarpanch nahi rahe. Pichhle karyakal me sarpanch pratinidhi ke taur par aur 40 saal ki sachchi samaj seva me unhone gaon ke kaam karwaye—is baar wo khud sarpanch pratyashi hain.`);
            break;
        case 'polling': {
            const b = boothForWard((user && user.ward) || mem.ward, facts);
            body = S('मतदान सोमवार, 16 नवंबर 2026 को सुबह 7:30 से शाम 5:30 तक राजकीय उच्च माध्यमिक विद्यालय, सिहाली खुर्द में है।', 'Matdaan Somvar, 16 November 2026 ko subah 7:30 se shaam 5:30 tak Govt. Sr. Sec. School, Sihali Khurd me hai.') +
                (b ? S(` आपका बूथ ${b.booth}, कमरा ${b.room}।`, ` Aapka booth ${b.booth}, room ${b.room}.`) : S(' अपना वार्ड बताइए, बूथ-कमरा भी बता दूँगी।', ' Apna ward bataiye, booth-room bhi bata doongi.'));
            mem.told.pollDate = true; if (b) mem.told.booth = true;
            ask = !!b;
            break;
        }
        case 'meeting':
            if (user) user.wantsVisit = true;
            needsAdmin = true;
            body = S(`ज़रूर ${hon}! मुलाकात की बात टीम को भेज दी है, जल्द फ़ोन आएगा। अपना वार्ड और सही समय बता दीजिए।`, `Zaroor ${hon}! Mulakat ki baat team ko bhej di hai, jaldi phone aayega. Apna ward aur sahi samay bata dijiye.`);
            ask = false;
            break;
        case 'introduce': {
            const nm = nameFor(user, l) || cls.name || '';
            const ward = (user && user.ward) || mem.ward;
            const b = boothForWard(ward, facts);
            body = vary(user, [S(`${nm ? nm + ' ' : ''}${hon}, आपसे जुड़कर बहुत अच्छा लगा! 🙏`, `${nm ? nm + ' ' : ''}${hon}, aapse judkar bahut achha laga! 🙏`), S(`राम राम ${nm ? nm + ' ' : ''}${hon}! 🙏 नाम नोट कर लिया।`, `Ram Ram ${nm ? nm + ' ' : ''}${hon}! 🙏 Naam note kar liya.`)]);
            if (ward) body += S(` वार्ड ${ward} नोट है`, ` Ward ${ward} note hai`) + (b ? S(`—आपका बूथ ${b.booth}, कमरा ${b.room} रहेगा।`, `—aapka booth ${b.booth}, room ${b.room} rahega.`) : S('।', '.'));
            if (b) mem.told.booth = true;
            body += mem.concerns.length ? '' : S(' आपके यहाँ सबसे ज़रूरी काम कौन-सा है—पानी, सड़क, नाली या कुछ और?', ' Aapke yahan sabse zaroori kaam kaun sa hai—paani, sadak, naali ya kuch aur?');
            ask = !!mem.concerns.length;
            break;
        }
        case 'voter_slip':
            body = S(`पर्ची अभी निकाल देती हूँ ${hon}—अपना पूरा नाम और पिता/पति का नाम लिख भेजिए।`, `Parchi abhi nikaal deti hoon ${hon}—apna poora naam aur pita/pati ka naam likh bhejiye.`);
            ask = false;
            break;
        case 'undecided': {
            body = vary(user, [S(`कोई बात नहीं ${hon}, सोच-समझकर फ़ैसला करना ही सही है।`, `Koi baat nahi ${hon}, soch-samajh kar faisla karna hi sahi hai.`), S(`बिल्कुल ${hon}, आराम से सोचिए—वोट आपका हक़ है।`, `Bilkul ${hon}, aaram se sochiye—vote aapka haq hai.`)]);
            const tlist = [anyConcern && anyConcern.topic, ...(AUDIENCE_TOPICS[person.gender || 'none'] || []), 'water', 'health', 'road', 'youth', 'education'].filter(Boolean);
            let sn = '';
            for (const t of tlist) { sn = addFacts(topicItems(t, l, user, t === (anyConcern && anyConcern.topic) ? null : 'done'), 1); if (sn) break; }
            if (sn) body += S(' एक बात याद रखिएगा: ', ' Ek baat yaad rakhiyega: ') + sn;
            break;
        }
        case 'positive':
            body = vary(user, [S(`आपके आशीर्वाद के लिए धन्यवाद ${greetName}! 🙏`, `Aapke aashirwad ke liye dhanyavad ${greetName}! 🙏`), S(`आपकी बात सुनकर अच्छा लगा ${greetName}! 🙏`, `Aapki baat sunkar achha laga ${greetName}! 🙏`)]);
            break;
        case 'thanks': {
            const r = voterMemory.recallPhrase(user, l);
            const jiOnly = /^(जी|ji)$/i.test(hon);
            body = vary(user, [jiOnly ? S('जी 🙏', 'Ji 🙏') : S(`जी ${hon} 🙏`, `Ji ${hon} 🙏`), S(`आपका भी धन्यवाद ${hon} 🙏`, `Aapka bhi dhanyavad ${hon} 🙏`), S(`हमेशा आपकी सेवा में ${hon} 🙏`, `Hamesha aapki seva me ${hon} 🙏`)]) + (r ? ' ' + r : '');
            if (stage === 'committed') ask = false;
            break;
        }
        case 'greeting': {
            const greeted = user && user.context && user.context.greetedOnce;
            const returning = greeted || (mem.concerns.length > 0) || (user && user.interactionCount > 3);
            if (returning) {
                const r = voterMemory.recallPhrase(user, l, { force: mem.concerns.length > 0 });
                body = vary(user, [
                    S(`राम राम ${greetName}! 🙏 फिर से बात करके अच्छा लगा।`, `Ram Ram ${greetName}! 🙏 Phir se baat karke achha laga.`),
                    S(`राम राम ${greetName}! 🙏 घर में सब राज़ी-ख़ुशी?`, `Ram Ram ${greetName}! 🙏 Ghar me sab raazi-khushi?`),
                    S(`प्रणाम ${greetName}! 🙏 बताइए, आज क्या सेवा करूँ?`, `Pranam ${greetName}! 🙏 Bataiye, aaj kya seva karun?`)
                ]) + (r ? ' ' + r : '');
                if (stage === 'committed' || r) ask = false;
            } else {
                body = S(`राम राम ${greetName}! 🙏 घर-परिवार में सब कुशल-मंगल?`, `Ram Ram ${greetName}! 🙏 Ghar-parivar me sab kushal-mangal?`);
                if (stage !== 'committed') { body += S(' आपके मोहल्ले में इस बार चुनाव का क्या माहौल है?', ' Aapke mohalle me is baar chunav ka kya mahaul hai?'); ask = false; }
            }
            if (user) { user.context = user.context || {}; user.context.greetedOnce = true; }
            break;
        }
        case 'who_are_you':
            if (mem.told.whoAmI || /(bot|robot|insaan|insan|real|machine|\bai\b|रोबोट|बॉट|इंसान)/i.test(message)) {
                const jo = /^(जी|ji)$/i.test(hon);
                body = S(`जी${jo ? '' : ' ' + hon}, मैं ऑटोमेटेड डिजिटल सहायिका हूँ, इंसान नहीं—पर आपकी हर बात टीम तक पहुँचती है। बात करनी हो तो टीम का साथी खुद फ़ोन करेगा।`, `Ji${jo ? '' : ' ' + hon}, main automated digital sahayika hoon, insaan nahi—par aapki har baat team tak pahunchti hai. Baat karni ho to team ka saathi khud phone karega.`);
                mem.told.whoAmI = true; ask = false;
                break;
            }
            body = S(`मैं सुमन हूँ ${hon}—बाबा अभय सिंह जनसंपर्क टीम की डिजिटल सहायिका (ऑटोमेटेड)। वोटर पर्ची, बूथ, गाँव के काम या कोई शिकायत—सबमें मदद करती हूँ; ज़रूरत हो तो टीम का कोई साथी खुद फ़ोन करेगा।`, `Main Suman hoon ${hon}—Baba Abhay Singh jansampark team ki digital sahayika (automated). Voter parchi, booth, gaon ke kaam ya koi shikayat—sabme madad karti hoon; zaroorat ho to team ka koi saathi khud phone karega.`);
            mem.told.whoAmI = true; ask = false;
            break;
        case 'joke':
            body = vary(user, [
                S(`😄 हँसी-मज़ाक से ही तो गाँव की चौपाल में रौनक है ${hon}! वैसे सच्ची ख़ुशी तब होगी जब हर घर नल में मीठा पानी आएगा—उसी का संकल्प है।`, `😄 Hansi-mazaak se hi to gaon ki chaupal me raunak hai ${hon}! Waise sachchi khushi tab hogi jab har ghar nal me meetha paani aayega—usi ka sankalp hai.`),
                S(`😄 आप तो बड़े ज़िंदादिल हैं ${hon}! ऐसे ही मुस्कुराते रहिए—और 16 नवंबर को वोट डालना मत भूलिएगा।`, `😄 Aap to bade zindadil hain ${hon}! Aise hi muskurate rahiye—aur 16 November ko vote daalna mat bhooliyega.`)
            ]);
            break;
        case 'off_topic':
            body = cls.party
                ? S(`${hon}, ये पंचायत का चुनाव है—इसमें किसी पार्टी की बात नहीं, बस गाँव के काम और भरोसे की बात है।`, `${hon}, ye panchayat ka chunav hai—isme kisi party ki baat nahi, bas gaon ke kaam aur bharose ki baat hai.`)
                : S(`इसकी पक्की जानकारी मेरे पास नहीं है ${hon} 🙏 मैं गाँव के काम, वोटर पर्ची और चुनाव की जानकारी में मदद करती हूँ।`, `Iski pakki jankari mere paas nahi hai ${hon} 🙏 Main gaon ke kaam, voter parchi aur chunav ki jankari me madad karti hoon.`);
            body += S(' आपके घर-मोहल्ले में सबसे ज़रूरी काम क्या है?', ' Aapke ghar-mohalle me sabse zaroori kaam kya hai?');
            ask = false;
            break;
        case 'memory_check': {
            const asked = kb.primaryTopic(message, kbTopic(cls.topic));
            const r = voterMemory.recallPhrase(user, l, { allowSame: true, force: true, preferTopic: asked });
            const recalledConcern = voterMemory.concernToRecall(user, { allowSame: true, preferTopic: asked });
            const extra = [];
            if (mem.ward) extra.push(S(`वार्ड ${mem.ward}`, `ward ${mem.ward}`));
            if (mem.familyVotes) extra.push(S(`घर के ${mem.familyVotes} वोट`, `ghar ke ${mem.familyVotes} vote`));
            body = r ? S(`बिल्कुल याद है ${hon}! `, `Bilkul yaad hai ${hon}! `) + r + (extra.length ? S(` (${extra.join(', ')} भी नोट है।)`, ` (${extra.join(', ')} bhi note hai.)`) : '')
                : S(`अभी तक आपने कोई खास समस्या नहीं बताई ${hon}—बताइए, नोट करके अभय सिंह जी तक पहुँचाऊँगी।`, `Abhi tak aapne koi khaas samasya nahi batayi ${hon}—bataiye, note karke Abhay Singh ji tak pahunchaungi.`);
            if (r && recalledConcern) {
                const sn = addFacts(topicItems(recalledConcern.topic, l, user), 1);
                if (sn) body += ' ' + sn;
            }
            break;
        }
        case 'gave_ward': {
            if (user && cls.ward) user.ward = cls.ward;
            if (cls.ward) mem.ward = cls.ward;
            const b = boothForWard(cls.ward, facts);
            const open = user && user.context && user.context.openComplaint;
            body = S(`वार्ड ${cls.ward} नोट कर लिया ${hon}।`, `Ward ${cls.ward} note kar liya ${hon}.`) +
                (open ? S(' आपकी शिकायत इसी वार्ड के नाम से टीम को भेज दी है।', ' Aapki shikayat isi ward ke naam se team ko bhej di hai.') : '') +
                (b ? S(` आपका बूथ ${b.booth}, कमरा ${b.room} रहेगा।`, ` Aapka booth ${b.booth}, room ${b.room} rahega.`) : '');
            if (b) mem.told.booth = true;
            if (open) {
                needsAdmin = true;
                if (mem.openFollowUp && !mem.openFollowUp.ward) mem.openFollowUp.ward = cls.ward;
                const c = mem.concerns[mem.concerns.length - 1]; if (c && !c.ward) c.ward = cls.ward;
            }
            break;
        }
        case 'short_reply': {
            const r = voterMemory.recallPhrase(user, l);
            body = vary(user, [/^(जी|ji)$/i.test(hon) ? S('जी।', 'Ji.') : S(`जी ${hon}।`, `Ji ${hon}.`), S(`अच्छा ${hon}।`, `Achha ${hon}.`), S(`समझ गई ${hon}।`, `Samajh gayi ${hon}.`)]) + (r ? ' ' + r : '');
            break;
        }
        default: // unclear: one short clarifying question, flag admin
            needsAdmin = true;
            return {
                text: vary(user, [
                    S(`माफ़ कीजिए ${hon}, ठीक से समझ नहीं पाई। आपको वोटर पर्ची चाहिए, गाँव की कोई समस्या बतानी है, या अभय सिंह जी से कुछ पूछना है?`, `Maaf kijiye ${hon}, theek se samajh nahi paayi. Aapko voter parchi chahiye, gaon ki koi samasya batani hai, ya Abhay Singh ji se kuch poochna hai?`),
                    S(`${hon}, थोड़ा खुलकर बताएँगे? पर्ची, बूथ, या गाँव का कोई काम—किस बारे में बात करें?`, `${hon}, thoda khulkar batayenge? Parchi, booth, ya gaon ka koi kaam—kis baare me baat karein?`)
                ]),
                ask: false, needsAdmin, used
            };
    }
    const recalled = /(बताई थी|batayi thi)/.test(body);
    return { text: body, ask, needsAdmin, used, concern: recalled ? null : (concernNow || anyConcern) };
}

// ---------------- LLM writing + validation ----------------
const BANNED = /(बाबा जी|बाबाजी|\bbaba ji\b|\bbabaji\b|पैसे देंगे|पैसा देंगे|दारू देंगे|paise denge|daru denge|देख लेंगे तुम्हें|अंजाम|धमकी|dhamki|जाति|धर्म के नाम|हिंदू|मुसलमान|जाट|यादव|गुर्जर|मेघवाल|ब्राह्मण|\bjaat\b|as an ai|i'm sorry|i cannot)/i;
const SARPANCH_CLAIM = /((पहले|पूर्व|पिछले कार्यकाल में)\s*(भी\s*)?सरपंच\s*(रहे|थे|रह चुके)|सरपंच\s*(रहते|रहे थे|रह चुके)|former sarpanch|ex[- ]sarpanch|(pehle|purv|pichhle)\s*(bhi\s*)?sarpanch\s*(rahe|the|reh chuke)|sarpanch (rehte|reh chuke))/i;
const OPPONENT_ATTACK = /(उनके (झूठ|चोर)|वो (चोर|झूठे)|wo (chor|jhoothe)|unke jhooth|किस बिल में|kis bil me|बिकाऊ|bikau)/i;
const MONEY = /(₹|रुपये|रुपए|लाख|करोड़|\blakh\b|crore|rupees?|rupaye|budget|बजट|लागत)/i;
const FAKE_DELIVERY = /(पर्ची भेज दी|parchi bhej di|slip bhej di)/i;
const WORK_COUNT = /(\d+\s*\+?\s*(काम|कार्य|संकल्प|सड़कें|kaam|sankalp|works))/i;

function validateLLM(reply, { allowedText, user, l } = {}) {
    if (!reply) return 'empty';
    const r = String(reply).trim();
    if (r.length > 480) return 'too_long';
    if (BANNED.test(r)) return 'banned';
    if (SARPANCH_CLAIM.test(r)) return 'sarpanch_claim';
    if (OPPONENT_ATTACK.test(r)) return 'opponent_attack';
    if (MONEY.test(r)) return 'money';
    if (FAKE_DELIVERY.test(r)) return 'fake_slip_delivery';
    if (WORK_COUNT.test(r)) return 'work_count';
    if (l === 'hi' && !hasDevanagari(r)) return 'wrong_script';
    if (l === 'en' && hasDevanagari(r)) return 'wrong_script';
    const nums = r.match(/\d+(?:[.:]\d+)?/g) || [];
    for (const n of nums) if (!String(allowedText || '').includes(n)) return 'new_number:' + n;
    if (user && replyQuality.isRepeated(r, user)) return 'repeated';
    return null;
}

function historyTurns(user, opts, n = 10) {
    const h = (user && Array.isArray(user.history) && user.history.length ? user.history : []).filter(x => x && x.text);
    const turns = h.length ? h.map(x => ({ role: x.role === 'bot' ? 'assistant' : 'user', content: String(x.text).slice(0, 400) })) : (opts.history || []);
    // the current message is passed separately
    const trimmed = turns.slice();
    if (trimmed.length && trimmed[trimmed.length - 1].role === 'user') trimmed.pop();
    return trimmed.slice(-n);
}

function buildLLMPrompt(cls, ctx, draft) {
    const { l, hon, person, stage, goal, user, items } = ctx;
    const facts = ctx.facts.split('\n').filter(f => /^(Candidate|Polling|Booth|Operator-provided service|CONTENT HOLD)/.test(f));
    const card = voterMemory.buildCard(user);
    const summary = voterMemory.summaryText(user);
    const factLinesTxt = (items || []).filter(i => !i.held).slice(0, 5).map(i => `- [${i.type === 'future' ? 'FUTURE SANKALP' : 'DONE'}] ${i.title}: ${i.desc}${i.location ? ' (' + i.location + ')' : ''}${(user.memory && user.memory.toldItems || []).includes(i.id) ? ' (already told — do not repeat unless asked)' : ''}`);
    return [
        'You are "Suman", a warm, sharp village campaign worker (female; use feminine verbs: करती हूँ / karti hoon) for Abhay Singh (Moti Aangli wale), Sarpanch candidate, Gram Panchayat Sihali Khurd (Sihali Khurd, Sihali Kalan, Hadahedi). Poll: Monday 16 Nov 2026, 7:30 AM-5:30 PM, Govt. Sr. Sec. School Sihali Khurd.',
        `Write ONE short WhatsApp reply (max 3 short sentences). Language: ${l === 'hi' ? 'Devanagari Hindi (Haryanvi/Ahirwal warmth welcome)' : 'simple Roman Hinglish, NO Devanagari'}${user.memory && user.memory.dialect ? ', with a light ' + user.memory.dialect + ' flavour' : ''}. Address the voter as "${hon}".`,
        `Intent: ${cls.intent}${cls.topic ? ' (topic ' + cls.topic + ')' : ''}. Persuasion stage: ${stage}. Gender: ${person.gender || 'unknown'}.`,
        goal ? `Today's campaign focus: ${goal}` : '',
        'VOTER MEMORY CARD (what this voter told us before — use it, refer back to it naturally):', card || '(new voter)',
        summary ? 'OLDER CONVERSATION SUMMARY: ' + summary : '',
        'HOW TO REPLY: 1) answer the actual message first; 2) if relevant, refer to something the voter said earlier (their concern/ward/family); 3) never repeat a pitch or work already told; 4) end with ONE short persuasive step toward a committed vote for Abhay Singh tied to their own concern (skip for opposed/abuse/bribe; if already committed, ask for family votes or offer booth/slip instead).',
        'HARD RULES: use ONLY the facts below — no other works, numbers, dates or promises; never mention budgets/rupees or counts of works; call him "अभय सिंह जी"/"बाबा अभय सिंह", never just "बाबा जी"; never say he was sarpanch before (he served as सरपंच प्रतिनिधि; 40 साल की सच्ची समाज सेवा); never attack or name-call opponents; no threats, no money/gifts/liquor, no caste or religion; never claim a voter slip was sent.',
        'FACTS (fact sheets):', ...factLinesTxt, ...facts.map(f => '- ' + f),
        `SAFE DRAFT (grounded; you may improve wording, keep its facts): ${draft}`
    ].filter(Boolean).join('\n');
}

const LLM_INTENTS = new Set(['introduce', 'works', 'future', 'about_baba', 'complaint', 'taunt', 'undecided', 'greeting', 'positive', 'commit', 'family_votes', 'opponent', 'off_topic', 'joke', 'memory_check', 'who_are_you', 'unclear', 'short_reply', 'thanks', 'was_sarpanch', 'meeting']);

function redirectVariants(user, l, message) {
    const hon = honorific(personOf(user, message), l);
    const jiOnly = /^(जी|ji)$/i.test(hon);
    const c = voterMemory.concernToRecall(user, { allowSame: true });
    const label = c ? kb.topicLabel(c.topic, l) : null;
    return l === 'hi'
        ? [label ? `${hon}, ${label} वाली बात मेरे पास दर्ज है। कोई और बात—पर्ची, बूथ या घर के वोट—जिसमें मदद करूँ?` : `${hon}, बताइए और किस बात में मदद करूँ—पर्ची, बूथ या गाँव का कोई काम?`,
            jiOnly ? 'जी, आपकी बात समझ ली। कोई नया सवाल हो तो बेझिझक पूछिए 🙏' : `जी ${hon}, आपकी बात समझ ली। कोई नया सवाल हो तो बेझिझक पूछिए 🙏`,
            `${hon}, मैं यहीं हूँ—जो भी जानना हो, लिख दीजिए।`]
        : [label ? `${hon}, ${label} wali baat mere paas darj hai. Koi aur baat—parchi, booth ya ghar ke vote—jisme madad karun?` : `${hon}, bataiye aur kis baat me madad karun—parchi, booth ya gaon ka koi kaam?`,
            jiOnly ? 'Ji, aapki baat samajh li. Koi naya sawal ho to bejhijhak poochiye 🙏' : `Ji ${hon}, aapki baat samajh li. Koi naya sawal ho to bejhijhak poochiye 🙏`,
            `${hon}, main yahin hoon—jo bhi jaanna ho, likh dijiye.`];
}

/**
 * @param {string} message
 * @param {object} user  user_memory record (mutated: memory, stage, context, needsAdmin)
 * @param {object} [opts] { llm: async (systemPrompt, history, message) => string|null,
 *                          llmJson: async (prompt) => string|null  (fact extraction),
 *                          goal: string, history: [] }
 */
async function respond(message, user = {}, opts = {}) {
    if (user && !user.history) user.history = [];
    const facts = factsText();
    const l = lang(message, user);
    const cls = classify(message, user);
    const prevBot = lastBotText(user);
    // 1. memory
    voterMemory.updateFromVoterMessage(user, message, { lastBotText: prevBot, intent: cls.intent, topic: kbTopic(cls.topic) });
    if (opts.llmJson) await voterMemory.llmExtract(user, message, opts.llmJson);
    voterMemory.rollSummary(user);
    voterMemory.tickTurn(user);
    const mem = user.memory;
    const person = personOf(user, message);
    const hon = honorific(person, l);
    const previousStage = stageOf(user);
    const stage = nextStage(previousStage, cls.intent);
    if (user) {
        user.persuasionStage = stage;
        if (stage !== previousStage) {
            user.persuasionHistory = (user.persuasionHistory || []).concat([{ from: previousStage, to: stage, at: new Date().toISOString(), intent: cls.intent }]).slice(-20);
        }
        if (person.gender && person.source !== 'name') user.genderDetected = person.gender;
        if (person.gender) user.genderGuess = person.gender;
        if (mem.ward && !user.ward) user.ward = mem.ward;
    }
    // 2. retrieval (only for intents that talk about works / promises)
    const wantsFacts = ['works', 'future', 'complaint', 'taunt', 'opponent', 'undecided', 'memory_check'].includes(cls.intent);
    const items = wantsFacts ? retrieveFor(message, cls, user, { type: cls.intent === 'future' ? 'future' : null }) : [];
    const ctx = { l, hon, facts, user, person, stage, goal: opts.goal || '', message, items };
    // 3. grounded draft
    const c = compose(cls, ctx);
    let text = c.text;
    if (c.ask) {
        const closer = pickCloser(stage, l, user, c.concern || null);
        if (closer) text += ' ' + closer;
    }
    let source = 'template';
    // 4. LLM writes from the full context, validated against the same facts
    if (opts.llm && LLM_INTENTS.has(cls.intent)) {
        try {
            const sys = buildLLMPrompt(cls, ctx, text);
            const out = await opts.llm(sys, historyTurns(user, opts, 10), message);
            const allowed = facts + ' ' + kb.allowedTextFor(items) + ' ' + message + ' ' + text + ' 2026 16 7:30 5:30';
            const why = validateLLM(out, { allowedText: allowed, user, l });
            if (!why) { text = String(out).trim(); source = 'llm'; }
            else source = 'template(llm_rejected:' + why + ')';
        } catch (e) { source = 'template(llm_error)'; }
    }
    // 5. never repeat ourselves (exact or near-duplicate of the last 6 bot messages)
    if (user && replyQuality.isRepeated(text, user)) {
        const alt = redirectVariants(user, l, message).find(v => !replyQuality.isRepeated(v, user));
        text = alt || text;
        source += '+redirect';
    }
    text = text.charAt(0).toUpperCase() + text.slice(1);
    if (user) voterMemory.markTold(user, c.used || []);
    if (c.needsAdmin && user) user.needsAdmin = { at: new Date().toISOString(), text: String(message).slice(0, 200), intent: cls.intent };
    return { text, intent: cls.intent, topic: cls.topic, stage, previousStage, needsAdmin: !!c.needsAdmin, source, honorific: hon, gender: person.gender, facts: items.map(i => i.id), used: c.used || [] };
}

/**
 * Synchronous grounded reply (no LLM, no network). Used as the backstop when the async path fails,
 * replacing the legacy getFastLocalAnswer canned engine.
 */
function respondSync(message, user = {}) {
    if (user && !user.history) user.history = [];
    const facts = factsText();
    const l = lang(message, user);
    const cls = classify(message, user);
    voterMemory.updateFromVoterMessage(user, message, { lastBotText: lastBotText(user), intent: cls.intent, topic: kbTopic(cls.topic) });
    voterMemory.tickTurn(user);
    const person = personOf(user, message);
    const hon = honorific(person, l);
    const stage = nextStage(stageOf(user), cls.intent);
    if (user) user.persuasionStage = stage;
    const wantsFacts = ['works', 'future', 'complaint', 'taunt', 'opponent', 'undecided', 'memory_check'].includes(cls.intent);
    const items = wantsFacts ? retrieveFor(message, cls, user, { type: cls.intent === 'future' ? 'future' : null }) : [];
    const c = compose(cls, { l, hon, facts, user, person, stage, goal: '', message, items });
    let text = c.text;
    if (c.ask) { const cl = pickCloser(stage, l, user, c.concern || null); if (cl) text += ' ' + cl; }
    if (replyQuality.isRepeated(text, user)) text = redirectVariants(user, l, message).find(v => !replyQuality.isRepeated(v, user)) || text;
    voterMemory.markTold(user, c.used || []);
    return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Proactive follow-up (legacy entry point kept for server.js compatibility) — now delegates to the
 * follow-up planner which uses the voter's memory. Returns text or null.
 */
function buildPersuasionNudge(user = {}, goal = {}, now = new Date()) {
    try {
        const planner = require('./followup_planner.js');
        const plan = planner.planFor(user, { goal, now });
        return plan ? plan.text : null;
    } catch (e) { return null; }
}

module.exports = { buildPersuasionNudge, respond, respondSync, classify, personOf, honorific, nameFor, nextStage, boothForWard, validateLLM, pickCloser, buildLLMPrompt, STAGES, SNIPPETS, KB_TOPIC, BANNED, SARPANCH_CLAIM };
