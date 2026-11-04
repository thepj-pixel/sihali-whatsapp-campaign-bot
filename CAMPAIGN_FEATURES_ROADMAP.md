# 🏛️ ग्राम पंचायत सिहाली खुर्द चुनाव 2026 — बाबा अभय सिंह
## 📋 Campaign Bot & Live CRM Master Roadmap & Feature Tracker

> **प्रत्याशी:** बाबा अभय सिंह (मोटी आंगली वाले बाबा)  
> **ग्राम पंचायत:** सिहाली खुर्द (सिहाली खुर्द, सिहाली कलां / बड़ी सिहाली, हाड़ाहेड़ी)  
> **मतदान तिथि:** सोमवार, 16 नवम्बर 2026  
> **डिजिटल सारथी:** सुमन (गांव की छोटी बहन / डिजिटल प्रचारक)

---

### 📊 Feature Status Matrix (मौजूदा व आगामी सुविधाएं)

| फ़ीचर / मॉड्यूल | स्थिति | विवरण |
|---|:---:|---|
| **Multi-Tier LLM Failover** | ✅ **DONE** | NVIDIA Bolt (Tier 1) ➔ Groq Qwen 27B (Tier 2) ➔ Gemini 3.5 Flash (Tier 3) ➔ Local Fast Engine (Tier 4). |
| **Strict Naming Lock** | ✅ **DONE** | केवल 'बाबा अभय सिंह' या 'अभय सिंह' (कभी भी सिर्फ 'बाबा जी' या 'बाबाजी' नहीं)। |
| **Zero Work Count & Zero Budget Lock** | ✅ **DONE** | किसी गांव में कामों की संख्या या गिनती (उदा: 52 काम vs 15 काम) नहीं बोली जाती, बजट/रुपये स्ट्रिप्ड। |
| **15-Category Auto-Tagging Matrix** | ✅ **DONE** | गाली/विपक्ष, समर्थक, असमंजस, परिवार, माहौल, काम की शिकायत, पर्ची, मुलाकात, युवा टीम, किसान, बुजुर्ग, महिला, धांधली अलर्ट, संकल्प पत्र, प्रवासी। |
| **WhatsApp Web Replica Live CRM** | ✅ **DONE** | 17 स्मार्ट फ़िल्टर चिप्स, सर्च बार, अवतार कार्ड्स, चैट हिस्ट्री, कलर-कोडेड टैग्स। |
| **Anti-Rogue AutoPilot Switch** | ✅ **DONE** | 1-क्लिक AI टॉगल (`🤖 Auto` vs `⏸️ Manual`)। मैन्युअल मोड में बॉट चुप रहता है। |
| **AI Copilot (Assisted Manual Drafting)** | 🟡 **DEPLOYING** | मैन्युअल मोड में एडमिन निर्देश लिखेगा ("बोलो कल आ जाएं"), AI सुमन की आवाज़ में 2 लाइन का ड्राफ्ट बना देगा। |
| **Dynamic Respectful Greetings** | 🟡 **DEPLOYING** | नाम पता होने पर 6 रोटेटिंग अभिवादन; नाम न होने पर मीठे अंदाज़ में नाम पूछना व बैकग्राउंड में सहेजना। |
| **Target Conversational Goals** | 🟡 **DEPLOYING** | हर वोटर या पूरे वार्ड के लिए अलग लक्ष्य सेट करना (उदा: "चौपाल पर बुलाना", "सड़क का आश्वासन देना")। |
| **Demo Poster Testing Mode** | ✅ **DONE** | जब तक फाइनल पोस्टर तैयार नहीं होते, केवल `poster_demo_test.png` भेजा जाता है। |
| **Daily Fixed Target Poster/Reel** | 🟡 **DEPLOYING** | आज रात तक कौन सा पोस्टर/वीडियो प्राथमिकता पर भेजना है, इसका एडमिन टारगेट टॉगल। |
| **On-the-Fly Name Poster Generator** | ✅ **DONE** | वोटर के नाम का 9:16 WhatsApp Status पोस्टर जेनरेट करके भेजना। |
| **Voter Parchi (Slip) Precision Engine** | ✅ **DONE** | 3,435 वोटरों की प्रमाणित लिस्ट से वार्ड/नाम/EPIC द्वारा तुरंत डिजिटल पर्ची जारी करना। |
| **Permanent Domain & Nginx Proxy** | ✅ **DONE** | एक स्थायी domain VM public IP पर point होता है; Nginx dashboard को port 3000 से serve करता है। Temporary tunnel की जरूरत नहीं। |
| **Direct Baba Register & Ground Intel** | ✅ **DONE** | समस्याएं सीधे `baba_direct_register.json` व `ground_intelligence_feed.json` में दर्ज। |

