const { searchVoters, isConversationalInquiry, isGreeting, isLikelyNameOrVoterQuery, formatShortSlipResponse, formatDisambiguationPrompt } = require('./voter_engine');
const { generateVoterCard } = require('./voter_card_generator');

async function benchmark() {
    console.log('--- 🚀 STARTING 200-CONCURRENT VOTER SIMULATION BENCHMARK ---');

    const sampleQueries = [
        'prince yadav',
        'rajesh kumar',
        'suman devi',
        'ramesh sharma',
        'kavita devi',
        'anita yadav',
        'sunil kumar',
        'manoj arya',
        'mukesh kumar',
        'voter parchi bhejo',
        'ward 3 parchi',
        'IED1610633',
        'CYN1518117',
        'baba abhay singh ke kaam batao',
        'kya haal chaal hai',
        'hitesh kumar',
        'dinesh chand',
        'anil kumar',
        'santosh devi',
        'om prakash'
    ];

    const startTime = Date.now();
    let searchCount = 0;
    let cardGenCount = 0;
    let errorCount = 0;

    // Simulate 200 users arriving rapidly
    const tasks = [];
    for (let i = 0; i < 200; i++) {
        const query = sampleQueries[i % sampleQueries.length];
        const userPhone = `91980000${String(i).padStart(4, '0')}`;

        tasks.push((async () => {
            try {
                // 1. Search Voter DB (synchronous in-memory lookup)
                const matches = searchVoters(query, 5);
                searchCount++;

                // 2. If it's a voter match and every 4th query asks for full card render:
                if (matches && matches.length > 0 && i % 4 === 0) {
                    const card = await generateVoterCard(matches[0]);
                    if (card && card.length > 50000) {
                        cardGenCount++;
                    }
                }
            } catch (err) {
                errorCount++;
                console.error(`Error for user ${userPhone}:`, err.message);
            }
        })());
    }

    await Promise.all(tasks);
    const durationMs = Date.now() - startTime;

    console.log('--- 📊 BENCHMARK RESULTS ---');
    console.log(`✓ Processed 200 voter requests in ${(durationMs / 1000).toFixed(2)} seconds!`);
    console.log(`✓ Total Voter DB Searches: ${searchCount} (Avg ${(durationMs / 200).toFixed(2)} ms/query)`);
    console.log(`✓ High-Res Voter Cards Rendered: ${cardGenCount}`);
    console.log(`✓ Errors: ${errorCount}`);
    console.log(`✓ Throughput: ${(200 / (durationMs / 1000)).toFixed(1)} requests/second`);

    if (durationMs < 180000) {
        console.log(`🏆 PASSED: System answered 200 voters in ${(durationMs / 1000).toFixed(2)}s (Target was under 180s/3 minutes)!`);
    } else {
        console.log('❌ FAILED: Exceeded 3 minutes.');
    }
}

benchmark().catch(console.error);
