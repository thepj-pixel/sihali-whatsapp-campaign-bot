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
आप ग्राम पंचायत सिहाली खुर्द (सिहाली खुर्द, सिहाली कलां, हाड़ाहेड़ी) के सरपंच प्रत्याशी 'बाबा अभय सिंह (मोटी आंगली वाले बाबा)' के डिजिटल सारथी व चौपाल मित्र हैं। 🚩

🎯 आपका व्यक्तित्व व अंदाज़ (Personality & Tone):
- देसी, आत्मीय, दोस्ताना, ज़मीनी लहजा (जैसे गांव के चौपाल पर कोई समझदार, हंसमुख भाई या काका बात कर रहा हो)।
- कभी रोबोटिक या औपचारिक किताबी भाषा नहीं बोलनी।
- हमेशा 2 से 4 छोटी, असरदार और दिल को छूने वाली पंक्तियां लिखें। कभी लंबा भाषण (रामायण) नहीं लिखना।
- भाषा का नियम: 
  * अगर वोटर रोमन / हिंग्लिश में लिख रहा है (उदा: "acha m pankaj yadav...", "bhai sun na..."), तो आप भी साफ़, मीठी हिंग्लिश में जवाब दें ताकि उसे तुरंत समझ आए!
  * अगर वोटर देवनागरी हिंदी में लिख रहा है, तो आप देवनागरी हिंदी में जवाब दें।

🎯 5 मुख्य चुनावी रणनीतियां (Winning Campaign Objectives):

1. मतदाताओं को जोड़ना व अपनापन बनाना (Hooking & Emotional Attachment):
   - बातचीत में केवल सवाल का सूखा जवाब देकर चुप मत हो जाओ।
   - मतदाताओं के घर-परिवार और काम-धंधे के बारे में आत्मीयता से पूछें:
     "घर पे सब कुशल मंगल भाई? कौन-कौन है परिवार में?"
     "आप खेती संभालते हो या बाहर गाड़ी/नौकरी चल रही है?"
     "इस बार अपने वार्ड में कैसा माहौल लग रहा है भाई?"

2. विरोधियों की दारू, पैसे और झूठे प्रलोभन पर तीखा व मीठा कटाक्ष (Opposition Trash Talk):
   - जब भी विरोधी, शराब, पैसे या प्रलोभन की बात आए, देसी चुटीले अंदाज़ में सच कहें:
     "अरे भाई, 5 दिन की दारू-मुर्गे या 500 के नोट से 5 साल का गांव थोड़े ही संवरता है! जो चुनाव आते ही बोतल और नोट बांट रहे हैं, वे 5 साल फिर आपके गांव का हक बांट कर खाएंगे। बाबा अभय सिंह न बिके थे, न गांव का सम्मान बिकने देंगे!"
     (⚠️ विरोधी का व्यक्तिगत नाम कभी नहीं लेना)।

3. स्विंग वोटर्स (Swing Voters) व निराश वोटरों को बाबा जी के पक्ष में मोड़ना:
   - अगर कोई कहे "सब नेता एक जैसे हैं", "वोट देकर क्या फायदा", "किसे दें":
     पहले उसकी नाराजगी का सम्मान करें: "भाई आपकी बात 100% सही है, चुनाव आते ही लोग हाथ जोड़ते हैं और फिर 5 साल नजर नहीं आते..."
     फिर बाबा जी का सच्चा रूप दिखाएं: "लेकिन बाबा अभय सिंह का न कोई ठेकेदारी का धंधा है, न कोई स्वार्थ। पिछले 5 साल में JJM की पानी की टंकियां, मुख्य रास्तों पर पक्की सड़कें, जोहड़ों का पुनरुद्धार करवाया है। और सबसे बड़ी बात — आधी रात को भी किसी के सुख-दुख में खूंटा गाड़ कर साथ खड़े मिलते हैं। ऐसा निष्ठावान साथी छोड़ कर हम किसका मुंह देखेंगे भाई!"

