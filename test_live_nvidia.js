const fs = require('fs');
const path = require('path');

const kbPath = path.join(__dirname, 'campaign_knowledge_base.json');
const KB = JSON.parse(fs.readFileSync(kbPath, 'utf8'));

const API_KEY = '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';

const systemPrompt = `
आप ग्राम पंचायत सिहाली खुर्द के सरपंच पद प्रत्याशी 'बाबा अभय सिंह (मोटी आंगली वाले बाबा)' के डिजिटल सहायक हैं।

🎯 नियम (Strict Rules):
1. भाषा: मीठी, विनम्र, दोस्ताना और ज़मीनी हिंदी। कभी गुस्सा या बहस नहीं करना (Respectful, cute & pleasing tone)।
2. दारू/प्रलोभन पर जवाब: 
   "अरे भाई, 5 दिन की दारू या दिखावे से 5 साल का गांव का भविष्य थोड़े ही बनेगा! हमें तो अपना ईमानदार बाबा चाहिए जो आधी रात को भी सुख-दुख में साथ खड़ा मिले। बाकी आप खुद समझदार हो! 😊"
3. काम की लिस्ट (Main Highlights Only):
   हमेशा सिर्फ मुख्य काम 2-3 बुलेट में बताएं (जैसे: JJM पानी की टंकियां, सी.सी. सड़कें, जोहड़ों की गहरी खुदाई, आश्रम डामर सड़क)।
   ⚠️ किसी भी काम का रुपया या बजट (Amount) कभी नहीं बताना।
4. लंबाई: सिर्फ 2 से 3 छोटी और असरदार पंक्तियां (Zero Long Speeches)।
5. अंत में प्यार से कहें: "अगर अपनी वोटर पर्ची देखनी हो तो नाम लिख कर भेज देना!"

📌 प्रमाणित ज्ञानकोश (Knowledge Base):
${JSON.stringify(KB, null, 2)}
`;

async function testQuery(userQ) {
    console.log(`\n======================================================`);
    console.log(`👤 VOTER: "${userQ}"`);
    console.log(`======================================================`);
    const t0 = Date.now();
    try {
        const res = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'openai/gpt-oss-20b',
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userQ }
                ],
                max_tokens: 450,
                temperature: 0.5
            })
        });

        const elapsed = Date.now() - t0;
        const data = await res.json();
        const content = data.choices?.[0]?.message?.content || data.choices?.[0]?.message?.reasoning;
        console.log(`⚡ Latency: ${elapsed}ms`);
        console.log(`🤖 ASSISTANT REPLY:\n${content}`);
    } catch (err) {
        console.error('Error:', err.message);
    }
}

async function run() {
    await testQuery('Ram Ram bhai, Baba ne pichle 5 saal me kya karwaya h gaon me?');
    await testQuery('Dusre log toh daaru baat rahe hain, Baba kya de rahe hain?');
    await testQuery('Election kab h aur voting kahan hogi?');
}

run();
