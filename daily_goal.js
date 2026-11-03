const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'campaign_runtime.json');
const DEFAULT_GOAL = {
    date: new Date().toISOString().slice(0, 10),
    targetType: 'voter_help',
    title: 'आज का मतदाता सहायता लक्ष्य',
    instruction: 'सहमति देने वाले लोगों को मतदाता पर्ची, कार्यक्रम और पंचायत जानकारी उपलब्ध कराना।',
    targetContacts: 400,
    completedContacts: 0
};

function load() {
    try {
        if (fs.existsSync(FILE)) return { ...DEFAULT_GOAL, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
    } catch (error) {
        console.warn('[DailyGoal] Could not load runtime goal:', error.message);
    }
    return { ...DEFAULT_GOAL };
}

let goal = load();

function get() {
    return { ...goal };
}

function update(changes = {}) {
    const allowed = ['date', 'targetType', 'title', 'instruction', 'targetContacts', 'completedContacts'];
    for (const key of allowed) {
        if (changes[key] !== undefined) goal[key] = changes[key];
    }
    goal.targetContacts = Math.max(0, Number(goal.targetContacts) || 0);
    goal.completedContacts = Math.max(0, Number(goal.completedContacts) || 0);
    fs.writeFileSync(FILE, JSON.stringify(goal, null, 2), 'utf8');
    return get();
}

module.exports = { get, update, FILE };
