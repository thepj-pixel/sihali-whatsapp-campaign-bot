const fs = require('fs');
const path = require('path');

const FILE = process.env.CAMPAIGN_PROFILE_PATH || path.join(__dirname, 'campaign_profile.json');
const DEFAULTS = {
    verifiedFacts: [],
    talkingStyle: 'Natural, respectful village conversation. Reply directly and briefly. Never invent a fact.',
    updatedAt: null,
    updatedBy: 'dashboard'
};

function load() {
    try {
        const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
        return { ...DEFAULTS, ...parsed };
    } catch (error) {
        return { ...DEFAULTS };
    }
}

function normalizeFacts(input) {
    const values = Array.isArray(input) ? input : String(input || '').split(/\r?\n/);
    return values.map(value => String(value).trim()).filter(Boolean).slice(0, 200);
}

function update(changes = {}) {
    const current = load();
    const next = {
        ...current,
        verifiedFacts: changes.verifiedFacts === undefined ? current.verifiedFacts : normalizeFacts(changes.verifiedFacts),
        talkingStyle: changes.talkingStyle === undefined ? current.talkingStyle : String(changes.talkingStyle || '').trim().slice(0, 4000),
        updatedAt: new Date().toISOString(),
        updatedBy: 'dashboard'
    };
    fs.writeFileSync(FILE, JSON.stringify(next, null, 2) + '\n', 'utf8');
    return next;
}

function getPrompt() {
    const profile = load();
    const facts = profile.verifiedFacts.length
        ? profile.verifiedFacts.map((fact, index) => `${index + 1}. ${fact}`).join('\n')
        : 'No dashboard facts have been added yet. Use only the locked knowledge base and say when something needs verification.';
    return `[LIVE VERIFIED FACTS - highest priority; do not add unsupported details]\n${facts}\n\n[TALKING STYLE]\n${profile.talkingStyle}`;
}

function parseImportedFile(content, fileName = '') {
    const text = String(content || '').replace(/^\uFEFF/, '').trim();
    if (!text) return { verifiedFacts: [], talkingStyle: '' };

    if (String(fileName).toLowerCase().endsWith('.json') || text.startsWith('{') || text.startsWith('[')) {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) return { verifiedFacts: normalizeFacts(parsed), talkingStyle: '' };
        return {
            verifiedFacts: normalizeFacts(parsed.verifiedFacts || parsed.facts || parsed.items || []),
            talkingStyle: String(parsed.talkingStyle || parsed.style || '').trim()
        };
    }

    const facts = text.split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'))
        .map(line => line.replace(/^[-*•\d.)\s]+/, '').trim())
        .filter(Boolean);
    return { verifiedFacts: normalizeFacts(facts), talkingStyle: '' };
}

function importFile(content, fileName = '', mode = 'replace') {
    const parsed = parseImportedFile(content, fileName);
    const current = load();
    const facts = mode === 'append'
        ? Array.from(new Set([...current.verifiedFacts, ...parsed.verifiedFacts]))
        : parsed.verifiedFacts;
    return update({
        verifiedFacts: facts,
        talkingStyle: parsed.talkingStyle || current.talkingStyle
    });
}

module.exports = { FILE, load, update, getPrompt, normalizeFacts, parseImportedFile, importFile };
