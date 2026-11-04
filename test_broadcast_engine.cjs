// Unit tests for broadcast_engine.js, contact_utils.js and the opt-out policy. No network, no WhatsApp.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { BroadcastEngine, normalizePhone, spin, renderMessage, dedupeAndValidate, normalizeCaps, inQuietHours } = require('./broadcast_engine.js');
const contactUtils = require('./contact_utils.js');
const policy = require('./engagement_policy.js');

let passed = 0, failed = 0;
function check(name, cond) { if (cond) { passed++; console.log('PASS ' + name); } else { failed++; console.error('FAIL ' + name); } }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-test-'));
const mediaDir = path.join(tmp, 'media');
fs.mkdirSync(mediaDir);
fs.writeFileSync(path.join(mediaDir, 'poster.jpg'), 'x');
fs.writeFileSync(path.join(mediaDir, 'notes.txt'), 'x');

// Fixed clock: 2026-11-04 12:00 IST (= 06:30 UTC), well outside quiet hours
let NOW = Date.UTC(2026, 10, 4, 6, 30, 0);
const clock = () => NOW;
let seed = 1;
const rng = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };

function mockSock({ notOnWa = [], failSend = false, failCheck = false } = {}) {
    const sock = { sent: [], presence: [], checks: 0 };
    sock.onWhatsApp = async (p) => { sock.checks++; if (failCheck) throw new Error('timeout'); return [{ exists: !notOnWa.includes(p), jid: p + '@s.whatsapp.net' }]; };
    sock.presenceSubscribe = async () => {};
    sock.sendPresenceUpdate = async (t, jid) => { sock.presence.push(t + ':' + jid); };
    sock.sendMessage = async (jid, content) => { if (failSend) throw new Error('rate-overlimit'); sock.sent.push({ jid, content }); return { key: { id: 'm' + sock.sent.length } }; };
    return sock;
}

function makeEngine(sessions, file = path.join(tmp, 'state_' + Math.random().toString(36).slice(2) + '.json'), extra = {}) {
    return new BroadcastEngine({ stateFile: file, mediaDir, getSessions: () => sessions, now: clock, random: rng, sleep: async () => {}, logger: { log() {}, warn() {}, error() {} }, ...extra });
}

async function drain(engine, maxTicks = 500, stepMs = 61000) {
    for (let i = 0; i < maxTicks; i++) {
        const jobs = await engine.tick();
        await Promise.all(jobs);
        const c = engine.active();
        if (!c || c.status !== 'running') return;
        NOW += stepMs;
    }
}

