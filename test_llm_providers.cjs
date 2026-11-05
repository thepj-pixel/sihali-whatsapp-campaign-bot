// LLM provider cascade with a mocked fetch: Groq gpt-oss-20b + several keys (429/5xx -> next key),
// Gemini via x-goog-api-key header, 2.5-flash -> flash-latest, one 503 retry. No network, no key values logged.
process.env.NVIDIA_API_KEY = ''; process.env.NVIDIA_API_KEYS = '';
process.env.GROQ_API_KEY = ''; process.env.GROQ_API_KEYS = ''; process.env.GEMINI_API_KEY = '';
const assert = require('assert');
const ai = require('./ai_assistant_service.js');
const { loadApiConfig } = require('./api_keys.js');
let calls = [];
let plan = () => ({ status: 200, body: {} });
global.fetch = async (url, opts) => {
    const c = { url: String(url), headers: opts.headers || {}, body: JSON.parse(opts.body || '{}') };
    calls.push(c);
    const r = plan(c, calls.length);
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
};
const groqOk = t => ({ status: 200, body: { choices: [{ message: { content: t } }] } });
const gemOk = t => ({ status: 200, body: { candidates: [{ content: { parts: [{ text: t }] } }] } });
let pass = 0;
const t = async (name, fn) => { calls = []; await fn(); pass++; console.log('ok -', name); };

(async () => {
    // config loader
    const fs = require('fs'); const os = require('os'); const path = require('path');
    const tmp = path.join(os.tmpdir(), 'llmcfg_' + process.pid + '.json');
    fs.writeFileSync(tmp, JSON.stringify({ groq_api_keys: ['gA', 'gB'], groq_api_key: 'gLegacy' }));
    const cfg = loadApiConfig({ env: {}, configPath: tmp });
    assert.deepStrictEqual(cfg.groq_api_keys, ['gA', 'gB', 'gLegacy']);
    fs.writeFileSync(tmp, JSON.stringify({ groq_api_key: 'only' }));
    assert.deepStrictEqual(loadApiConfig({ env: {}, configPath: tmp }).groq_api_keys, ['only']);
    fs.unlinkSync(tmp); pass++; console.log('ok - groq_api_keys + legacy groq_api_key merge');

    ai.CONFIG.nvidia_keys = []; ai.CONFIG.groq_api_keys = ['K1', 'K2', 'K3']; ai.CONFIG.groq_api_key = ''; ai.CONFIG.gemini_api_key = 'AQ.testkey';

    await t('groq model gpt-oss-20b, reasoning low, max_tokens ~700', async () => {
        plan = () => groqOk('राम राम जी');
        const r = await ai.callLLMCascade('sys', [], 'hi');
        assert.strictEqual(r, 'राम राम जी');
        assert.strictEqual(calls[0].body.model, 'openai/gpt-oss-20b');
        assert.strictEqual(calls[0].body.reasoning_effort, 'low');
        assert.ok(calls[0].body.max_tokens >= 600 && calls[0].body.max_tokens <= 800);
        assert.ok(!/llama|qwen/.test(JSON.stringify(calls[0].body)));
    });
    await t('groq 429 -> next key, 503 -> next key', async () => {
        plan = (c) => c.headers.Authorization === 'Bearer K1' ? { status: 429, body: {} } : c.headers.Authorization === 'Bearer K2' ? { status: 503, body: {} } : groqOk('तीसरी चाबी');
        const r = await ai.callLLMCascade('sys', [], 'hi');
        assert.strictEqual(r, 'तीसरी चाबी');
        assert.deepStrictEqual(calls.map(c => c.headers.Authorization), ['Bearer K1', 'Bearer K2', 'Bearer K3']);
    });
    await t('groq 401 does not burn other keys; falls to gemini', async () => {
        plan = (c) => c.url.includes('groq') ? { status: 401, body: {} } : gemOk('जेमिनी');
        const r = await ai.callLLMCascade('sys', [], 'hi');
        assert.strictEqual(r, 'जेमिनी');
        assert.strictEqual(calls.filter(c => c.url.includes('groq')).length, 1);
    });
    await t('gemini: header key (AQ. format), not query string; 2.5-flash first', async () => {
        plan = (c) => c.url.includes('groq') ? { status: 500, body: {} } : gemOk('ठीक');
        const r = await ai.callLLMCascade('sys', [{ role: 'assistant', content: 'a' }], 'hi');
        assert.strictEqual(r, 'ठीक');
        const g = calls.filter(c => c.url.includes('generativelanguage'));
        assert.strictEqual(g.length, 1);
        assert.ok(g[0].url.includes('/models/gemini-2.5-flash:generateContent'));
        assert.ok(!g[0].url.includes('key='));
        assert.strictEqual(g[0].headers['x-goog-api-key'], 'AQ.testkey');
        assert.strictEqual(g[0].body.contents[0].role, 'model');
    });
    await t('gemini 503 retried once, then flash-latest', async () => {
        plan = (c) => c.url.includes('groq') ? { status: 503, body: {} } : c.url.includes('gemini-2.5-flash') ? { status: 503, body: {} } : gemOk('लेटेस्ट');
        const r = await ai.callLLMCascade('sys', [], 'hi', null, 9000);
        assert.strictEqual(r, 'लेटेस्ट');
        const g = calls.filter(c => c.url.includes('generativelanguage')).map(c => c.url.match(/models\/([^:]+)/)[1]);
        assert.deepStrictEqual(g, ['gemini-2.5-flash', 'gemini-2.5-flash', 'gemini-flash-latest']);
    });
    await t('cascade order nvidia1 -> nvidia2 -> groq -> gemini', async () => {
        ai.CONFIG.nvidia_keys = ['N1', 'N2'];
        plan = (c) => c.url.includes('nvidia') ? { status: 500, body: {} } : c.url.includes('groq') ? { status: 429, body: {} } : gemOk('अंत');
        const r = await ai.callLLMCascade('sys', [], 'hi');
        assert.strictEqual(r, 'अंत');
        const seq = calls.map(c => c.url.includes('nvidia') ? 'nv' : c.url.includes('groq') ? 'gq' : 'gm');
        assert.deepStrictEqual(seq, ['nv', 'nv', 'gq', 'gq', 'gq', 'gm']);
        ai.CONFIG.nvidia_keys = [];
    });
    await t('ai-status counts + probe tests each groq key, never shows key values', async () => {
        const st = ai.aiStatus();
        assert.strictEqual(st.providers.groq, 3);
        assert.strictEqual(st.providers.gemini, 1);
        plan = (c) => c.url.includes('groq') ? (c.headers.Authorization === 'Bearer K2' ? { status: 429, body: {} } : groqOk('ok')) : gemOk('ok');
        const p = await ai.probeProviders();
        assert.strictEqual(p.groq.count, 3); assert.strictEqual(p.groq.okCount, 2); assert.strictEqual(p.groq.ok, true);
        assert.strictEqual(p.gemini.ok, true);
        const dump = JSON.stringify({ st, p });
        assert.ok(!/K1|K2|K3|AQ\.testkey/.test(dump.replace(/"key":\d/g, '')));
    });
    console.log(`\n${pass} passed`);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
