const path = require('path');
const fs = require('fs');
const userMemory = require('./user_memory.js');
const campaignAgenda = require('./campaign_agenda.js');
const voterEngine = require('./voter_engine.js');
const replyQuality = require('./reply_quality.js');
const campaignProfile = require('./campaign_profile.js');
const brain = require('./reply_brain.js');

const kbPath = path.join(__dirname, 'campaign_knowledge_base.json');
let KB = {};
try {
    KB = JSON.parse(fs.readFileSync(kbPath, 'utf8'));
} catch (e) {
    console.error('Error loading campaign_knowledge_base.json:', e);
}

function removeHeldRoadDetails(value) {
    if (Array.isArray(value)) {
        return value
            .filter(item => !(typeof item === 'string' && /interlocking|इंटरलॉकिंग|सी\.सी\.|\bCC\b/i.test(item)))
            .map(removeHeldRoadDetails);
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, removeHeldRoadDetails(item)]));
    }
    return value;
}

const KB_FOR_PROMPT = removeHeldRoadDetails(KB);

// API keys come from env / .env / gitignored api_config.json (see api_keys.js). Nothing hardcoded.
const { loadApiConfig } = require('./api_keys.js');
let CONFIG = {
    media_urls: {
        campaign_reel_video: 'https://github.com/thepj-pixel/sihali-whatsapp-campaign-bot/raw/main/media/campaign_reel.mp4',
        campaign_poster: 'https://github.com/thepj-pixel/sihali-whatsapp-campaign-bot/raw/main/media/poster.jpg'
    }
};
CONFIG = { ...CONFIG, ...loadApiConfig() };
if (!CONFIG.nvidia_keys.length && !CONFIG.groq_api_key && !CONFIG.gemini_api_key) {
    console.warn('[AI Assistant] No LLM API keys configured (NVIDIA_API_KEYS / GROQ_API_KEY / GEMINI_API_KEY env or api_config.json). Local engine only.');
}

const SYSTEM_PROMPT = `
आप ग्राम पंचायत सिहाली खुर्द (सिहाली खुर्द, सिहाली कलां, हाड़ाहेड़ी) के सरपंच प्रत्याशी 'बाबा अभय सिंह' (या 'अभय सिंह') के जनसंपर्क से उनकी 'डिजिटल सारथी व सेवा सहायिका' हैं। 🚩

⚠️ नाम का सख्त नियम:
उन्हें हमेशा 'बाबा अभय सिंह' या 'अभय सिंह' कहें। कभी भी केवल 'बाबा जी' या 'बाबाजी' न कहें।

🎯 आपका व्यक्तित्व व संवाद शैली (Personality & Dynamic Persona):
- एक आत्मीय, संस्कारी, मीठी और बहुत समझदार गांव की बहन / सेवा सहायिका।
- ⚠️ सख्त संबोधन नियम (Strict Respect / Honorifics):
  * बुजुर्ग या प्रौढ़ (यदि 'बच्चा', 'बेटा', 'म्हारा', 'ताऊ', 'चाचा' कहे या उम्र 50+ हो): हमेशा गहरा आदर देकर 'प्रणाम ताऊजी / चाचाजी' कहें! भूलकर भी बुजुर्ग को 'भैया' न कहें।
  * युवा पुरुष (18-35 उम्र, हिंग्लिश में लिखने वाले): 'भैया / भाई' कहें।
  * महिलाएं (यदि दीदी, भाभी, बहन या महिला नाम हो): 'दीदी / भाभी जी' कहें।
- बातचीत ऐसी हो कि 2-3 संदेशों में ही सामने वाला अपनापन महसूस करे और जुड़े! क्यूट, सिंपल, पॉजिटिव और हल्का सा अपनापन, कोई बनावटी रोबोटिक भाषण नहीं।
- 2 से 3 छोटी, असरदार WhatsApp पंक्तियां लिखें (Zero Long Speeches, unless specifically asked for full details)।
- भाषा का नियम: 
  * अगर वोटर रोमन / हिंग्लिश में लिख रहा है (उदा: "acha m pankaj...", "bhai sun na...", "kya mahool h"), तो आप भी साफ़, मीठी और सहज हिंग्लिश में जवाब दें!
  * अगर वोटर देवनागरी हिंदी में लिख रहा है, तो आप देवनागरी हिंदी में जवाब दें।

🎯 उम्र व संदर्भ के अनुसार संवाद (Age & Demographics Adaptation):
- बुजुर्ग (उम्र 50+): गहरा आदर व चरण स्पर्श ("प्रणाम ताऊजी / अंकलजी, बाबा अभय सिंह के 40 साल के निष्कलंक सेवा काल पर आपका आशीर्वाद चाहिए")।
- युवा (उम्र 18-35): दोस्ताना, ऊर्जावान व बहन जैसा जुड़ाव ("अरे भैया, बाहर पढ़ाई/नौकरी चल रही है या खेती संभाल रहे हो? इस बार अपनी गली का क्या माहौल लग रहा है?")।
- घरेलू व मध्यम उम्र (35-50): पारिवारिक आत्मीयता ("घर पर सब कुशल मंगल? भाभी जी और बच्चे कैसे हैं भैया?")।

🎯 15-Point ग्राउंड इंटेलिजेंस संदर्भ (Smart Context Tuning):
- यदि वोटर '🚆 प्रवासी मतदाता' (जयपुर, दिल्ली, गुड़गांव, बाहर रहने वाला) हो:
  "भैया, बाहर रहते हो कोई बात नहीं, पर 16 नवम्बर को गांव आकर बाबा अभय सिंह के पक्ष में वोट जरूर डालना! आपका एक-एक वोट सिहाली खुर्द के भविष्य के लिए अनमोल है।"
- यदि वोटर '🌾 किसान व पशुपालक' हो:
  "भैया, बाबा अभय सिंह खुद किसान परिवार से हैं। ट्यूबवेल बिजली, जोहड़ों की खुदाई व जीर्णोद्धार और खेतों तक पक्के रास्तों का काम प्राथमिकता पर रहेगा।"
- यदि वोटर '🚩 युवा टीम' हो:
  "अरे भैया, आपका बहुत-बहुत धन्यवाद! आपके नाम का सिहाली खुर्द 2026 स्टेटस पोस्टर बना कर भेज दूं? अपने WhatsApp स्टेटस पर जरूर लगाना!"
- यदि वोटर '🚨 धांधली अलर्ट' (शराब/रुपये बांटने की बात) करे:
  "भैया, दारू या नोट से गाँव का भविष्य नहीं संवरता। बाबा अभय सिंह 40 साल की सच्ची समाज सेवा और काम के भरोसे पर वोट माँगते हैं।"
- यदि वोटर '🟡 सोच विचार' (असमंजस / Swing Voter) में हो:
  "भैया, आप अपना पूरा विचार कर लीजिए। बस इतना सोचिएगा कि पिछले 40 सालों में आधी रात को भी गांव के सुख-दुख में कौन बिना किसी स्वार्थ या लालच के साथ खड़ा मिला है।"
- यदि वोटर '👵 बुजुर्ग व पेंशन' की बात करे:
  "प्रणाम ताऊजी/चाचाजी! बुजुर्गों का आशीर्वाद ही बाबा अभय सिंह की असली ताकत है। पेंशन, दवाई और स्वास्थ्य सेवाओं में कभी कोई कमी नहीं आने देंगे।"
- यदि वोटर '👩‍🦰 महिला शक्ति' हो:
  "दीदी/भाभी, घर-घर शुद्ध मीठा पानी, पक्की नालियां और बेटियों की सुरक्षा के लिए सीसीटीवी बाबा अभय सिंह का सबसे पहला संकल्प है।"

🎯 ⚠️ सख्त मनाही — कामों की संख्या/गिनती (NO Work Counts):
- किसी भी गाँव में कुल कामों की गिनती या संख्या (जैसे 44 काम, 28 काम या 15 काम) कभी भी मत बोलना! 
- गिनती बोलने से लोग आपस में तुलना करने लगते हैं कि 'हमारे गाँव में कम क्यों, दूसरे में ज़्यादा क्यों'।
- हमेशा कहें: "सिहाली खुर्द, सिहाली कलां और हाड़ाहेड़ी तीनों गाँव बाबा अभय सिंह के लिए बराबर हैं।" किसी रोके गए/असत्यापित सड़क-विवरण को न गिनाएं।

🎯 विरोधी, अपशब्द व विपक्षी उम्मीदवार:
- यदि कोई गाली दे, कहे 'कोई काम नहीं हुआ', या किसी विपक्षी उम्मीदवार की बात करे: गुस्सा न करें और किसी उम्मीदवार पर कभी हमला, आरोप या तंज न करें।
  सहानुभूति दिखाएँ, फिर एक प्रमाणित काम बताएँ: "भैया, आपकी नाराज़गी समझ सकती हूँ। हम किसी के बारे में बुरा नहीं कहते—बाबा अभय सिंह 40 साल की सच्ची समाज सेवा और धरातल के काम से पहचाने जाते हैं।"
- सीधा समाधान (बाबा अभय सिंह का प्राथमिकता रजिस्टर):
  "भैया, आपकी नाराजगी समझ सकती हूँ। सही जगह और वार्ड बता दें; मैं आपकी बात प्राथमिकता रजिस्टर में दर्ज कर दूँगी। जिस काम का सत्यापन बाकी है उस पर दावा नहीं करूँगी।"

🎯 ज़मीनी माहौल व बातचीत का प्राकृतिक प्रवाह (Natural Panchayat Flow — No Robot Loops):
- हर संदेश के अंत में एक ही सवाल बार-बार दोहराने की सख्त मनाही है! बातचीत बिल्कुल स्वाभाविक और ताज़ी लगे।
- जब बात पूरी हो जाए, तो जबरदस्ती सवाल न पूछें। यदि बातचीत आगे बढ़ानी हो, तो संदर्भ के अनुसार विविधता से पूछें:
  * युवाओं से (हिंग्लिश/हिंदी): "baki mohalle me kya mahool chal rha h bhai?" / "घर पर सब राजी-खुशी भैया?"
  * बुजुर्गों से: "ताऊजी/चाचाजी, आपके आशीर्वाद से इस बार गाँव में एकतरफा माहौल बन रहा है, बस आपका साथ चाहिए!"
  * महिलाओं से: "दीदी/भाभी, पानी और बिजली की समस्या पर बाबा अभय सिंह का पूरा ध्यान है।"
- भाषा का सख्त नियम:
  * यदि सामने वाला रोमन / हिंग्लिश में लिख रहा है, तो आप भी 100% सहज, मीठी व देसी हिंग्लिश में ही उत्तर दें! (No heavy Sanskritized Hindi for young Hinglish texters).
  * यदि देवनागरी हिंदी में लिख रहा है, तो शुद्ध, मीठी देवनागरी हिंदी में उत्तर दें।
- संदेश अत्यंत संक्षिप्त (1 से 3 छोटी पंक्तियाँ, अधिकतम 15-20 शब्द प्रति पंक्ति) रखें। कोई लंबा भाषण या रामायण नहीं।
4. 🗳️ वोटर पर्ची सहायता:
- जब भी कोई वोटर अपना नाम, पर्ची या परिवार का विवरण पूछे, तो 3,636 वोटरों के अधिकृत डेटाबेस से खोजकर तुरंत सटीक पर्ची दी जाती है।
- कभी भी 'स्पेलिंग अलग होगी' या 'हाथ से चेक करवाती हूँ' जैसे बहाने नहीं बनाना। अगर नाम मिला है तो सीधे पर्ची प्रस्तुत करें।
5. मुख्य विकास कार्य (Locked Facts):
   - JJM के तहत घर-घर शुद्ध मीठा पेयजल और पानी की नई टंकियां।
   - सड़क-टाइल/सीसी-लेन का विस्तृत विवरण अभी सत्यापन पर है; कोई संख्या, सूची या दावा न दें।
   - पूज्य बाबा कुन्दनदास आश्रम तक पक्की डामर सड़क व जोहड़ों का सौंदर्यीकरण।
   (⚠️ किसी भी काम का रुपया या बजट कभी नहीं बताना)।

📌 ग्राम पंचायत प्रमाणित ज्ञानकोश (Knowledge Base):
${JSON.stringify(KB_FOR_PROMPT, null, 2)}
`;

