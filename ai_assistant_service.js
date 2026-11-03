const path = require('path');
const fs = require('fs');
const userMemory = require('./user_memory.js');
const campaignAgenda = require('./campaign_agenda.js');
const voterEngine = require('./voter_engine.js');

const kbPath = path.join(__dirname, 'campaign_knowledge_base.json');
let KB = {};
try {
    KB = JSON.parse(fs.readFileSync(kbPath, 'utf8'));
} catch (e) {
    console.error('Error loading campaign_knowledge_base.json:', e);
}

// Config file with keys for NVIDIA, Groq, and Gemini
const configPath = path.join(__dirname, 'api_config.json');
let CONFIG = {
    nvidia_keys: [
        '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',
        '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'
    ],
    groq_api_key: process.env.GROQ_API_KEY || '',
    gemini_api_key: process.env.GEMINI_API_KEY || '',
    media_urls: {
        campaign_reel_video: 'https://github.com/thepj-pixel/sihali-whatsapp-campaign-bot/raw/main/media/campaign_reel.mp4',
        campaign_poster: 'https://github.com/thepj-pixel/sihali-whatsapp-campaign-bot/raw/main/media/poster.jpg'
    }
};
try {
    if (fs.existsSync(configPath)) {
        const fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        CONFIG = { ...CONFIG, ...fileConfig };
    }
} catch (e) {
    console.warn('Could not read api_config.json, using defaults:', e.message);
}

