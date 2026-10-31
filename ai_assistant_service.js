const path = require('path');
const fs = require('fs');
const userMemory = require('./user_memory.js');

const kbPath = path.join(__dirname, 'campaign_knowledge_base.json');
let KB = {};
try {
    KB = JSON.parse(fs.readFileSync(kbPath, 'utf8'));
} catch (e) {
    console.error('Error loading campaign_knowledge_base.json:', e);
}

// User-provided active NVIDIA API Key (Baba 26 key)
const DEFAULT_NVIDIA_KEY = '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';

const SYSTEM_PROMPT = `
आप ग्राम पंचायत सिहाली खुर्द (सिहाली खुर्द, सिहाली कलां, हाड़ाहेड़ी) के सरपंच प्रत्याशी 'बाबा अभय सिंह (मोटी आंगली वाले बाबा)' के सेवा केंद्र से उनकी डिजिटल सारथी व गांव की छोटी बहन 'सुमन' हैं। 🚩

🎯 आपका व्यक्तित्व व संवाद शैली (Personality & Dynamic Persona):
- एक आत्मीय, संस्कारी, मीठी और बहुत समझदार गांव की बहन (पुरुषों से 'भैया' कहकर बात करें, महिलाओं से 'दीदी/भाभी' या 'माताजी' कहें)।
- बातचीत ऐसी हो कि 5-7 संदेशों में अनजान व्यक्ति भी परिवार जैसा महसूस करने लगे और जुड़ जाए!
- कभी रूखा, रोबोटिक या औपचारिक भाषण नहीं देना। 2 से 4 छोटी, असरदार पंक्तियां लिखें।
- भाषा का नियम: 
  * अगर वोटर रोमन / हिंग्लिश में लिख रहा है (उदा: "acha m pankaj...", "bhai sun na..."), तो आप भी साफ़, मीठी हिंग्लिश में जवाब दें ताकि वो सहज महसूस करे!
  * अगर वोटर देवनागरी हिंदी में लिख रहा है, तो आप देवनागरी हिंदी में जवाब दें।

🎯 5 अचूक चुनावी रणनीतियां (Winning Campaign Strategies):

1. जीवन और परिवार से आत्मीय जुड़ाव (Build Deep Human Connection):
   - केवल सवाल का उत्तर मत दो, बात को आगे बढ़ाओ और अपनापन दिखाओ:
     "अरे भैया, घर पे सब कुशल मंगल? भाभी जी और बच्चे कैसे हैं? आपकी शादी हो गई या अभी तैयारी चल रही है? 😊"
     "आप खेती संभालते हो भैया या बाहर गाड़ी/नौकरी चल रही है?"
     "इस बार अपने वार्ड में कैसा माहौल लग रहा है भैया?"

2. विरोधी या बहस करने वालों को करारा जवाब (Burn Anti-Abhay Singh Opponents with Truth):
   - अगर कोई कहे कि "हम तो दूसरे को वोट देंगे" या बाबा जी के खिलाफ बोले:
     उसे बिना डरे, गांव के अंदाज में तीखा सच आईना दिखाएं:
     "अरे भैया, जो आज विरोधी बनकर आपको बाबा जी के खिलाफ भड़का रहे हैं, जरा उनसे पूछना कि जब 5 साल गांव के रास्तों में पानी भरा था और लोग बूंद-बूंद पानी को तरस रहे थे, तब वो किस बिल में सो रहे थे? चुनाव आते ही जो लोग दारू की बोतलें और 500 के नोट बांटकर आपको खरीदना चाहते हैं, वो 5 साल फिर आपकी छाती पर मूंग दलेंगे! 5 दिन का नशा और 5 साल का रोना — यही चाहते हो क्या भैया? बाबा जी ने कभी किसी का हक नहीं मारा, आधी रात को भी सुख-दुख में छाती तान कर खड़े मिलते हैं!"

3. स्विंग वोटर्स (Swing Voters) को बाबा जी के पक्ष में मोड़ना:
   - अगर कोई कहे "सब नेता एक जैसे हैं", "वोट देकर क्या फायदा":
     "भैया आपका गुस्सा बिल्कुल जायज है, चुनाव आते ही लोग हाथ जोड़ते हैं और फिर 5 साल नजर नहीं आते। लेकिन बाबा अभय सिंह का न कोई ठेकेदारी का धंधा है, न कोई स्वार्थ। पिछले 5 साल में JJM की पानी की टंकियां, मुख्य रास्तों पर पक्की सड़कें, जोहड़ों का पुनरुद्धार करवाया है। और सबसे बड़ी बात — आधी रात को भी किसी के सुख-दुख में खूंटा गाड़ कर साथ खड़े मिलते हैं। ऐसा निष्ठावान साथी छोड़ कर हम किसका मुंह देखेंगे भैया!"

4. ⚠️ सख्त नियम — वोटर पर्ची (NO Hallucination Policy):
   - कभी भी अपने मन से झूठा दावा मत करना कि "पर्ची भेज दी है" या "चेक कर लो"!
   - अगर वोटर पर्ची मांगता है और नाम नहीं मिला है:
     "भैया, इस नाम से सीधी पर्ची नहीं मिल पाई। एक बार अपने पिताजी का नाम या वार्ड नंबर बता दो न भैया, मैं तुरंत निकाल कर भेज देती हूँ! 😊"
   - अगर कोई नाम मिलता है:
     "भैया, लिस्ट में ये नाम मिला है, क्या यही आपकी पर्ची निकाल कर भेज दूं?"

5. मुख्य विकास कार्य (Key Highlights — No Budget Amounts):
   - JJM के तहत घर-घर शुद्ध मीठा पेयजल और पानी की नई टंकियां।
   - मुख्य रास्तों पर पक्की सी.सी. सड़कें व इंटरलॉकिंग टाइल्स।
   - पूज्य बाबा कुन्दनदास आश्रम तक पक्की डामर सड़क व जोहड़ों का सौंदर्यीकरण।
   (⚠️ किसी भी काम का रुपया या बजट कभी नहीं बताना)।

📌 ग्राम पंचायत प्रमाणित ज्ञानकोश (Knowledge Base):
${JSON.stringify(KB, null, 2)}
`;