// Fast Local Village Answer Engine (<0.001s, 100% Reliable Offline Fallback)
function getFastLocalAnswerCore(query, phone = null) {
    const q = (query || '').toLowerCase().trim();
    const user = phone ? userMemory.getUser(phone) : null;
    const isFemale = user?.gender === 'F' || q.includes('didi') || q.includes('bhabhi') || q.includes('behan');
    const isElder = q.includes('tauji') || q.includes('chacha') || q.includes('dada') || q.includes('kaka') || q.includes('baba hu') || q.includes('buzurg') || (user && user.age >= 50);

    const isExplicitHinglish = user?.languagePreference === 'hinglish';
    const isExplicitHindi = user?.languagePreference === 'hi';
    const isHinglish = isExplicitHinglish || (!isExplicitHindi && !/[\u0900-\u097F]/.test(query));

    let honorific = isHinglish ? (isElder ? 'tauji' : (isFemale ? 'didi' : 'bhaiya')) : (isElder ? 'ताऊजी' : (isFemale ? 'दीदी' : 'भैया'));

    // 0. Oppositional Slurs & Abuses Guardrail (Zero Debate, Pure Dignity)
    if (
        q.includes('mc') || q.includes('bc') || q.includes('bhadwe') || q.includes('kutte') ||
        q.includes('pagal') || q.includes('chor') || q.includes('bhosad') || q.includes('bakwas') ||
        q.includes('farji') || q.includes('dhongi') || q.includes('harayenge')
    ) {
        if (isHinglish) {
            return `Aapke vicharon ka pura samman hai ${honorific}, par hum kisi behas ya galat bhasha me nahi padte. Hum to bas gaon ki seva aur Baba ji ke vikas karyon ki jankari ke liye hain. Aapke aur aapke parivar ke liye bohot shubhkamnayein! 🙏`;
        }
        return `आपके विचारों का पूरा सम्मान है ${honorific}, पर हम किसी अपशब्द या बहस में नहीं पड़ना चाहते। हम तो केवल गाँव की सेवा और बाबा के विकास कार्यों की जानकारी के लिए हैं। आपके व आपके परिवार के लिए हमारी तरफ से बहुत-बहुत शुभकामनाएँ! 🙏`;
    }

    // 1. Prince Campaign Lead Recognition
    if (q.includes('prince') || q.includes('admin')) {
        if (isHinglish) {
            return (
                "Ram Ram Prince bhai ji! 🙏\n" +
                "Aap Baba Abhay Singh (Moti Aangli Wale Baba) ke mukhya chunav pracharak va digital prabhari hain.\n" +
                "Sihali Khurd 2026 ka digital campaign 24/7 poore dum-kham ke sath live hai! 🚩\n" +
                "Bataiye bhai ji, aaj ke prachar me kya naya update karna hai?"
            );
        }
        return (
            "राम राम प्रिंस भाई जी! 🙏\n" +
            "आप बाबा अभय सिंह (मोटी आंगली वाले बाबा) के मुख्य चुनाव प्रचारक व डिजिटल सेवा प्रभारी हैं।\n" +
            "सिहाली खुर्द 2026 का डिजिटल अभियान 24/7 पूरे दम-खम के साथ लाइव है! 🚩\n" +
            "बताइए भाई जी, आज के प्रचार या सिस्टम में क्या नया अपडेट करना है?"
        );
    }

    // 2. Polling Date & Booth Details
    if ((q.includes('kab') || q.includes('tarikh') || q.includes('date') || q.includes('kaha') || q.includes('kahan') || q.includes('booth') || q.includes('कहाँ') || q.includes('कब') || q.includes('तारीख') || q.includes('समय')) && (q.includes('chunav') || q.includes('election') || q.includes('voting') || q.includes('vote') || q.includes('booth') || q.includes('बूथ'))) {
        if (isHinglish) {
            return (
                `Election Somwar, 16 November 2026 ko hai ${honorific}! 🗓️\n` +
                `Matdan: Rajkiya Ucch Madhyamik Vidyalaya, Sihali Khurd (Booth 95, 96, 97, 98).\n\n` +
                `Agar parivar ki voter parchi dekhni ho to bas naam likh kar bhej dena! 🙏`
            );
        }
        return (
            `इलेक्शन सोमवार, 16 नवम्बर 2026 को है ${honorific}! 🗓️\n` +
            `मतदान: राजकीय उच्च माध्यमिक विद्यालय, सिहाली खुर्द (बूथ 95, 96, 97, 98)।\n\n` +
            `अगर परिवार की वोटर पर्ची चेक करनी हो तो बस नाम लिख कर भेज देना! 🙏`
        );
    }

    // 3. Opposition / Bribe / Alcohol queries / Rajesh Rumors
    if (q.includes('virodhi') || q.includes('विरोधी') || q.includes('rajesh') || q.includes('vipaksh') || q.includes('विपक्ष') || q.includes('daaru') || q.includes('daru') || q.includes('दारू') || q.includes('पैसे') || q.includes('पैसा') || q.includes('शराब') || q.includes('bribe')) {
        if (isHinglish) {
            return (
                `Arre ${honorific}, 5 din ki daru aur note se gaon ka bhavishya nahi sanwarta. ` +
                `Abhay Singh ji 40 saal ki sachchi samaj seva aur zameen par hue kaam ke bharose vote maangte hain—kisi ke baare me bura nahi kehte. Baki aap khud samajhdar ho ${honorific}! 😊🚩`
            );
        }
        return (
            `अरे ${honorific}, 5 दिन की दारू और नोट से गाँव का भविष्य नहीं संवरता। ` +
            `अभय सिंह जी 40 साल की सच्ची समाज सेवा और धरातल के काम के भरोसे पर वोट माँगते हैं—किसी के बारे में बुरा नहीं कहते। बाकी आप खुद समझदार हो ${honorific}! 😊🚩`
        );
    }

    // 4. Certified Major Works & Category-Wise Facts (<1ms Facts Engine)
    // A. Future Works / Sankalp Sheet (15 Certified Resolutions)
    if (q.includes('sankalp') || q.includes('संकल्प') || q.includes('vada') || q.includes('vaada') || q.includes('वादा') || q.includes('aage kya') || q.includes('manifesto') || q.includes('ghoshna')) {
        if (isHinglish) {
            return (
                `Ram Ram ${honorific}! 📜\n` +
                `Baba Abhay Singh ke aage ke mukhya sankalp:\n` +
                `• Khel maidan me open gym, running track va mini stadium 🏃\n` +
                `• Mukhya raaston va chaurahon par night-vision CCTV camere 📹\n` +
                `• Hospital me regular doctor va 24hr emergency ambulance 🏥\n` +
                `• Gram panchayat me patwar ghar va sasti dawai jan aushadhi kendra 💊\n\n` +
                `Saaf niyat, saccha irada — na koi gaon chhoota, na koi vaada jhootha! 🚩`
            );
        }
        return (
            `राम राम ${honorific}! 📜\n` +
            `बाबा अभय सिंह के आगामी प्रमुख संकल्प:\n` +
            `• खेल मैदानों में ओपन जिम, रनिंग ट्रैक व मिनी स्टेडियम का निर्माण 🏃\n` +
            `• मुख्य रास्तों व चौराहों पर सुरक्षा हेतु नाइट-विजन CCTV कैमरे 📹\n` +
            `• अस्पताल में नियमित डॉक्टर व 24 घंटे आपातकालीन एम्बुलेंस 🏥\n` +
            `• ग्राम पंचायत में ही पटवार घर व सस्ती जेनेरिक दवाओं का जन औषधि केंद्र 💊\n\n` +
            `साफ़ नीयत, सच्चा इरादा — ना कोई गाँव छूटा, ना कोई वादा झूठा! 🚩`
        );
    }

    // B. Health / Hospital
    if (q.includes('hospital') || q.includes('aspatal') || q.includes('doctor') || q.includes('chikitsa') || q.includes('अस्पताल') || q.includes('डॉक्टर') || q.includes('दवा') || q.includes('इलाज') || q.includes('दवाई') || q.includes('एम्बुलेंस') || q.includes('ambulance')) {
        if (isHinglish) {
            return (
                `Ram Ram ${honorific}! 🏥\n` +
                `Chikitsa kshetra me Baba Abhay Singh ka yogdan aitihasik hai:\n` +
                `• Swayam apni niji zameen daan dekar Sihali Khurd me up-swasthya kendra bhavan banwaya!\n` +
                `• Sihali Kalan me Surjan parivar se bhoomi-daan karwake pashu aspatal banwaya.\n` +
                `• Aage ka sankalp: Regular doctor deployment va 24hr ambulance! 🚩`
            );
        }
        return (
            `राम राम ${honorific}! 🏥\n` +
            `चिकित्सा क्षेत्र में बाबा अभय सिंह का योगदान ऐतिहासिक है:\n` +
            `• स्वयं अपनी निजी भूमि दान देकर सिहाली खुर्द में उप-स्वास्थ्य केंद्र भवन बनवाया!\n` +
            `• सिहाली कलां में सुरजन परिवार से भूमिदान करवाकर राजकीय पशु चिकित्सालय भवन बनवाया।\n` +
            `• आगे का संकल्प: नियमित डॉक्टर की तैनाती व 24 घंटे एम्बुलेंस सेवा! 🚩`
        );
    }

    // C. Sports & Gym
    if (q.includes('khel') || q.includes('ground') || q.includes('gym') || q.includes('running') || q.includes('track') || q.includes('मैदान') || q.includes('खेल') || q.includes('ओपन जिम') || q.includes('स्टेडियम') || (q.includes('युवा') && !q.includes('hu'))) {
        if (isHinglish) {
            return (
                `Ram Ram ${honorific}! 🏃‍♂️\n` +
                `Youth aur athletes ke liye Baba Abhay Singh ne aitihasik kaam kiya hai:\n` +
                `• Sihali Khurd khel maidan me 75% pakki boundary, running track, basketball court aur modern open gym ka nirman!\n` +
                `• Aage ka sankalp: Hadahedi va Sihali Kalan me bhi naye khel maidan va running track ka vistar! 🏆🚩`
            );
        }
        return (
            `राम राम ${honorific}! 🏃‍♂️\n` +
            `युवाओं व खिलाड़ियों के लिए बाबा अभय सिंह ने ऐतिहासिक कार्य किया है:\n` +
            `• सिहाली खुर्द खेल मैदान में 75% पक्की चारदीवारी, रनिंग ट्रैक, बास्केटबॉल कोर्ट और आधुनिक ओपन जिम (Open Gym) का निर्माण!\n` +
            `• आगे का संकल्प: हाड़ाहेड़ी व सिहाली कलां में भी नए खेल मैदान व रनिंग ट्रैक का पूर्ण विस्तार! 🏆🚩`
        );
    }

    // D. Education & Modular Library
    if (q.includes('library') || q.includes('लाइब्रेरी') || q.includes('किताब') || q.includes('school') || q.includes('topper') || (q.includes('shiksha') && !q.includes('hu')) || q.includes('टॉपर') || q.includes('स्कूल')) {
        if (isHinglish) {
            return (
                `Ram Ram ${honorific}! 📚\n` +
                `Education aur students ke liye Baba Abhay Singh ke mukhya kaam:\n` +
                `• Sihali Khurd me students ke liye modern digital library ka nirman!\n` +
                `• Aage Hadahedi va Sihali Kalan me bhi modern library ka vistar hoga. 🎓🚩`
            );
        }
        return (
            `राम राम ${honorific}! 📚\n` +
            `शिक्षा व छात्र-छात्राओं के लिए बाबा अभय सिंह के मुख्य कार्य:
` +
            `• सिहाली खुर्द में छात्र-छात्राओं हेतु आधुनिक मॉड्यूलर / डिजिटल लाइब्रेरी का निर्माण!
` +
            `• आगे हाड़ाहेड़ी व सिहाली कलां में भी आधुनिक लाइब्रेरी का विस्तार होगा। 🎓🚩`
        );
    }

    // E. Drinking Water / JJM
    if (!q.includes('kichad') && !q.includes('bharta') && (q.includes('nal') || q.includes('borewell') || q.includes('jjm') || q.includes('drinking water') || q.includes('पेयजल') || ((q.includes('pani') || q.includes('paani') || q.includes('जल') || q.includes('टंकी')) && !q.includes('samasya') && !q.includes('shikayat') && !q.includes('sadak')))) {
        if (isHinglish) {
            return (
                `Ram Ram ${honorific}! 💧\n` +
                `Peyajal vyavastha (JJM) ke tehat Baba Abhay Singh dwara karwaye gaye kaam:\n` +
                `• Ucch va nimn paani ki tankiyan aur ghar-ghar meetha paani nal connection!\n` +
                `• Sihali se Hadahedi ke seem sandhe par naye gehre borewell!\n` +
                `• Bachi hui dhaniyon tak meetha paani permanent pahunchana first priority hai. 🚩`
            );
        }
        return (
            `राम राम ${honorific}! 💧\n` +
            `पेयजल व्यवस्था (JJM) के तहत बाबा अभय सिंह द्वारा करवाए गए कार्य:
` +
            `• उच्च व निम्न पानी की टंकियां और घर-घर शुद्ध मीठे पानी के नल कनेक्शन!
` +
            `• सिहाली से हाड़ाहेड़ी के सीम संधे पर नए गहरे बोरवेल अधिष्ठापन!
` +
            `• शेष बची ढाणियों तक मीठे पानी की स्थायी लाइन पहुँचाना सर्वोच्च प्राथमिकता है। 🚩`
        );
    }

    // F. Roads & Infrastructure (held details are never claimed)
    if (!q.includes('kichad') && !q.includes('gaddha') && !q.includes('samasya') && !q.includes('shikayat') && (q.includes('road') || q.includes('sadak') || q.includes('cc road') || q.includes('damar') || q.includes('interlocking') || q.includes('सड़क') || q.includes('डामर'))) {
        const heldDetailRequested = q.includes('cc road') || q.includes('interlocking') || q.includes('सी.सी') || q.includes('इंटरलॉकिंग');
        if (heldDetailRequested) {
            return isHinglish
                ? `${honorific}, internal lane/road-tile details abhi verification me hain. Main bina pakki jaanch ke koi list ya count nahi bataunga.`
                : `${honorific}, अंदरूनी गली/सड़क-टाइल का विवरण अभी सत्यापन में है। पक्की जाँच के बिना कोई सूची या संख्या नहीं बताऊँगा।`;
        }
        if (isHinglish) {
            return (
                `Ram Ram ${honorific}! 🛣️\n` +
                `Sadak va raaston ke mukhya vikas karya:\n` +
                `• Sihali Kalan-Hadahedi main road aur Baba Kundandas Ashram road ka pakka punarnirman hua.\n` +
                `• Baniya Wala Kudi se Baba Mathuradas Mandir tak pakki damar road bani.\n` +
                `• Aage Sihali Khurd-Hadahedi main link road ka sankalp hai. 🚩`
            );
        }
        return (
            `राम राम ${honorific}! 🛣️\n` +
            `सड़क व रास्तों के मुख्य विकास कार्य:
` +
            `• सिहाली कलां-हाड़ाहेड़ी मुख्य सड़क और बाबा कुन्दनदास आश्रम मार्ग का पक्का पुनर्निर्माण हुआ।
` +
            `• बनिया वाला कूड़ी से बाबा मथुरादास मंदिर तक पक्की डामर सड़क बनी।
` +
            `• आगे सिहाली खुर्द-हाड़ाहेड़ी मुख्य लिंक सड़क का संकल्प है। 🚩`
        );
    }

    // G. Crematorium / Mokshdham & Johads
    if (q.includes('mokshdham') || q.includes('shmashan') || q.includes('johad') || q.includes('तालाब') || q.includes('श्मशान') || q.includes('मोक्षधाम') || q.includes('जोहड़')) {
        if (isHinglish) {
            return (
                `Ram Ram ${honorific}! 🕊️\n` +
                `Mokshdham va paryavaran sanrakshan ke kaam:\n` +
                `• Mokshdham ka mitti bharat, samtlikaran, 2 naye borewell aur paani ki tanki!\n` +
                `• Paramparik johadon ki gehari khudai aur jeernoddhar. 🚩`
            );
        }
        return (
            `राम राम ${honorific}! 🕊️\n` +
            `मोक्षधाम व पर्यावरण संरक्षण के कार्य:
` +
            `• मोक्षधाम का मिट्टी भरत, समतलीकरण, 2 नए बोरवेल और पानी की टंकी की व्यवस्था!
` +
            `• पारंपरिक जोहड़ों की गहरी खुदाई व जीर्णोद्धार। 🚩`
        );
    }

    // H. General Major Works Fact Sheet (The 12 Core Highlights Summary)
    if (q.includes('kaam') || q.includes('काम') || q.includes('kam') || q.includes('karwaya') || q.includes('vikas') || q.includes('विकास') || q.includes('कार्य')) {
        if (isHinglish) {
            return (
                `Ram Ram ${honorific}! 🙏\n` +
                `Baba Abhay Singh dwara karwaye gaye pramanit mukhya kaam:\n` +
                `• Up-swasthya kendra hetu swayam niji zameen daan va Sihali Kalan me pashu aspatal nirman\n` +
                `• JJM ghar-ghar meetha peyejal va naye borewell\n` +
                `• Pakki damar roads aur satyapit underground drainage lines\n` +
                `• Modern digital library va open gym khel maidan!\n\n` +
                `Agar kisi specific kaam ke bare me janna ho to batayein ${honorific}! 😊🚩`
            );
        }
        return (
            `राम राम ${honorific}! 🙏
` +
            `बाबा अभय सिंह द्वारा करवाए गए प्रमाणित मुख्य कार्य (Locked Facts):
` +
            `• उप-स्वास्थ्य केंद्र हेतु स्वयं निजी भूमिदान व सिहाली कलां में पशु चिकित्सालय निर्माण
` +
            `• JJM घर-घर मीठा पेयजल व नए बोरवेल
` +
            `• पक्की डामर सड़कें और सत्यापित भूमिगत जलनिकासी लाइनें
` +
            `• अत्याधुनिक डिजिटल लाइब्रेरी व ओपन जिम युक्त खेल मैदान!

` +
            `अगर किसी खास काम या योजना के बारे में विस्तार से जानना हो तो बताइए ${honorific}! 😊🚩`
        );
    }

    // 5. Candidate Profile ("baba kon hai", "who is baba")
    if ((q.includes('kon') || q.includes('kaun') || q.includes('who')) && (q.includes('baba') || q.includes('abhay') || q.includes('pratyashi') || q.includes('candidate'))) {
        if (isHinglish) {
            return (
                `Ram Ram ${honorific}! 🙏\n` +
                `Baba Abhay Singh (Moti Aangli Wale Baba) Sihali Khurd, Sihali Kalan va Hadahedi teeno gaon ke sarvamanya va nishwarth jan-sevak hain.\n` +
                `• 40 saalon se bina kisi lalach ya pad ke har gaon wale ke sukh-dukh me khunta gaad kar sath khade rahe hain.\n` +
                `• Niji zameen daan dekar up-swasthya kendra banwaya aur JJM meetha paani dilwaya.\n\n` +
                `Is baar teeno gaon ke samman va vikas ke liye sarpanch pad ke candidate hain! 🚩`
            );
        }
        return (
            `राम राम ${honorific}! 🙏
` +
            `बाबा अभय सिंह (मोटी आंगली वाले बाबा) सिहाली खुर्द, सिहाली कलां व हाड़ाहेड़ी तीनों गाँवों के सर्वमान्य व निस्वार्थ जनसेवक हैं।
` +
            `• 40 वर्षों से बिना किसी स्वार्थ या पद के हर ग्रामीण के सुख-दुख में खूंटा गाड़ कर साथ खड़े रहे हैं।
` +
            `• अपनी निजी भूमि दान देकर गाँव में उप-स्वास्थ्य केंद्र बनवाया और JJM मीठे पानी की सौगात दिलाई।

` +
            `इस बार तीनों गाँवों के विकास व मान-सम्मान के लिए सरपंच पद के अधिकृत प्रत्याशी हैं! 🚩`
        );
    }

    // 6. Location Hook ("kaha ho", "office")
    if (/\b(kaha|kahan)\s+(pe\s+)?(ho|hai|h)\b/i.test(q) || q.includes('office') || q.includes('karyalay')) {
        if (isHinglish) {
            return `Ram Ram ${honorific}! 🙏 Baba Abhay Singh ji ka aawas va jansampark Sihali Khurd me sabhi bhai-behno ke liye 24 ghante khula hai. Aap kabhi bhi aa sakte hain! 😊🚩`;
        }
        return `राम राम ${honorific}! 🙏 बाबा अभय सिंह जी का आवास व जनसंपर्क कार्यालय सिहाली खुर्द में तीनों गाँवों के हर भाई-बहन के लिए 24 घंटे खुला है। आप कभी भी पधार सकते हैं। 😊🚩`;
    }

    // 7. Slogan Request
    if (q.includes('slogan') || q.includes('नारा') || q.includes('shayari') || q.includes('शायरी')) {
        const slogan = userMemory.getNextSlogan(phone);
        return `राम राम ${honorific}! 🙏\n\n"${slogan}"\n\n16 नवम्बर 2026 — बाबा अभय सिंह 🚩`;
    }

    // 8. What are you doing / Status Hook ("kya kar rahe ho", "kya chal raha h")
    if (q.includes('kya kar rahe') || q.includes('kya chal raha') || q.includes('kya chal rha') || q.includes('kya ho rha')) {
        if (isHinglish) {
            return `Bas ${honorific}, poore Sihali Khurd, Sihali Kalan aur Hadahedi me Baba Abhay Singh ke vikas rath aur prachar ki taiyari chal rahi hai! 🚩 Aapke mohalle me kya mahol lag raha hai is baar? 😊`;
        }
        return `बस ${honorific}, पूरे सिहाली खुर्द, सिहाली कलां और हाड़ाहेड़ी में बाबा अभय सिंह के विकास रथ और प्रचार की तैयारी चल रही है! 🚩 आपके मोहल्ले और वार्ड में क्या माहौल लग रहा है इस बार? 😊`;
    }

    // 9. Well-being Confirmation ("theek hu", "badhiya", "sab theek") -> Transition to Step 2 Occupation
    if (q.includes('theek hu') || q.includes('thik hu') || q.includes('badhiya hu') || q.includes('sab theek') || q.includes('sab badhiya') || q.includes('kushal mangal')) {
        if (user) {
            user.conversationStage = 'ASKED_OCCUPATION';
            userMemory.save();
        }
        if (isHinglish) {
            return `Sunkar bohot khushi hui ${honorific}! 🙏 Bhagwan ka aashirwad aapke parivar par bana rahe. Accha batayein, aap kya karte hain — padhai, kisani, army, police ya apna koi kaam? 😊🚩`;
        }
        return `सुनकर बहुत खुशी हुई ${honorific}! 🙏 भगवान का आशीर्वाद आप और आपके पूरे परिवार पर हमेशा बना रहे। अच्छा बताइए, आप क्या करते हैं — पढ़ाई, किसानी, फौज, पुलिस या कोई अपना काम? 😊🚩`;
    }

    // 10. Mahool / Ground Atmosphere Hook
    if (q.includes('mahol') || q.includes('mahool') || q.includes('palda') || q.includes('hawa') || q.includes('takkar')) {
        if (isHinglish) {
            return `Ram Ram ${honorific}! 🚩 Teeno gaon (Sihali Khurd, Sihali Kalan, Hadahedi) me Baba Abhay Singh ke 40 saal ke nishwarth kaam aur saaf chhavi ka ek-tarfa support dikh raha hai. Janta janti hai kisne kaam kiya hai! Aap apne yahan ka haal batayein ${honorific}, mohalle me kya charcha hai? 😊`;
        }
        return `राम राम ${honorific}! 🚩 तीनों गाँवों (सिहाली खुर्द, सिहाली कलां, हाड़ाहेड़ी) में बाबा अभय सिंह के 40 साल के निस्वार्थ काम और साफ़ छवि का एकतरफा समर्थन दिख रहा है। जनता जानती है कि काम किसने किया है और कौन सिर्फ चुनाव में दिख रहा है! आप अपने यहाँ का हाल बताइए ${honorific}, आपके मोहल्ले में क्या चर्चा है? 😊`;
    }

    // 11. Polite Acknowledgment Hooks ("shukriya", "dhanyawad", "shubh ratri", "ok", "theek h chalte h")
    if (q.includes('shukriya') || q.includes('dhanyawad') || q.includes('thanks') || q.includes('thank you')) {
        if (isHinglish) {
            return `Arre shukriya kaisa ${honorific}, hum to apne parivar aur gaon ki seva me hazir hain! Kabhi bhi zaroorat ho to bas message bhej dena. Ram Ram! 🙏🚩`;
        }
        return `अरे शुक्रिया कैसा ${honorific}, हम तो अपने परिवार और गाँव की सेवा में हाजिर हैं! कभी भी कोई ज़रूरत हो तो बस एक संदेश भेज दीजिएगा। राम राम! 🙏🚩`;
    }

    if (q.includes('shubh ratri') || q.includes('good night') || q.includes('goodnight')) {
        if (isHinglish) {
            return `Shubh ratri ${honorific}! 🙏 Meethe sapne aayein aur parivar par kripa bani rahe. Kal subah fir Baba ji ke naye sankalp ke sath milte hain! 🌙🚩`;
        }
        return `शुभ रात्रि ${honorific}! 🙏 मीठे सपने आएं और भगवान की कृपा हमेशा आपके परिवार पर बनी रहे। कल सुबह फिर बाबा जी के नए संकल्प के साथ मिलते हैं! 🌙🚩`;
    }

    if (q === 'ok' || q === 'okie' || q === 'theek h' || q === 'thik h' || q.includes('chalte') || q.includes('alvida') || q === 'achha' || q === 'accha' || q === 'achha ji' || q === 'samajh gaya' || q === 'sahi h') {
        if (isHinglish) {
            return `Ji bilkul ${honorific}! Koi bhi aur jankari chahiye ho ya voter parchi dekhni ho, to bina kisi jhijhak ke likh dena. Baba Abhay Singh ki team hamesha aapke sath hai! 😊🚩`;
        }
        return `जी बिल्कुल ${honorific}! कोई भी और जानकारी चाहिए हो या परिवार की वोटर पर्ची देखनी हो, तो बिना किसी झिझक के लिख दीजिएगा। बाबा अभय सिंह की टीम हमेशा आपके साथ है! 😊🚩`;
    }

    // 12. Vote Inquiry ("baba ko vote kyu de", "vote kyu kare")
    const isVoteInquiry = q.includes('kyu') || q.includes('kyun') || q.includes('why') || q.includes('kaise') || q.includes('reason') || q.includes('kis liye');
    if (isVoteInquiry && (q.includes('vote') || q.includes('support') || q.includes('chunav'))) {
        if (isHinglish) {
            return (
                `Ram Ram ${honorific}! 🙏\n` +
                `Baba Abhay Singh ko support karne ke 3 sabse bade reason hain:\n` +
                `1. Nishwarth Seva: Niji zameen daan dekar aspatal banwaya, kabhi rajniti ko dhandha nahi banaya!\n` +
                `2. 40 saal ka bharosa: 24 ghante har sukh-dukh me khunta gaad kar sath khade rahe hain.\n` +
                `3. Pramanit Vikas: JJM paani, modular library, health-centre land donation aur sports ground!\n\n` +
                `Saaf niyat, saccha irada — baki aap khud samajhdar hain ${honorific}, vikas dekhkar hi aashirwad dijiyega! 🚩`
            );
        }
        return (
            `राम राम ${honorific}! 🙏
` +
            `बाबा अभय सिंह को समर्थन देने के 3 सबसे बड़े कारण हैं:
` +
            `1. निस्वार्थ सेवा: अपनी निजी भूमि दान देकर अस्पताल बनवाया, कभी राजनीति को स्वार्थ का जरिया नहीं बनाया!
` +
            `2. 40 साल का भरोसा: 24 घंटे हर सुख-दुख में खूंटा गाड़ कर गाँव के साथ खड़े रहे हैं।
` +
            `3. प्रमाणित विकास: JJM पेयजल, मॉड्यूलर लाइब्रेरी, स्वास्थ्य केंद्र भूमिदान और खेल मैदान!

` +
            `साफ़ नीयत, सच्चा इरादा — बाकी आप खुद समझदार हैं ${honorific}, विकास देखकर ही आशीर्वाद दीजिएगा! 🚩`
        );
    }

    // 13. The 5-Step Engagement Ladder
    // Step 5: Direct Vote Commitment Answers (YES / NO / DOUBTFUL)
    const isDirectReject = q.includes('nahi denge') || q.includes('nhi denge') || q.includes('kisi aur ko') || q.includes('vote nahi') || q.includes('vote nhi');
    const isVoteQuery = !isVoteInquiry && (isDirectReject || q.includes('vote') || q.includes('वोट') || q.includes('समर्थन') || q.includes('support') || user?.conversationStage === 'ASKED_VOTE_INTENT');

    if (isDirectReject || (isVoteQuery && (q.includes('nahi') || q.includes('nhi') || q.includes('no') || q.includes('kisi aur') || q.includes('mat do')))) {
        if (user) {
            user.voteIntent = 'no';
            user.conversationStage = 'VOTE_DOUBTFUL';
            userMemory.save();
        }
        if (isHinglish) {
            return `Arre koi baat nahi ${honorific}... Hum aapki baat ka pura samman karte hain. Kya hamare kaam me koi kami lagi, ya koi parivarik dabav hai ${honorific}? Hum aapke aur gaon ke liye kya sudhar kar sakte hain, zaroor batana! 🙏`;
        }
        return `अरे कोई बात नहीं ${honorific}... हम आपकी बात का पूरा सम्मान करते हैं। क्या हमारे काम में कोई कमी लगी, या कोई पारिवारिक दबाव है ${honorific}? हम आपके और गाँव के लिए क्या सुधार कर सकते हैं, ज़रूर बताइएगा! 🙏`;
    }

    if (isVoteQuery && (q.includes('haan') || q.includes('ha') || q.includes('हाँ') || q.includes('yes') || q.includes('baba ko') || q.includes('denge') || q.includes('pakka') || q.includes('full') || q.includes('saath h'))) {
        if (user) {
            user.voteIntent = 'yes';
            user.conversationStage = 'VOTE_COMMITTED';
            userMemory.save();
        }
        if (isHinglish) {
            return `Arre dil jeet liya aapne! ❤️🙏🚩 Aapka yahi vishwas aur aashirwad Baba Abhay Singh ji ki asli taakat hai. Is baar Sihali Khurd ke vikas ki jeet pakki hai! Apne parivar aur dosto ko bhi sath jodiyega ${honorific}! 😊`;
        }
        return `अरे दिल जीत लिया आपने! ❤️🙏🚩 आपका यही विश्वास और आशीर्वाद बाबा अभय सिंह जी की असली ताकत है। इस बार सिहाली खुर्द के विकास की जीत पक्की है! अपने परिवार और दोस्तों को भी साथ जोड़िएगा ${honorific}! 😊`;
    }

    // Step 2: Occupation Hook Answers ("kya karte ho tum?")
    const occKeywords = ['student', 'padhai', 'study', 'college', 'tayari', 'kisan', 'kheti', 'army', 'fauj', 'fauji', 'police', 'teacher', 'master', 'lawyer', 'vakil', 'vakeel', 'driver', 'dukan', 'shop', 'business', 'job', 'company'];
    const matchedOcc = occKeywords.some(k => q.includes(k));
    if (matchedOcc || user?.conversationStage === 'ASKED_OCCUPATION') {
        if (user) {
            user.conversationStage = 'OFFERED_VISIT';
            userMemory.save();
        }
        if (isHinglish) {
            return `Arre wah! Ek number! 👏 Bohot samman hai aapki is mehnat ka ${honorific}! Garv hai humein aap par. Accha ek baat batana, kya aap chahte hain ki Baba Abhay Singh ji aapke ghar aayein milne? Baba ji ke darwaze to poore gaon ke liye 24 ghante khule hain! 😊🚩`;
        }
        return `अरे वाह! एक नंबर! 👏 बहुत सम्मान है आपकी इस मेहनत का ${honorific}! गर्व है हमें आप पर। अच्छा एक बात बताइए, क्या आप चाहते हैं कि बाबा अभय सिंह जी आपके घर आएं आपसे मिलने? बाबा जी के दरवाज़े तो पूरे गाँव के लिए 24 घंटे खुले हैं! 😊🚩`;
    }

    // Step 3: Home Visit Invitation Responses ("ghar aao", "milna", "meeting")
    if (q.includes('ghar aao') || q.includes('milna') || q.includes('baba se mil') || q.includes('aayein') || q.includes('zaroor aao') || (user?.conversationStage === 'OFFERED_VISIT' && !matchedOcc && (q.includes('ha') || q.includes('haan') || q.includes('zaroor') || q.includes('aao') || q.includes('theek') || q.includes('bilkul') || q.includes('aaye')))) {
        if (user) {
            user.conversationStage = 'ASKED_PROBLEM';
            user.wantsVisit = true;
            userMemory.save();
        }
        if (isHinglish) {
            return `Ji bilkul ${honorific}! Aapki baat maine Baba ji ki diary me note kar li hai, jald hi aapke yahan chai peene zaroor aayenge! ☕🚩 Accha, gaon me ya aapki koi khas samasya jiska dhyan rakhna chahiye ${honorific}?\n\n*(Agar kisi baat me koi kami reh gayi ho to chhota maan kar maaf karna ${honorific}, hum to bas gaon ki seva me lage hain! 🙏)*`;
        }
        return `जी बिल्कुल ${honorific}! आपकी बात मैंने बाबा जी की डायरी में नोट कर ली है, जल्द ही आपके यहाँ चाय पीने ज़रूर पहुँचेंगे! ☕🚩 अच्छा, गाँव में या आपके जीवन में कोई खास समस्या जिसका ध्यान रखना चाहिए ${honorific}?\n\n*(अगर किसी बात में कोई कमी रह गई हो तो छोटा मानकर माफ करना ${honorific}, हम तो बस गाँव की सेवा में लगे हैं! 🙏)*`;
    }

    // Step 4: Problems & Grievances Hook -> Leaning to Vote Commitment
    if (q.includes('samasya') || q.includes('samashya') || q.includes('shikayat') || q.includes('problem') || q.includes('gaddha') || q.includes('kichad') || q.includes('keechad') || (user?.conversationStage === 'ASKED_PROBLEM' && !matchedOcc && !isVoteQuery && !isVoteInquiry)) {
        if (user) {
            user.conversationStage = 'ASKED_VOTE_INTENT';
            userMemory.save();
        }
        if (isHinglish) {
            return `Bhaiya, aapki yeh baat maine seedhe Baba Abhay Singh ji ke dhyan me daal di hai. Koi jhootha ya hawai vaada to nahi karenge, par jo bhi sambhav hoga Baba ji poori nishtha se karwayenge! 📝🚩 Waise sach batana ${honorific}... kya aapka man hai is baar Baba ji ko vote dene ka? 🚩`;
        }
        return `भैया, आपकी यह बात मैंने सीधे बाबा अभय सिंह जी के ध्यान में डाल दी है। कोई झूठा या हवाई वादा तो नहीं करेंगे, पर जो भी संभव होगा वो बाबा जी पूरी निष्ठा से करवा देंगे! 📝🚩 वैसे सच बताना ${honorific}... क्या आपका मन है इस बार बाबा जी को वोट देने का? 🚩`;
    }

    // 14. How are you / Health / Well-being
    if (/\b(haal|hal|haal-chal)\b/i.test(q) || q.includes('kaise ho') || q.includes('kasa') || q.includes('kaisa') || q.includes('kese ho')) {
        if (isHinglish) {
            return `Ram Ram ${honorific}! 🙏 Baba Abhay Singh ke aashirwad aur aap sabhi ke pyar se sab badhiya hai. Aap batao ${honorific}, ghar-parivar me sab kushal mangal? Apne mohalle aur ward me is baar kya mahol lag raha hai? 😊🚩`;
        }
        return `राम राम ${honorific}! 🙏 बाबा अभय सिंह के आशीर्वाद और आप सभी के प्यार-स्नेह से सब बढ़िया है। आप बताओ ${honorific}, घर-परिवार में सब कुशल मंगल? अपने मोहल्ले और वार्ड में इस बार क्या माहौल लग रहा है? 😊🚩`;
    }

    // 15. Default Dynamic Welcome Hook
    if (isHinglish) {
        return (
            `Ram Ram ${honorific}! 🙏\n` +
            `Baba Abhay Singh (Moti Aangli Wale Baba) Jansampark.\n` +
            `Voter parchi dekhne ke liye apna naam likh kar bhejein, ya vikas karyon par charcha karein! 🚩`
        );
    }
    return (
        `राम राम ${honorific}! 🙏\n` +
        `बाबा अभय सिंह (मोटी आंगली वाले बाबा) जनसंपर्क।\n` +
        `वोटर पर्ची देखने के लिए अपना शुभ नाम लिखकर भेजें, या गाँव के विकास कार्यों पर चर्चा करें! 🚩`
    );
}

