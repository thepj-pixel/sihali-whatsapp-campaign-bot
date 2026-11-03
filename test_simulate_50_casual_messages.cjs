const aiService = require('./ai_assistant_service.js');
const voterEngine = require('./voter_engine.js');
const userMemory = require('./user_memory.js');

async function run50MessageBrutalSimulation() {
    console.log('================================================================');
    console.log('🧪 50-MESSAGE BRUTAL CASUAL CONVERSATION & LOOP ELIMINATION TEST');
    console.log('================================================================\n');

    const testPhone = '919876543210';
    const user = userMemory.getUser(testPhone, 'सुमित यादव');
    user.gender = 'M';
    user.languagePreference = 'auto'; // Auto-detect based on input script
    userMemory.save();

    const failedList = [];

    const messages = [
        // Batch 1: Greetings & Casual Openers
        { id: 1, text: 'ram ram', expectNotLoop: true },
        { id: 2, text: 'kasa ho', expectNotLoop: true },
        { id: 3, text: 'theek hu bhai', expectNotLoop: true, expectKeyword: ['padhai', 'पढ़ाई'] },
        { id: 4, text: 'sab badhiya', expectNotLoop: true },
        { id: 5, text: 'kaha ho', expectNotLoop: true, expectKeyword: ['aawas', 'jansampark', 'कार्यालय', 'आवास'] },
        { id: 6, text: 'kya chal raha hai', expectNotLoop: true, expectKeyword: ['vikas rath', 'विकास रथ'] },
        { id: 7, text: 'gaon me kya mahol h', expectNotLoop: true, expectKeyword: ['support', 'samarthan', 'समर्थन'] },
        { id: 8, text: 'ward 3 me kya mahol h', expectNotLoop: true, expectKeyword: ['support', 'samarthan', 'समर्थन'] },

        // Batch 2: The 5-Step Engagement Ladder
        { id: 9, text: 'main student hu college me', expectNotLoop: true, expectKeyword: ['Ek number', 'एक नंबर'] },
        { id: 10, text: 'haan zaroor aao ghar pe chai peeyenge', expectNotLoop: true, expectKeyword: ['diary', 'डायरी'] },
        { id: 11, text: 'sadak par kichad aur paani bharta h bohot samasya h', expectNotLoop: true, expectKeyword: ['vote', 'वोट'] },
        { id: 12, text: 'haan baba ko hi vote denge pakka', expectNotLoop: true, expectKeyword: ['dil jeet liya', 'दिल जीत लिया'] },
        { id: 13, text: 'full support baba ko', expectNotLoop: true, expectKeyword: ['dil jeet liya', 'दिल जीत लिया'] },

        // Batch 3: Alternative Ladder Branch (Opposition / Skeptic / Doubtful)
        { id: 14, text: 'baba ko vote kyu de', expectNotLoop: true, expectKeyword: ['reason', 'कारण'] },
        { id: 15, text: 'nahi denge kisi aur ko denge', expectNotLoop: true, expectKeyword: ['samman', 'सम्मान'] },
        { id: 16, text: 'soch ke batayenge', expectNotLoop: true },

        // Batch 4: Alternate Occupations (Testing Token Normalization)
        { id: 17, text: 'fauj me hu army me', expectNotLoop: true, expectKeyword: ['Ek number', 'एक नंबर'] },
        { id: 18, text: 'kisan hu kheti karta hu', expectNotLoop: true, expectKeyword: ['Ek number', 'एक नंबर'] },
        { id: 19, text: 'police me hu', expectNotLoop: true, expectKeyword: ['Ek number', 'एक नंबर'] },
        { id: 20, text: 'teacher hu master', expectNotLoop: true, expectKeyword: ['Ek number', 'एक नंबर'] },

        // Batch 5: Facts & Major Certified Works
        { id: 21, text: 'baba kon hai', expectNotLoop: true, expectKeyword: ['jan-sevak', 'जनसेवक'] },
        { id: 22, text: 'baba abhay singh kon hai', expectNotLoop: true, expectKeyword: ['jan-sevak', 'जनसेवक'] },
        { id: 23, text: 'baba ne kya kaam karwaya', expectNotLoop: true, expectKeyword: ['mukhya kaam', 'मुख्य कार्य'] },
        { id: 24, text: 'hospital me kya kaam hua', expectNotLoop: true, expectKeyword: ['up-swasthya', 'उप-स्वास्थ्य'] },
        { id: 25, text: 'sports aur gym ka kya hua', expectNotLoop: true, expectKeyword: ['open gym', 'ओपन जिम'] },
        { id: 26, text: 'pani ki samasya hai drinking water', expectNotLoop: true, expectKeyword: ['JJM', 'meetha'] },
        { id: 27, text: 'sadak aur cc road ka kya hua', expectNotLoop: true, expectKeyword: ['CC', 'सी.सी.'] },
        { id: 28, text: 'school aur library ka batao', expectNotLoop: true, expectKeyword: ['library', 'लाइब्रेरी'] },
        { id: 29, text: 'mokshdham aur johad ka kya hua', expectNotLoop: true, expectKeyword: ['Mokshdham', 'मोक्षधाम'] },
        { id: 30, text: 'aage kya sankalp hai agle 5 saal ka', expectNotLoop: true, expectKeyword: ['sankalp', 'संकल्प'] },

        // Batch 6: Rumors, Opposition, Bribes & Guardrails
        { id: 31, text: 'rajesh keh raha tha baba ne kuch nahi kiya', expectNotLoop: true, expectKeyword: ['daru', 'दारू'] },
        { id: 32, text: 'virodhi daru aur paise baat rahe hai', expectNotLoop: true, expectKeyword: ['5 din', '5 साल'] },
        { id: 33, text: 'mc bakwas mat kar', expectNotLoop: true, expectKeyword: ['samman', 'सम्मान'] },
        { id: 34, text: 'pagal chor ho tum sab', expectNotLoop: true, expectKeyword: ['samman', 'सम्मान'] },

        // Batch 7: Polling & Election Essentials
        { id: 35, text: 'chunav kab hai date batao', expectNotLoop: true, expectKeyword: ['November', 'नवम्बर', '16'] },
        { id: 36, text: 'voting kahan hogi booth', expectNotLoop: true, expectKeyword: ['Vidyalaya', 'विद्यालय', 'Booth'] },
        { id: 37, text: 'ek slogan sunao', expectNotLoop: true, expectKeyword: ['16', 'बाबा अभय सिंह', 'Baba Abhay Singh'] },

        // Batch 8: Legitimate Parchi & EPIC Queries (Must Work Accurately!)
        { id: 38, text: 'satish kumar ki parchi bhej do', isParchi: true, expectName: 'सतीश कुमार' },
        { id: 39, text: 'IED1029487', isParchi: true, expectName: 'दयाल भान यादव' },
        { id: 40, text: 'rince yadav kie parchi bhej do', isParchi: true, expectName: 'प्रिंस यादव' },

        // Batch 9: Casual Conversational Pleasantries & Slang
        { id: 41, text: 'shukriya bhai', expectNotLoop: true, expectKeyword: ['shukriya kaisa', 'शुक्रिया कैसा'] },
        { id: 42, text: 'dhanyawad', expectNotLoop: true, expectKeyword: ['shukriya kaisa', 'शुक्रिया कैसा'] },
        { id: 43, text: 'achha ji', expectNotLoop: true, expectKeyword: ['bilkul', 'बिल्कुल'] },
        { id: 44, text: 'samajh gaya', expectNotLoop: true, expectKeyword: ['bilkul', 'बिल्कुल'] },
        { id: 45, text: 'theek h chalte h', expectNotLoop: true, expectKeyword: ['bilkul', 'बिल्कुल'] },
        { id: 46, text: 'shubh ratri', expectNotLoop: true, expectKeyword: ['Shubh ratri', 'शुभ रात्रि'] },
        { id: 47, text: 'good morning', expectNotLoop: true },
        { id: 48, text: 'namaste ji', expectNotLoop: true },
        { id: 49, text: 'prince bhai', expectNotLoop: true, expectKeyword: ['pracharak', 'प्रचारक'] },
        { id: 50, text: 'bhai suno', expectNotLoop: true }
    ];

    let passedCount = 0;
    let failedCount = 0;

    for (const m of messages) {
        const lower = m.text.toLowerCase().trim();
        let reply = '';
        let route = '';

        // Check parchi routing
        const hasEpic = /\b([A-Za-z]{3}\d{7}|RJ\/\d+\/\d+\/\d+|[Ww]\d{1,2}-\d{1,4}|IED\d+|CYN\d+)\b/i.test(m.text);
        const hasExplicitParchi = lower.includes('parchi') || lower.includes('पर्ची') || lower.includes('voter slip');
        const isLikelyVoter = voterEngine.isLikelyNameOrVoterQuery(m.text);

        if (hasEpic || hasExplicitParchi || isLikelyVoter) {
            const matches = voterEngine.searchVoters(m.text, 1);
            if (matches && matches.length > 0) {
                reply = voterEngine.formatShortSlipResponse(matches[0]);
                route = `PARCHI_FOUND(${matches[0].name_hi})`;
            } else if (hasExplicitParchi || hasEpic) {
                reply = voterEngine.formatFallbackResponse();
                route = 'PARCHI_FALLBACK_NOT_FOUND';
            } else {
                // Fall through to AI / local
                reply = aiService.getFastLocalAnswer(m.text, testPhone);
                route = 'AI_LOCAL_FALLTHROUGH';
            }
        } else {
            reply = aiService.getFastLocalAnswer(m.text, testPhone);
            route = 'FAST_LOCAL_ANSWER';
        }

        const isLoopTrapped = reply.includes('ग्राम पंचायत सिहाली खुर्द चुनाव सहायता केंद्र') && !m.isParchi;
        let testOk = true;

        if (isLoopTrapped) {
            testOk = false;
        } else if (m.expectKeyword) {
            const keywords = Array.isArray(m.expectKeyword) ? m.expectKeyword : [m.expectKeyword];
            const hasAnyKeyword = keywords.some(k => reply.toLowerCase().includes(k.toLowerCase()));
            if (!hasAnyKeyword) testOk = false;
        } else if (m.isParchi && (!reply.includes(m.expectName) || reply.includes('सहायता केंद्र'))) {
            testOk = false;
        }

        const statusIcon = testOk ? '✅ [PASS]' : '❌ [FAIL]';
        if (testOk) {
            passedCount++;
        } else {
            failedCount++;
            failedList.push({ id: m.id, text: m.text, reply: reply.substring(0, 100), expected: m.expectKeyword || m.expectName });
        }

        console.log(`Msg #${m.id.toString().padStart(2, '0')}: "${m.text}"`);
        console.log(`   Route: ${route}`);
        console.log(`   Reply Preview: ${reply.split('\n')[0].substring(0, 75)}...`);
        console.log(`   Result: ${statusIcon}\n`);
    }

    console.log('================================================================');
    console.log(`📊 SIMULATION COMPLETE: ${passedCount}/50 PASSED (${failedCount} FAILED)`);
    if (failedList.length > 0) {
        console.log('\n❌ FAILED MESSAGES DETAILS:');
        failedList.forEach(f => console.log(`   Msg #${f.id}: "${f.text}"\n     Expected: "${JSON.stringify(f.expected)}"\n     Got Reply: "${f.reply}..."\n`));
    }
    console.log('================================================================');
    if (failedCount > 0) process.exitCode = 1;
}

run50MessageBrutalSimulation().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