---

### 🔑 VM पर API Keys व सेटिंग्स अपडेट करने की गाइड (How to Update VM)

#### 1. API Keys फ़ाइल (`api_config.json`)
VM में बॉट डायरेक्टरी में `api_config.json` फ़ाइल रहती है:
```json
{
  "nvidia_keys": [
    "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",
    "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"
  ],
  "groq_api_key": "gsk_...",
  "gemini_api_key": "AQ.Ab8RN6InN-...",
  "media_urls": {
    "campaign_reel_video": "https://github.com/thepj-pixel/sihali-whatsapp-campaign-bot/raw/main/media/campaign_reel.mp4",
    "campaign_poster": "https://github.com/thepj-pixel/sihali-whatsapp-campaign-bot/raw/main/media/poster.jpg"
  }
}
```
**VM पर कमांड:**
```bash
# VM में लॉगिन करके api_config.json खोलें या एडिट करें
nano /home/patrikryian/sihali-whatsapp-campaign-bot/api_config.json

# बॉट रीलोड करें
pm2 restart whatsapp-bot
```

#### 2. Permanent dashboard domain चेक करने की कमांड
```bash
# Local app और Nginx दोनों चेक करें
curl -fsS http://127.0.0.1:3000/health
sudo nginx -t
```
Domain setup के लिए `OPERATIONS.md` और `deploy/nginx-whatsapp-bot.conf` इस्तेमाल करें।

---

### 🧠 RAG नॉलेज बेस फ़ाइलों की मैपिंग (`rag_vault/`)

| फ़ाइल का नाम | सामग्री व उपयोग |
|---|---|
| `01_AI_BOT_MASTER_KNOWLEDGE_BASE.md` | मास्टर AI प्रॉम्प्ट, चुनावी इतिहास, व्यक्तित्व नियम ও आचार संहिता। |
| `01_SANITIZED_INDIVIDUAL_KAAM_LIST.json` | 99 प्रमाणित गली-मोहल्ले वार विकास कार्य (बिना किसी गिनती या रुपये के)। |
| `02_MAJOR_KAAM_LIST_HIGHLIGHTS.json` | 18 प्रमाणित प्रमुख कार्य (JJM, सी.सी. सड़कें, खेल मैदान, लाइब्रेरी आदि)। |
| `03_FUTURE_WORK_SANKALP_RESOLUTIONS.json` | 15 भावी संकल्प (मिनी स्टेडियम, सीसीटीवी, स्ट्रीट लाइट आदि)। |
| `04_BABA_AND_GAON_HISTORY_PROFILE.md` | बाबा अभय सिंह का 40 वर्षीय निष्कलंक सेवा प्रोफाइल, मोटी आंगली इतिहास व बूथ कमरे। |
| `05_BOT_ROLE_AND_CAMPAIGN_FENCE.md` | सुमन का व्यक्तित्व, विरोधी को जवाब, गैर-हैलुसिनेशन व कानूनी सुरक्षा घेरा। |
| `works_data.json` | वेबसाइट का प्रमाणित विकास कार्य डेटा। |

---
*दस्तावेज़ अंतिम अद्यतन: 1 नवम्बर 2026*