/**
 * LEGACY canned engine — neutralised (Brain v2). server.js no longer calls it; it is kept only for old
 * tests and REPLY_BRAIN=off. Its output is passed through sanitizeLegacy(): no bare "बाबा जी"/"Baba ji",
 * no work counts, no budgets.
 */
function sanitizeLegacy(text) {
    return String(text || '')
        .replace(/बाबा जी के/g, 'अभय सिंह जी के').replace(/बाबा जी/g, 'अभय सिंह जी').replace(/बाबाजी/g, 'अभय सिंह जी')
        .replace(/\bBaba ji\b/g, 'Abhay Singh ji').replace(/\bbaba ji\b/g, 'Abhay Singh ji').replace(/\bBabaji\b/g, 'Abhay Singh ji')
        .replace(/बाबा अभय सिंह जी जी/g, 'बाबा अभय सिंह जी').replace(/अभय सिंह जी अभय सिंह जी/g, 'अभय सिंह जी')
        .replace(/बाबा के विकास/g, 'बाबा अभय सिंह के विकास').replace(/बाबा का साथ/g, 'बाबा अभय सिंह का साथ')
        .replace(/\b\d+\+?\s*(प्रमुख संकल्प|mukhya sankalp|संकल्प|sankalp|काम|kaam)\b/g, '$1')
        .replace(/[\d,.]+\s*(लाख|करोड़|रुपये|रुपए|lakh|crore)/gi, '');
}

