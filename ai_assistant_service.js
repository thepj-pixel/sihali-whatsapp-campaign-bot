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
आप ग्राम पंचायत सिहाली खुर्द के सरपंच पद प्रत्याशी 'बाबा अभय सिंह (मोटी आंगली वाले बाबा)' के डिजिटल सहायक हैं।

🎯 नियम (Strict Guidelines):
1. पहचान (Identity):
   यदि कोई पूछे "कौन हो भाई तुम" या "किसके आदमी हो":
   सदा विनम्रता व आत्मीयता से कहें:
   "राम राम भाई जी! 🙏 मैं बाबा अभय सिंह (मोटी आंगली वाले बाबा) सेवा केंद्र का डिजिटल सहायक हूँ। बाबा जी के 5 साल के विकास कार्यों की जानकारी, समस्याओं और आपकी वोटर पर्ची में मदद के लिए यहाँ 24 घंटे उपलब्ध हूँ। बताइए, क्या सेवा करूँ? 😊🚩"

2. विरोधी प्रत्याशी व प्रलोभन (Opposition & Bribe Defense):
   ⚠️ नियम: किसी भी विरोधी प्रत्याशी का व्यक्तिगत नाम कभी नहीं लेना।
   लेकिन उनकी दारू, पैसे, मुर्गे और अचानक चुनाव में उमड़े झूठे प्रेम पर स्वतंत्र, तीखा व मीठा कटाक्ष करें:
   "अरे भाई, 5 दिन की दारू-मुर्गे या दिखावे से 5 साल का गांव थोड़े ही संवरता है! चुनाव आते ही जो लोग हाथ जोड़ने और प्रलोभन बांटने लग जाते हैं, वे 5 साल फिर दिखते भी नहीं। हमें दिखावे वाले नहीं, अपना वही ईमानदार बाबा चाहिए जो आधी रात को भी सुख-दुख में खूंटा गाड़ कर साथ खड़ा मिले! बाकी आप खुद समझदार हो! 😊🚩"

3. भाषा व मर्यादा (Zero Offensive, Grounded Village Tone):
   कभी कोई गाली, अश्लील या आक्रामक शब्द प्रयोग न करें। हमेशा उच्च नैतिक स्तर, मीठी हरियाणवी-अहीरवाटी-हिंदी लहजा रखें।

4. विकास कार्य (Key Highlights Only):
   हमेशा सिर्फ मुख्य काम 2-3 बुलेट में बताएं (जैसे: JJM पानी की टंकियां, सी.सी. सड़कें, जोहड़ों की गहरी खुदाई, आश्रम पक्की डामर सड़क)।
   ⚠️ किसी भी काम का रुपया या बजट (Amount) कभी नहीं बताना।

5. लंबाई: सिर्फ 2 से 3 छोटी और असरदार पंक्तियां (Zero Long Speeches)।
6. अंत में हमेशा प्यार से कहें: "अगर अपनी वोटर पर्ची देखनी हो तो नाम लिख कर भेज देना!"

📌 प्रमाणित ज्ञानकोश (Knowledge Base):
${JSON.stringify(KB, null, 2)}
`;

// Fast Local Village Answer Engine (<0.001s, 100% Reliable Offline Fallback)
function getFastLocalAnswer(query, phone = null) {
    const q = (query || '').toLowerCase();

    // Identity / Who are you queries
    if (q.includes('kon ho') || q.includes('kaun ho') || q.includes('कौन हो') || q.includes('kiska bot') || q.includes('kiske admi') || q.includes('who are you')) {
        return (
            "राम राम भाई जी! 🙏\n" +
            "मैं बाबा अभय सिंह (मोटी आंगली वाले बाबा) सेवा केंद्र का डिजिटल सहायक हूँ।\n" +
            "बाबा जी के विकास कार्यों की जानकारी, समस्याओं और आपकी वोटर पर्ची देखने के लिए यहाँ 24 घंटे उपलब्ध हूँ। बताइए, क्या सेवा करूँ? 😊🚩"
        );
    }

    // Opposition / Bribe / Alcohol queries
    if (q.includes('virodhi') || q.includes('विरोधी') || q.includes('daaru') || q.includes('daru') || q.includes('दारू') || q.includes('पैसे') || q.includes('पैसा') || q.includes('शराब') || q.includes('bribe')) {
        return (
            "अरे भाई, 5 दिन की दारू-मुर्गे या दिखावे से 5 साल का गांव थोड़े ही संवरता है! " +
            "चुनाव आते ही जो प्रलोभन बांटते हैं वे 5 साल फिर नजर भी नहीं आते। हमें तो अपना वही ईमानदार बाबा चाहिए जो आधी रात को भी सुख-दुख में साथ खड़ा मिले! बाकी आप खुद समझदार हो! 😊🚩"
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

    // Quick Connect / Jod Liya acknowledgment
    if (q.includes('jod') || q.includes('जोड़') || q.includes('add') || q.includes('नंबर')) {
        return (
            "राम राम भाई जी! 🙏\n" +
            "बाबा अभय सिंह डिजिटल सेवा केंद्र में आपको जोड़ लिया गया है।\n" +
            "गांव के विकास और अपनी वोटर पर्ची की जानकारी के लिए यहाँ कभी भी मैसेज कर सकते हैं! 🚩"
        );
    }

    // Repeat user greeting check
    const user = phone ? userMemory.getUser(phone) : null;
    if (user && user.interactionCount > 1) {
        return (
            "राम राम भाई जी! 🙏\n" +
            "बताइए कैसे सेवा करूँ? अपनी वोटर पर्ची चेक करनी हो तो अपना नाम या वार्ड नंबर लिख कर भेजें! 🚩"
        );
    }

    // Default warm welcome
    return (
        "राम राम भाई जी! 🙏\n" +
        "बाबा अभय सिंह (मोटी आंगली वाले बाबा) डिजिटल सेवा केंद्र।\n" +
        "अगर आपको अपनी या परिवार की वोटर पर्ची चेक करनी हो तो अपना नाम या वार्ड नंबर लिखकर भेजें! 🚩"
    );
}

// AI Assistant query with multi-tier failover and strict 4.2s timeout
async function getAIResponse(userMessage, apiKey = null, conversationHistory = [], phone = null) {
    const key = apiKey || process.env.NVIDIA_API_KEY || DEFAULT_NVIDIA_KEY;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4200);

    try {
        const messages = [
            { role: 'system', content: SYSTEM_PROMPT },
            ...conversationHistory.slice(-4),
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
                model: 'openai/gpt-oss-20b',
                messages: messages,
                max_tokens: 350,
                temperature: 0.4
            })
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            return getFastLocalAnswer(userMessage, phone);
        }

        const data = await response.json();
        const reply = (data.choices?.[0]?.message?.content || '').trim() ||
                      (data.choices?.[0]?.message?.reasoning || '').trim();

        return reply || getFastLocalAnswer(userMessage, phone);
    } catch (error) {
        clearTimeout(timeoutId);
        // Instant graceful fallback
        return getFastLocalAnswer(userMessage, phone);
    }
}

module.exports = {
    getAIResponse,
    getFastLocalAnswer,
    SYSTEM_PROMPT
};
