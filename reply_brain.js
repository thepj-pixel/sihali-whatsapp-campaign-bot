/**
 * Reply Brain — understand first, then answer that specific thing.
 *
 *   1. read the message + stored context (topic, last concern, stage, ward, voter record)
 *   2. classify intent
 *   3. pick only the verified facts relevant to that intent (campaign_profile.json)
 *   4. compose a short reply in the person's script (Devanagari / Hinglish), with a
 *      gender- and age-aware honorific, and ONE persuasion step toward a clear vote commitment
 *   5. if an LLM is configured, let it phrase the reply from the same facts — then validate it
 *      (length, no new numbers, no banned content, no repetition). Invalid -> grounded template.
 *   6. unsure -> one short clarifying question and flag for admin; never ramble.
 *
 * Persuasion is firm but lawful: no threats, intimidation, bribes/offers, caste or religion appeals,
 * or claims outside the verified fact sheet. STOP is handled before this module (engagement_policy).
 */
const campaignProfile = require('./campaign_profile.js');
const replyQuality = require('./reply_quality.js');

const STAGES = ['unknown', 'undecided', 'leaning', 'committed', 'opposed'];

// ---------------- language / person ----------------
const hasDevanagari = t => /[\u0900-\u097F]/.test(String(t || ''));

function lang(text, user) {
    if (user && user.languagePreference === 'hinglish') return 'en';
    if (user && user.languagePreference === 'hi') return 'hi';
    return hasDevanagari(text) ? 'hi' : 'en';
}

const FEMALE_NAME = /(देवी|कुमारी|बाई|वती|रानी|ममता|सुनीता|अनीता|सरोज|कमला|शारदा|पूजा|प्रियंका|सुमन|\bdevi\b|kumari|\bbai\b|wati|vati|rani\b|sunita|anita|saroj|kamla|pooja|priyanka|suman|mamta|sharda)/i;
const SELF_FEMALE = /(main (ek )?(mahila|aurat|ladki|beti|bahu)|मैं (एक )?(महिला|औरत|लड़की|बेटी|बहू)|hum (mahila|auratein)|didi bol|bahan hoon|बहन हूँ)/i;