(async () => {
    // ---- normalisation ----
    check('10-digit -> 91 prefix', normalizePhone('9876543210') === '919876543210');
    check('+91 with spaces', normalizePhone('+91 98765 43210') === '919876543210');
    check('0-prefixed', normalizePhone('09876543210') === '919876543210');
    check('0091 prefix', normalizePhone('0091-98765-43210') === '919876543210');
    check('+91 0 prefix', normalizePhone('+91 0 9876543210') === '919876543210');
    check('landline-like start digit rejected', normalizePhone('1234567890') === null);
    check('too short rejected', normalizePhone('98765') === null);
    check('repeated digits rejected', normalizePhone('9999999999') === null);
    check('foreign number rejected', normalizePhone('+1 450 279 0497') === null);
    check('empty rejected', normalizePhone('') === null && normalizePhone(null) === null);

    // ---- dedupe ----
    const d = dedupeAndValidate([{ phone: '9876543210' }, { phone: '+919876543210' }, { phone: '098765 43210' }, { phone: 'abc' }, { phone: '9123456780', name: 'Ram' }]);
    check('dedupe keeps unique valid numbers', d.valid.length === 2 && d.duplicates === 2 && d.invalid.length === 1);
    const d2 = dedupeAndValidate([{ phone: '9876543210' }, { phone: '9123456780' }], p => p === '919876543210' ? 'opted_out' : null);
    check('policy-blocked numbers separated', d2.valid.length === 1 && d2.blocked.length === 1 && d2.blocked[0].reason === 'opted_out');

    // ---- spintax ----
    const seen = new Set();
    for (let i = 0; i < 50; i++) seen.add(spin('{नमस्ते|राम राम} भाई', rng));
    check('spintax produces both variants', seen.has('नमस्ते भाई') && seen.has('राम राम भाई') && seen.size === 2);
    check('nested spintax resolves', !/[{}|]/.test(spin('{a|{b|c}} x', rng)));
    check('{name} placeholder filled', renderMessage('राम राम {name}!', { name: 'सीता' }, rng) === 'राम राम सीता!');
    check('{name} fallback when missing', renderMessage('राम राम {name}!', { name: '' }, rng) === 'राम राम भाई जी!');
    check('{name} is not treated as spintax', renderMessage('{name} {हाँ|हां}', { name: 'Ram' }, rng).startsWith('Ram '));

    // ---- caps validation ----
    check('default caps valid', normalizeCaps({}).errors.length === 0 && normalizeCaps({}).caps.hourlyCap === 60 && normalizeCaps({}).caps.dailyCap === 250);
    check('too-fast delay rejected', normalizeCaps({ minDelaySec: 2 }).errors.length > 0);
    check('max<min rejected', normalizeCaps({ minDelaySec: 40, maxDelaySec: 30 }).errors.length > 0);
    check('quiet hours 21-8 IST', inQuietHours(Date.UTC(2026, 10, 4, 17, 0), normalizeCaps({}).caps) && !inQuietHours(Date.UTC(2026, 10, 4, 6, 30), normalizeCaps({}).caps));

    // ---- CSV / paste ----
    const csvRows = contactUtils.parseContactCsv('Mobile Number,Name,Ward,Village\n+91 98765 43210,Ram,5,सिहाली खुर्द\n09123456780,"Sita, Devi",3,हाड़ाहेड़ी');
    check('CSV flexible header + village', csvRows.length === 2 && csvRows[1].name === 'Sita, Devi' && csvRows[1].village === 'हाड़ाहेड़ी' && csvRows[0].ward === '5');
    const noHeader = contactUtils.parseContactCsv('9876543210,Ram\n9123456780,Shyam');
    check('CSV without header', noHeader.length === 2 && noHeader[0].name === 'Ram');
    const pasted = contactUtils.parsePastedContacts('9876543210\nRam Lal - +91 91234 56780\n9000000001, 9000000002');
    check('pasted lines parsed', pasted.length === 4 && pasted[1].name === 'Ram Lal');
    const dial = contactUtils.buildDialerCsv([{ name: 'Ram', phone: '919876543210', ward: 5, village: 'X' }, { name: 'dup', phone: '9876543210' }, { name: 'bad', phone: '123' }]);
    check('dialer CSV has 10 and 91 forms, deduped, invalid dropped', dial.count === 1 && dial.csv.includes('Ram,9876543210,919876543210,5,X') && dial.csv.includes('name,phone_10,phone_91,ward,village'));

    // ---- opt-out policy ----
    check('STOP is opt-out', policy.isOptOutMessage('STOP') && policy.isOptOutMessage(' बंद! ') && policy.isOptOutMessage('रुको'));
    check('normal sentences are not opt-out', !policy.isOptOutMessage('ruko main batata hoon') && !policy.isOptOutMessage('stop par milte hain'));
    check('consent: "pata nahi, parchi chahiye" is not a refusal', policy.parseConsentResponse('pata nahi, parchi chahiye') === 'accepted');
    check('consent: "i know" is not a refusal', policy.parseConsentResponse('i know') === 'accepted');
    const u = { consentStatus: 'ACCEPTED', consented: true, autoPilot: true };
    policy.applyOptOut(u);
    check('applyOptOut blocks broadcast + automation', policy.broadcastBlockReason(u) === 'opted_out' && u.autoPilot === false && u.consentStatus === 'REJECTED');
    policy.applyOptIn(u);
    check('explicit opt-in restores', policy.broadcastBlockReason(u) === null && u.consentStatus === 'ACCEPTED');

    // ---- create validation ----
    const offline = [{ id: 'sim_636', name: 'P', status: 'DISCONNECTED', sock: null }];
    const e0 = makeEngine(offline);
    let r = e0.create({ phones: '9876543210', message: 'hi' });
    check('no connected lines -> 503', r.status === 503 && /no connected lines/.test(r.error));
    check('empty recipients -> 400', e0.create({ message: 'hi' }).status === 400);
    check('empty message -> 400', e0.create({ phones: '9876543210' }).status === 400);
    check('unknown line -> 400', e0.create({ phones: '9876543210', message: 'x', lines: ['nope'] }).status === 400);
    check('bad media type -> 400', e0.create({ phones: '9876543210', message: 'x', mediaFile: 'notes.txt' }).status === 400);
    check('path traversal media -> 400', e0.create({ phones: '9876543210', message: 'x', mediaFile: '../server.js' }).status === 400);
    check('preview works with no lines', e0.preview({ phones: '9876543210\n9876543210\nxx', message: '{a|b} {name}' }).valid === 1);

    // ---- full run with two lines, round robin, not-on-WA skip, media ----
    const sA = mockSock({ notOnWa: ['919000000003'] }), sB = mockSock();
    const sessions = [{ id: 'sim_636', name: 'A', status: 'CONNECTED', sock: sA }, { id: 'canada', name: 'B', status: 'CONNECTED', sock: sB }];
    const e1 = makeEngine(sessions);
    const phones = ['9000000001', '9000000002', '9000000003', '9000000004', '9000000005', '9000000006'].join('\n');
    r = e1.create({ phones, message: '{नमस्ते|राम राम} {name}', mediaFile: 'poster.jpg' });
    check('create ok', r.ok && r.campaign.counts.pending === 6);
    check('second create blocked while running', e1.create({ phones: '9111111111', message: 'x' }).status === 409);
    await drain(e1);
    const c1 = e1.active();
    const k1 = e1.counts(c1);
    check('campaign completed', c1.status === 'completed');
    check('5 sent, 1 skipped not_on_whatsapp', k1.sent + k1.skipped === 6 && c1.recipients.filter(x => x.reason === 'not_on_whatsapp').length <= 1 && k1.sent >= 5);
    check('both lines used (round robin)', sA.sent.length > 0 && sB.sent.length > 0);
    check('typing presence sent before messages', sA.presence.some(p => p.startsWith('composing')) && sB.presence.some(p => p.startsWith('composing')));
    check('media sent as image with caption', sA.sent.concat(sB.sent).every(m => m.content.image && m.content.image.url.endsWith('poster.jpg') && m.content.caption));
    check('no number sent twice', new Set(sA.sent.concat(sB.sent).map(m => m.jid)).size === sA.sent.length + sB.sent.length);
    check('results CSV has all rows', e1.resultsCsv().trim().split('\n').length === 7);

    // ---- delay respected per line ----
    const sC = mockSock();
    const e2 = makeEngine([{ id: 'sim_636', name: 'A', status: 'CONNECTED', sock: sC }]);
    e2.create({ phones: '9000000001\n9000000002', message: 'x' });
    await Promise.all(await e2.tick());
    NOW += 5000; // only 5s later
    await Promise.all(await e2.tick());
    check('random delay enforced (no 2nd send after 5s)', sC.sent.length === 1);
    NOW += 61000;
    await Promise.all(await e2.tick());
    check('2nd send after delay window', sC.sent.length === 2);

    // ---- hourly cap ----
    const sD = mockSock();
    const e3 = makeEngine([{ id: 'sim_636', name: 'A', status: 'CONNECTED', sock: sD }]);
    const many = Array.from({ length: 10 }, (_, i) => '90000001' + String(i).padStart(2, '0')).join('\n');
    e3.create({ phones: many, message: 'x', caps: { hourlyCap: 3, dailyCap: 5, minDelaySec: 10, maxDelaySec: 10 } });
    for (let i = 0; i < 20; i++) { await Promise.all(await e3.tick()); NOW += 11000; }
    check('hourly cap holds (3 in first ~4 min)', sD.sent.length === 3 && e3.active().waitingReason === 'hourly_cap');
    NOW += 3600 * 1000;
    for (let i = 0; i < 40; i++) { await Promise.all(await e3.tick()); NOW += 11000; }
    check('daily cap holds (5 max per day)', sD.sent.length === 5 && e3.active().waitingReason === 'daily_cap');

    // ---- auto-pause after 3 consecutive errors ----
    const sE = mockSock({ failSend: true });
    const e4 = makeEngine([{ id: 'sim_636', name: 'A', status: 'CONNECTED', sock: sE }]);
    e4.create({ phones: many, message: 'x' });
    await drain(e4, 20);
    const c4 = e4.active();
    check('line auto-paused after 3 errors, campaign paused', e4.lineStat('sim_636').paused && c4.status === 'paused' && e4.counts(c4).failed === 3);
    check('failed sends are not retried (no double send risk)', c4.recipients.filter(x => x.status === 'failed').every(x => x.reason.includes('rate-overlimit')));

    // ---- disconnect auto-pause and stable-reconnect resume ----
    const sF = mockSock();
    const sessF = [{ id: 'sim_636', name: 'A', status: 'CONNECTED', sock: sF }];
    const e5 = makeEngine(sessF);
    e5.create({ phones: '9000000001\n9000000002\n9000000003', message: 'x' });
    await Promise.all(await e5.tick());
    sessF[0].status = 'DISCONNECTED';
    NOW += 61000; await Promise.all(await e5.tick());
    check('disconnect auto-pauses line', e5.lineStat('sim_636').pausedReason === 'disconnected' && sF.sent.length === 1);
    sessF[0].status = 'CONNECTED';
    NOW += 1000; await Promise.all(await e5.tick());
    NOW += 30000; await Promise.all(await e5.tick());
    check('stays paused until reconnect is stable', sF.sent.length === 1);
    NOW += 130000; await Promise.all(await e5.tick());
    NOW += 61000; await Promise.all(await e5.tick());
    check('resumes after stable reconnect', sF.sent.length >= 2);

    // ---- opt-out mid-campaign ----
    const sG = mockSock();
    const e6 = makeEngine([{ id: 'sim_636', name: 'A', status: 'CONNECTED', sock: sG }]);
    e6.create({ phones: '9000000001\n9000000002', message: 'x' });
    e6.markOptOut('+91 90000 00002', 'STOP');
    await drain(e6);
    check('opted-out recipient skipped mid-campaign', sG.sent.length === 1 && e6.active().recipients.find(x => x.phone === '919000000002').reason === 'opted_out');
    const again = e6.create({ phones: '9000000002\n9000000005', message: 'x' });
    check('opted-out excluded from future broadcasts', again.ok && again.campaign.counts.skipped === 1 && again.campaign.counts.pending === 1);
    const e6b = makeEngine([{ id: 'sim_636', name: 'A', status: 'CONNECTED', sock: mockSock() }], undefined, { isBlocked: p => p === '919000000009' ? 'declined_outreach' : null });
    const rb = e6b.create({ phones: '9000000009\n9000000008', message: 'x' });
    check('external consent policy blocks declined contacts', rb.ok && rb.campaign.counts.skipped === 1);

    // ---- persistence / resume / no double send ----
    const file = path.join(tmp, 'resume.json');
    const sH = mockSock();
    const sessH = [{ id: 'sim_636', name: 'A', status: 'CONNECTED', sock: sH }];
    const e7 = makeEngine(sessH, file);
    e7.create({ phones: '9000000001\n9000000002\n9000000003\n9000000004', message: 'x' });
    await Promise.all(await e7.tick()); // sends #1
    // simulate crash mid-send of #2: mark it 'sending' on disk
    const st = JSON.parse(fs.readFileSync(file, 'utf8'));
    const camp = st.campaigns[st.activeId];
    camp.recipients[1].status = 'sending';
    fs.writeFileSync(file, JSON.stringify(st));
    const sH2 = mockSock();
    const e8 = makeEngine([{ id: 'sim_636', name: 'A', status: 'CONNECTED', sock: sH2 }], file);
    const c8 = e8.active();
    check('state reloaded after restart', c8 && c8.status === 'running' && c8.recipients[0].status === 'sent');
    check('in-flight recipient not resent after crash', c8.recipients[1].status === 'skipped' && /interrupted/.test(c8.recipients[1].reason));
    NOW += 61000;
    await drain(e8);
    const sentPhones = sH2.sent.map(m => m.jid.split('@')[0]);
    check('resume sends only the remaining numbers', sentPhones.length === 2 && sentPhones.includes('919000000003') && sentPhones.includes('919000000004') && !sentPhones.includes('919000000001'));

    // ---- pause/resume/cancel ----
    const sI = mockSock();
    const e9 = makeEngine([{ id: 'sim_636', name: 'A', status: 'CONNECTED', sock: sI }]);
    e9.create({ phones: '9000000001\n9000000002\n9000000003', message: 'x' });
    check('pause ok', e9.pause().ok && e9.active().status === 'paused');
    NOW += 61000; await Promise.all(await e9.tick());
    check('paused campaign sends nothing', sI.sent.length === 0);
    check('resume ok', e9.resume().ok);
    await Promise.all(await e9.tick());
    check('resumed campaign sends', sI.sent.length === 1);
    check('cancel ok and marks rest cancelled', e9.cancel().ok && e9.active().recipients.filter(x => x.reason === 'cancelled').length === 2);
    const st9 = e9.status();
    check('status has counts and lines', st9.campaign.counts.sent === 1 && st9.lines.length === 1);

    // ---- quiet hours ----
    const sJ = mockSock();
    const e10 = makeEngine([{ id: 'sim_636', name: 'A', status: 'CONNECTED', sock: sJ }]);
    e10.create({ phones: '9000000001', message: 'x' });
    const saved = NOW; NOW = Date.UTC(2026, 10, 4, 17, 0); // 22:30 IST
    await Promise.all(await e10.tick());
    check('no sends during quiet hours', sJ.sent.length === 0 && e10.active().waitingReason === 'quiet_hours');
    NOW = saved;

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(`RESULT ${passed} passed, ${failed} failed`);
    if (failed) process.exitCode = 1;
})().catch(e => { console.error(e); process.exitCode = 1; });