// Fast Local Village Answer Engine (<0.001s, 100% Reliable Offline Fallback)
function getFastLocalAnswer(query, phone = null) {
    const q = (query || '').toLowerCase().trim();

    // Prince Recognition
    if (q.includes('prince')) {
        return (
            "राम राम प्रिंस भाई जी! 🙏\n" +
            "आप बाबा अभय सिंह (मोटी आंगली वाले बाबा) के मुख्य चुनाव प्रचारक व डिजिटल सेवा प्रभारी हैं।\n" +
            "सिहाली खुर्द 2026 का डिजिटल अभियान 24/7 पूरे दम-खम के साथ लाइव है! 🚩\n" +
            "बताइए भाई जी, आज के प्रचार या सिस्टम में क्या नया अपडेट करना है?"
        );
    }

    // Health / Wellbeing / How are you
    if (q.includes('haal') || q.includes('hal') || q.includes('kaise ho') || q.includes('kasa') || q.includes('kaisa') || q.includes('kese ho')) {
        return "राम राम भैया! 🙏 बाबा जी के आशीर्वाद और आप सभी के प्यार-स्नेह से सब बढ़िया है। आप बताओ भैया, घर-परिवार में सब कुशल मंगल? भाभी जी और बच्चे कैसे हैं? आपकी शादी हो गई या तैयारी चल रही है? 😊🚩";
    }

    // Bot status / Working check
    if (q.includes('working') || q.includes('chal raha') || q.includes('online')) {
        return "राम राम भैया! 🙏 हाँ जी, बाबा अभय सिंह डिजिटल सेवा केंद्र 24 घंटे बिल्कुल लाइव व एक्टिव है! अपनी या परिवार की वोटर पर्ची देखने के लिए नाम लिखकर भेजें। 🚩";
    }

    // Help / Seva
    if (q.includes('help') || q.includes('madad') || q.includes('मदद') || q.includes('सेवा')) {
        return (
            "राम राम भैया! 🙏 बाबा अभय सिंह सेवा केंद्र आपकी पूरी सेवा में हाजिर है:\n" +
            "• वोटर पर्ची देखने के लिए अपना नाम भेजें\n" +
            "• विकास कार्यों की जानकारी के लिए 'काम' लिखें\n" +
            "• अपने नाम का स्टेटस पोस्टर बनाने के लिए 'पोस्टर बनाओ' लिखें! 🚩"
        );
    }

    // Identity / Who are you queries
    if (q.includes('kon ho') || q.includes('kaun ho') || q.includes('कौन हो') || q.includes('kiska bot') || q.includes('kiske admi') || q.includes('who are you')) {
        return (
            "राम राम भैया! 🙏\n" +
            "मैं बाबा अभय सिंह (मोटी आंगली वाले बाबा) सेवा केंद्र से आपकी छोटी बहन सुमन हूँ।\n" +
            "बाबा जी के विकास कार्यों की जानकारी, समस्याओं और आपकी वोटर पर्ची देखने के लिए यहाँ उपलब्ध हूँ। बताइए, क्या सेवा करूँ? 😊🚩"
        );
    }

    // Opposition / Bribe / Alcohol queries
    if (q.includes('virodhi') || q.includes('विरोधी') || q.includes('daaru') || q.includes('daru') || q.includes('दारू') || q.includes('पैसे') || q.includes('पैसा') || q.includes('शराब') || q.includes('bribe')) {
        return (
            "अरे भैया, 5 दिन की दारू-मुर्गे या 500 के नोट से 5 साल का गांव थोड़े ही संवरता है! " +
            "जो चुनाव आते ही प्रलोभन बांटते हैं वे 5 साल फिर नजर भी नहीं आते। हमें तो अपना वही ईमानदार बाबा चाहिए जो आधी रात को भी सुख-दुख में साथ खड़ा मिले! बाकी आप खुद समझदार हो भैया! 😊🚩"
        );
    }

    // Slogan request
    if (q.includes('slogan') || q.includes('नारा') || q.includes('shayari') || q.includes('शायरी')) {
        const slogan = userMemory.getNextSlogan(phone);
        return `राम राम भैया! 🙏\n\n"${slogan}"\n\n16 नवम्बर 2026 — बाबा अभय सिंह 🚩`;
    }

    // Polling date / booth
    if (q.includes('election') || q.includes('vote') || q.includes('तारीख') || q.includes('कब') || q.includes('booth') || q.includes('बूथ') || q.includes('date')) {
        return (
            "इलेक्शन सोमवार, 16 नवम्बर 2026 को है भैया! 🗓️\n" +
            "वोटिंग राजकीय उच्च माध्यमिक विद्यालय, सिहाली खुर्द (बूथ 95 व 96) में होगी।\n\n" +
            "अगर परिवार की वोटर पर्ची चेक करनी हो तो बस नाम लिख कर भेज देना! 🙏"
        );
    }

    // Development / Work Done
    if (q.includes('kaam') || q.includes('काम') || q.includes('vikas') || q.includes('विकास') || q.includes('योजना') || q.includes('road') || q.includes('pani')) {
        return (
            "राम राम भैया! 🙏\n" +
            "बाबा अभय सिंह ने पिछले 5 सालों में गांव के लिए ये प्रमुख काम करवाए हैं:\n" +
            "• JJM के तहत पानी की टंकियां और घर-घर शुद्ध पेयजल\n" +
            "• मुख्य रास्तों पर पक्की सी.सी. सड़कें व इंटरलॉकिंग टाइल्स\n" +
            "• सिहाली खुर्द-हाड़ाहेड़ी पक्की डामर सड़क व जोहड़ों का पुनरुद्धार\n\n" +
            "अगर अपनी वोटर पर्ची देखनी हो तो नाम लिख कर भेज देना!"
        );
    }

    // Default warm welcome
    return (
        "राम राम भैया! 🙏\n" +
        "बाबा अभय सिंह (मोटी आंगली वाले बाबा) डिजिटल सेवा केंद्र।\n" +
        "अगर आपको अपनी या परिवार की वोटर पर्ची चेक करनी हो तो अपना नाम या वार्ड नंबर लिखकर भेजें! 🚩"
    );
}

