const readline = require('readline');
const voterEngine = require('./voter_engine.js');
const aiService = require('./ai_assistant_service.js');

const NVIDIA_KEY = process.env.NVIDIA_API_KEY || '';

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

console.log('====================================================');
console.log('🏛️ SIHALI KHURD CAMPAIGN BOT - INTERACTIVE TESTBENCH');
console.log('====================================================');
console.log(`NVIDIA API Key: ${NVIDIA_KEY ? 'CONFIGURED (' + NVIDIA_KEY.slice(0, 10) + '...)' : 'NOT SET (Set NVIDIA_API_KEY env var for full LLM test)'}`);
console.log('Type your test message (e.g. "Ram Ram", "Satyanarayan Ward 1", "Kaam ki list batao", "Daru baat rahe hain"):');
console.log('Type "exit" to quit.\n');

async function handleMessage(input) {
    const text = input.trim();
    if (!text) return;
    if (text.toLowerCase() === 'exit') {
        rl.close();
        process.exit(0);
    }

    // Step 1: Check if input looks like a Name/EPIC query
    // An input is considered a voter query if it matches someone in the DB or specifically asks for parchi
    const matches = voterEngine.searchVoters(text);
    const asksParchi = text.toLowerCase().includes('parchi') || text.toLowerCase().includes('voter') || text.toLowerCase().includes('पर्ची');

    if (matches && matches.length > 0 && (asksParchi || matches[0].name_hi.length > 0)) {
        // High confidence voter match
        console.log('\n[ROUTER: Deterministic Database Voter Slip]');
        console.log(voterEngine.formatSlipResponse(matches[0]));
    } else {
        // Step 2: Route to AI Assistant with Grounded Knowledge Base
        console.log('\n[ROUTER: NVIDIA AI Assistant (Llama-3.3 70B)]');
        const reply = await aiService.getAIResponse(text, NVIDIA_KEY);
        console.log(reply);
    }
    console.log('\n----------------------------------------------------\n');
    promptUser();
}

function promptUser() {
    rl.question('You: ', handleMessage);
}

promptUser();
