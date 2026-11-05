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

        // 2. NVIDIA vision (same NVIDIA keys as the reply brain; short timeout, never blocks the reply for long)
        try {
            const nv = await this.analyzeWithNvidia(base64Data, mimeType, promptText);
            if (nv) return nv;
        } catch (e) { console.warn('[VisionService] NVIDIA vision failed:', e.message); }

        // 3. No vision available: the caller asks the voter in one line what the photo is about (fallback:true)
        return {
            category: 'other',
            fallback: true,
            summaryHindi: '',
            details: {},
            suggestedTag: null
        };
    }

    /** Shrink to <=768px JPEG so the base64 fits NVIDIA's inline image limit. */
    async _shrink(base64Data) {
        try {
            const sharp = require('sharp');
            const out = await sharp(Buffer.from(base64Data, 'base64')).rotate().resize({ width: 768, height: 768, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 70 }).toBuffer();
            return out.toString('base64');
        } catch (e) { return base64Data; }
    }

    async analyzeWithNvidia(base64Data, mimeType, promptText, opts = {}) {
        const keys = (CONFIG.nvidia_keys || []).filter(Boolean);
        if (!keys.length || process.env.VISION_NVIDIA === 'off') return null;
        const small = await this._shrink(base64Data);
        // NVIDIA hosts its vision models on ai.api.nvidia.com (gr/vlm paths); integrate.api.nvidia.com serves the newer VL models
        const ENDPOINT = {
            'meta/llama-3.2-11b-vision-instruct': 'https://ai.api.nvidia.com/v1/gr/meta/llama-3.2-11b-vision-instruct/chat/completions',
            'meta/llama-3.2-90b-vision-instruct': 'https://ai.api.nvidia.com/v1/gr/meta/llama-3.2-90b-vision-instruct/chat/completions',
            'microsoft/phi-3.5-vision-instruct': 'https://ai.api.nvidia.com/v1/vlm/microsoft/phi-3_5-vision-instruct'
        };
        const models = opts.models || (process.env.NVIDIA_VISION_MODELS ? process.env.NVIDIA_VISION_MODELS.split(',') : ['nvidia/nemotron-nano-12b-v2-vl', 'meta/llama-4-maverick-17b-128e-instruct', 'meta/llama-3.2-90b-vision-instruct']);
        const budgetMs = opts.timeoutMs || 12000;
        const started = Date.now();
        const tried = [];
        for (const model of models) {
            for (const key of keys.slice(0, 2)) {
                const left = budgetMs - (Date.now() - started);
                if (left < 1500) { this.lastNvidia = { ok: false, tried, reason: 'budget' }; return null; }
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), Math.min(left, opts.perCallMs || 9000));
                try {
                    const res = await fetch(ENDPOINT[model] || 'https://integrate.api.nvidia.com/v1/chat/completions', {
                        method: 'POST',
                        signal: controller.signal,
                        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key, Accept: 'application/json' },
                        body: JSON.stringify({
                            model,
                            messages: [{ role: 'user', content: ENDPOINT[model]
                                ? promptText + `\n<img src="data:image/jpeg;base64,${small}" />`
                                : [{ type: 'text', text: promptText }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + small } }] }],
                            max_tokens: 300, temperature: 0.2, stream: false
                        })
                    });
                    clearTimeout(timer);
                    if (!res.ok) { tried.push(model + ':' + res.status); if (res.status === 404 || res.status === 400 || res.status === 422) break; continue; }
                    const data = await res.json();
                    const raw = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
                    const jm = raw.match(/\{[\s\S]*\}/);
                    if (!jm) { tried.push(model + ':nojson'); continue; }
                    const parsed = JSON.parse(jm[0]);
                    const cats = ['voter_id', 'civic_issue', 'campaign_material', 'personal_photo', 'other'];
                    if (!cats.includes(parsed.category)) parsed.category = 'other';
                    parsed.model = model;
                    parsed.provider = 'nvidia';
                    this.lastNvidia = { ok: true, model, at: new Date().toISOString() };
                    console.log(`[VisionService] NVIDIA ${model}:`, parsed.category, parsed.summaryHindi);
                    return parsed;
                } catch (e) {
                    clearTimeout(timer);
                    tried.push(model + ':' + (e.name === 'AbortError' ? 'timeout' : String(e.message).slice(0, 40)));
                    break; // a timeout/network error on one key -> next model
                }
            }
        }
        this.lastNvidia = { ok: false, tried, at: new Date().toISOString() };
        return null;
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