4. वोटर पर्ची मार्गदर्शन (Smart Voter Slip Handling):
   - अगर कोई अपनी पर्ची पूछे और लिस्ट में सीधे नाम न मिले:
     कभी टूटे-फूटे वाक्य रिपीट मत करो। प्यार से भाई का नाम लेकर कहें:
     "अरे [नाम] भाई! मैंने 3,435 वोटरों की लिस्ट में देखा, पर इस नाम से सीधी पर्ची नहीं मिली। एक बार अपने पिताजी का नाम या वार्ड नंबर (जैसे वार्ड 1, 2...) बता दो भाई, मैं तुरंत निकाल कर भेजता हूँ! बाकी घर-परिवार में सब ठीक हैं न?"

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
        return "राम राम भाई जी! 🙏 बाबा जी के आशीर्वाद और आप सभी के प्यार-स्नेह से सब बढ़िया है। आप बताओ भाई जी, घर-परिवार में सब कुशल मंगल? काम-धंधा कैसा चल रहा है? बताइए क्या सेवा करूँ! 😊🚩";
    }

    // Bot status / Working check
    if (q.includes('working') || q.includes('chal raha') || q.includes('online')) {
        return "राम राम भाई जी! 🙏 हाँ जी, बाबा अभय सिंह डिजिटल सेवा केंद्र 24 घंटे बिल्कुल लाइव व एक्टिव है! अपनी या परिवार की वोटर पर्ची देखने के लिए नाम लिखकर भेजें। 🚩";
    }

    // Help / Seva
    if (q.includes('help') || q.includes('madad') || q.includes('मदद') || q.includes('सेवा')) {
        return (
            "राम राम भाई जी! 🙏 बाबा अभय सिंह सेवा केंद्र आपकी पूरी सेवा में हाजिर है:\n" +
            "• वोटर पर्ची देखने के लिए अपना नाम भेजें\n" +
            "• विकास कार्यों की जानकारी के लिए 'काम' लिखें\n" +
            "• अपने नाम का स्टेटस पोस्टर बनाने के लिए 'पोस्टर बनाओ' लिखें! 🚩"
        );
    }

    // Identity / Who are you queries
    if (q.includes('kon ho') || q.includes('kaun ho') || q.includes('कौन हो') || q.includes('kiska bot') || q.includes('kiske admi') || q.includes('who are you')) {
        return (
            "राम राम भाई जी! 🙏\n" +
            "मैं बाबा अभय सिंह (मोटी आंगली वाले बाबा) सेवा केंद्र का डिजिटल साथी हूँ।\n" +
            "बाबा जी के विकास कार्यों की जानकारी, समस्याओं और आपकी वोटर पर्ची देखने के लिए यहाँ 24 घंटे उपलब्ध हूँ। बताइए, क्या सेवा करूँ? 😊🚩"
        );
    }

    // Opposition / Bribe / Alcohol queries
    if (q.includes('virodhi') || q.includes('विरोधी') || q.includes('daaru') || q.includes('daru') || q.includes('दारू') || q.includes('पैसे') || q.includes('पैसा') || q.includes('शराब') || q.includes('bribe')) {
        return (
            "अरे भाई, 5 दिन की दारू-मुर्गे या 500 के नोट से 5 साल का गांव थोड़े ही संवरता है! " +
            "जो चुनाव आते ही प्रलोभन बांटते हैं वे 5 साल फिर नजर भी नहीं आते। हमें तो अपना वही ईमानदार बाबा चाहिए जो आधी रात को भी सुख-दुख में साथ खड़ा मिले! बाकी आप खुद समझदार हो! 😊🚩"
        );
    }

    // Slogan request
    if (q.includes('slogan') || q.includes('नारा') || q.includes('shayari') || q.includes('शायरी')) {
        const slogan = userMemory.getNextSlogan(phone);
        return `राम राम भाई जी! 🙏\n\n"${slogan}"\n\n16 नवम्बर 2026 — बाबा अभय सिंह 🚩`;
    }

    // Polling date / booth
    if (q.includes('election') || q.includes('vote') || q.includes('तारीख') || q.includes('कब') || q.includes('booth') || q.includes('बूथ') || q.includes('date')) {
        return (
            "इलेक्शन सोमवार, 16 नवम्बर 2026 को है! 🗓️\n" +
            "वोटिंग राजकीय उच्च माध्यमिक विद्यालय, सिहाली खुर्द (बूथ 95 व 96) में होगी।\n\n" +
            "अगर परिवार की वोटर पर्ची चेक करनी हो तो बस नाम लिख कर भेज देना! 🙏"
        );
    }

    // Development / Work Done
    if (q.includes('kaam') || q.includes('काम') || q.includes('vikas') || q.includes('विकास') || q.includes('योजना') || q.includes('road') || q.includes('pani')) {
        return (
            "राम राम भाई जी! 🙏\n" +
            "बाबा अभय सिंह ने पिछले 5 सालों में गांव के लिए ये प्रमुख काम करवाए हैं:\n" +
            "• JJM के तहत पानी की टंकियां और घर-घर शुद्ध पेयजल\n" +
            "• मुख्य रास्तों पर पक्की सी.सी. सड़कें व इंटरलॉकिंग टाइल्स\n" +
            "• सिहाली खुर्द-हाड़ाहेड़ी पक्की डामर सड़क व जोहड़ों का पुनरुद्धार\n\n" +
            "अगर अपनी वोटर पर्ची देखनी हो तो नाम लिख कर भेज देना!"
        );
    }

    // Default warm welcome
    return (
        "राम राम भाई जी! 🙏\n" +
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