function personOf(user = {}, text = '') {
    const v = user.voterProfile || user.lastFoundVoter || null;
    let gender = null, age = null, source = null;
    if (v) {
        const g = String(v.gender || v.g || v.gender_hi || '');
        if (/महिला|^f/i.test(g)) gender = 'F'; else if (/पुरुष|^m/i.test(g)) gender = 'M';
        age = Number(v.age || v.a) || null;
        if (gender) source = 'voter_record';
    }
    if (!gender && user.genderConfirmed) { gender = user.genderConfirmed; source = 'confirmed'; }
    if (!gender && SELF_FEMALE.test(text)) { gender = 'F'; source = 'message'; }
    if (!gender && user.name && FEMALE_NAME.test(user.name)) { gender = 'F'; source = 'name'; }
    if (!gender && user.pushName && FEMALE_NAME.test(user.pushName)) { gender = 'F'; source = 'name'; }
    if (!age && Number(user.age)) age = Number(user.age);
    // Elder cues in the message ("beta", "bachcha" from elders)
    if (!age && /(\bbeta\b|bachch?a|बेटा|बच्चा|म्हारा छोरा|mhara chhora)/i.test(text)) age = 60;
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

// ---------------- intent ----------------
const RX = {
    commitYes: /(pakk?a\b|pakka vote|vote (to )?(denge|dunga|dungi|dege|de denge)|aap?ke sath|aapke saath|saath (hai|hain|h)\b|baba ko hi|abhay singh ko hi|support (hai|h|karenge)|hamara vote|mhara vote|पक्का|वोट (देंगे|दूंगा|दूँगा|दूंगी|देगें|दे देंगे)|साथ (हैं|है)|समर्थन (है|करेंगे)|आपको ही|अभय सिंह को ही)/i,
    opposed: /(nahi denge|nhi denge|nahi dunga|vote nahi|vote nhi|kisi aur ko|dusre ko|doosre ko|against|virodh me|नहीं देंगे|वोट नहीं|किसी और को|दूसरे को|खिलाफ)/i,
    bribe: /(daru|daaru|sharab|botal|bottle|kitna doge|kitne doge|paise doge|paisa do|note do|पैसे दो|पैसा दो|कितना दोगे|दारू|शराब|बोतल)/i,
    taunt: /((40 saal|चालीस साल|40 साल|aaj tak|आज तक|5 saal|पाँच साल)[^?]{0,20}(kya kiya|क्या किया)|kuch nahi kiya|kuch nhi kiya|kuchh nahi|jhoot|jhooth|chor|farji|farzi|dhongi|bekar|bakwas|kaam hi nahi|कुछ नहीं किया|झूठ|चोर|फर्जी|बेकार|बकवास)/i,
    abuse: /(\bmc\b|\bbc\b|bhosd|madarc|behenc|kutt?e\b|harami|कुत्ते|हरामी)/i,
    slip: /(parchi|parchee|voter slip|slip|epic|voter id|mera naam|naam dekh|list me naam|पर्ची|मतदाता सूची|वोटर लिस्ट|मेरा नाम)/i,
    polling: /(kab hai|kab h\b|tarikh|tareekh|date|booth|kahan (vote|dalna)|kidhar vote|kitne baje|time kya|मतदान कब|कब है|तारीख|बूथ|कहाँ वोट|कितने बजे|16 nov)/i,
    meeting: /(milna|milne|mulakat|mulaqat|ghar aao|ghar aa|chaupal|meeting|baat karni|baat karao|phone karo|call karo|मिलना|मुलाकात|घर आओ|चौपाल|बात करनी|बात कराओ|फोन करो)/i,
    future: /(aage kya|aage ka|sankalp|vaada|vada|wada|kya karoge|kya karenge|plan kya|manifesto|आगे क्या|संकल्प|वादा|क्या करोगे|क्या करेंगे)/i,
    works: /(kya kaam|kaun kaun se kaam|vikas|vikaas|kaam kiya|kaam karwaya|kaam hua|कौन से काम|क्या काम|विकास|काम किया|काम करवाया|काम हुआ)/i,
    aboutBaba: /(kaun (hai|h|hain)|kon (hai|h)|parichay|baare me batao|bare me batao|abhay singh kaun|candidate kaun|कौन हैं|कौन है|परिचय|के बारे में)/i,
    undecided: /(soch(enge| rahe| rhe|na padega)|dekhenge|dekh lenge|tay nahi|tay nhi|abhi pata nahi|pata nhi|decide nahi|सोचेंगे|सोच रहे|देखेंगे|तय नहीं|पता नहीं)/i,
    positive: /(achha kaam|accha kaam|badhiya|sahi (hai|h)|bahut achha|अच्छा काम|बढ़िया|सही है|बहुत अच्छा|आशीर्वाद)/i,
    family: /(parivar|ghar (ke|wale)|family|biwi|patni|bete|परिवार|घर के|घरवाले)/i,
    thanks: /^(ok+|okay|thik|theek|thik hai|theek hai|dhanyavad|dhanyawad|shukriya|thanks|thank you|👍|🙏|ठीक है|धन्यवाद|शुक्रिया|जी)[\s!.🙏👍]*$/i,
    greet: /^(ram ram|raam raam|namaste|namaskar|hi+|hello|hlo|hey|jai shri ram|pranam|राम राम|नमस्ते|नमस्कार|प्रणाम|जय श्री राम)[\s\w!.🙏]{0,20}$/i,
    howAreYou: /(kaise ho|kese ho|kaisa hai|kya haal|kya hal|sab badhiya|कैसे हो|क्या हाल)/i
};

const TOPIC_RX = {
    water: /(pani|paani|water|tanki|nal\b|jjm|boring|borewell|पानी|टंकी|नल|बोरवेल)/i,
    drainage: /(nali|naali|drain|sewer|gandagi|safai|kachra|नाली|सीवर|गंदगी|सफाई|कचरा)/i,
    road: /(sadak|road|rasta|raasta|gaddha|kichad|सड़क|रास्ता|गड्ढा|कीचड़)/i,
    electricity: /(bijli|light|khamba|andhera|बिजली|लाइट|खंभा|अंधेरा)/i,
    health: /(hospital|aspatal|doctor|davai|dawai|ilaj|ambulance|अस्पताल|डॉक्टर|दवा|इलाज|एम्बुलेंस)/i,
    education: /(school|college|library|padhai|kitab|student|स्कूल|कॉलेज|लाइब्रेरी|पढ़ाई|किताब)/i,
    youth: /(yuva|naujawan|naukri|job|rozgar|berozgar|khel|ground|gym|stadium|युवा|नौकरी|रोजगार|खेल|मैदान|जिम)/i,
    farming: /(kisan|kheti|khet|fasal|khad|beej|pashu|किसान|खेती|खेत|फसल|खाद|बीज|पशु)/i,
    pension: /(pension|budhape|buzurg|bujurg|पेंशन|बुढ़ापे|बुजुर्ग)/i,
    safety: /(suraksha|safety|chori|cctv|darr|ladkiyon|betiyon|सुरक्षा|चोरी|डर|बेटियों|लड़कियों)/i,
    cremation: /(shmashan|smashan|mokshdham|श्मशान|मोक्षधाम)/i,
    pond: /(johad|talab|talaab|pond|जोहड़|तालाब)/i
};
const CONCERN_RX = /(problem|pareshani|samasya|samashya|shikayat|nahi hai|nhi hai|nahi hua|nhi hua|nahi aata|nhi aata|toot|tuta|band (hai|h)|kharab|kab hoga|kab banega|समस्या|परेशानी|शिकायत|नहीं है|नहीं हुआ|नहीं आता|टूट|खराब|बंद है|कब होगा|कब बनेगा)/i;

function detectTopic(text) {
    for (const [k, rx] of Object.entries(TOPIC_RX)) if (rx.test(text)) return k;
    return null;
}

function classify(text, user = {}) {
    const t = String(text || '').trim();
    const topic = detectTopic(t);
    const out = (intent, extra = {}) => ({ intent, topic, ...extra });
    if (!t) return out('unclear');
    if (RX.abuse.test(t)) return out('abuse');
    if (RX.bribe.test(t)) return out('bribe');
    if (RX.opposed.test(t)) return out('opposed');
    if (RX.commitYes.test(t) && !/\?|kya|क्या/.test(t.slice(-8))) return out('commit', { family: RX.family.test(t) });
    if (RX.taunt.test(t)) return out('taunt');
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
    if (RX.positive.test(t)) return out('positive');
    if (RX.thanks.test(t)) return out('thanks');
    if (RX.greet.test(t) || RX.howAreYou.test(t)) return out('greeting');
    // Answer to a question the bot just asked (ward / name / short reply)
    const ward = t.match(/(?:ward|वार्ड|w)\s*[:#-]?\s*(\d{1,2})\b/i) || (/^\d{1,2}$/.test(t) ? [null, t] : null);
    if (ward) return out('gave_ward', { ward: Number(ward[1]) });
    if (t.length <= 25 && !/\?/.test(t)) return out('short_reply');
    return out('unclear');
}

// ---------------- facts (only what campaign_profile.json says) ----------------
function factsText() { return (campaignProfile.load().verifiedFacts || []).join('\n'); }
const has = (facts, needle) => facts.toLowerCase().includes(needle.toLowerCase());

/** Hindi/Hinglish one-liners, each gated by a substring that must exist in the verified fact sheet. */
const SNIPPETS = {
    water: [{ need: 'JJM water tanks', hi: 'सिहाली खुर्द और सिहाली कलां में JJM की पानी की टंकियाँ, घर-घर नल कनेक्शन और पाइपलाइन का काम हुआ है, और 6 नए बोरवेल मोटर समेत लगे हैं।', en: 'Sihali Khurd aur Sihali Kalan me JJM ki tankiyan, ghar-ghar nal connection aur pipeline ka kaam hua hai, aur 6 naye borewell motor ke saath lage hain.' },
        { need: 'remaining household water supply', hi: 'जिन घरों तक नल अभी नहीं पहुँचा, वहाँ JJM का बचा काम पूरा करना पहला संकल्प है।', en: 'Jin gharon tak nal abhi nahi pahuncha, wahan JJM ka bacha kaam poora karna pehla sankalp hai.' }],
    road: [{ need: 'Sihali Kalan-Hadahedi main road', hi: 'सिहाली कलां–हाड़ाहेड़ी मुख्य सड़क पक्की डामर बनी, और आश्रम से सिहाली कलां का रास्ता भी दोबारा बना।', en: 'Sihali Kalan–Hadahedi main road pakki damar bani, aur Ashram se Sihali Kalan ka rasta bhi dobara bana.' },
        { need: 'CONTENT HOLD', hi: 'गलियों की इंटरलॉकिंग/सीसी की पूरी सूची अभी जाँची जा रही है, इसलिए उस पर पक्का बताकर ही बोलेंगे।', en: 'Galiyon ki interlocking/CC ki poori list abhi verify ho rahi hai, isliye us par pakka karke hi bolenge.' }],
    drainage: [{ need: 'Completed drainage work', hi: 'हाड़ाहेड़ी और सिहाली खुर्द में कई जगह भूमिगत नाली लाइनें डली हैं; आगे लगातार नाली और स्थायी सफाई व्यवस्था का संकल्प है।', en: 'Hadahedi aur Sihali Khurd me kai jagah underground naali line dali hai; aage lagatar naali aur pakki safai vyavastha ka sankalp hai.' }],
    health: [{ need: 'sub-health-centre building', hi: 'अभय सिंह जी ने अपनी पुश्तैनी ज़मीन दान देकर सिहाली खुर्द में उप-स्वास्थ्य केंद्र का भवन बनवाया।', en: 'Abhay Singh ji ne apni pushtaini zameen daan karke Sihali Khurd me up-swasthya kendra ka bhawan banwaya.' },
        { need: 'regular doctor', hi: 'आगे वहाँ नियमित डॉक्टर और 24 घंटे एम्बुलेंस के लिए प्रयास करेंगे।', en: 'Aage wahan regular doctor aur 24 ghante ambulance ke liye prayas karenge.' }],
    education: [{ need: 'modular library', hi: 'सिहाली खुर्द में बच्चों और युवाओं के लिए मॉड्यूलर लाइब्रेरी बनी है; हाड़ाहेड़ी और सिहाली कलां में भी लाइब्रेरी का संकल्प है।', en: 'Sihali Khurd me bachchon aur yuvaon ke liye modular library bani hai; Hadahedi aur Sihali Kalan me bhi library ka sankalp hai.' }],
    youth: [{ need: 'running track', hi: 'खेल मैदान में रनिंग ट्रैक, बास्केटबॉल-बैडमिंटन-खो खो कोर्ट और ओपन जिम लगा है, और लाइब्रेरी भी बनी है।', en: 'Khel maidan me running track, basketball-badminton-kho kho court aur open gym laga hai, aur library bhi bani hai.' },
        { need: 'mini stadium', hi: 'आगे हाड़ाहेड़ी व सिहाली कलां में खेल मैदान और सिहाली खुर्द में मिनी स्टेडियम का संकल्प है।', en: 'Aage Hadahedi va Sihali Kalan me khel maidan aur Sihali Khurd me mini stadium ka sankalp hai.' }],
    farming: [{ need: 'farmer service centre', hi: 'बीज, खाद और दवाई के लिए गाँव में ही किसान सेवा केंद्र बनाने का संकल्प है, और जोहड़-तालाब गहरे करवाए गए हैं।', en: 'Beej, khaad aur dawai ke liye gaon me hi kisan seva kendra banane ka sankalp hai, aur johad-talab gehre karwaye gaye hain.' },
        { need: 'Patwar house', hi: 'ज़मीन के काम गाँव में हों, इसके लिए पटवार घर बनवाने का संकल्प है।', en: 'Zameen ke kaam gaon me hon, iske liye patwar ghar banwane ka sankalp hai.' }],
    pension: [{ need: 'senior-citizen chaupal', hi: 'बुज़ुर्गों के लिए पंखे और पानी वाली चौपाल बनाने का संकल्प है। पेंशन का कोई काम अटका हो तो नाम-वार्ड बताइए, टीम साथ जाकर मदद करेगी।', en: 'Buzurgon ke liye pankhe aur paani wali chaupal ka sankalp hai. Pension ka koi kaam atka ho to naam-ward bataiye, team saath jaakar madad karegi.' }],
    safety: [{ need: 'CCTV', hi: 'मुख्य रास्तों, गाँव के प्रवेश और चौराहों पर CCTV और रोड लाइट लगवाने का संकल्प है, ताकि बहन-बेटियाँ बेफिक्र आ-जा सकें।', en: 'Main raston, gaon ke entry aur chauraahon par CCTV aur road light lagwane ka sankalp hai, taaki behan-betiyan befikr aa-ja sakein.' }],
    cremation: [{ need: 'cremation-ground work', hi: 'श्मशान में भराव-समतलीकरण, दो बोरवेल, पानी की टंकी और पीने के पानी की व्यवस्था हुई है।', en: 'Shmashan me bharav-samtalikaran, do borewell, paani ki tanki aur peene ke paani ki vyavastha hui hai.' }],
    pond: [{ need: 'ponds and reservoirs', hi: 'हाड़ाहेड़ी और सिहाली कलां के पुराने जोहड़-तालाब गहरे करके बरसाती पानी के लिए ठीक करवाए गए हैं।', en: 'Hadahedi aur Sihali Kalan ke purane johad-talab gehre karke barsaati paani ke liye theek karwaye gaye hain.' }],
    electricity: []
};
// Talking points by audience (only topics that have verified facts)
const AUDIENCE_TOPICS = { F: ['water', 'safety', 'pension', 'education'], M: ['road', 'farming', 'youth', 'water'], none: ['water', 'health', 'youth'] };

function snippetFor(topic, l, facts, { first = false } = {}) {
    const list = (SNIPPETS[topic] || []).filter(s => has(facts, s.need));
    if (!list.length) return null;
    return first ? list[0][l] : list.map(s => s[l]).join(' ');
}

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
    if (intent === 'undecided') return current === 'committed' ? 'committed' : 'undecided';
    if (intent === 'positive') return ['committed'].includes(current) ? current : 'leaning';
    if (current === 'unknown' && ['works', 'future', 'about_baba', 'complaint', 'polling', 'meeting', 'voter_slip', 'taunt'].includes(intent)) return 'undecided';
    return current;
}

const CLOSERS = {
    unknown: { hi: ['16 नवंबर को अभय सिंह जी का साथ देंगे ना?', 'इस बार अभय सिंह जी को आशीर्वाद देंगे ना?'],
        en: ['16 November ko Abhay Singh ji ka saath denge na?', 'Is baar Abhay Singh ji ko aashirwad denge na?'] },
    undecided: { hi: ['बस इतना सोचिएगा—40 साल से गाँव के सुख-दुख में कौन साथ खड़ा रहा। 16 नवंबर को अभय सिंह जी का साथ देंगे ना?', 'गाँव की इज़्ज़त और काम दोनों देखकर फ़ैसला कीजिए। अभय सिंह जी पर भरोसा करके देखेंगे ना?'],
        en: ['Bas itna sochiyega—40 saal se gaon ke sukh-dukh me kaun saath khada raha. 16 Nov ko Abhay Singh ji ka saath denge na?', 'Gaon ki izzat aur kaam dono dekh kar faisla kijiye. Abhay Singh ji par bharosa karke dekhenge na?'] },
    leaning: { hi: ['तो पक्का रहा? 16 नवंबर को अभय सिंह जी को वोट देंगे ना?', 'आपकी बात से हौसला मिला। पक्का वोट देंगे ना, और घर वालों को भी साथ लाएँगे?'],
        en: ['To pakka raha? 16 Nov ko Abhay Singh ji ko vote denge na?', 'Aapki baat se hausla mila. Pakka vote denge na, aur ghar walon ko bhi saath laayenge?'] },
    committed: { hi: ['घर के बाकी वोटरों को भी साथ लेकर आइएगा—सुबह 7:30 से शाम 5:30, राजकीय उच्च माध्यमिक विद्यालय, सिहाली खुर्द।', 'अपने परिवार और पड़ोस में भी अभय सिंह जी की बात पहुँचाइएगा, यही असली साथ है।'],
        en: ['Ghar ke baaki voters ko bhi saath laaiyega—subah 7:30 se shaam 5:30, Govt. Sr. Sec. School, Sihali Khurd.', 'Apne parivar aur padosiyon tak bhi Abhay Singh ji ki baat pahunchaiyega, yahi asli saath hai.'] },
    opposed: { hi: ['आपकी राय का सम्मान है। फिर भी कोई बात मन में हो तो बताइए, अभय सिंह जी तक सीधे पहुँचाऊँगी।'],
        en: ['Aapki raay ka samman hai. Phir bhi koi baat man me ho to bataiye, Abhay Singh ji tak seedhe pahunchaaungi.'] }
};

function pickCloser(stage, l, user) {
    const opts = (CLOSERS[stage] || CLOSERS.unknown)[l];
    const recent = (user && Array.isArray(user.history) ? user.history.filter(h => h.role === 'bot').slice(-4).map(h => h.text || '') : []).join(' ');
    return opts.find(o => !recent.includes(o.slice(0, 25))) || null; // null => don't repeat the ask
}

// ---------------- compose (grounded template) ----------------
function compose(cls, ctx) {
    const { l, hon, facts, user, person, stage } = ctx;
    const hi = l === 'hi';
    const name = user && user.name && !/ग्रामवासी|contact/i.test(user.name) ? user.name.split(' ')[0] : '';
    const greetName = name ? (hi ? `${name} ${hon}` : `${name} ${hon}`) : hon;
    const S = (h, e) => (hi ? h : e);
    let body = '', ask = true, needsAdmin = false;

    switch (cls.intent) {
        case 'abuse':
            return { text: S(`आपकी नाराज़गी समझ सकते हैं ${hon}। गाली-गलौज से बात नहीं बनेगी—कोई असली शिकायत हो तो बताइए, सीधे अभय सिंह जी तक पहुँचाऊँगी। 🙏`, `Aapki narazgi samajh sakte hain ${hon}. Gaali se baat nahi banegi—koi asli shikayat ho to bataiye, seedhe Abhay Singh ji tak pahunchaungi. 🙏`), ask: false };
        case 'bribe':
            return { text: S(`${hon}, यहाँ कोई पैसा, दारू या लालच नहीं दिया जाता—ये कानून के खिलाफ़ भी है। अभय सिंह जी 40 साल की सेवा और काम के भरोसे पर वोट माँगते हैं। 🙏`, `${hon}, yahan koi paisa, daaru ya laalach nahi diya jata—ye kanoon ke khilaf bhi hai. Abhay Singh ji 40 saal ki seva aur kaam ke bharose vote maangte hain. 🙏`), ask: false };
        case 'opposed': {
            const asked = user && user.context && user.context.askedOpposedReason;
            if (user) { user.context = user.context || {}; user.context.askedOpposedReason = true; }
            body = asked
                ? S(`ठीक है ${hon}, आपकी राय का पूरा सम्मान है। कभी भी कोई काम या बात हो तो यहीं लिखिएगा। 🙏`, `Theek hai ${hon}, aapki raay ka poora samman hai. Kabhi bhi koi kaam ya baat ho to yahin likhiyega. 🙏`)
                : S(`आपकी राय का सम्मान है ${hon}। बस इतना बता दीजिए—कौन-सी बात आपको खटक रही है? सही बात सीधे अभय सिंह जी तक पहुँचेगी।`, `Aapki raay ka samman hai ${hon}. Bas itna bata dijiye—kaun si baat aapko khatak rahi hai? Sahi baat seedhe Abhay Singh ji tak pahunchegi.`);
            return { text: body, ask: false };
        }
        case 'commit': {
            body = S(`दिल से धन्यवाद ${greetName}! 🙏 आपका यही भरोसा अभय सिंह जी की असली ताकत है।`, `Dil se dhanyavad ${greetName}! 🙏 Aapka yahi bharosa Abhay Singh ji ki asli taakat hai.`);
            const b = boothForWard(user && user.ward, facts);
            if (b) body += S(` आपका बूथ ${b.booth}, कमरा ${b.room} है।`, ` Aapka booth ${b.booth}, room ${b.room} hai.`);
            break;
        }
        case 'taunt': {
            const t = cls.topic || (AUDIENCE_TOPICS[person.gender || 'none'] || [])[0];
            const sn = snippetFor(t, l, facts, { first: true });
            body = S(`सवाल पूछना आपका हक़ है ${hon}।`, `Sawal poochna aapka haq hai ${hon}.`) + (sn ? ' ' + sn : '') +
                S(' जिस जगह काम अधूरा लगे, उस गली/वार्ड का नाम बताइए—अभय सिंह जी खुद देखेंगे।', ' Jis jagah kaam adhoora lage, us gali/ward ka naam bataiye—Abhay Singh ji khud dekhenge.');
            ask = stage !== 'opposed';
            break;
        }
        case 'complaint': {
            const sn = snippetFor(cls.topic, l, facts, { first: true });
            if (user) { user.context = user.context || {}; user.context.openComplaint = { topic: cls.topic, at: new Date().toISOString() }; }
            const knowsPlace = user && user.ward;
            body = S(`आपकी बात नोट कर ली है ${hon}, इसे सीधे अभय सिंह जी की प्राथमिकता सूची में डाल रही हूँ।`, `Aapki baat note kar li hai ${hon}, ise seedhe Abhay Singh ji ki priority list me daal rahi hoon.`) +
                (sn ? ' ' + sn : '') +
                (knowsPlace ? '' : S(' किस वार्ड/गली की बात है, बता देंगे?', ' Kis ward/gali ki baat hai, bata denge?'));
            ask = !!knowsPlace;
            if (!SNIPPETS[cls.topic] || !SNIPPETS[cls.topic].length) needsAdmin = true;
            break;
        }
        case 'works': {
            const t = cls.topic || (AUDIENCE_TOPICS[person.gender || 'none'] || [])[0];
            const sn = snippetFor(t, l, facts) || snippetFor('water', l, facts, { first: true });
            body = (sn || S('काम की पक्की सूची टीम से लेकर भेजती हूँ।', 'Kaam ki pakki list team se lekar bhejti hoon.'));
            if (!sn) needsAdmin = true;
            break;
        }
        case 'future': {
            const t = cls.topic || (person.gender === 'F' ? 'safety' : 'youth');
            const sn = (SNIPPETS[t] || []).filter(s => has(facts, s.need)).map(s => s[l]).pop();
            body = sn || S('आगे के संकल्पों की पूरी सूची जल्द भेजती हूँ।', 'Aage ke sankalpon ki poori list jaldi bhejti hoon.');
            break;
        }
        case 'about_baba':
            body = S(`अभय सिंह जी (मोटी आंगली वाले) ग्राम पंचायत सिहाली खुर्द से सरपंच प्रत्याशी हैं—40 साल से गाँव की सेवा और भाईचारे में लगे हैं।`, `Abhay Singh ji (Moti Aangli wale) Gram Panchayat Sihali Khurd se Sarpanch pratyashi hain—40 saal se gaon ki seva aur bhaichare me lage hain.`) +
                (has(facts, 'sub-health-centre building') ? S(' अपनी पुश्तैनी ज़मीन दान देकर गाँव का उप-स्वास्थ्य केंद्र बनवाया।', ' Apni pushtaini zameen daan karke gaon ka up-swasthya kendra banwaya.') : '');
            break;
        case 'polling': {
            const b = boothForWard(user && user.ward, facts);
            body = S('मतदान सोमवार, 16 नवंबर 2026 को सुबह 7:30 से शाम 5:30 तक राजकीय उच्च माध्यमिक विद्यालय, सिहाली खुर्द में है।', 'Matdaan Somvar, 16 November 2026 ko subah 7:30 se shaam 5:30 tak Govt. Sr. Sec. School, Sihali Khurd me hai.') +
                (b ? S(` आपका बूथ ${b.booth}, कमरा ${b.room}।`, ` Aapka booth ${b.booth}, room ${b.room}.`) : S(' अपना वार्ड बताइए, बूथ-कमरा भी बता दूँगी।', ' Apna ward bataiye, booth-room bhi bata doongi.'));
            ask = !!b;
            break;
        }
        case 'meeting':
            if (user) user.wantsVisit = true;
            needsAdmin = true;
            body = S(`ज़रूर ${hon}! मुलाकात की बात टीम को भेज दी है, जल्द फ़ोन आएगा। अपना वार्ड और सही समय बता दीजिए।`, `Zaroor ${hon}! Mulakat ki baat team ko bhej di hai, jaldi phone aayega. Apna ward aur sahi samay bata dijiye.`);
            ask = false;
            break;
        case 'voter_slip':
            body = S(`पर्ची अभी निकाल देती हूँ ${hon}—अपना पूरा नाम और पिता/पति का नाम लिख भेजिए।`, `Parchi abhi nikaal deti hoon ${hon}—apna poora naam aur pita/pati ka naam likh bhejiye.`);
            ask = false;
            break;
        case 'undecided':
            body = S(`कोई बात नहीं ${hon}, सोच-समझकर फ़ैसला करना ही सही है।`, `Koi baat nahi ${hon}, soch-samajh kar faisla karna hi sahi hai.`);
            {
                const t = (AUDIENCE_TOPICS[person.gender || 'none'] || [])[0];
                const sn = snippetFor(t, l, facts, { first: true });
                if (sn) body += ' ' + sn;
            }
            break;
        case 'positive':
            body = S(`आपके आशीर्वाद के लिए धन्यवाद ${greetName}! 🙏`, `Aapke aashirwad ke liye dhanyavad ${greetName}! 🙏`);
            break;
        case 'thanks':
            body = S(`जी ${hon} 🙏`, `Ji ${hon} 🙏`);
            if (stage === 'committed') ask = false;
            break;
        case 'greeting': {
            const greeted = user && user.context && user.context.greetedOnce;
            body = S(`राम राम ${greetName}! 🙏 घर-परिवार में सब कुशल-मंगल?`, `Ram Ram ${greetName}! 🙏 Ghar-parivar me sab kushal-mangal?`);
            if (!greeted && stage !== 'committed') {
                body += S(' आपके मोहल्ले में इस बार चुनाव का क्या माहौल है?', ' Aapke mohalle me is baar chunav ka kya mahaul hai?');
                ask = false;
            }
            if (user) { user.context = user.context || {}; user.context.greetedOnce = true; }
            break;
        }
        case 'gave_ward': {
            if (user && cls.ward) user.ward = cls.ward;
            const b = boothForWard(cls.ward, facts);
            const open = user && user.context && user.context.openComplaint;
            body = S(`वार्ड ${cls.ward} नोट कर लिया ${hon}।`, `Ward ${cls.ward} note kar liya ${hon}.`) +
                (open ? S(' आपकी शिकायत इसी वार्ड के नाम से टीम को भेज दी है।', ' Aapki shikayat isi ward ke naam se team ko bhej di hai.') : '') +
                (b ? S(` आपका बूथ ${b.booth}, कमरा ${b.room} रहेगा।`, ` Aapka booth ${b.booth}, room ${b.room} rahega.`) : '');
            if (open) needsAdmin = true;
            break;
        }
        case 'short_reply':
            body = S(`जी ${hon}।`, `Ji ${hon}.`);
            break;
        default: // unclear: one short clarifying question, flag admin
            needsAdmin = true;
            return {
                text: S(`माफ़ कीजिए ${hon}, ठीक से समझ नहीं पाई। आपको वोटर पर्ची चाहिए, गाँव की कोई समस्या बतानी है, या अभय सिंह जी से कुछ पूछना है?`, `Maaf kijiye ${hon}, theek se samajh nahi paayi. Aapko voter parchi chahiye, gaon ki koi samasya batani hai, ya Abhay Singh ji se kuch poochna hai?`),
                ask: false, needsAdmin
            };
    }
    return { text: body, ask, needsAdmin };
}

// ---------------- LLM phrasing + validation ----------------
const BANNED = /(बाबा जी|बाबाजी|\bbaba ji\b|पैसे देंगे|पैसा देंगे|दारू देंगे|देख लेंगे तुम्हें|अंजाम|धमकी|जाति|धर्म के नाम|हिंदू|मुसलमान|जाट|यादव|गुर्जर|मेघवाल|ब्राह्मण|as an ai|i'm sorry|i cannot)/i;

function validateLLM(reply, { allowedText, user }) {
    if (!reply) return 'empty';
    const r = String(reply).trim();
    if (r.length > 420) return 'too_long';
    if (BANNED.test(r)) return 'banned';
    const nums = r.match(/\d+(?:[.:]\d+)?/g) || [];
    for (const n of nums) if (!allowedText.includes(n)) return 'new_number:' + n;
    if (user && replyQuality.isRepeated(r, user)) return 'repeated';
    return null;
}

function buildLLMPrompt(cls, ctx, draft) {
    const { l, hon, facts, person, stage, goal, user } = ctx;
    const relevant = facts.split('\n').filter(f => {
        if (/^(Candidate|Polling|Booth|Operator-provided service|CONTENT HOLD)/.test(f)) return true;
        const topic = cls.topic || '';
        const words = { water: /water|JJM|borewell/i, road: /road/i, drainage: /drain|sewer/i, health: /health|doctor|ambulance/i, education: /library|school/i, youth: /sports|stadium|library/i, farming: /farmer|Patwar|pond/i, pension: /senior/i, safety: /CCTV|lighting/i, cremation: /cremation/i, pond: /pond/i }[topic];
        return words ? words.test(f) : false;
    }).slice(0, 12);
    return [
        'You write ONE short WhatsApp reply (max 2 short sentences + one question) for the campaign of Abhay Singh (Moti Aangli wale), Sarpanch candidate, Gram Panchayat Sihali Khurd. Poll: 16 Nov 2026.',
        `Reply language: ${l === 'hi' ? 'Devanagari Hindi with a light Ahirwal/Haryanvi warmth' : 'simple Roman Hinglish'}. Address the person as "${hon}". You are a female campaign helper (use feminine verbs: करती हूँ / bhejti hoon).`,
        `Detected intent: ${cls.intent}${cls.topic ? ' (topic: ' + cls.topic + ')' : ''}. Voter stage: ${stage}. Gender: ${person.gender || 'unknown'}.`,
        goal ? `Today's campaign goal: ${goal}` : '',
        `Context: ${(user && user.context && user.context.lastConcern) ? 'last concern: ' + user.context.lastConcern : 'none'}${user && user.ward ? '; ward ' + user.ward : ''}.`,
        'Answer the person\'s actual message first. Then ONE gentle step toward a clear commitment to vote for Abhay Singh on 16 Nov (warm: relationship, gaon ki izzat, 40 saal ki seva, a specific verified work), unless intent is opposed/abuse/bribe.',
        'STRICT: use only these verified facts; no other numbers, works, dates or promises. Never threaten, never offer money/gifts/liquor, never appeal to caste or religion, never say "बाबा जी". If a fact is not listed, say the team will confirm.',
        'VERIFIED FACTS:', ...relevant.map(f => '- ' + f),
        `A safe draft you may improve (keep its facts): ${draft}`
    ].filter(Boolean).join('\n');
}

/**
 * @param {string} message
 * @param {object} user  user_memory record (mutated: stage, context, needsAdmin)
 * @param {object} [opts] { llm: async (systemPrompt, history, message) => string|null, goal: string, history: [] }
 * @returns {Promise<{text, intent, topic, stage, previousStage, needsAdmin, source}>}
 */
async function respond(message, user = {}, opts = {}) {
    const facts = factsText();
    const l = lang(message, user);
    const person = personOf(user, message);
    const hon = honorific(person, l);
    const cls = classify(message, user);
    const previousStage = stageOf(user);
    const stage = nextStage(previousStage, cls.intent);
    if (user) {
        user.persuasionStage = stage;
        if (stage !== previousStage) {
            user.persuasionHistory = (user.persuasionHistory || []).concat([{ from: previousStage, to: stage, at: new Date().toISOString(), intent: cls.intent }]).slice(-20);
        }
        if (person.gender && person.source !== 'name') user.genderDetected = person.gender;
        if (person.gender) user.genderGuess = person.gender;
    }
    const ctx = { l, hon, facts, user, person, stage, goal: opts.goal || '' };
    const c = compose(cls, ctx);
    let text = c.text;
    if (c.ask) {
        const closer = pickCloser(stage, l, user);
        if (closer) text += (text.endsWith('?') ? ' ' : ' ') + closer;
    }
    let source = 'template';

    // Let the LLM phrase it (if configured) — only for open intents; validated against the same facts.
    const llmIntents = ['works', 'future', 'about_baba', 'complaint', 'taunt', 'undecided', 'greeting', 'positive'];
    if (opts.llm && llmIntents.includes(cls.intent)) {
        try {
            const sys = buildLLMPrompt(cls, ctx, text);
            const out = await opts.llm(sys, (opts.history || []).slice(-4), message);
            const why = validateLLM(out, { allowedText: facts + ' ' + message + ' ' + text + ' 2026 16', user });
            if (!why) { text = String(out).trim(); source = 'llm'; }
            else source = 'template(llm_rejected:' + why + ')';
        } catch (e) { source = 'template(llm_error)'; }
    }

    text = text.charAt(0).toUpperCase() + text.slice(1);
    // Never repeat ourselves verbatim
    if (user && replyQuality.isRepeated(text, user)) text = replyQuality.buildContextRedirect(user, message);

    if (c.needsAdmin && user) user.needsAdmin = { at: new Date().toISOString(), text: String(message).slice(0, 200), intent: cls.intent };
    return { text, intent: cls.intent, topic: cls.topic, stage, previousStage, needsAdmin: !!c.needsAdmin, source, honorific: hon, gender: person.gender };
}

/**
 * Proactive follow-up for consented contacts who are undecided/leaning: one warm persuasion step.
 * goal.targetWard + goal.task (admin-written text) is appended only for people in that ward.
 */
function buildPersuasionNudge(user = {}, goal = {}) {
    const stage = stageOf(user);
    if (!['undecided', 'leaning', 'unknown'].includes(stage)) {
        if (stage === 'committed' && goal && goal.task && goal.targetWard && String(goal.targetWard) === String(user.ward)) {
            return String(goal.task).slice(0, 300);
        }
        return null;
    }
    const facts = factsText();
    const l = user.languagePreference === 'hinglish' ? 'en' : 'hi';
    const person = personOf(user, '');
    const hon = honorific(person, l);
    const topic = (user.context && user.context.openComplaint && user.context.openComplaint.topic) || (AUDIENCE_TOPICS[person.gender || 'none'] || [])[0];
    const sn = snippetFor(topic, l, facts, { first: true });
    const closer = pickCloser(stage === 'unknown' ? 'undecided' : stage, l, user) || (CLOSERS[stage === 'unknown' ? 'undecided' : stage] || CLOSERS.unknown)[l][0];
    let text = (l === 'hi' ? `राम राम ${hon}! 🙏 ` : `Ram Ram ${hon}! 🙏 `) + (sn ? sn + ' ' : '') + closer;
    if (goal && goal.task && goal.targetWard && String(goal.targetWard) === String(user.ward)) text += ' ' + String(goal.task).slice(0, 200);
    if (replyQuality.isRepeated(text, user)) return null;
    return text;
}

module.exports = { buildPersuasionNudge, respond, classify, personOf, honorific, nextStage, boothForWard, validateLLM, STAGES, SNIPPETS };