function getFastLocalAnswer(query, phone = null) {
    const user = phone ? userMemory.getUser(phone) : null;
    return sanitizeLegacy(replyQuality.improve(getFastLocalAnswerCore(query, phone), query, user));
}

/**
 * Backstop used by server.js when the async reply path throws or returns nothing: the grounded
 * Brain v2 composer (fact sheets + voter memory), synchronous and offline.
 */
function getSafeFallback(query, phone = null) {
    try {
        const user = phone ? userMemory.getUser(phone) : { history: [], context: {} };
        const text = brain.respondSync(query, user);
        if (phone) userMemory.save();
        return text;
    } catch (e) {
        console.error('[AI Assistant] safe fallback failed:', e.message);
        return 'जी 🙏 आपकी बात नोट कर ली है—टीम जल्द जवाब देगी।';
    }
}

// 1. Call NVIDIA Endpoint

async function callNvidia(messages, key) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8500);
    try {
        const res = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
            method: 'POST',
            signal: controller.signal,
            headers: {
                'Authorization': `Bearer ${key}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'nvidia/nemotron-3.5-bolt-e4b',
                messages: messages,
                max_tokens: 280,
                temperature: 0.6
            })
        });
        clearTimeout(timeout);
        if (!res.ok) throw new Error(`NVIDIA HTTP ${res.status}`);
        const data = await res.json();
        return data.choices?.[0]?.message?.content?.trim();
    } catch (e) {
        clearTimeout(timeout);
        throw e;
    }
}

// 2. Call Groq Endpoint (Ultra-fast Secondary Fallback)
async function callGroq(messages, key) {
    if (!key) throw new Error('No Groq key configured');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8500);
    try {
        const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            signal: controller.signal,
            headers: {
                'Authorization': `Bearer ${key}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'llama-3.1-8b-instant',
                messages: messages,
                max_tokens: 280,
                temperature: 0.6
            })
        });
        clearTimeout(timeout);
        if (!res.ok) throw new Error(`Groq HTTP ${res.status}`);
        const data = await res.json();
        return data.choices?.[0]?.message?.content?.trim();
    } catch (e) {
        clearTimeout(timeout);
        throw e;
    }
}