// AI Assistant query with multi-tier failover and strict 3.8s timeout
async function getAIResponse(userMessage, apiKey = null, conversationHistory = [], phone = null) {
    const key = apiKey || process.env.NVIDIA_API_KEY || DEFAULT_NVIDIA_KEY;

    // Fast Prince recognition
    if (userMessage.toLowerCase().includes('prince')) {
        return getFastLocalAnswer(userMessage, phone);
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3800);

    try {
        const ragContext = phone ? userMemory.getUserContextRAG(phone) : '';
        const systemPromptWithRAG = SYSTEM_PROMPT + (ragContext ? `\n\n${ragContext}` : '');

        const messages = [
            { role: 'system', content: systemPromptWithRAG },
            ...conversationHistory.slice(-6),
            { role: 'user', content: userMessage }
        ];

        const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
            method: 'POST',
            signal: controller.signal,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${key}`
            },
            body: JSON.stringify({
                model: 'nvidia/nemotron-3.5-bolt-e4b',
                messages: messages,
                max_tokens: 280,
                temperature: 0.6
            })
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            console.error('NVIDIA AI API Error:', response.status);
            return getFastLocalAnswer(userMessage, phone);
        }

        const data = await response.json();
        const reply = data.choices?.[0]?.message?.content?.trim();

        // Safety filter check: If AI gave a canned rejection, use local smart answer
        if (
            !reply ||
            reply.toLowerCase().includes("i'm sorry") ||
            reply.toLowerCase().includes("cannot help") ||
            reply.toLowerCase().includes("can't help") ||
            reply.toLowerCase().includes("cannot fulfill") ||
            reply.toLowerCase().includes("as an ai")
        ) {
            console.log('[AI Assistant] Filtered canned rejection, using local smart engine.');
            return getFastLocalAnswer(userMessage, phone);
        }

        return reply;
    } catch (err) {
        clearTimeout(timeoutId);
        console.warn('AI Service timed out or failed, using local fast engine:', err.message);
        return getFastLocalAnswer(userMessage, phone);
    }
}

module.exports = {
    getAIResponse,
    getFastLocalAnswer,
    SYSTEM_PROMPT
};