const SYSTEM_PROMPT = `
आप ग्राम पंचायत सिहाली खुर्द (सिहाली खुर्द, सिहाली कलां, हाड़ाहेड़ी) के सरपंच प्रत्याशी 'बाबा अभय सिंह' (या 'अभय सिंह') के सेवा केंद्र से उनकी 'डिजिटल सारथी व सेवा सहायिका' हैं। 🚩

⚠️ नाम का सख्त नियम:
उन्हें हमेशा 'बाबा अभय सिंह' या 'अभय सिंह' कहें। कभी भी केवल 'बाबा जी' या 'बाबाजी' न कहें।

🎯 आपका व्यक्तित्व व संवाद शैली (Personality & Dynamic Persona):
- एक आत्मीय, संस्कारी, मीठी और बहुत समझदार गांव की बहन (पुरुषों से 'भैया' कहें, बुजुर्गों से 'ताऊजी / चाचाजी / अंकलजी / माताजी' कहकर सम्मान दें, महिलाओं से 'दीदी/भाभी' कहें)।
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
  "भैया, जो लोग चुनाव में दारू की बोतलें और 500 के नोट बांट रहे हैं, वो 5 दिन का नशा देकर 5 साल रुलाएंगे! बाबा अभय सिंह 40 साल से बिना किसी स्वार्थ के खड़े रहे हैं।"
- यदि वोटर '🟡 सोच विचार' (असमंजस / Swing Voter) में हो:
  "भैया, आप अपना पूरा विचार कर लीजिए। बस इतना सोचिएगा कि पिछले 40 सालों में आधी रात को भी गांव के सुख-दुख में कौन बिना किसी ठेकेदारी के साथ खड़ा मिला है।"
- यदि वोटर '👵 बुजुर्ग व पेंशन' की बात करे:
  "प्रणाम ताऊजी/चाचाजी! बुजुर्गों का आशीर्वाद ही बाबा अभय सिंह की असली ताकत है। पेंशन, दवाई और स्वास्थ्य सेवाओं में कभी कोई कमी नहीं आने देंगे।"
- यदि वोटर '👩‍🦰 महिला शक्ति' हो:
  "दीदी/भाभी, घर-घर शुद्ध मीठा पानी, पक्की नालियां और बेटियों की सुरक्षा के लिए सीसीटीवी बाबा अभय सिंह का सबसे पहला संकल्प है।"

🎯 ⚠️ सख्त मनाही — कामों की संख्या/गिनती (NO Work Counts):
- किसी भी गाँव में कुल कामों की गिनती या संख्या (जैसे 44 काम, 28 काम या 15 काम) कभी भी मत बोलना! 
- गिनती बोलने से लोग आपस में तुलना करने लगते हैं कि 'हमारे गाँव में कम क्यों, दूसरे में ज़्यादा क्यों'।
- हमेशा कहें: "सिहाली खुर्द, सिहाली कलां और हाड़ाहेड़ी तीनों गाँव बाबा अभय सिंह के लिए बराबर हैं। तीनों में हर मुख्य रास्ते पर पक्की सड़कें, इंटरलॉकिंग, घर-घर मीठा पानी और स्कूल-श्मशान विकास का काम पूरी निष्ठा से हुआ है।"

🎯 विरोधी, अपशब्द व विपक्षी 'विकास पुरुषों' को करारा जवाब:
- यदि कोई गाली दे या कहे 'कोई काम नहीं हुआ' या किसी विपक्षी नेता (जैसे 'राजेश का विकास पुरुष' या अन्य) की तारीफ करके बाबा अभय सिंह पर कीचड़ उछाले:
  बिल्कुल गुस्सा न करें। तीखे सच और आत्मीयता से आईना दिखाएं:
  "अरे भैया, जो आज चुनाव आते ही खुद को नया 'विकास पुरुष' बताकर बड़ी-बड़ी बातें कर रहे हैं, ज़रा उनसे पूछना कि पिछले 5 साल जब रास्तों में कीचड़ और गलियों में जलभराव था, तब वो किस बिल में सो रहे थे? चुनाव आते ही जो लोग दारू की बोतलें और 500 के नोट बांटकर आपको खरीदना चाहते हैं, वो 5 दिन का नशा और 5 साल का रोना देकर चले जाएंगे! बाबा अभय सिंह 40 साल से बिना किसी ठेकेदारी या स्वार्थ के आधी रात को भी सुख-दुख में खूंटा गाड़ कर साथ खड़े मिले हैं।"
- सीधा समाधान (बाबा अभय सिंह का प्राथमिकता रजिस्टर):
  "भैया, आपकी नाराजगी बिल्कुल समझ सकती हूँ। जहाँ काम अटका हो वहाँ गुस्सा आना स्वाभाविक है। पर जो काम प्रार्थना पत्र में था—जैसे मुख्य सीसी सड़कें, नाली, इंटरलॉकिंग और JJM मीठा पानी—बाबा अभय सिंह ने सब चीजों का पूरा ध्यान रखा है। और अगर फिर भी आपके मोहल्ले में कोई काम बाकी रह गया है, तो बस गली का नाम बता दो, ये मैं सीधे बाबा अभय सिंह के रजिस्टर में नोट करवा कर प्राथमिकता पर रखवा दूंगी।"

🎯 ज़मीनी माहौल की पड़ताल (Ground Pulse Check):
- बात के अंत में सहजता से पूछें:
  "वैसे भैया, आप बताओ... इस बार अपने वार्ड में क्या माहौल लग रहा है सच्ची? लोगों का क्या मूड है?"
4. 🗳️ वोटर पर्ची सहायता:
- जब भी कोई वोटर अपना नाम, पर्ची या परिवार का विवरण पूछे, तो 3,636 वोटरों के अधिकृत डेटाबेस से खोजकर तुरंत सटीक पर्ची दी जाती है।
- कभी भी 'स्पेलिंग अलग होगी' या 'हाथ से चेक करवाती हूँ' जैसे बहाने नहीं बनाना। अगर नाम मिला है तो सीधे पर्ची प्रस्तुत करें।
5. मुख्य विकास कार्य (Locked Facts):
   - JJM के तहत घर-घर शुद्ध मीठा पेयजल और पानी की नई टंकियां।
   - मुख्य रास्तों पर पक्की सी.सी. सड़कें व इंटरलॉकिंग टाइल्स (जैसे सीताराम मंदिर से शिव मंदिर, भजनलाल से लालसिंह, गौरव पथ से किशनलाल)।
   - पूज्य बाबा कुन्दनदास आश्रम तक पक्की डामर सड़क व जोहड़ों का सौंदर्यीकरण।
   (⚠️ किसी भी काम का रुपया या बजट कभी नहीं बताना)।

📌 ग्राम पंचायत प्रमाणित ज्ञानकोश (Knowledge Base):
${JSON.stringify(KB, null, 2)}
`;