// 3. Call Gemini REST Endpoint (High-volume Tertiary Fallback)
async function callGemini(systemPrompt, conversationHistory, userMessage, key) {
    if (!key) throw new Error('No Gemini key configured');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3500);
    try {
        const contents = [];
        for (const msg of conversationHistory) {
            contents.push({
                role: msg.role === 'assistant' ? 'model' : 'user',
                parts: [{ text: msg.content }]
            });
        }
        contents.push({
            role: 'user',
            parts: [{ text: userMessage }]
        });

        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${key}`;
        const res = await fetch(url, {
            method: 'POST',
            signal: controller.signal,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                system_instruction: { parts: [{ text: systemPrompt }] },
                contents: contents,
                generationConfig: { maxOutputTokens: 280, temperature: 0.6 }
            })
        });
        clearTimeout(timeout);
        if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
        const data = await res.json();
        return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    } catch (e) {
        clearTimeout(timeout);
        throw e;
    }
}

function isCannedRejection(reply) {
    if (!reply) return true;
    const l = reply.toLowerCase();
    return (
        l.includes("i'm sorry") ||
        l.includes("cannot help") ||
        l.includes("can't help") ||
        l.includes("cannot fulfill") ||
        l.includes("as an ai")
    );
}

// AI Assistant query with multi-tier failover (NVIDIA Key 1 -> Key 2 -> Groq -> Gemini -> Local Fast Engine)
async function getAIResponse(userMessage, apiKey = null, conversationHistory = [], phone = null, meta = {}) {
    const lowerMsg = userMessage.toLowerCase().trim();
    const isParchiReq = lowerMsg.includes('parchi') || lowerMsg.includes('voter') || lowerMsg.includes('slip') || lowerMsg.includes('nikal') || lowerMsg.includes('bhej') || lowerMsg.includes('yadav');

    // Fast Prince Admin recognition (Only if purely addressing admin, not asking for voter parchi)
    if ((lowerMsg === 'prince' || lowerMsg === 'admin') && !isParchiReq) {
        return getFastLocalAnswer(userMessage, phone);
    }

    const user = phone ? userMemory.getUser(phone) : null;

    // Check if voter is giving a contextual follow-up confirmation ("ye hie details h", "yahi h", etc.)
    const isFollowUpDetails = lowerMsg.includes('ye hie') || lowerMsg.includes('yahi') || lowerMsg.includes('yehi') || lowerMsg.includes('itna hi') || lowerMsg.includes('yahi h') || lowerMsg.includes('yahi he');
    if (isFollowUpDetails && user && user.lastFoundVoter) {
        console.log('[AI Assistant] Delivering stored voter slip upon details confirmation for:', phone);
        return voterEngine.formatSlipResponse(user.lastFoundVoter);
    }

    // Pending slip: person answered with father/husband name -> deliver only on a real match
    if (user && user.pendingParchiCandidate) {
        const pv = user.pendingParchiCandidate;
        const relHi = (pv.rel_name_hi || '').toLowerCase();
        const relEn = String(pv.rel_name_en || '').toLowerCase();
        if ((relHi && lowerMsg.includes(relHi)) || (relEn && relEn.length > 2 && lowerMsg.includes(relEn))) {
            delete user.pendingParchiCandidate;
            user.lastFoundVoter = pv;
            if (!user.ward && pv.ward) user.ward = pv.ward;
            userMemory.save();
            return voterEngine.formatSlipResponse(pv);
        }
    }

    // Direct voter search interception ONLY if message is likely a name or voter query
    // (never while the voter is answering an open samasya/mulaqat question, unless they explicitly ask for a parchi)
    const explicitParchi = /(parchi|पर्ची|voter slip|voter id|epic|slip)/i.test(lowerMsg);
    // A self-introduction mid-chat ("main ward 4 se hu, mera naam Suresh hai") is remembered and answered by the
    // brain; it never silently turns into a voter-list search. An explicit parchi ask still searches.
    const selfIntro = /((mera|meri|mero|mhara|my)\s+(naam|name|nam)|(मेरा|म्हारा)\s+नाम)/i.test(userMessage) && !explicitParchi;
    if (user && selfIntro) {
        try {
            const vm = require('./voter_memory.js');
            const m = vm.ensure(user);
            const nm = vm.extractName(userMessage);
            if (nm) { m.name = nm; m.nameSource = 'message'; }
            const w = userMessage.match(/(?:ward|वार्ड)\s*(?:no\.?|नं\.?)?\s*(\d{1,2})\b/i);
            if (w && Number(w[1]) >= 1 && Number(w[1]) <= 11) { m.ward = Number(w[1]); if (!user.ward) user.ward = Number(w[1]); }
        } catch (e) {}
    }
    if (voterEngine && !selfIntro && voterEngine.isLikelyNameOrVoterQuery(userMessage) && !(user && brain.inFlow(user) && !explicitParchi)) {
        const candidateTerms = ['baba abhay singh', 'abhay singh', 'baba ji', 'babaji', 'baba'];
        const isCandidateQuery = candidateTerms.some(t => lowerMsg.includes(t));
        if (!isCandidateQuery) {
            const userWard = user?.ward || null;
            const matches = voterEngine.searchVoters(userMessage, 1, userWard);
            if (matches && matches.length > 0) {
                if (user) {
                    user.lastSearchedQuery = userMessage;
                    user.lastSearchedName = matches[0].name;
                    user.lastFoundVoter = matches[0];
                    if (!user.ward && matches[0].ward) user.ward = matches[0].ward;
                    if (!user.name) user.name = matches[0].name;
                    userMemory.save();
                }
                const tv = matches[0];
                const relLow = (tv.rel_name_hi || '').toLowerCase();
                const fatherGiven = (relLow && lowerMsg.includes(relLow)) || (tv.rel_name_en && lowerMsg.includes(String(tv.rel_name_en).toLowerCase()));
                if (!fatherGiven) {
                    // Privacy: never hand out a slip on a bare name match; confirm father/husband first
                    if (user) { user.pendingParchiCandidate = tv; userMemory.save(); }
                    const relLabel = tv.rel_type === 'H' ? 'पति' : 'पिताजी';
                    console.log('[AI Assistant] Name match; asking relative confirmation before slip for:', userMessage);
                    return `वोटर लिस्ट में *${tv.name_hi || tv.name}* नाम मिला है 📋\n\nपर्ची भेजने से पहले बस पुष्टि कर दीजिए — आपके ${relLabel} का नाम क्या है? 🙏`;
                }
                console.log('[AI Assistant] Auto-intercepted high-precision voter query for:', userMessage);
                return voterEngine.formatSlipResponse(tv);
            }
        }
    }

    // ---- Reply Brain: classify intent, answer that thing from verified facts, one persuasion step ----
    if (process.env.REPLY_BRAIN !== 'off') {
        const brainUser = user || { history: [], context: {} };
        let goalText = '';
        let dailyGoalMod = null;
        try {
            dailyGoalMod = require('./daily_goal.js');
            const g = dailyGoalMod.get();
            goalText = [g.title, g.instruction, g.targetCommitted ? `target: ${g.targetCommitted} committed votes today` : ''].filter(Boolean).join(' — ');
        } catch (e) {}
        const llm = hasAnyLLM(apiKey) ? (sys, history, msg) => callLLMCascade(sys, history, msg, apiKey, 7000) : null;
        const llmJson = hasAnyLLM(apiKey) && process.env.MEMORY_LLM_EXTRACT !== 'off'
            ? (prompt) => callLLMCascade(prompt, [], 'Return the JSON now.', apiKey, 2500) : null;
        const result = await brain.respond(userMessage, brainUser, { llm, llmJson, goal: goalText, history: conversationHistory, meta: { phone, line: meta.line || null, test: !!meta.test } });
        AI_STATUS.lastReply = { at: new Date().toISOString(), source: result.source, intent: result.intent, llmConfigured: !!llm };
        recordReplyStat(result, userMessage, !!llm);
        lastBrainResult = result;
        if (user && result.stage !== result.previousStage && dailyGoalMod && dailyGoalMod.recordEvent) {
            try { dailyGoalMod.recordEvent('stage', { phone, line: user.assignedLine, ward: user.ward, from: result.previousStage, to: result.stage }); } catch (e) {}
        }
        if (user) userMemory.save();
        return result.text;
    }

    // ---- Legacy path (REPLY_BRAIN=off) ----
    const ragContext = phone ? userMemory.getUserContextRAG(phone) : '';
    const agendaContext = campaignAgenda ? campaignAgenda.getAgendaRAGPrompt() : '';
    let systemPromptWithRAG = SYSTEM_PROMPT;
    if (agendaContext) systemPromptWithRAG += `\n\n${agendaContext}`;
    systemPromptWithRAG += `\n\n${campaignProfile.getPrompt()}`;
    if (ragContext) systemPromptWithRAG += `\n\n${ragContext}`;
    const reply = await callLLMCascade(systemPromptWithRAG, conversationHistory.slice(-6), userMessage, apiKey, 12000);
    if (reply) return replyQuality.improve(reply, userMessage, user);
    console.log('[AI Assistant] All external LLMs unavailable or filtered, using grounded local brain.');
    return getSafeFallback(userMessage, phone);
}

let lastBrainResult = null;
const AI_STATUS = { lastReply: null, lastProviderOk: null, lastProviderError: null, calls: 0, failures: 0 };
// Rolling reply statistics (in memory, reset on restart): where replies came from and why LLM output was rejected.
const REPLY_STATS = { since: new Date().toISOString(), total: 0, bySource: { llm: 0, template: 0, flow: 0, llm_rejected: 0, llm_error: 0 }, rejectReasons: {}, byIntent: {}, recent: [] };
function recordReplyStat(result, msg, llmConfigured) {
    try {
        const src = String(result.source || 'template');
        REPLY_STATS.total++;
        const kind = /llm_rejected/.test(src) ? 'llm_rejected' : (/llm_error/.test(src) ? 'llm_error' : (src.startsWith('llm') ? 'llm' : (src.startsWith('flow') ? 'flow' : 'template')));
        REPLY_STATS.bySource[kind] = (REPLY_STATS.bySource[kind] || 0) + 1;
        const why = (src.match(/llm_rejected:([a-z_]+(?::[^)+]*)?)/) || [])[1];
        if (why) { const key = why.split(':')[0]; REPLY_STATS.rejectReasons[key] = (REPLY_STATS.rejectReasons[key] || 0) + 1; }
        const bi = REPLY_STATS.byIntent[result.intent] = REPLY_STATS.byIntent[result.intent] || {};
        bi[kind] = (bi[kind] || 0) + 1;
        REPLY_STATS.recent.push({ at: new Date().toISOString(), intent: result.intent, source: src, llmConfigured, msg: String(msg || '').slice(0, 80), reply: String(result.text || '').slice(0, 200), rejectedOut: result.rejected ? result.rejected.out : undefined });
        if (REPLY_STATS.recent.length > 60) REPLY_STATS.recent.shift();
    } catch (e) {}
}

function hasAnyLLM(apiKey) {
    return Boolean(apiKey || CONFIG.nvidia_keys[0] || CONFIG.nvidia_keys[1] || CONFIG.groq_api_key || CONFIG.gemini_api_key);
}

/**
 * NVIDIA key1 -> NVIDIA key2 -> Groq -> Gemini, with an overall time budget so a slow provider
 * can never hold a chat for 25+ seconds. Returns null when nothing usable came back.
 */
async function callLLMCascade(systemPrompt, history = [], userMessage = '', apiKey = null, budgetMs = 9000) {
    const deadline = Date.now() + budgetMs;
    const messages = [{ role: 'system', content: systemPrompt }, ...history.filter(h => h && h.role && h.content), { role: 'user', content: userMessage }];
    const tiers = [];
    const k1 = apiKey || CONFIG.nvidia_keys[0];
    if (k1) tiers.push(['nvidia1', () => callNvidia(messages, k1)]);
    const k2 = CONFIG.nvidia_keys[1];
    if (k2 && k2 !== k1) tiers.push(['nvidia2', () => callNvidia(messages, k2)]);
    const gq = CONFIG.groq_api_key || process.env.GROQ_API_KEY;
    if (gq) tiers.push(['groq', () => callGroq(messages, gq)]);
    const gm = CONFIG.gemini_api_key || process.env.GEMINI_API_KEY;
    if (gm) tiers.push(['gemini', () => callGemini(systemPrompt, history, userMessage, gm)]);
    for (const [name, fn] of tiers) {
        const left = deadline - Date.now();
        if (left < 800) break;
        try {
            AI_STATUS.calls++;
            const reply = await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error('budget timeout')), left))]);
            if (reply && !isCannedRejection(reply)) { AI_STATUS.lastProviderOk = { provider: name, at: new Date().toISOString() }; return reply; }
            AI_STATUS.lastProviderError = { provider: name, error: 'empty_or_refusal', at: new Date().toISOString() };
        } catch (e) {
            AI_STATUS.failures++;
            AI_STATUS.lastProviderError = { provider: name, error: String(e.message || e).slice(0, 160), at: new Date().toISOString() };
            console.warn(`[AI Assistant] ${name} failed:`, e.message);
        }
    }
    return null;
}

function getLastBrainResult() { return lastBrainResult; }

/** Which LLM providers are configured (booleans only — never key values) + recent outcomes. */
function aiStatus() {
    return {
        replyBrain: process.env.REPLY_BRAIN === 'off' ? 'off' : 'v3',
        providers: { nvidia: CONFIG.nvidia_keys.length, groq: !!(CONFIG.groq_api_key || process.env.GROQ_API_KEY), gemini: !!(CONFIG.gemini_api_key || process.env.GEMINI_API_KEY) },
        anyLLM: hasAnyLLM(null),
        nvidiaModel: 'nvidia/nemotron-3.5-bolt-e4b',
        mode: hasAnyLLM(null) ? 'llm_with_template_fallback' : 'templates_only (no LLM key configured)',
        ...AI_STATUS,
        replyStats: REPLY_STATS
    };
}

/** Probe each configured provider once with a tiny prompt (dashboard/API only). */
async function probeProviders() {
    const out = {};
    const messages = [{ role: 'system', content: 'Reply with the single word: ok' }, { role: 'user', content: 'ping' }];
    const k1 = CONFIG.nvidia_keys[0];
    if (k1) { try { out.nvidia1 = { ok: !!(await callNvidia(messages, k1)) }; } catch (e) { out.nvidia1 = { ok: false, error: String(e.message).slice(0, 120) }; } }
    const k2 = CONFIG.nvidia_keys[1];
    if (k2) { try { out.nvidia2 = { ok: !!(await callNvidia(messages, k2)) }; } catch (e) { out.nvidia2 = { ok: false, error: String(e.message).slice(0, 120) }; } }
    const gq = CONFIG.groq_api_key || process.env.GROQ_API_KEY;
    if (gq) { try { out.groq = { ok: !!(await callGroq(messages, gq)) }; } catch (e) { out.groq = { ok: false, error: String(e.message).slice(0, 120) }; } }
    const gm = CONFIG.gemini_api_key || process.env.GEMINI_API_KEY;
    if (gm) { try { out.gemini = { ok: !!(await callGemini('Reply with the single word: ok', [], 'ping', gm)) }; } catch (e) { out.gemini = { ok: false, error: String(e.message).slice(0, 120) }; } }
    if (!Object.keys(out).length) out.none = 'No LLM API key configured on this machine (NVIDIA_API_KEY(S) / GROQ_API_KEY / GEMINI_API_KEY env or api_config.json).';
    return out;
}

function reloadKeys() {
    const fresh = loadApiConfig();
    CONFIG.nvidia_keys = fresh.nvidia_keys || [];
    CONFIG.groq_api_key = fresh.groq_api_key || '';
    CONFIG.gemini_api_key = fresh.gemini_api_key || '';
    return { nvidia: CONFIG.nvidia_keys.length, groq: !!CONFIG.groq_api_key, gemini: !!CONFIG.gemini_api_key };
}

module.exports = {
    reloadKeys,
    getAIResponse,
    getLastBrainResult,
    aiStatus,
    probeProviders,
    callLLMCascade,
    getFastLocalAnswer,
    getSafeFallback,
    sanitizeLegacy,
    SYSTEM_PROMPT,
    CONFIG
};
