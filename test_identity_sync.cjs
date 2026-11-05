// One identity across tabs: the same voter must show the same phone (91XXXXXXXXXX / intl digits, never a JID/@lid)
// and the same name in Live Chat, CRM, Contacts, Samasya, Mulaqat, Overview, Voter Plan and Scheduled Bulk APIs.
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const identity = require('./identity.js');
let passed = 0, failed = 0;
const check = (n, c, extra) => { if (c) { passed++; console.log('PASS ' + n); } else { failed++; console.error('FAIL ' + n + (extra ? ' ' + extra : '')); } };

// ---- unit: normalizer + name source of truth ----
const N = identity.normalizePhone;
check('10-digit -> 91XXXXXXXXXX', N('9876543210') === '919876543210');
check('+91 spaced -> 91XXXXXXXXXX', N('+91 98765 43210') === '919876543210');
check('0-prefixed -> 91XXXXXXXXXX', N('09876543210') === '919876543210');
check('JID with device -> number', N('916367810227:8@s.whatsapp.net') === '916367810227');
check('@lid is not a phone', N('15746155425964:8@lid') === '');
check('+1 Canada stays international', N('+1 (450) 279-0497') === '14502790497');
const users = { '919876543210': { phone: '919876543210', name: 'ग्रामवासी', pushName: 'RK', memory: { name: 'राम कुमार' } }, '919811111111': { phone: '919811111111', pushName: 'Sunil' } };
const contacts = { '919811111111': { phone: '919811111111', name: 'सुनील जाट' }, '919876543210': { phone: '919876543210', name: 'ग्रामवासी' } };
const r = identity.makeResolver({ userMemory: { users }, contactsManager: { findByPhone: p => contacts[N(p)] || null } });
check('placeholder contact name loses to voter-memory name', r.nameFor('9876543210') === 'राम कुमार');
check('operator contact name wins', r.nameFor('+91 98111 11111') === 'सुनील जाट');
const h = r.harmonize({ rows: [{ phone: '9811111111', name: 'Sunil' }, { phone: '919811111111@s.whatsapp.net', name: '' }], feed: [{ phone: '919876543210' }] }, { addName: true });
check('harmonize rewrites phone + name everywhere', h.rows.every(x => x.phone === '919811111111' && x.name === 'सुनील जाट') && h.feed[0].name === 'राम कुमार');

// ---- integration: every tab API on a real server ----
(async () => {
    const port = 35000 + Math.floor(Math.random() * 500);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'idsync_'));
    const proc = spawn(process.execPath, ['server.js'], { cwd: __dirname, stdio: 'ignore', env: { ...process.env, DASHBOARD_ONLY: 'true', PORT: String(port), CAMPAIGN_PIN: '2026',
        BROADCAST_STATE_PATH: path.join(tmp, 'bc.json'), CONTACTS_DB_PATH: path.join(tmp, 'contacts.json'), CAMPAIGN_AGENDA_PATH: path.join(tmp, 'agenda.json'),
        SAMASYA_PATH: path.join(tmp, 'samasya.json'), MULAQAT_PATH: path.join(tmp, 'mulaqat.json') } });
    const base = `http://127.0.0.1:${port}`;
    const H = { 'x-campaign-pin': '2026', 'content-type': 'application/json' };
    try {
        let up = false;
        for (let i = 0; i < 300 && !up; i++) { try { up = (await fetch(base + '/health')).ok; } catch (e) { await new Promise(r => setTimeout(r, 100)); } }
        check('server up', up);
        // a voter that exists in user memory gets an operator-saved name in Contacts with a messy phone format
        const allUsers = await (await fetch(base + '/api/voters', { headers: H })).json();
        const anyUser = (Array.isArray(allUsers) ? allUsers : []).find(u => /^91[6-9]\d{9}$/.test(String(u.phone || '')));
        const testPhone = anyUser ? anyUser.phone : '919876500011';
        const raw = '+91 ' + testPhone.slice(2, 7) + ' ' + testPhone.slice(7);
        await fetch(base + '/api/contacts/add', { method: 'POST', headers: H, body: JSON.stringify({ phone: raw, name: 'पहचान टेस्ट नाम', ward: 3, line: 'sim_636' }) });
        const routes = ['messages', 'voters', 'contacts', 'samasya', 'mulaqat', 'voter-plan?includeTest=1', 'overview', 'scheduled'];
        const seen = {}; const bad = [];
        const walk = (o, route) => {
            if (!o || typeof o !== 'object') return;
            if (Array.isArray(o)) return o.forEach(x => walk(x, route));
            if (o.phone !== undefined) {
                const p = String(o.phone);
                if (!/^\d+$/.test(p) || (p.length >= 10 && !identity.normalizePhone(p))) bad.push(route + ':' + p);
                if (o.name !== undefined) (seen[p] = seen[p] || new Set()).add(route + '=' + o.name);
            }
            Object.values(o).forEach(v => walk(v, route));
        };
        for (const rt of routes) {
            const res = await fetch(base + '/api/' + rt, { headers: H });
            check('GET /api/' + rt + ' ok', res.ok, String(res.status));
            if (res.ok) walk(await res.json(), rt.split('?')[0]);
        }
        check('every phone in every tab API is one normalized format (no JID/@lid/+/spaces)', bad.length === 0, bad.slice(0, 5).join(', '));
        const conflicts = Object.entries(seen).filter(([, s]) => new Set([...s].map(x => x.split('=').slice(1).join('='))).size > 1);
        check('same phone -> same name in every tab API', conflicts.length === 0, JSON.stringify(conflicts.slice(0, 3).map(([p, s]) => [p, [...s]])));
        const names = [...(seen[testPhone] || [])];
        check('operator-saved contact name shows in Contacts' + (anyUser ? ' and CRM' : ''), names.some(x => x.startsWith('contacts=पहचान टेस्ट नाम')) && (!anyUser || names.some(x => x.startsWith('voters=पहचान टेस्ट नाम'))), JSON.stringify(names));
        const feed = await (await fetch(base + '/api/messages', { headers: H })).json();
        check('Live Chat feed rows carry the canonical name field', !Array.isArray(feed) || !feed.length || feed.every(m => 'name' in m || !m.phone));
    } finally {
        proc.kill('SIGTERM');
        fs.rmSync(tmp, { recursive: true, force: true });
    }
    console.log(`\nRESULT ${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
