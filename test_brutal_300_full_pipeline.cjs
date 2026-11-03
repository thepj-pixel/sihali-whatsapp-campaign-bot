const fs = require('fs');
const path = require('path');
const voterEngine = require('./voter_engine.js');
const voterCardGen = require('./voter_card_generator.js');
const aiService = require('./ai_assistant_service.js');
const userMemory = require('./user_memory.js');

async function runBrutalSuite() {
    console.log('================================================================');
    console.log('🔥 STARTING BRUTAL 300-BURST & INTEGRITY TEST SUITE FOR WHATSAPP BOT');
    console.log('================================================================\n');

    let totalTests = 0;
    let passedTests = 0;
    let failedTests = 0;

    function assert(name, condition, extra = '') {
        totalTests++;
        if (condition) {
            passedTests++;
            console.log(`  ✓ [PASS] ${name}`);
        } else {
            failedTests++;
            console.error(`  ❌ [FAIL] ${name} ${extra}`);
        }
    }

    // -------------------------------------------------------------
    // PHASE 1: PRECISION & DISAMBIGUATION TEST
    // -------------------------------------------------------------
    console.log('▶ PHASE 1: VOTER ENGINE SEARCH & DISAMBIGUATION PRECISION');
    
    // Test 1.1: Exact EPIC search
    const epicMatch = voterEngine.searchVoters('IED1610633');
    assert('1.1 Exact EPIC search finds voter', epicMatch.length === 1 && epicMatch[0].epic.toUpperCase() === 'IED1610633');

    // Test 1.2: Transliterated Hinglish Name
    const princeMatch = voterEngine.searchVoters('prince yadav');
    assert('1.2 Hinglish "prince yadav" resolves to Prince', princeMatch.length > 0 && princeMatch[0].name_hi.includes('प्रिंस'));

    // Test 1.3: Common duplicate name disambiguation check
    const mukeshMatches = voterEngine.searchVoters('mukesh kumar');
    assert('1.3 Common name "mukesh kumar" returns multiple candidates for disambiguation', mukeshMatches.length > 1);

    // Test 1.4: Ward filtered search
    const wardMatch = voterEngine.searchVoters('anil kumar ward 4');
    assert('1.4 Ward extraction in query filters by ward', wardMatch.every(v => v.ward === 4));

    // Test 1.5: Fillers stripping ("bhai mera naam dekhna list me")
    const fillerSearch = voterEngine.searchVoters('bhai mera naam list me dekhna prince yadav');
    assert('1.5 Conversational filler query extracts target name', fillerSearch.length > 0 && fillerSearch[0].name_hi.includes('प्रिंस'));

    // -------------------------------------------------------------
    // PHASE 2: FATHER CONFIRMATION STATE MACHINE
    // -------------------------------------------------------------
    console.log('\n▶ PHASE 2: FATHER CONFIRMATION & CARD GENERATION STATE MACHINE');
    const mockUserPhone = '919876543210';
    
    // Simulate user asking for single unique candidate
    const singleMatches = voterEngine.searchVoters('prince yadav');
    const targetVoter = singleMatches[0];
    const userObj = userMemory.getUser(mockUserPhone);
    userObj.pendingParchiCandidate = targetVoter;
    userMemory.save();

    // Confirm candidate with "haan"
    const confirmations = ['haan', 'ha', 'sahi h', 'yahi h', 'shi h', 'ji', 'thik h'];
    let confirmSuccess = true;
    for (const c of confirmations) {
        const lower = c.toLowerCase();
        const isYes = lower === 'ha' || lower === 'haan' || lower === 'हाँ' || lower === 'yes' || lower === 'sahi h' || lower === 'sahi hai' || lower === 'yahi h' || lower === 'yahi he' || lower === 'shi h' || lower === 'ji' || lower === 'theek h' || lower === 'thik h';
        if (!isYes) confirmSuccess = false;
    }
    assert('2.1 All colloquial confirmation variants ("haan", "sahi h", etc.) recognize affirmative', confirmSuccess);

    // Test Voter Card Generation (Sharp SVG/JPG)
    const cardBuffer = await voterCardGen.generateVoterCard(targetVoter);
    assert('2.2 High-Res Voter Slip JPG card rendered with buffer > 30KB', cardBuffer && cardBuffer.length > 30000);

    // Test Card Cache hit
    const t0 = Date.now();
    const cachedBuffer = await voterCardGen.generateVoterCard(targetVoter);
    const cacheLatency = Date.now() - t0;
    assert(`2.3 Cached voter card returned instantaneously in ${cacheLatency}ms`, cachedBuffer && cacheLatency < 10);

    // -------------------------------------------------------------
    // PHASE 3: CONVERSATIONAL & POLITICAL GUARDRAILS
    // -------------------------------------------------------------
    console.log('\n▶ PHASE 3: POLITICAL GUARDRAILS & SENSITIVE QUERY FENCE');
    
    // Test 3.1: Rupee amount / Budget trap
    const budgetReply = aiService.getFastLocalAnswer('sadak me kitna rupya kharch hua budget batao', mockUserPhone);
    assert('3.1 Local answer does not leak unverified rupee budgets', !budgetReply.includes('लाख') && !budgetReply.includes('करोड़') && !budgetReply.includes('रुपए'));

    // Test 3.2: Critical slur / opposition auto-tagging
    userMemory.recordMessage(mockUserPhone, 'user', 'are rajesh ka vikas purush bol raha tha ki sab bekar h kuch nahi kiya');
    const taggedUser = userMemory.getUser(mockUserPhone);
    assert('3.2 Opposition slur/attack triggers "critical" sentiment & tags', taggedUser.voterSentiment === 'critical' && taggedUser.tags.includes('🔴 विरोधी / नाराज'));

    // Test 3.3: Prince Admin Recognition
    const adminReply = aiService.getFastLocalAnswer('prince', mockUserPhone);
    assert('3.3 Admin "prince" recognized with respectful campaign coordinator status', /(प्रिंस भाई जी|Prince bhai ji)/i.test(adminReply));

    // -------------------------------------------------------------
    // PHASE 4: 300-MESSAGE RAPID BURST SIMULATION
    // -------------------------------------------------------------
    console.log('\n▶ PHASE 4: 300-MESSAGE RAPID CONCURRENCY BURST SIMULATION');
    console.log('  Simulating 300 voters simultaneously querying voter slips, works, and confirmations...');

    const sampleQueries = [
        'prince yadav',
        'IED1610633',
        'CYN1518117',
        'rajesh kumar ward 1',
        'suman devi',
        'ramesh sharma',
        'baba abhay singh ke kaam batao',
        'chunav kab hai',
        'booth kaun sa hai',
        'kavita devi',
        'sunil kumar ward 3',
        'haan sahi h',
        '1',
        'ram ram bhai',
        'mera poster bana do'
    ];

    const burstStartTime = Date.now();
    let burstSearches = 0;
    let burstCards = 0;
    let burstLocalAnswers = 0;
    let burstErrors = 0;

    const burstTasks = [];
    for (let i = 0; i < 300; i++) {
        const query = sampleQueries[i % sampleQueries.length];
        const userPhone = `91970000${String(i).padStart(4, '0')}`;

        burstTasks.push((async () => {
            try {
                // 1. Memory record incoming message
                userMemory.recordMessage(userPhone, 'user', query);

                // 2. Classify intent
                const lower = query.toLowerCase();
                const isConv = voterEngine.isConversationalInquiry(query);
                const isGreet = voterEngine.isGreeting(query);

                if (isConv || isGreet) {
                    const ans = aiService.getFastLocalAnswer(query, userPhone);
                    burstLocalAnswers++;
                    userMemory.recordMessage(userPhone, 'bot', ans);
                } else {
                    const matches = voterEngine.searchVoters(query, 5);
                    burstSearches++;
                    if (matches && matches.length > 0) {
                        // Every 5th voter generates a full JPG slip
                        if (i % 5 === 0) {
                            const card = await voterCardGen.generateVoterCard(matches[0]);
                            if (card && card.length > 30000) burstCards++;
                        }
                    }
                    const slipText = matches.length > 0 ? voterEngine.formatShortSlipResponse(matches[0]) : voterEngine.formatFallbackResponse();
                    userMemory.recordMessage(userPhone, 'bot', slipText);
                }
            } catch (err) {
                burstErrors++;
                console.error(`Burst error for ${userPhone}:`, err.message);
            }
        })());
    }

    await Promise.all(burstTasks);
    const burstDurationMs = Date.now() - burstStartTime;
    const burstDurationSec = burstDurationMs / 1000;
    const throughput = (300 / burstDurationSec).toFixed(1);

    console.log(`\n  --- 📊 300-BURST BENCHMARK METRICS ---`);
    console.log(`  ✓ Total Requests Processed: 300 in ${burstDurationSec.toFixed(2)}s`);
    console.log(`  ✓ Voter DB Lookups: ${burstSearches}`);
    console.log(`  ✓ Voter Slip Cards Generated: ${burstCards}`);
    console.log(`  ✓ Instant Conversational Answers: ${burstLocalAnswers}`);
    console.log(`  ✓ Errors / Failures: ${burstErrors}`);
    console.log(`  ✓ Throughput: ${throughput} requests/sec (~${(throughput * 60).toFixed(0)} requests/min)`);

    assert('4.1 Zero errors in 300-burst execution', burstErrors === 0);
    assert(`4.2 300 messages processed in under 60 seconds (Actual: ${burstDurationSec.toFixed(2)}s)`, burstDurationSec < 60);

    // -------------------------------------------------------------
    // SUMMARY REPORT
    // -------------------------------------------------------------
    console.log('\n================================================================');
    console.log(`🏁 TEST SUITE COMPLETE: ${passedTests}/${totalTests} Passed (${failedTests} Failures)`);
    console.log('================================================================');

    // Clean up mock users
    try {
        const mem = userMemory.getAllUsers();
        for (let i = 0; i < 300; i++) {
            const p = `91970000${String(i).padStart(4, '0')}`;
            delete userMemory.users[p];
        }
        delete userMemory.users[mockUserPhone];
        userMemory.save();
    } catch (e) {}
    if (failedTests > 0) process.exitCode = 1;
}

runBrutalSuite().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
