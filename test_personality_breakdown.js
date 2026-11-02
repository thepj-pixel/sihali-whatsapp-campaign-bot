const aiService = require('./ai_assistant_service');
const voterEngine = require('./voter_engine');
const userMemory = require('./user_memory');

async function testPersonalities() {
    console.log('--- 🧪 BRUTAL CONVERSATION & PERSONALITY TEST ---');

    const testCases = [
        {
            role: '1. SKEPTIC VOTER (Tough Questions / Opposition Rumors)',
            phone: '919811100001',
            name: 'सुरेश गुर्जर',
            incoming: 'विरोधी कह रहे हैं कि बाबा ने कुछ काम नहीं किया और चुनाव में शराब बंटवा रहे हैं, क्या सच है?'
        },
        {
            role: '2. YOUTH VOTER (Sports / Library / Career)',
            phone: '919811100002',
            name: 'राहुल यादव',
            incoming: 'भाई जी, हम युवाओं के लिए क्या खास है? हमारे यहाँ खेल मैदान या रनिंग ट्रैक का क्या हुआ?'
        },
        {
            role: '3. ELDER / TAUJI (Respect, Healthcare, Pension, Peace)',
            phone: '919811100003',
            name: 'रामकिशन शर्मा',
            incoming: 'राम राम बेटा, मैं बुजुर्ग आदमी हूँ, अस्पताल में डॉक्टर नहीं बैठते, इसका क्या समाधान है?'
        },
        {
            role: '4. WOMAN VOTER (Drinking Water, JJM, Dignity)',
            phone: '919811100004',
            name: 'कमलेश देवी',
            incoming: 'हमारे मोहल्ले में पीने का पानी ठीक से नहीं आता, नल कब तक चालू होगा?'
        },
        {
            role: '5. PARCHI QUERY (Fast, Accurate, Disambiguation Check)',
            phone: '919811100005',
            name: 'प्रिंस यादव',
            incoming: 'rince yadav kie parchi bhej do'
        }
    ];

    for (const tc of testCases) {
        console.log(`\n======================================================`);
        console.log(`🎭 PERSONA: ${tc.role}`);
        console.log(`👤 Voter: ${tc.name} (${tc.phone})`);
        console.log(`💬 Incoming: "${tc.incoming}"`);
        console.log(`------------------------------------------------------`);

        const lower = tc.incoming.toLowerCase();

        // 1. Voter slip check
        if (lower.includes('parchi') || lower.includes('पर्ची') || voterEngine.isLikelyNameOrVoterQuery(tc.incoming)) {
            const matches = voterEngine.searchVoters(tc.incoming, 5);
            if (matches && matches.length > 1) {
                console.log(`⚡ ACTION: Multiple matches found -> Disambiguation prompt:`);
                console.log(voterEngine.formatDisambiguationPrompt(matches, 'प्रिंस यादव'));
            } else if (matches && matches.length > 0) {
                console.log(`⚡ ACTION: Voter Slip Found:`);
                console.log(voterEngine.formatShortSlipResponse(matches[0]));
            }
            continue;
        }

        // 2. AI Conversation Test
        try {
            const reply = await aiService.getAIResponse(tc.incoming, process.env.NVIDIA_API_KEY || '', [], tc.phone);
            console.log(`🤖 BOT RESPONSE:`);
            console.log(reply);
        } catch (e) {
            console.error(`Error generating response:`, e.message);
        }
    }
    console.log(`\n======================================================`);
    console.log(`✓ Personality test completed!`);
}

testPersonalities().catch(console.error);
