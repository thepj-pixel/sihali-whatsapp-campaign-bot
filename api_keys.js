/**
 * Central API key loader — NO keys are hardcoded in source.
 *
 * Sources (all optional):
 *   1. Process environment (pm2 ecosystem, shell export, Render/Docker env)
 *   2. A local `.env` file next to this file (gitignored) — only fills vars NOT already set
 *   3. `api_config.json` next to this file (gitignored) — the format the VM already uses
 *
 * Precedence (kept identical to the pre-refactor behaviour):
 *   - NVIDIA: env NVIDIA_API_KEY first, then env NVIDIA_API_KEYS (comma separated),
 *     then api_config.json "nvidia_keys". Deduplicated, order preserved.
 *     The AI cascade tries nvidia_keys[0] -> nvidia_keys[1] -> Groq -> Gemini -> local engine.
 *   - Groq / Gemini: api_config.json value wins if present, else env GROQ_API_KEY / GEMINI_API_KEY
 *     (this is how the old `{ ...defaults, ...fileConfig }` merge behaved).
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;

function loadDotEnv(file = path.join(ROOT, '.env')) {
    try {
        if (!fs.existsSync(file)) return;
        const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
        for (const line of lines) {
            const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
            if (!m) continue;
            let val = m[2];
            if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
                val = val.slice(1, -1);
            }
            if (process.env[m[1]] === undefined) process.env[m[1]] = val;
        }
    } catch (e) {
        console.warn('[api_keys] Could not read .env:', e.message);
    }
}

function splitKeys(v) {
    if (!v) return [];
    return String(v).split(',').map(s => s.trim()).filter(Boolean);
}

function loadApiConfig(opts = {}) {
    const env = opts.env || process.env;
    const configPath = opts.configPath || path.join(ROOT, 'api_config.json');

    let fileConfig = {};
    try {
        if (fs.existsSync(configPath)) {
            fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8')) || {};
        }
    } catch (e) {
        console.warn('[api_keys] Could not read api_config.json:', e.message);
    }

    const fileNvidia = Array.isArray(fileConfig.nvidia_keys)
        ? fileConfig.nvidia_keys
        : splitKeys(fileConfig.nvidia_keys);

    const nvidia = [];
    for (const k of [...splitKeys(env.NVIDIA_API_KEY), ...splitKeys(env.NVIDIA_API_KEYS), ...fileNvidia]) {
        if (k && !nvidia.includes(k)) nvidia.push(k);
    }

    return {
        ...fileConfig,
        nvidia_keys: nvidia,
        groq_api_key: fileConfig.groq_api_key || env.GROQ_API_KEY || '',
        gemini_api_key: fileConfig.gemini_api_key || fileConfig.geminiApiKey || env.GEMINI_API_KEY || ''
    };
}

loadDotEnv();

module.exports = { loadApiConfig, loadDotEnv, splitKeys };
