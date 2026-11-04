// Starts the dashboard (DASHBOARD_ONLY), runs the new tab scripts against a tiny DOM stub and checks that
// clicking the Bulk Send / Goal tab buttons calls switchTab with the dataset tab id (no inline onclick quoting).
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const vm = require('vm');
let passed = 0, failed = 0;
const check = (n, c) => { if (c) { passed++; console.log('PASS ' + n); } else { failed++; console.error('FAIL ' + n); } };

function makeDom(html) {
    const els = new Map();
    const mk = (id) => {
        const listeners = {};
        const e = { id, dataset: {}, style: { display: 'none' }, value: '', checked: false, textContent: '', innerHTML: '', files: null,
            addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); },
            fire: (t, ev = {}) => (listeners[t] || []).forEach(f => f.call(e, { preventDefault() {}, target: e, ...ev })),
            appendChild() {}, contains: () => true, closest: () => null, click() { e.fire('click'); } };
        const m = html.match(new RegExp('id="' + id + '"[^>]*data-tab="([^"]+)"'));
        if (m) e.dataset.tab = m[1];
        return e;
    };
    const document = {
        readyState: 'complete',
        getElementById: (id) => { if (!html.includes('id="' + id + '"')) return null; if (!els.has(id)) els.set(id, mk(id)); return els.get(id); },
        querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, createElement: () => mk('x'), activeElement: null
    };
    return { document, els };
}

(async () => {
    const port = 33000 + Math.floor(Math.random() * 500);
    const tmp = os.tmpdir();
    const proc = spawn(process.execPath, ['server.js'], { cwd: __dirname, stdio: 'ignore', env: { ...process.env, DASHBOARD_ONLY: 'true', PORT: String(port), CAMPAIGN_PIN: '2026',
        BROADCAST_STATE_PATH: path.join(tmp, 'tabs_bc.json'), CONTACTS_DB_PATH: path.join(tmp, 'tabs_contacts.json'), CAMPAIGN_AGENDA_PATH: path.join(tmp, 'tabs_agenda.json') } });
    try {
        let html = '';
        for (let i = 0; i < 200 && !html; i++) {
            try { const r = await fetch(`http://127.0.0.1:${port}/?pin=2026`); if (r.ok) html = await r.text(); } catch (e) { await new Promise(r => setTimeout(r, 100)); }
        }
        check('dashboard served', html.length > 1000);
        const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
        check('all inline scripts parse', scripts.every(s => { try { new vm.Script(s); return true; } catch (e) { return false; } }));
        check('new tab buttons use data-tab, not inline onclick', /id="tab-btn-bulk"[^>]*data-tab="bulk"/.test(html) && !/id="tab-btn-bulk"[^>]*onclick/.test(html) && /id="tab-btn-goal"[^>]*data-tab="goal"/.test(html));
        const { document } = makeDom(html);
        const calls = [];
        const sandbox = { document, window: { confirm: () => true, location: {} }, fetch: async () => ({ json: async () => ({ lines: [], media: [], progress: { goal: {}, byLine: {}, byWard: {}, stageChanges: {} }, totals: {} }), status: 200 }),
            switchTab: (id) => calls.push(id), setInterval: () => 0, setTimeout: () => 0, clearTimeout() {}, FileReader: function () {}, Intl, console, encodeURIComponent, String, Array, Math, JSON, Object };
        vm.createContext(sandbox);
        for (const s of scripts.slice(1)) vm.runInContext(s, sandbox); // the two new IIFE scripts
        document.getElementById('tab-btn-bulk').click();
        document.getElementById('tab-btn-goal').click();
        check('Bulk Send tab click -> switchTab("bulk")', calls.includes('bulk'));
        check('Goal tab click -> switchTab("goal")', calls.includes('goal'));
    } finally {
        proc.kill();
    }
    console.log(`RESULT ${passed} passed, ${failed} failed`);
    if (failed) process.exitCode = 1;
})();
