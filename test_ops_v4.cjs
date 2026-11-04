/* OPS v4 unit tests: विरोधी gentle mode, per-line contact card, Overview, Scheduled bulk campaigns. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const userMemory = require('./user_memory.js');
userMemory.save = () => {};
const contactTags = require('./contact_tags.js');
const contactCard = require('./contact_card.js');
const overview = require('./overview.js');
const { ScheduledCampaigns, planTimes, rotation, parseIst, windowFromHours } = require('./scheduled_campaigns.js');
const { BroadcastEngine } = require('./broadcast_engine.js');

let passed = 0, failed = 0;
async function t(name, fn) {
    try { await fn(); passed++; console.log('  ✅ ' + name); }
    catch (e) { failed++; console.log('  ❌ ' + name + '\n     ' + (e && e.stack || e).split('\n').slice(0, 3).join('\n     ')); }
}
function seq(seed = 7) { let x = seed; return () => { x = (x * 16807) % 2147483647; return (x - 1) / 2147483646; }; }

(async () => {
    console.log('— विरोधी list + gentle mode');
    await t('addVirodhi parses pasted numbers, dedupes, flags memory', () => {
        const um = { users: { '919812345678': { phone: '919812345678', history: [] } }, save() {} };
        const r = contactTags.addVirodhi('98123 45678, रामलाल\n+91 9876500011\nabc\n9812345678', { userMemory: um, note: 'owner list' });
        assert.strictEqual(r.added.length, 2);
        assert.strictEqual(r.already.length, 1);
        assert.strictEqual(r.invalid.length, 1);
        assert.strictEqual(um.users['919812345678'].virodhi, true);
        assert.ok(contactTags.isVirodhi('9812345678'));
        assert.ok(contactTags.isVirodhi('+91 98765 00011'));
        assert.ok(!contactTags.isVirodhi('9000000001'));
        assert.ok(contactTags.isVirodhiUser({ phone: '919876500011' }));
    });
    await t('removeVirodhi clears list + memory flag', () => {
        const um = { users: { '919876500011': { phone: '919876500011', virodhi: true } }, save() {} };
        assert.ok(contactTags.removeVirodhi('9876500011', { userMemory: um }));
        assert.ok(!contactTags.isVirodhi('9876500011'));
        assert.strictEqual(um.users['919876500011'].virodhi, undefined);
    });
    await t('gentle() strips every vote ask and never returns empty', () => {
        const a = contactTags.gentle('जी, पानी की टंकी का काम हुआ है। 16 नवंबर को अभय सिंह जी का साथ देंगे ना?', 'hi');
        assert.ok(!contactTags.PUSH_RX.test(a), a);
        assert.ok(/पानी/.test(a));
        const b = contactTags.gentle('Is baar Abhay Singh ji ko aashirwad denge na?', 'en');
        assert.ok(b.length > 8 && !contactTags.PUSH_RX.test(b), b);
        const c = contactTags.gentle('Ghar ke kitne vote hain?', 'en');
        assert.ok(!contactTags.PUSH_RX.test(c), c);
    });
    await t('reply_brain: virodhi user never gets a vote ask (template path, 6 different messages)', () => {
        const brain = require('./reply_brain.js');
        const msgs = ['abhay singh ne kya kaam kiye?', 'ram ram', 'theek hai', 'hmm dekhenge', 'wo to chor hai', 'pani ki samasya hai ward 3 me'];
        for (const m of msgs) {
            const u = userMemory.getUser('919811100022');
            u.virodhi = true;
            const out = brain.respondSync(m, u);
            assert.ok(!contactTags.PUSH_RX.test(out), `"${m}" -> ${out}`);
            userMemory.recordMessage('919811100022', 'user', m);
            userMemory.recordMessage('919811100022', 'bot', out);
        }
    });
    await t('installGentleMode post-filters respond() (LLM rephrase can not add a vote ask)', async () => {
        const fake = { respond: async () => ({ text: 'Bilkul ji. 16 November ko vote denge na?' }), respondSync: () => 'Ji. Saath denge na?' };
        contactTags.installGentleMode(fake);
        const r = await fake.respond('x', { virodhi: true });
        assert.ok(!contactTags.PUSH_RX.test(r.text) && r.gentle);
        const r2 = await fake.respond('x', { virodhi: false });
        assert.ok(/vote denge/.test(r2.text));
        assert.ok(!contactTags.PUSH_RX.test(fake.respondSync('x', { virodhi: true })));
    });

    console.log('— contact card once per contact per line');
    await t('needsCard / markSent per line, legacy flag counts for assigned line', () => {
        const u = { consentStatus: 'ACCEPTED' };
        assert.ok(contactCard.needsCard(u, 'sim_636'));
        contactCard.markSent(u, 'sim_636');
        assert.ok(!contactCard.needsCard(u, 'sim_636'));
        assert.ok(contactCard.needsCard(u, 'canada'));
        assert.strictEqual(u.contactCardSent, true);
        const legacy = { contactCardSent: true, assignedLine: 'canada' };
        assert.ok(!contactCard.needsCard(legacy, 'canada'));
        assert.ok(contactCard.needsCard(legacy, 'sim_636'));
        assert.ok(!contactCard.needsCard({ broadcastOptOut: true }, 'sim_636'));
        assert.ok(!contactCard.needsCard({ consentStatus: 'REJECTED' }, 'sim_636'));
    });
    await t('server.js: card hook uses contact_card (per line) and single-send attaches it', () => {
        const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
        assert.ok(/contactCard\.needsCard\(u, sessionObj\.id\)/.test(src));
        assert.ok(/contactCardQueued/.test(src));
        assert.ok(!/u\.contactCardSent \|\| u\.broadcastOptOut/.test(src));
        assert.ok(/sendLineContactCardOnce\(sock, replyJid, senderPhone, sessionObj, \{ withPrompt: false \}\)/.test(src), 'card right after the first reply (intro)');
    });

    console.log('— Overview / निष्कर्ष');
    const now = Date.now();
    const H = (role, text, ago) => ({ role, text, createdAt: now - ago });
    const users = [
        { phone: '919800000001', name: 'रमेश', ward: 3, assignedLine: 'sim_636', persuasionStage: 'committed', memory: { name: 'रमेश', familyVotes: 4, concerns: [{ topic: 'water', text: 'paani' }], commitment: { status: 'committed' } }, persuasionHistory: [{ intent: 'commit' }, { intent: 'family_votes' }], history: [H('user', 'pakka vote denge, ghar ke 4 vote', 1000), H('bot', 'धन्यवाद', 900)] },
        { phone: '919800000002', persuasionStage: 'undecided', history: [H('user', 'soch ke batayenge', 5000)] },
        { phone: '919800000003', persuasionStage: 'undecided', persuasionHistory: [{ intent: 'abuse' }], history: [H('user', 'tum sab chor ho', 3000)] },
        { phone: '919800000004', persuasionStage: 'leaning', history: [H('user', 'achha aadmi hai', 2000)] },
        { phone: '919800000005', virodhi: true, persuasionStage: 'unknown', history: [H('user', 'ram ram', 2500)] },
        { phone: '919800000006', persuasionStage: 'opposed', history: [H('user', 'nahi denge', 2600)] },
        { phone: '914500000000', selfTest: 'st_1', history: [H('user', 'test', 10)] },
        { phone: '919800000007', history: [] }
    ];
    const samasya = [{ id: 'S1', phone: '919800000002', category: 'road', status: 'new' }, { id: 'S2', phone: '919800000001', category: 'water', status: 'in-progress' }];
    const mulaqat = [{ id: 'M1', phone: '919800000001', name: 'रमेश', status: 'requested', preferredWhen: 'रविवार शाम 5 बजे', place: 'मंदिर के पास', ward: 3 }];
    await t('stances, totals, samasya by category, mulaqat with when/place', () => {
        const o = overview.build({ users, samasya, mulaqat });
        const by = Object.fromEntries(o.rows.map(r => [r.phone, r]));
        assert.strictEqual(o.totals.conversations, 6);
        assert.strictEqual(by['919800000001'].stance, 'commit');
        assert.strictEqual(by['919800000002'].stance, 'सोच रहे');
        assert.strictEqual(by['919800000003'].stance, 'नाराज़');
        assert.strictEqual(by['919800000004'].stance, 'समर्थक');
        assert.strictEqual(by['919800000005'].stance, 'विरोधी');
        assert.strictEqual(by['919800000006'].stance, 'विरोधी');
        assert.strictEqual(o.totals.commit, 1); assert.strictEqual(o.totals['विरोधी'], 2); assert.strictEqual(o.totals['नाराज़'], 1);
        assert.strictEqual(o.totals.samasyaTotal, 2);
        assert.strictEqual(o.totals.samasyaByCategory['सड़क'], 1);
        assert.strictEqual(o.mulaqatScheduled[0].when, 'रविवार शाम 5 बजे');
        assert.strictEqual(o.mulaqatScheduled[0].place, 'मंदिर के पास');
        assert.ok(/घर के 4 वोट/.test(by['919800000001'].summary), by['919800000001'].summary);
        assert.ok(o.good.some(g => g.phone === '919800000001'));
        assert.ok(o.bad.some(g => g.phone === '919800000003'));
        assert.ok(!o.rows.some(r => r.phone === '914500000000'), 'test hidden by default');
    });
    await t('filters (stance / q / includeTest) and isVirodhi callback', () => {
        assert.strictEqual(overview.build({ users, filter: { stance: 'commit' } }).rows.length, 1);
        assert.strictEqual(overview.build({ users, filter: { q: 'chor' } }).rows.length, 1);
        assert.ok(overview.build({ users, filter: { includeTest: true } }).rows.some(r => r.phone === '914500000000'));
        const o = overview.build({ users, isVirodhi: p => p === '919800000004' });
        assert.strictEqual(o.rows.find(r => r.phone === '919800000004').stance, 'विरोधी');
    });

    console.log('— Scheduled bulk campaigns');
    await t('parseIst + windowFromHours are IST wall clock', () => {
        assert.strictEqual(new Date(parseIst('2026-11-05T08:00')).toISOString(), '2026-11-05T02:30:00.000Z');
        const w = windowFromHours('2026-11-05', 17, 20);
        assert.strictEqual(new Date(w.start).toISOString(), '2026-11-05T11:30:00.000Z');
        assert.strictEqual(w.end - w.start, 3 * 3600e3);
    });
    await t('planTimes: 200 people over 3h on 2 lines — random times, ≥20s apart per line, balanced lines', () => {
        const rs = Array.from({ length: 200 }, (_, i) => ({ phone: '9198' + String(10000000 + i) }));
        const start = 1e12, end = start + 3 * 3600e3;
        const { items, overflow } = planTimes(rs, { start, end, lines: ['a', 'b'], minGapSec: 20, maxGapSec: 90, rng: seq(3) });
        assert.strictEqual(items.length, 200);
        for (const l of ['a', 'b']) {
            const ts = items.filter(i => i.line === l).map(i => i.dueAt).sort((x, y) => x - y);
            assert.ok(Math.abs(ts.length - 100) <= 1);
            for (let i = 1; i < ts.length; i++) assert.ok(ts[i] - ts[i - 1] >= 20000, 'gap ' + (ts[i] - ts[i - 1]));
            assert.ok(ts[0] >= start);
        }
        const minutes = new Set(items.map(i => Math.floor(i.dueAt / 60000)));
        assert.ok(minutes.size > 120, 'spread over many minutes: ' + minutes.size);
        assert.ok(overflow < 20, 'overflow ' + overflow);
    });
    await t('rotation is balanced across variants', () => {
        const r = rotation(200, 3, seq(5));
        const c = [0, 0, 0]; r.forEach(i => c[i]++);
        assert.ok(Math.max(...c) - Math.min(...c) <= 1, c.join(','));
    });

    // fake world
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ops4-'));
    const mediaDir = path.join(tmp, 'media'); fs.mkdirSync(mediaDir);
    fs.writeFileSync(path.join(mediaDir, 'p1.jpg'), 'x'); fs.writeFileSync(path.join(mediaDir, 'p2.png'), 'x');
    let clock = Date.parse('2026-11-05T02:30:00Z'); // 08:00 IST
    const sent = [];
    const mkSock = (id) => ({ onWhatsApp: async (p) => [{ exists: !String(p).endsWith('99'), jid: p + '@s.whatsapp.net' }], sendMessage: async (jid, content) => { sent.push({ line: id, jid, content, at: clock }); return { key: { id: 'M' + sent.length, remoteJid: jid } }; } });
    const sessions = [{ id: 'sim_636', name: 'Primary', status: 'CONNECTED', sock: mkSock('sim_636') }, { id: 'canada', name: 'Canada', status: 'CONNECTED', sock: mkSock('canada') }];
    const engine = new BroadcastEngine({ stateFile: path.join(tmp, 'bc.json'), mediaDir, getSessions: () => sessions, now: () => clock });
    const own = { '14502790497': 'canada', '916367810227': 'sim_636' };
    const virodhiSet = new Set(['919811111111']);
    const mk = () => new ScheduledCampaigns({ stateFile: path.join(tmp, 'sc.json'), mediaDir, getSessions: () => sessions, engine, now: () => clock, random: seq(11), sleep: async () => {}, logger: { log() {}, warn() {}, error() {} },
        isVirodhi: p => virodhiSet.has(p), ownLineOf: p => own[String(p).replace(/\D/g, '')] || null, isBlocked: p => (own[p] ? 'own_line' : null) });
    let sc = mk();
    const audience = Array.from({ length: 12 }, (_, i) => '98100000' + String(10 + i)).join('\n') + '\n9811111111\n9810000099';
    let cid;
    await t('create: validates, skips विरोधी + opted-out at plan time, rotates text+poster', () => {
        engine.markOptOut('919810000010', 'STOP');
        const r = sc.create({ phones: audience, messages: 'राम राम {name} जी 🙏\n---\n{नमस्ते|राम राम} जी, आपका दिन शुभ हो', mediaFiles: ['p1.jpg', 'p2.png'], windowStart: '2026-11-05T08:00', windowEnd: '2026-11-05T08:30', lines: ['sim_636', 'canada'] });
        assert.ok(r.ok, r.error);
        cid = r.campaign.id;
        const c = sc.get(cid);
        assert.strictEqual(c.items.length, 12); // 14 - virodhi - opted-out
        assert.ok(c.skippedAtPlan.some(s => s.reason === 'virodhi'));
        assert.ok(c.skippedAtPlan.some(s => s.reason === 'opted_out'));
        assert.ok(new Set(c.items.map(i => i.msgIdx)).size === 2 && new Set(c.items.map(i => i.mediaIdx)).size === 2);
        assert.ok(c.items.every(i => i.dueAt >= clock));
        assert.strictEqual(c.quietHours, false, 'quiet hours default OFF');
    });
    await t('errors: no window / no content / unknown line / test campaign to a voter number', () => {
        assert.ok(!sc.create({ phones: '9810000050', messages: 'x', lines: ['sim_636'] }).ok);
        assert.ok(!sc.create({ phones: '9810000050', windowStart: '2026-11-05T09:00', windowEnd: '2026-11-05T10:00', lines: ['sim_636'] }).ok);
        assert.ok(!sc.create({ phones: '9810000050', messages: 'x', windowStart: '2026-11-05T09:00', windowEnd: '2026-11-05T10:00', lines: ['nope'] }).ok);
        const bad = sc.create({ test: true, recipients: [{ phone: '919810000050', line: 'sim_636' }], messages: 'x', startInMinutes: 0, durationMinutes: 5, lines: ['sim_636'] });
        assert.ok(!bad.ok && /own line/.test(bad.error), bad.error);
        const self = sc.create({ test: true, recipients: [{ phone: '14502790497', line: 'canada' }], messages: 'x', startInMinutes: 0, durationMinutes: 5, lines: ['canada'] });
        assert.ok(!self.ok, 'line cannot message itself');
    });
    await t('ticks send only due items, one per line at a time, gaps respected, caps shared', async () => {
        const c = sc.get(cid);
        let guard = 0;
        while (c.items.some(i => i.status === 'pending') && guard++ < 2000) {
            const jobs = await sc.tick();
            await Promise.all(jobs);
            clock += 5000;
        }
        const k = sc.counts(c);
        assert.strictEqual(k.sent, 11, JSON.stringify(k));
        assert.ok(c.items.find(i => i.phone === '919810000099').reason === 'not_on_whatsapp');
        for (const l of ['sim_636', 'canada']) {
            const ts = sent.filter(s => s.line === l).map(s => s.at);
            for (let i = 1; i < ts.length; i++) assert.ok(ts[i] - ts[i - 1] >= 20000, 'gap');
        }
        for (const it of c.items.filter(i => i.status === 'sent')) assert.ok(it.sentAt >= it.dueAt);
        assert.ok(sent.every(s => s.content.image && s.content.caption), 'poster + caption');
        assert.ok(new Set(sent.map(s => s.content.caption)).size >= 2, 'text variants');
        assert.strictEqual(engine.lineUsage('sim_636').hour + engine.lineUsage('canada').hour, 11, 'shared caps counted');
        await sc.tick();
        assert.strictEqual(c.status, 'done');
    });
    await t('hourly cap blocks further sends on that line', async () => {
        const r = sc.create({ phones: '9810000201\n9810000202', messages: 'hi', windowStart: new Date(clock).toISOString(), windowEnd: new Date(clock + 600e3).toISOString(), lines: ['sim_636'], hourlyCap: 1 });
        assert.ok(r.ok, r.error);
        const before = sent.length;
        for (let i = 0; i < 300; i++) { await Promise.all(await sc.tick()); clock += 2000; }
        assert.strictEqual(sent.length, before, 'cap already reached by earlier sends this hour');
        assert.strictEqual(sc.get(r.campaign.id).waitingReason, 'hourly_cap');
        sc.setStatus(r.campaign.id, 'cancel');
    });
    await t('STOP mid-campaign is honoured at send time; virodhi skipped at send time', async () => {
        clock += 3 * 3600e3; // fresh hour
        const r = sc.create({ phones: '9810000301\n9810000302', messages: 'hi', startInMinutes: 0, durationMinutes: 2, lines: ['canada'] });
        assert.ok(r.ok, r.error);
        engine.markOptOut('919810000301', 'STOP');
        virodhiSet.add('919810000302');
        for (let i = 0; i < 100; i++) { await Promise.all(await sc.tick()); clock += 3000; }
        const c = sc.get(r.campaign.id);
        assert.deepStrictEqual(c.items.map(i => i.reason).sort(), ['opted_out', 'virodhi']);
    });
    await t('restart: pending resumes, mid-send is never resent', async () => {
        clock += 3 * 3600e3;
        const r = sc.create({ phones: '9810000401\n9810000402', messages: 'hi', startInMinutes: 1, durationMinutes: 3, lines: ['sim_636'] });
        const c = sc.get(r.campaign.id);
        c.items[0].status = 'sending'; sc.save();
        sc.stop();
        sc = mk();
        const c2 = sc.get(r.campaign.id);
        assert.strictEqual(c2.items[0].status, 'skipped');
        assert.strictEqual(c2.items[0].reason, 'interrupted_during_send_maybe_delivered');
        clock += 5 * 60e3;
        for (let i = 0; i < 50; i++) { await Promise.all(await sc.tick()); clock += 3000; }
        assert.strictEqual(c2.items[1].status, 'sent');
    });
    await t('window passed (+60 min grace) skips the rest instead of sending late', async () => {
        clock += 3 * 3600e3;
        const r = sc.create({ phones: '9810000501', messages: 'hi', startInMinutes: 1, durationMinutes: 1, lines: ['sim_636'] });
        sessions[0].status = 'DISCONNECTED';
        clock += 2 * 3600e3;
        await sc.tick();
        sessions[0].status = 'CONNECTED';
        assert.strictEqual(sc.get(r.campaign.id).items[0].reason, 'window_passed');
    });
    await t('test campaign: own numbers only, cross-line, randomized within 5 min', async () => {
        clock += 3 * 3600e3;
        const r = sc.create({ test: true, name: 'live verify', recipients: [{ phone: '14502790497', line: 'sim_636' }, { phone: '916367810227', line: 'canada' }], messages: ['🧪 test A {name}', '🧪 test B'], mediaFiles: ['p1.jpg'], startInMinutes: 0, durationMinutes: 5, lines: ['sim_636', 'canada'] });
        assert.ok(r.ok, r.error);
        const c = sc.get(r.campaign.id);
        assert.strictEqual(c.items.find(i => i.phone === '14502790497').line, 'sim_636');
        assert.strictEqual(c.items.find(i => i.phone === '916367810227').line, 'canada');
        for (let i = 0; i < 200; i++) { await Promise.all(await sc.tick()); clock += 3000; }
        assert.strictEqual(sc.counts(c).sent, 2);
    });
    await t('test campaign waits while a Live Self-Test is running', async () => {
        clock += 3 * 3600e3;
        let busy = true;
        sc.isTestBusy = () => busy;
        const r = sc.create({ test: true, recipients: [{ phone: '14502790497', line: 'sim_636' }], messages: 'x', startInMinutes: 0, durationMinutes: 2, lines: ['sim_636'] });
        for (let i = 0; i < 30; i++) { await Promise.all(await sc.tick()); clock += 3000; }
        assert.strictEqual(sc.counts(sc.get(r.campaign.id)).sent, 0);
        assert.strictEqual(sc.get(r.campaign.id).waitingReason, 'self_test_running');
        busy = false;
        for (let i = 0; i < 30; i++) { await Promise.all(await sc.tick()); clock += 3000; }
        assert.strictEqual(sc.counts(sc.get(r.campaign.id)).sent, 1);
    });
    await t('agenda slot window + preview hides full numbers', () => {
        const p = sc.preview({ phones: '9810000601\n9810000602', messages: 'hi', preset: 'evening', date: new Date(clock + 86400e3).toISOString().slice(0, 10), lines: ['sim_636'] });
        assert.ok(p.ok, JSON.stringify(p));
        assert.ok(p.samples.every(s => /…/.test(s.phone)));
        assert.ok(/17:|18:|19:|20:/.test(p.samples[0].at), p.samples[0].at);
    });
    await t('dashboard UI strings contain both tabs and no template-literal placeholders', () => {
        const { ui } = require('./ops_routes.js');
        const all = ui.tabButtons() + ui.tabPanes() + ui.script();
        assert.ok(/tab-overview/.test(all) && /tab-schedule/.test(all) && /tab-btn-overview/.test(all));
        assert.ok(!/\$\{/.test(all));
        assert.ok(!/\.csv/.test(all), 'no CSV export of voter numbers in Overview');
    });

    console.log(`\nOPS v4: ${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
