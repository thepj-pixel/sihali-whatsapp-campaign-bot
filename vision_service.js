const fs = require('fs');
const path = require('path');

const { loadApiConfig } = require('./api_keys.js');
let CONFIG = loadApiConfig();

class VisionService {
    constructor() {
        this.geminiKey = CONFIG.gemini_api_key || CONFIG.geminiApiKey || '';
    }

    reloadConfig() {
        try {
            CONFIG = loadApiConfig();
            this.geminiKey = CONFIG.gemini_api_key || CONFIG.geminiApiKey || '';
        } catch (e) {}
    }

    async analyzeImage(bufferOrBase64, mimeType = 'image/jpeg') {
        this.reloadConfig();
        const base64Data = Buffer.isBuffer(bufferOrBase64)
            ? bufferOrBase64.toString('base64')
            : (bufferOrBase64.includes('base64,') ? bufferOrBase64.split('base64,')[1] : bufferOrBase64);

        const promptText = `आप ग्राम पंचायत सिहाली खुर्द (अलवर, राजस्थान) में सरपंच प्रत्याशी 'बाबा अभय सिंह' के चुनाव सेवा केंद्र के AI विज़न विश्लेषक हैं।
इस छवि का विश्लेषण करें और पहचानें कि यह किस श्रेणी की है:
1. 'voter_id': वोटर आईडी कार्ड, आधार कार्ड या पुरानी वोटर पर्ची। (EPIC नंबर, नाम, पिता का नाम, वार्ड निकालें)
2. 'civic_issue': गाँव की समस्या (टूटी सड़क, कीचड़, गंदी नाली, पानी की किल्लत, टूटा हैंडपंप, बिजली खंभा/तार)।
3. 'campaign_material': बाबा अभय सिंह का पोस्टर, बैनर, प्रचार पर्चा, झंडा या जनसंपर्क।
4. 'personal_photo': व्यक्ति की फोटो, सेल्फी, परिवार, खेती या पशुपालक।
5. 'other': कोई अन्य तस्वीर।

केवल और केवल वैध JSON आउटपुट दें:
{
  "category": "voter_id" | "civic_issue" | "campaign_material" | "personal_photo" | "other",
  "summaryHindi": "चित्र का 1 वाक्य में विवरण",
  "details": {
    "epic": "",
    "name": "",
    "issueType": ""
  },
  "suggestedTag": "🎫 वोटर पर्ची" | "📝 काम की शिकायत" | "🟢 पक्का समर्थक" | "⚪ सामान्य संपर्क"
}`;

        // 1. Try Gemini Vision (gemini-flash-latest / gemini-3.8-flash)
        if (this.geminiKey) {
            const models = ['gemini-flash-latest', 'gemini-3.8-flash'];
            for (const model of models) {
                try {
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), 7000);

                    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${this.geminiKey}`;
                    const res = await fetch(url, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        signal: controller.signal,
                        body: JSON.stringify({
                            contents: [{
                                parts: [
                                    { text: promptText },
                                    {
                                        inline_data: {
                                            mime_type: mimeType,
                                            data: base64Data
                                        }
                                    }
                                ]
                            }],
                            generationConfig: {
                                temperature: 0.2,
                                maxOutputTokens: 250
                            }
                        })
                    });
                    clearTimeout(timeoutId);

                    if (res.ok) {
                        const data = await res.json();
                        const rawReply = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
                        const jsonMatch = rawReply.match(/\{[\s\S]*\}/);
                        if (jsonMatch) {
                            const parsed = JSON.parse(jsonMatch[0]);
                            console.log(`[VisionService] Analyzed with ${model}:`, parsed.category, parsed.summaryHindi);
                            return parsed;
                        }
                    }
                } catch (e) {
                    console.warn(`[VisionService] ${model} failed or timed out:`, e.message);
                }
            }
        }

        // 2. Intelligent Village Fallback
        return {
            category: 'other',
            summaryHindi: 'ग्रामवासी द्वारा भेजी गई फोटो (सड़क, पर्ची या व्यक्तिगत संदर्भ)',
            details: {},
            suggestedTag: '⚪ सामान्य संपर्क'
        };
    }

    getConversationalReply(analysis, voterName = 'भैया') {
        const cat = analysis.category || 'other';
        const summary = analysis.summaryHindi || '';

        if (cat === 'voter_id') {
            const epic = analysis.details?.epic;
            const name = analysis.details?.name;
            return `राम राम ${voterName}! 🙏 आपकी वोटर आईडी / पर्ची की तस्वीर मिल गई है। ${epic ? 'पहचान पत्र नं. ' + epic + ' नोट कर लिया है।' : ''} मैं तुरंत लिस्ट में आपकी सही मतदान पर्ची और बूथ का कमरा नंबर चेक करके भेजती हूँ! 😊`;
        }

        if (cat === 'civic_issue') {
            return `राम राम ${voterName}! 🙏 आपकी भेजी गई समस्या की तस्वीर ("${summary}") मिल गई है। मैंने इसे बाबा अभय सिंह के विकास प्राथमिकता रजिस्टर में सीधे नोट करवा दिया है। चुनाव जीतते ही इस कार्य को तुरंत करवाया जाएगा भैया! 🚩`;
        }

        if (cat === 'campaign_material') {
            return `अरे वाह ${voterName}! 🙏 बाबा अभय सिंह का प्रचार पोस्टर भेजने के लिए बहुत-बहुत धन्यवाद! क्या बात है भैया, इसे अपने WhatsApp स्टेटस पर भी जरूर लगाइएगा ताकि पूरे गाँव में अपना माहौल और मजबूत हो! 🚩😊`;
        }

        if (cat === 'personal_photo') {
            return `राम राम ${voterName}! 🙏 आपकी तस्वीर देखकर बहुत खुशी हुई भैया। बाबा अभय सिंह के सेवा केंद्र से जुड़ने के लिए धन्यवाद। घर-परिवार में सब कुशल मंगल? 😊`;
        }

        return `राम राम ${voterName}! 🙏 आपकी भेजी गई तस्वीर प्राप्त हो गई है। अगर यह किसी काम या समस्या के संबंध में है, तो एक छोटा संदेश लिखकर भी बता दीजिए ताकि मैं तुरंत सहायता कर सकूँ! 😊🚩`;
    }
}

module.exports = new VisionService();
