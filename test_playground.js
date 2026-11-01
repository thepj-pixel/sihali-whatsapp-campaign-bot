/**
 * 🎮 BABA ABHAY SINGH CAMPAIGN BOT — LIVE PLAYGROUND
 * Usage:
 *   node test_playground.js                     (Runs default test suite on full cascade)
 *   node test_playground.js --model=nvidia       (Tests NVIDIA directly)
 *   node test_playground.js --model=groq         (Tests Groq directly)
 *   node test_playground.js --model=gemini       (Tests Gemini directly)
 *   node test_playground.js "Aapka custom sawal yahan"
 */

const fs = require('fs');
const path = require('path');
const aiService = require('./ai_assistant_service.js');

const config = aiService.CONFIG;

async function testSingleModel(provider, query) {
    const t0 = Date.now();
    console.log(`\n======================================================`);
    console.log(`🔍 [PROVIDER: ${provider.toUpperCase()}]`);
    console.log(`👤 VOTER: "${query}"`);
    console.log(`======================================================`);

    const messages = [
        { role: 'system', content: aiService.SYSTEM_PROMPT },
        { role: 'user', content: query }
    ];

    try {
        let reply = '';
        if (provider === 'nvidia') {
            const res = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${config.nvidia_keys[0]}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: 'nvidia/nemotron-3.5-bolt-e4b',
                    messages: messages,
                    max_tokens: 250,
                    temperature: 0.6
                })
            });
            const data = await res.json();
            reply = data.choices?.[0]?.message?.content || data.choices?.[0]?.message?.reasoning || JSON.stringify(data);
        } else if (provider === 'groq') {
            const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${config.groq_api_key}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: 'qwen/qwen3.8-27b',
                    messages: messages,
                    max_tokens: 250,
                    temperature: 0.6
                })
            });
            const data = await res.json();
            reply = data.choices?.[0]?.message?.content || data.choices?.[0]?.message?.reasoning || JSON.stringify(data);
        } else if (provider === 'gemini') {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${config.gemini_api_key}`;
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    system_instruction: { parts: [{ text: aiService.SYSTEM_PROMPT }] },
                    contents: [{ role: 'user', parts: [{ text: query }] }],
                    generationConfig: { maxOutputTokens: 250, temperature: 0.6 }
                })
            });
            const data = await res.json();
            reply = data.candidates?.[0]?.content?.parts?.[0]?.text;
        } else {
            // Full Cascade
            reply = await aiService.getAIResponse(query);
        }

        const ms = Date.now() - t0;
        console.log(`⚡ Latency: ${ms}ms`);
        console.log(`🤖 SUMAN:\n${reply?.trim()}`);
    } catch (e) {
        console.error(`❌ Error with ${provider}:`, e.message);
    }
}

async function main() {
    const args = process.argv.slice(2);
    let targetModel = 'cascade';
    let customQuery = null;

    for (const arg of args) {
        if (arg.startsWith('--model=')) {
            targetModel = arg.split('=')[1].toLowerCase();
        } else if (!arg.startsWith('--')) {
            customQuery = arg;
        }
    }

    const testQueries = customQuery ? [customQuery] : [
        "Ram Ram Suman! Baba Abhay Singh ne kya kaam karwaya h pichle 5 saal me?",
        "koi kaam nhi hua faltu bkwas h sab chor h mc",
        "agar Baba Abhay Singh jeet gaye to aage kya karwayenge?",
        "Election kab h aur mera booth kaunsa padega?"
    ];

    console.log(`🚀 Starting Playground [Mode: ${targetModel.toUpperCase()}]`);

    for (const q of testQueries) {
        if (targetModel === 'all') {
            await testSingleModel('nvidia', q);
            await testSingleModel('groq', q);
            await testSingleModel('gemini', q);
        } else {
            await testSingleModel(targetModel, q);
        }
    }
}

main();