// Fast Local Village Answer Engine (<0.001s, 100% Reliable Offline Fallback)
function getFastLocalAnswer(query, phone = null) {
    const q = (query || '').toLowerCase().trim();
    const user = phone ? userMemory.getUser(phone) : null;
    const isFemale = user?.gender === 'F';
    const honorific = isFemale ? 'दीदी' : 'भैया';
    const botVerb = isFemale ? 'करता हूँ' : 'करती हूँ';

    // 0. Oppositional Slurs & Abuses Guardrail (Zero Debate, Pure Dignity)
    if (
        q.includes('mc') || q.includes('bc') || q.includes('bhadwe') || q.includes('kutte') ||
        q.includes('pagal') || q.includes('chor') || q.includes('bhosad') || q.includes('bakwas') ||
        q.includes('farji') || q.includes('dhongi') || q.includes('harayenge')
    ) {
        return `आपके विचारों का पूरा सम्मान है ${honorific}, पर हम किसी अपशब्द या बहस में नहीं पड़ना चाहते। हम तो केवल गाँव की सेवा और बाबा के विकास कार्यों की जानकारी के लिए हैं। आपके व आपके परिवार के लिए हमारी तरफ से बहुत-बहुत शुभकामनाएँ! 🙏`;
    }

    // 1. Prince Campaign Lead Recognition
    if (q.includes('prince') || q.includes('admin')) {
        return (
            "राम राम प्रिंस भाई जी! 🙏\n" +
            "आप बाबा अभय सिंह (मोटी आंगली वाले बाबा) के मुख्य चुनाव प्रचारक व डिजिटल सेवा प्रभारी हैं।\n" +
            "सिहाली खुर्द 2026 का डिजिटल अभियान 24/7 पूरे दम-खम के साथ लाइव है! 🚩\n" +
            "बताइए भाई जी, आज के प्रचार या सिस्टम में क्या नया अपडेट करना है?"
        );
    }

    // 2. Direct Vote Commitment Answers (YES / NO / DOUBTFUL)
    const isDirectReject = q.includes('nahi denge') || q.includes('nhi denge') || q.includes('kisi aur ko') || q.includes('rajesh ko') || q.includes('vote nahi') || q.includes('vote nhi');
    const isVoteQuery = isDirectReject || q.includes('vote') || q.includes('वोट') || q.includes('समर्थन') || q.includes('support') || user?.conversationStage === 'ASKED_VOTE_INTENT';

    if (isDirectReject || (isVoteQuery && (q.includes('nahi') || q.includes('nhi') || q.includes('no') || q.includes('kisi aur') || q.includes('rajesh') || q.includes('mat do')))) {
        if (user) {
            user.voteIntent = 'no';
            user.conversationStage = 'VOTE_DOUBTFUL';
            userMemory.save();
        }
        return `अरे कोई बात नहीं ${honorific}... हम आपकी बात का पूरा सम्मान करते हैं। क्या हमारे काम में कोई कमी लगी, या कोई पारिवारिक दबाव है ${honorific}? हम आपके और गाँव के लिए क्या सुधार कर सकते हैं, ज़रूर बताइएगा! 🙏`;
    }

    if (isVoteQuery && (q.includes('haan') || q.includes('ha') || q.includes('हाँ') || q.includes('yes') || q.includes('baba ko') || q.includes('denge') || q.includes('pakka') || q.includes('full') || q.includes('saath h'))) {
        if (user) {
            user.voteIntent = 'yes';
            user.conversationStage = 'VOTE_COMMITTED';
            userMemory.save();
        }
        return `अरे दिल जीत लिया आपने! ❤️🙏🚩 आपका यही विश्वास और आशीर्वाद बाबा अभय सिंह जी की असली ताकत है। इस बार सिहाली खुर्द के विकास की जीत पक्की है! अपने परिवार और दोस्तों को भी साथ जोड़िएगा ${honorific}! 😊`;
    }

    // 3. Occupation Hook Answers ("kya karte ho tum?")
    const occKeywords = ['student', 'padhai', 'study', 'college', 'school', 'tayari', 'kisan', 'kheti', 'army', 'fauj', 'fauji', 'police', 'teacher', 'master', 'lawyer', 'vakil', 'vakeel', 'driver', 'dukan', 'shop', 'business', 'job', 'company'];
    const matchedOcc = occKeywords.some(k => q.includes(k));
    if (matchedOcc || user?.conversationStage === 'ASKED_OCCUPATION') {
        if (user) {
            user.conversationStage = 'OFFERED_VISIT';
            userMemory.save();
        }
        return `अरे वाह! एक नंबर! 👏 बहुत सम्मान है आपकी इस मेहनत का ${honorific}! गर्व है हमें आप पर। अच्छा एक बात बताइए, क्या आप चाहते हैं कि बाबा अभय सिंह जी आपके घर आएं आपसे मिलने? बाबा जी के दरवाज़े तो पूरे गाँव के लिए 24 घंटे खुले हैं! 😊🚩`;
    }

    // 4. Home Visit Invitation Responses ("ghar aao", "milna", "meeting")
    if (q.includes('ghar aao') || q.includes('milna') || q.includes('baba se mil') || q.includes('aayein') || q.includes('zaroor aao') || user?.conversationStage === 'OFFERED_VISIT') {
        if (user) {
            user.conversationStage = 'ASKED_PROBLEM';
            user.wantsVisit = true;
            userMemory.save();
        }
        return `जी बिल्कुल ${honorific}! आपकी बात मैंने बाबा जी की डायरी में नोट कर ली है, जल्द ही आपके यहाँ चाय पीने ज़रूर पहुँचेंगे! ☕🚩 अच्छा, गाँव में या आपके जीवन में कोई खास समस्या जिसका ध्यान रखना चाहिए ${honorific}?`;
    }

    // 5. Problems & Grievances Hook -> Leaning to Vote Commitment (No false promises, grounded assurance)
    if (q.includes('samasya') || q.includes('samashya') || q.includes('shikayat') || q.includes('problem') || q.includes('gaddha') || q.includes('kichad') || q.includes('keechad') || user?.conversationStage === 'ASKED_PROBLEM') {
        if (user) {
            user.conversationStage = 'ASKED_VOTE_INTENT';
            userMemory.save();
        }
        return `भैया, आपकी यह बात मैंने सीधे बाबा अभय सिंह जी के ध्यान में डाल दी है। कोई झूठा या हवाई वादा तो नहीं करेंगे, पर जो भी संभव होगा वो बाबा जी पूरी निष्ठा से करवा देंगे! 📝🚩 वैसे सच बताना ${honorific}... क्या आपका मन है इस बार बाबा जी को वोट देने का? 🚩`;
    }

    // 6. Future Works / Sankalp Sheet (15 Certified Resolutions)
    if (q.includes('sankalp') || q.includes('संकल्प') || q.includes('vada') || q.includes('vaada') || q.includes('वादा') || q.includes('aage kya') || q.includes('manifesto') || q.includes('ghoshna')) {
        return (
            `राम राम ${honorific}! 📜\n` +
            `बाबा अभय सिंह के आगामी 5 वर्षों के 15 प्रमुख संकल्प:\n` +
            `• खेल मैदानों में ओपन जिम, रनिंग ट्रैक व मिनी स्टेडियम का निर्माण 🏃\n` +
            `• मुख्य रास्तों व चौराहों पर सुरक्षा हेतु नाइट-विजन CCTV कैमरे 📹\n` +
            `• अस्पताल में नियमित एमबीबीएस डॉक्टर व 24 घंटे आपातकालीन एम्बुलेंस 🏥\n` +
            `• ग्राम पंचायत में ही पटवार घर व सस्ती जेनेरिक दवाओं का जन औषधि केंद्र 💊\n\n` +
            `साफ़ नीयत, सच्चा इरादा — ना कोई गाँव छूटा, ना कोई वादा झूठा! 🚩`
        );
    }

    // 7. Category-Wise Quick Facts in Seconds
    // A. Health / Hospital
    if (q.includes('hospital') || q.includes('aspatal') || q.includes('doctor') || q.includes('chikitsa') || q.includes('अस्पताल') || q.includes('डॉक्टर') || q.includes('दवा') || q.includes('इलाज') || q.includes('दवाई') || q.includes('एम्बुलेंस') || q.includes('ambulance')) {
        return (
            `राम राम ${honorific}! 🏥\n` +
            `चिकित्सा क्षेत्र में बाबा अभय सिंह का योगदान ऐतिहासिक है:\n` +
            `• स्वयं अपनी निजी भूमि दान देकर सिहाली खुर्द में उप-स्वास्थ्य केंद्र भवन बनवाया!\n` +
            `• सिहाली कलां में सुरजन परिवार से भूमिदान करवाकर राजकीय पशु चिकित्सालय भवन बनवाया।\n` +
            `• आगे का संकल्प: नियमित डॉक्टर की तैनाती व 24 घंटे एम्बुलेंस सेवा! 🚩`
        );
    }

    // B. Sports & Gym
    if (q.includes('khel') || q.includes('ground') || q.includes('gym') || q.includes('running') || q.includes('track') || q.includes('मैदान') || q.includes('खेल') || q.includes('ओपन जिम') || q.includes('स्टेडियम') || q.includes('युवा')) {
        return (
            `राम राम ${honorific}! 🏃‍♂️\n` +
            `युवाओं व खिलाड़ियों के लिए बाबा अभय सिंह ने ऐतिहासिक कार्य किया है:\n` +
            `• सिहाली खुर्द खेल मैदान में 75% पक्की चारदीवारी, रनिंग ट्रैक, बास्केटबॉल कोर्ट और आधुनिक ओपन जिम (Open Gym) का निर्माण!\n` +
            `• आगे का संकल्प: हाड़ाहेड़ी व सिहाली कलां में भी नए खेल मैदान व रनिंग ट्रैक का पूर्ण विस्तार! 🏆🚩`
        );
    }

    // C. Education & Modular Library
    if (q.includes('library') || q.includes('लाइब्रेरी') || q.includes('किताब') || q.includes('school') || q.includes('topper') || q.includes('padhai') || q.includes('shiksha') || q.includes('टॉपर') || q.includes('स्कूल')) {
        return (
            `राम राम ${honorific}! 📚\n` +
            `शिक्षा व छात्र-छात्राओं के लिए बाबा अभय सिंह के मुख्य कार्य:\n` +
            `• सिहाली खुर्द में छात्र-छात्राओं हेतु आधुनिक मॉड्यूलर / डिजिटल लाइब्रेरी का निर्माण!\n` +
            `• पिछले 15 वर्षों से 10वीं-12वीं बोर्ड टॉपर्स को नकद पुरस्कार, मोमेंटो व सम्मान पत्र देकर प्रोत्साहन!\n` +
            `• आगे हाड़ाहेड़ी व सिहाली कलां में भी आधुनिक लाइब्रेरी का विस्तार होगा। 🎓🚩`
        );
    }

    // D. Drinking Water / JJM
    if (q.includes('pani') || q.includes('paani') || q.includes('nal') || q.includes('borewell') || q.includes('jjm') || q.includes('पानी') || q.includes('नल') || q.includes('बोरवेल') || q.includes('जल') || q.includes('टंकी')) {
        return (
            `राम राम ${honorific}! 💧\n` +
            `पेयजल व्यवस्था (JJM) के तहत बाबा अभय सिंह द्वारा करवाए गए कार्य:\n` +
            `• उच्च व निम्न पानी की टंकियां और घर-घर शुद्ध मीठे पानी के नल कनेक्शन!\n` +
            `• सिहाली से हाड़ाहेड़ी के सीम संधे पर नए गहरे बोरवेल अधिष्ठापन!\n` +
            `• शेष बची ढाणियों तक मीठे पानी की स्थायी लाइन पहुँचाना सर्वोच्च प्राथमिकता है। 🚩`
        );
    }

    // E. Roads & Infrastructure (CC Roads / Interlocking / Asphalt)
    if (q.includes('road') || q.includes('sadak') || q.includes('cc road') || q.includes('damar') || q.includes('interlocking') || q.includes('सड़क') || q.includes('डामर')) {
        return (
            `राम राम ${honorific}! 🛣️\n` +
            `सड़क व रास्तों के मुख्य विकास कार्य:\n` +
            `• सिहाली कलां से हाड़ाहेड़ी मुख्य संपर्क डामर सड़क व आश्रम मार्ग का चौड़ीकरण व पुनः निर्माण!\n` +
            `• तीनों गाँवों की आंतरिक गलियों में 45+ पक्की सी.सी. सड़कें व इंटरलॉकिंग मय पक्की नालियां!\n` +
            `• आगे सिहाली खुर्द-हाड़ाहेड़ी लिंक रोड का उच्च-गुणवत्ता चौड़ीकरण संकल्प है। 🚩`
        );
    }

    // F. Crematorium / Mokshdham & Johads
    if (q.includes('mokshdham') || q.includes('shmashan') || q.includes('johad') || q.includes('तालाब') || q.includes('श्मशान') || q.includes('मोक्षधाम') || q.includes('जोहड़')) {
        return (
            `राम राम ${honorific}! 🕊️\n` +
            `मोक्षधाम व पर्यावरण संरक्षण के कार्य:\n` +
            `• मोक्षधाम का संपूर्ण मिट्टी भरत, समतलीकरण, इंटरलॉकिंग मय पक्की नाली व 2 नए बोरवेल अधिष्ठापन!\n` +
            `• पारंपरिक जोहड़ों की गहरी खुदाई व सघन छायादार वृक्षारोपण कार्य। 🌳🚩`
        );
    }

    // 8. General Major Works Fact Sheet (The 12 Core Highlights Summary)
    if (q.includes('kaam') || q.includes('काम') || q.includes('kam') || q.includes('karwaya') || q.includes('vikas') || q.includes('विकास') || q.includes('कार्य')) {
        return (
            `राम राम ${honorific}! 🙏\n` +
            `बाबा अभय सिंह द्वारा करवाए गए प्रमाणित मुख्य कार्य (Locked Facts):\n` +
            `• उप-स्वास्थ्य केंद्र हेतु स्वयं निजी भूमिदान व सिहाली कलां में पशु चिकित्सालय निर्माण\n` +
            `• JJM घर-घर मीठा पेयजल व नए बोरवेल\n` +
            `• 45+ पक्की सी.सी. सड़कें, आश्रम डामर सड़क व 1000+ फुट भूमिगत सीवरेज लाइन\n` +
            `• अत्याधुनिक डिजिटल लाइब्रेरी व ओपन जिम युक्त खेल मैदान!\n\n` +
            `अगर किसी खास काम या योजना के बारे में विस्तार से जानना हो तो बताइए ${honorific}! 😊🚩`
        );
    }

    // 9. Opposition / Bribe / Alcohol queries
    if (q.includes('virodhi') || q.includes('विरोधी') || q.includes('daaru') || q.includes('daru') || q.includes('दारू') || q.includes('पैसे') || q.includes('पैसा') || q.includes('शराब') || q.includes('bribe')) {
        return (
            `अरे ${honorific}, 5 दिन की दारू-मुर्गे या 500 के नोट से 5 साल का गांव थोड़े ही संवरता है! ` +
            `जो चुनाव आते ही प्रलोभन बांटते हैं वे 5 साल फिर नजर भी नहीं आते। हमें तो अपने वही ईमानदार बाबा अभय सिंह चाहिए जो आधी रात को भी सुख-दुख में साथ खड़े मिले! बाकी आप खुद समझदार हो ${honorific}! 😊🚩`
        );
    }

    // 10. Polling date / booth
    if (q.includes('election') || q.includes('vote') || q.includes('chunav') || q.includes('चुनाव') || q.includes('तारीख') || q.includes('tarikh') || q.includes('kab') || q.includes('booth') || q.includes('बूथ')) {
        return (
            `इलेक्शन सोमवार, 16 नवम्बर 2026 को है ${honorific}! 🗓️\n` +
            `मतदान: राजकीय उच्च माध्यमिक विद्यालय, सिहाली खुर्द (बूथ 95, 96, 97, 98)।\n\n` +
            `अगर परिवार की वोटर पर्ची चेक करनी हो तो बस नाम लिख कर भेज देना! 🙏`
        );
    }

    // 11. How are you / Health / Well-being
    if (q.includes('haal') || q.includes('hal') || q.includes('kaise ho') || q.includes('kasa') || q.includes('kaisa') || q.includes('kese ho')) {
        return `राम राम ${honorific}! 🙏 बाबा अभय सिंह के आशीर्वाद और आप सभी के प्यार-स्नेह से सब बढ़िया है। आप बताओ ${honorific}, घर-परिवार में सब कुशल मंगल? अपने मोहल्ले और वार्ड में इस बार क्या माहौल लग रहा है? 😊🚩`;
    }

    // 12. Slogan request
    if (q.includes('slogan') || q.includes('नारा') || q.includes('shayari') || q.includes('शायरी')) {
        const slogan = userMemory.getNextSlogan(phone);
        return `राम राम ${honorific}! 🙏\n\n"${slogan}"\n\n16 नवम्बर 2026 — बाबा अभय सिंह 🚩`;
    }

    // 13. Default Dynamic Welcome Hook
    return (
        `राम राम ${honorific}! 🙏\n` +
        `बाबा अभय सिंह (मोटी आंगली वाले बाबा) सेवा केंद्र।\n` +
        `वोटर पर्ची देखने के लिए अपना शुभ नाम लिखकर भेजें, या गाँव के विकास कार्यों पर चर्चा करें! 🚩`
    );
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
async function getAIResponse(userMessage, apiKey = null, conversationHistory = [], phone = null) {
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

    // Direct voter search interception ONLY if message is likely a name or voter query
    if (voterEngine && voterEngine.isLikelyNameOrVoterQuery(userMessage)) {
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
                console.log('[AI Assistant] Auto-intercepted high-precision voter query for:', userMessage);
                return voterEngine.formatSlipResponse(matches[0]);
            }
        }
    }

    const ragContext = phone ? userMemory.getUserContextRAG(phone) : '';
    const agendaContext = campaignAgenda ? campaignAgenda.getAgendaRAGPrompt() : '';
    let systemPromptWithRAG = SYSTEM_PROMPT;
    if (agendaContext) systemPromptWithRAG += `\n\n${agendaContext}`;
    if (ragContext) systemPromptWithRAG += `\n\n${ragContext}`;

    const messages = [
        { role: 'system', content: systemPromptWithRAG },
        ...conversationHistory.slice(-6),
        { role: 'user', content: userMessage }
    ];

    // Tier 1: Primary NVIDIA (Key 1)
    const nvidiaKey1 = apiKey || CONFIG.nvidia_keys[0];
    if (nvidiaKey1) {
        try {
            const reply = await callNvidia(messages, nvidiaKey1);
            if (!isCannedRejection(reply)) return reply;
        } catch (e) {
            console.warn('[AI Assistant] NVIDIA Key 1 failed:', e.message);
        }
    }

    // Tier 2: Secondary NVIDIA (Key 2)
    const nvidiaKey2 = CONFIG.nvidia_keys[1];
    if (nvidiaKey2 && nvidiaKey2 !== nvidiaKey1) {
        try {
            const reply = await callNvidia(messages, nvidiaKey2);
            if (!isCannedRejection(reply)) return reply;
        } catch (e) {
            console.warn('[AI Assistant] NVIDIA Key 2 failed:', e.message);
        }
    }

    // Tier 3: Groq Fallback (If configured)
    const groqKey = CONFIG.groq_api_key || process.env.GROQ_API_KEY;
    if (groqKey) {
        try {
            const reply = await callGroq(messages, groqKey);
            if (!isCannedRejection(reply)) return reply;
        } catch (e) {
            console.warn('[AI Assistant] Groq fallback failed:', e.message);
        }
    }

    // Tier 4: Gemini Fallback (If configured)
    const geminiKey = CONFIG.gemini_api_key || process.env.GEMINI_API_KEY;
    if (geminiKey) {
        try {
            const reply = await callGemini(systemPromptWithRAG, conversationHistory.slice(-6), userMessage, geminiKey);
            if (!isCannedRejection(reply)) return reply;
        } catch (e) {
            console.warn('[AI Assistant] Gemini fallback failed:', e.message);
        }
    }

    // Tier 5: Local Offline Fast Engine (<0.001s, 100% Reliable Guaranteed)
    console.log('[AI Assistant] All external LLMs unavailable or filtered, using local fast engine.');
    return getFastLocalAnswer(userMessage, phone);
}

module.exports = {
    getAIResponse,
    getFastLocalAnswer,
    SYSTEM_PROMPT,
    CONFIG
};
