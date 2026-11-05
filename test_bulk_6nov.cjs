/* 6 Nov bulk-day rehearsal tests: contact import (CSV/XLSX/VCF/paste), scheduled bulk (tag audience, windows,
 * rotation, gaps, caps, pause/resume/cancel, restart, auto-pause, results CSV, contact card flag, reply queue),
 * Status posts (audience, test line, retired, schedules, restart), agenda slot → bulk. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bulk6nov-'));
process.env.CONTACTS_DB_PATH = path.join(TMP, 'contacts.json');
process.env.OPERATOR_CONTROL_FILE = path.join(TMP, 'oc.json');
process.env.SCHEDULED_STATE_PATH = path.join(TMP, 'sched.json');
process.env.CAMPAIGN_AGENDA_PATH = path.join(TMP, 'agenda.json');

const userMemory = require('./user_memory.js');
userMemory.save = () => {};
const ci = require('./contact_import.js');
const contactsManager = require('./contacts_manager.js');
const { ScheduledCampaigns, PRESETS, windowFromHours, AUTO_PAUSE } = require('./scheduled_campaigns.js');
const { BroadcastEngine } = require('./broadcast_engine.js');
const { StatusPoster } = require('./status_posts.js');
const { ChatQueue } = (() => { const m = require('./chat_queue.js'); return m.ChatQueue ? m : { ChatQueue: m }; })();

let passed = 0, failed = 0;
async function t(name, fn) {
    try { await fn(); passed++; console.log('  ✅ ' + name); }
    catch (e) { failed++; console.log('  ❌ ' + name + '\n     ' + String(e && e.stack || e).split('\n').slice(0, 4).join('\n     ')); }
}
function seq(seed = 11) { let x = seed; return () => { x = (x * 16807) % 2147483647; return (x - 1) / 2147483646; }; }

// ---- tiny xlsx writer (real zip, deflated, shared strings + numeric cells like Excel writes) ----
function crc32(buf) { let c, crc = 0xffffffff; for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; }
function zip(files) {
    const locals = [], centrals = []; let off = 0;
    for (const [name, content] of Object.entries(files)) {
        const data = Buffer.from(content, 'utf8'); const comp = zlib.deflateRawSync(data); const nb = Buffer.from(name);
        const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(crc32(data), 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nb.length, 26);
        const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(crc32(data), 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42);
        locals.push(lh, nb, comp); centrals.push(ch, nb); off += 30 + nb.length + comp.length;
    }
    const cd = Buffer.concat(centrals); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
    return Buffer.concat([...locals, cd, end]);
}
function makeXlsx(rows) {
    const strings = []; const si = s => { let i = strings.indexOf(s); if (i < 0) { strings.push(s); i = strings.length - 1; } return i; };
    const col = i => String.fromCharCode(65 + i);
    const sheetRows = rows.map((r, ri) => `<row r="${ri + 1}">` + r.map((v, ci2) => typeof v === 'number' ? `<c r="${col(ci2)}${ri + 1}"><v>${v}</v></c>` : `<c r="${col(ci2)}${ri + 1}" t="s"><v>${si(String(v))}</v></c>`).join('') + '</row>').join('');
    const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    return zip({
        '[Content_Types].xml': '<?xml version="1.0"?><Types/>',
        'xl/workbook.xml': '<?xml version="1.0"?><workbook xmlns:r="r"><sheets><sheet name="Contacts" sheetId="1" r:id="rId1"/></sheets></workbook>',
        'xl/_rels/workbook.xml.rels': '<?xml version="1.0"?><Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
        'xl/sharedStrings.xml': '<?xml version="1.0"?><sst>' + strings.map(s => `<si><t>${esc(s)}</t></si>`).join('') + '</sst>',
        'xl/worksheets/sheet1.xml': '<?xml version="1.0"?><worksheet><sheetData>' + sheetRows + '</sheetData></worksheet>'
    });
}
function mock150() { const out = []; for (let i = 0; i < 150; i++) out.push({ phone: String(9100000000 + i), name: 'Mock ' + i }); return out; }

function fakeSock(log, opts = {}) {
    return {
        user: { id: (opts.self || '916367810227') + ':5@s.whatsapp.net' },
        onWhatsApp: async (p) => { if (opts.checkFail) throw new Error(opts.checkFail); return [{ exists: !(opts.notOn || []).includes(p), jid: p + '@s.whatsapp.net' }]; },
        presenceSubscribe: async () => {}, sendPresenceUpdate: async () => {},
        sendMessage: async (jid, content, o) => { if (opts.fail) throw new Error(typeof opts.fail === 'function' ? opts.fail() : opts.fail); log.push({ jid, content, o, at: opts.clock ? opts.clock() : Date.now() }); return { key: { id: 'MSG' + log.length, remoteJid: jid, fromMe: true } }; }
    };
}

(async () => {
    console.log('— ① contact import');
    await t('CSV with Hindi headers (नाम/मोबाइल), +91 / 0 / spaces / dashes, duplicate + invalid', () => {
        const csv = '\uFEFFक्रम,नाम,मोबाइल नंबर,वार्ड\n1,रामलाल,+91 98290-12345,3\n2,सीता देवी,098290 12346,4\n3,दोहराव,9829012345,3\n4,गलत,12345,1\n5,विदेशी,+1 450 279 0497,1\n';
        const p = ci.parseInput({ fileName: 'list.csv', fileText: csv });
        const a = ci.analyze(p.rows, {});
        assert.strictEqual(p.format, 'csv');
        assert.deepStrictEqual([a.counts.valid, a.counts.invalid, a.counts.duplicatesInFile], [2, 2, 1]);
        assert.strictEqual(a.valid[0].phone, '919829012345'); assert.strictEqual(a.valid[0].name, 'रामलाल'); assert.strictEqual(a.valid[0].ward, '3');
        assert.strictEqual(a.valid[1].phone, '919829012346');
    });
    await t('CSV English headers Name/Mobile + Google Contacts export (First/Last, "Phone 1 - Value" with :::)', () => {
        const a1 = ci.analyze(ci.parseInput({ fileName: 'a.csv', fileText: 'Name,Mobile\nRam,9876543210\n' }).rows);
        assert.strictEqual(a1.valid[0].phone, '919876543210');
        const g = 'First Name,Middle Name,Last Name,Phone 1 - Type,Phone 1 - Value\nSuresh,,Yadav,Mobile,+91 99887 76655 ::: 0141 2222222\nAnil,,,Mobile,"+1 (555) 010-2000 ::: 98111-22233"\n';
        const a2 = ci.analyze(ci.parseInput({ fileName: 'contacts.csv', fileText: g }).rows);
        assert.deepStrictEqual(a2.valid.map(v => [v.name, v.phone]), [['Suresh Yadav', '919988776655'], ['Anil', '919811122233']]);
    });
    await t('headerless CSV / semicolon / tab', () => {
        const a = ci.analyze(ci.parseInput({ fileName: 'x.csv', fileText: 'Ram Lal;9876543210;5\nShyam;+919876543211;6\n' }).rows);
        assert.deepStrictEqual(a.valid.map(v => [v.name, v.phone, v.ward]), [['Ram Lal', '919876543210', '5'], ['Shyam', '919876543211', '6']]);
        const b = ci.analyze(ci.parseInput({ fileName: 'x.txt', fileText: 'Name\tPhone\nGita\t98765 43212\n' }).rows);
        assert.strictEqual(b.valid[0].phone, '919876543212');
    });
    await t('VCF from a phone: QUOTED-PRINTABLE Hindi name, folded line, several TELs, item1.TEL, N only', () => {
        const vcf = 'BEGIN:VCARD\r\nVERSION:2.1\r\nN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:;=E0=A4=B0=E0=A4=BE=E0=A4=AE;;;\r\nFN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:=E0=A4=B0=E0=A4=BE=E0=A4=AE=20=E0=A4=B2=E0=A4=BE=\r\n=E0=A4=B2\r\nTEL;HOME:0141-2222222\r\nTEL;CELL:+91 98290 55555\r\nEND:VCARD\r\n' +
            'BEGIN:VCARD\nVERSION:3.0\nN:Kumar;Krishan;;;\nitem1.TEL;type=CELL:098290-55556\nEND:VCARD\n' +
            'BEGIN:VCARD\nVERSION:3.0\nFN:Very Long\n  Name\nTEL:+1 450 279 0497\nEND:VCARD\n';
        const p = ci.parseInput({ fileName: 'contacts.vcf', fileText: vcf });
        assert.strictEqual(p.format, 'vcf');
        const a = ci.analyze(p.rows);
        assert.deepStrictEqual(a.valid.map(v => [v.name, v.phone]), [['राम लाल', '919829055555'], ['Krishan Kumar', '919829055556']]);
        assert.strictEqual(a.counts.invalid, 1);
        assert.strictEqual(p.rows[2].name, 'Very Long Name');
    });
    await t('XLSX (Excel: shared strings + numeric phones incl. 9.876E9 style) via base64', () => {
        const buf = makeXlsx([['S.No', 'Name', 'Mobile No.', 'Ward'], [1, 'Mahesh', 9876500001, 2], [2, 'नरेश', '+91 98765-00002', 7], [3, 'Dup', 9876500001, 2], [4, 'Bad', 12345, 1]]);
        const p = ci.parseInput({ fileName: 'voters.xlsx', fileBase64: buf.toString('base64') });
        assert.strictEqual(p.format, 'xlsx');
        const a = ci.analyze(p.rows);
        assert.deepStrictEqual(a.valid.map(v => [v.name, v.phone, v.ward]), [['Mahesh', '919876500001', '2'], ['नरेश', '919876500002', '7']]);
        assert.deepStrictEqual([a.counts.duplicatesInFile, a.counts.invalid], [1, 1]);
        const files = ci.unzip(buf); assert.ok(files['xl/worksheets/sheet1.xml']);
        assert.strictEqual(ci.tableToContacts([['Mobile'], ['9.8765E+09']])[0].phone, '9876500000');
    });
    await t('old .xls is refused with a "save as xlsx/csv" message; pasted lines work', () => {
        assert.throws(() => ci.parseInput({ fileName: 'old.xls', fileBase64: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3, 4]).toString('base64') }), /Save as/i);
        const a = ci.analyze(ci.parseInput({ text: 'Ramesh Kumar 98765 43210\n+91-98765-43211, Suresh\n9876543210\n' }).rows);
        assert.deepStrictEqual([a.counts.valid, a.counts.duplicatesInFile], [2, 1]);
        assert.strictEqual(a.valid[0].name, 'Ramesh Kumar');
    });
    await t('150 mock numbers: dry run counts, commit with tag "📥 Bulk 6 Nov", audience by tag, delete batch', () => {
        contactsManager.contacts = [{ id: 'keep1', name: 'ग्रामवासी', phone: '919100000007', line: 'sim_636', tags: ['📥 WhatsApp Inbound'] }];
        const rows = [...mock150(), { phone: '9100000003', name: 'dup' }, { phone: '123', name: 'bad' }];
        const deps = { contactsManager, isOptedOut: p => p === '919100000001', isVirodhi: p => p === '919100000002', matchVoter: () => null };
        const a = ci.analyze(rows, deps);
        assert.deepStrictEqual([a.counts.valid, a.counts.invalid, a.counts.duplicatesInFile, a.counts.alreadySaved, a.counts.optedOut, a.counts.virodhi, a.counts.sendable], [150, 1, 1, 1, 1, 1, 148]);
        assert.strictEqual(contactsManager.contacts.length, 1, 'dry run saves nothing');
        assert.strictEqual(ci.defaultTag('2026-11-06'), '📥 Bulk 6 Nov');
        const r = ci.commit(a, { contactsManager, tag: '📥 Bulk 6 Nov' });
        assert.deepStrictEqual([r.created, r.tagged], [149, 1]);
        assert.strictEqual(contactsManager.getAll({ tag: '📥 Bulk 6 Nov' }).length, 150);
        const kept = contactsManager.findByPhone('919100000007');
        assert.ok(kept.tags.includes('📥 WhatsApp Inbound') && kept.tags.includes('📥 Bulk 6 Nov') && kept.name === 'Mock 7');
        assert.ok(ci.tagCounts(contactsManager.contacts).find(x => x.tag === '📥 Bulk 6 Nov').count === 150);
        const d = ci.deleteBatch(contactsManager, '📥 Bulk 6 Nov');
        assert.deepStrictEqual([d.removed, d.untagged, contactsManager.contacts.length], [149, 1, 1]);
        assert.ok(!contactsManager.contacts[0].tags.includes('📥 Bulk 6 Nov'));
    });
    await t('voter-roll match by name fills ward (optional)', () => {
        const a = ci.analyze([{ phone: '9876511111', name: 'X' }], { matchVoter: () => ({ matched: true, ward: 9, voterName: 'एक्स' }) });
        assert.strictEqual(a.counts.voterMatched, 1); assert.strictEqual(a.valid[0].ward, '9');
    });

    console.log('— ② scheduled bulk');
    const mediaDir = path.join(TMP, 'media'); fs.mkdirSync(mediaDir);
    for (const f of ['poster.jpg', 'baba_face.jpg', 'poster_sankalp.png', 'reel.mp4']) fs.writeFileSync(path.join(mediaDir, f), 'x');
    const T0 = Date.UTC(2026, 10, 6, 3, 25); // 08:55 IST, 6 Nov
    function mk(o = {}) {
        let now = o.start || T0;
        const engine = new BroadcastEngine({ stateFile: path.join(TMP, 'be_' + Math.random() + '.json'), mediaDir, getSessions: () => [], now: () => now, logger: { log() {}, warn() {}, error() {} } });
        engine.stop && engine.stop();
        const log = [];
        const sessions = o.sessions || [{ id: 'sim_636', name: 'Primary', status: 'CONNECTED', sock: fakeSock(log, { clock: () => now, ...(o.sock || {}) }) }];
        const sent = [];
        const sc = new ScheduledCampaigns({ stateFile: o.stateFile || path.join(TMP, 'sc_' + Math.random() + '.json'), mediaDir, getSessions: () => sessions, engine, now: () => now, random: seq(o.seed || 5), sleep: async () => {}, logger: { log() {}, warn() {}, error() {} },
            isBlocked: o.isBlocked || (() => null), isVirodhi: o.isVirodhi || (() => false), ownLineOf: o.ownLineOf || (() => null), onSent: (i) => sent.push(i) });
        return { sc, engine, log, sent, sessions, clock: { get: () => now, set: v => { now = v; }, add: ms => { now += ms; } } };
    }
    async function runUntil(h, end, step = 5000) { while (h.clock.get() < end) { const jobs = await h.sc.tick(); await Promise.all(jobs); h.clock.add(step); } }
    const TEXTS = ['राम राम {name} जी 🙏 पहला', 'नमस्ते {name} जी दूसरा', '{name} जी तीसरा संदेश', '{name} जी चौथा'];
    const audience = () => mock150().slice(0, 40).map(r => ({ phone: r.phone, name: r.name }));

    await t('presets: morning 09:00–11:30, evening 17:30–20:00 IST', () => {
        assert.deepStrictEqual(PRESETS.morning, [9, 11.5]); assert.deepStrictEqual(PRESETS.evening, [17.5, 20]);
        const h = mk();
        const r = h.sc.build({ contacts: audience(), messages: TEXTS, preset: 'morning', date: '2026-11-06' });
        assert.deepStrictEqual(r.errors, []);
        const w = windowFromHours('2026-11-06', 9, 11.5);
        assert.strictEqual(r.campaign.windowStart, w.start); assert.strictEqual(r.campaign.windowEnd, w.end);
        assert.ok(r.campaign.items.every(i => i.dueAt >= w.start));
    });
    await t('preview: count, skipped by reason (STOP / virodhi), duplicates, invalid, rotation, warnings', () => {
        const h = mk({ isBlocked: p => p === '919100000001' ? 'opted_out' : null, isVirodhi: p => p === '919100000002' });
        const rows = [...audience(), { phone: '9100000005', name: 'dup' }, { phone: '12', name: 'bad' }];
        const p = h.sc.preview({ contacts: rows, messages: TEXTS, mediaFiles: ['poster.jpg', 'baba_face.jpg'], preset: 'morning', date: '2026-11-06' });
        assert.ok(p.ok, JSON.stringify(p));
        assert.strictEqual(p.recipients, 38);
        assert.deepStrictEqual(p.skippedByReason, { opted_out: 1, virodhi: 1 });
        assert.deepStrictEqual([p.duplicates, p.invalid], [1, 1]);
        assert.deepStrictEqual(Object.values(p.textRotation).sort((a, b) => a - b), [9, 9, 10, 10]);
        assert.deepStrictEqual(Object.values(p.posterRotation), [19, 19]);
        const big = h.sc.preview({ contacts: mock150().map(r => ({ phone: r.phone, name: r.name })), messages: TEXTS, preset: 'morning', date: '2026-11-06' });
        assert.ok(big.warnings.some(w => /window fits about/.test(w)), JSON.stringify(big.warnings));
    });
    await t('retired posters: refused at plan time (server-side) and at send time', async () => {
        const h = mk();
        const r = h.sc.build({ contacts: audience(), messages: TEXTS, mediaFiles: ['poster_sankalp.png'], preset: 'morning', date: '2026-11-06' });
        assert.ok(r.errors.some(e => /Retired/.test(e)), JSON.stringify(r.errors));
        const ok = h.sc.create({ contacts: audience().slice(0, 2), messages: TEXTS, mediaFiles: ['poster.jpg'], startInMinutes: 0, durationMinutes: 5 });
        const c = h.sc.get(ok.campaign.id); c.media = [{ file: 'poster_sankalp.png', type: 'image' }];
        h.clock.add(60e3); await runUntil(h, h.clock.get() + 6 * 60e3);
        assert.strictEqual(h.log.length, 0, 'nothing sent');
        assert.ok(c.items.every(i => i.status === 'failed' && /Retired/.test(i.reason)));
        assert.notStrictEqual(c.status, 'paused', 'a retired poster is an operator error, not a line danger');
    });
    await t('live-like run: rotation, ≥ min gap between sends on a line, hourly cap, no one twice, onSent contactCard flag', async () => {
        const h = mk();
        const r = h.sc.create({ contacts: audience(), messages: TEXTS, mediaFiles: ['poster.jpg', 'baba_face.jpg'], preset: 'morning', date: '2026-11-06', minGapSec: 20, maxGapSec: 90, hourlyCap: 15 });
        assert.ok(r.ok, r.error);
        await runUntil(h, windowFromHours('2026-11-06', 9, 11.5).end + 70 * 60e3, 5000);
        const at = h.log.map(x => x.at).sort((a, b) => a - b);
        for (let i = 1; i < at.length; i++) assert.ok(at[i] - at[i - 1] >= 20000, 'gap ' + (at[i] - at[i - 1]));
        const perHour = {}; for (const x of at) { const k = Math.floor((x - at[0]) / 3600e3); perHour[k] = (perHour[k] || 0) + 1; }
        const c = h.sc.get(r.campaign.id);
        // rolling hour never above the cap
        for (let i = 0; i < at.length; i++) assert.ok(at.filter(x => x > at[i] - 3600e3 && x <= at[i]).length <= 15);
        const phones = h.log.map(x => x.jid); assert.strictEqual(new Set(phones).size, phones.length, 'no double send');
        assert.ok(h.log.length >= 30, 'sent ' + h.log.length);
        const usedT = new Set(h.log.map(x => x.content.caption.split(' ').pop())); assert.ok(usedT.size === 4, [...usedT].join(','));
        const usedP = new Set(h.log.map(x => path.basename(x.content.image.url))); assert.deepStrictEqual([...usedP].sort(), ['baba_face.jpg', 'poster.jpg']);
        assert.ok(h.log.every(x => !/\{name\}/.test(x.content.caption) && /Mock \d+ जी/.test(x.content.caption)));
        assert.ok(h.sent.every(s => s.contactCard === true));
        const k = h.sc.counts(c); assert.strictEqual(k.sent + k.skipped + k.failed, 40);
        const csv = h.sc.resultsCsv(c.id);
        assert.ok(/^\uFEFFphone,name,line,due_ist,status,reason,sent_ist,text_variant,poster,message_id/.test(csv));
        assert.ok(csv.includes('919100000000') && /,sent,/.test(csv));
        const h2 = mk(); const r2 = h2.sc.create({ contacts: audience().slice(0, 3), messages: TEXTS, startInMinutes: 0, durationMinutes: 4, contactCard: false });
        h2.clock.add(40e3); await runUntil(h2, h2.clock.get() + 6 * 60e3); assert.ok(h2.sent.length === 3 && h2.sent.every(s => s.contactCard === false));
        assert.strictEqual(r2.campaign.contactCard, false);
    });
    await t('pause / resume / cancel mid-run', async () => {
        const h = mk();
        const r = h.sc.create({ contacts: audience().slice(0, 10), messages: TEXTS, startInMinutes: 0, durationMinutes: 10, minGapSec: 20, maxGapSec: 30 });
        const id = r.campaign.id;
        h.clock.add(31e3);
        await runUntil(h, h.clock.get() + 70e3);
        const before = h.log.length; assert.ok(before >= 1);
        assert.ok(h.sc.setStatus(id, 'pause').ok);
        await runUntil(h, h.clock.get() + 3 * 60e3);
        assert.strictEqual(h.log.length, before, 'nothing while paused');
        assert.ok(h.sc.setStatus(id, 'resume').ok);
        await runUntil(h, h.clock.get() + 60e3);
        assert.ok(h.log.length > before);
        assert.ok(h.sc.setStatus(id, 'cancel').ok);
        const n = h.log.length; await runUntil(h, h.clock.get() + 10 * 60e3);
        assert.strictEqual(h.log.length, n);
        assert.ok(h.sc.get(id).items.filter(i => i.reason === 'cancelled').length >= 1);
    });
    await t('restart: a mid-send item is never resent; pending ones continue on the new process', async () => {
        const stateFile = path.join(TMP, 'restart.json');
        const h = mk({ stateFile });
        const r = h.sc.create({ contacts: audience().slice(0, 6), messages: TEXTS, startInMinutes: 0, durationMinutes: 6, minGapSec: 20, maxGapSec: 25 });
        h.clock.add(31e3); await runUntil(h, h.clock.get() + 50e3);
        const c = h.sc.get(r.campaign.id);
        const sentBefore = c.items.filter(i => i.status === 'sent').map(i => i.phone);
        const crashed = c.items.find(i => i.status === 'pending'); crashed.status = 'sending'; h.sc.save(); // crash during sendMessage
        const h2 = mk({ stateFile, start: h.clock.get() });
        const c2 = h2.sc.get(r.campaign.id);
        assert.strictEqual(c2.items.find(i => i.phone === crashed.phone).reason, 'interrupted_during_send_maybe_delivered');
        await runUntil(h2, h2.clock.get() + 15 * 60e3);
        const again = h2.log.map(x => x.jid.split('@')[0]);
        assert.ok(!again.includes(crashed.phone), 'crashed item not resent');
        assert.ok(!again.some(p => sentBefore.includes(p)), 'already-sent not resent');
        assert.strictEqual(h2.sc.counts(c2).pending, 0);
    });
    await t('same tag in morning + evening: second campaign skips people already sent / still queued', async () => {
        const h = mk();
        const all = audience();
        const m = h.sc.create({ contacts: all, messages: TEXTS, startInMinutes: 0, durationMinutes: 30, maxRecipients: 10, minGapSec: 20, maxGapSec: 30 });
        assert.strictEqual(m.campaign.counts.total, 10); assert.strictEqual(m.campaign.heldBack, 30);
        const p = h.sc.preview({ contacts: all, messages: TEXTS, preset: 'evening', date: '2026-11-06' });
        assert.strictEqual(p.skippedByReason.in_other_campaign, 10); assert.strictEqual(p.recipients, 30);
        h.clock.add(31e3); await runUntil(h, h.clock.get() + 40 * 60e3);
        const p2 = h.sc.preview({ contacts: all, messages: TEXTS, preset: 'evening', date: '2026-11-06' });
        assert.strictEqual(p2.skippedByReason.already_sent_today, 10);
    });
    await t('auto-pause: 3 send errors in a row', async () => {
        const h = mk({ sock: { fail: 'Connection Closed' } });
        const r = h.sc.create({ contacts: audience().slice(0, 8), messages: TEXTS, startInMinutes: 0, durationMinutes: 5, minGapSec: 10, maxGapSec: 12 });
        h.clock.add(31e3); await runUntil(h, h.clock.get() + 5 * 60e3);
        const c = h.sc.get(r.campaign.id);
        assert.strictEqual(c.status, 'paused'); assert.ok(/auto: 3 send errors in a row/.test(c.pauseReason), c.pauseReason);
        assert.strictEqual(c.items.filter(i => i.status === 'failed').length, AUTO_PAUSE.errorStreak);
        assert.ok(h.sc.setStatus(c.id, 'resume').ok); assert.strictEqual(c.pauseReason, null);
    });
    await t('auto-pause at once on a ban / rate-limit sign (and the line is paused for Bulk Send too)', async () => {
        const h = mk({ sock: { fail: 'rate-overlimit' } });
        const r = h.sc.create({ contacts: audience().slice(0, 8), messages: TEXTS, startInMinutes: 0, durationMinutes: 5 });
        h.clock.add(31e3); await runUntil(h, h.clock.get() + 3 * 60e3);
        const c = h.sc.get(r.campaign.id);
        assert.strictEqual(c.status, 'paused'); assert.ok(/ban \/ rate-limit/.test(c.pauseReason), c.pauseReason);
        assert.strictEqual(c.items.filter(i => i.status === 'failed').length, 1);
        assert.ok(h.engine.lineStat('sim_636').paused);
    });
    await t('auto-pause when the line is disconnected > 2 min while sends are due', async () => {
        const h = mk();
        const r = h.sc.create({ contacts: audience().slice(0, 5), messages: TEXTS, startInMinutes: 0, durationMinutes: 10 });
        h.sessions[0].status = 'DISCONNECTED';
        h.clock.add(31e3); await runUntil(h, h.clock.get() + 60e3);
        assert.strictEqual(h.sc.get(r.campaign.id).status, 'running', 'short blip tolerated');
        await runUntil(h, h.clock.get() + 3 * 60e3);
        const c = h.sc.get(r.campaign.id);
        assert.strictEqual(c.status, 'paused'); assert.ok(/disconnected/.test(c.pauseReason));
        assert.strictEqual(h.log.length, 0);
    });
    await t('STOP mid-campaign is honoured at send time', async () => {
        let stop = new Set();
        const h = mk({ isBlocked: p => stop.has(p) ? 'opted_out' : null });
        const r = h.sc.create({ contacts: audience().slice(0, 4), messages: TEXTS, startInMinutes: 0, durationMinutes: 4 });
        stop = new Set(r.campaign.counts ? h.sc.get(r.campaign.id).items.map(i => i.phone) : []);
        h.clock.add(31e3); await runUntil(h, h.clock.get() + 6 * 60e3);
        assert.strictEqual(h.log.length, 0);
        assert.ok(h.sc.get(r.campaign.id).items.every(i => i.reason === 'opted_out'));
    });
    await t('test campaigns: own numbers only, repeat ≤ 6 to prove rotation live', () => {
        const h = mk({ ownLineOf: p => ({ '14502790497': 'canada', '916367810227': 'sim_636' })[p] || null, isBlocked: () => 'own_line' });
        const bad = h.sc.build({ test: true, recipients: [{ phone: '919100000000', line: 'sim_636' }], messages: TEXTS, startInMinutes: 0, durationMinutes: 4 });
        assert.ok(bad.errors.some(e => /own line numbers/.test(e)));
        const ok = h.sc.build({ test: true, repeat: 4, recipients: [{ phone: '14502790497', line: 'sim_636' }], messages: TEXTS, mediaFiles: ['poster.jpg', 'baba_face.jpg'], startInMinutes: 0, durationMinutes: 4 });
        assert.deepStrictEqual(ok.errors, []); assert.strictEqual(ok.campaign.items.length, 4);
        assert.strictEqual(new Set(ok.campaign.items.map(i => i.msgIdx)).size, 4);
    });
    await t('replies are not starved: chat queue jobs finish while a bulk send is "typing"', async () => {
        let now = Date.now();
        const log = [];
        const slow = { onWhatsApp: async p => [{ exists: true, jid: p + '@s.whatsapp.net' }], presenceSubscribe: async () => {}, sendPresenceUpdate: async () => {}, sendMessage: async (j, c) => { log.push(j); return { key: { id: 'x' } }; } };
        const sc = new ScheduledCampaigns({ stateFile: path.join(TMP, 'q.json'), mediaDir, getSessions: () => [{ id: 'sim_636', name: 'P', status: 'CONNECTED', sock: slow }], logger: { log() {}, warn() {}, error() {} }, sleep: ms => new Promise(r => setTimeout(r, 600)) });
        sc.create({ contacts: audience().slice(0, 1), messages: TEXTS, startInMinutes: 0, durationMinutes: 2 });
        for (const c of Object.values(sc.state.campaigns)) for (const i of c.items) i.dueAt = Date.now() - 1;
        for (const c of Object.values(sc.state.campaigns)) c.status = 'running';
        const q = new ChatQueue({ concurrency: 4 });
        const t0 = Date.now();
        const jobs = await sc.tick();
        const replies = await Promise.all([1, 2, 3, 4, 5].map(n => q.enqueue('voter' + n, async () => { await new Promise(r => setTimeout(r, 20)); return Date.now() - t0; })));
        const maxReply = Math.max(...replies.map(r => (typeof r === 'number' ? r : (r && r.result) || 0)));
        assert.ok(maxReply < 400, 'replies took ' + maxReply + 'ms while bulk was typing');
        await Promise.all(jobs);
        assert.strictEqual(log.length, 1);
    });

    console.log('— ③ Status posts');
    const own = ['916367810227', '14502790497'];
    function sp(o = {}) {
        const log = [];
        let now = o.now || Date.UTC(2026, 10, 6, 3, 59);
        const sessions = [
            { id: 'sim_636', name: 'P', status: 'CONNECTED', sock: fakeSock(log) },
            { id: 'canada', name: 'C', status: 'CONNECTED', sock: fakeSock(log, { self: '14502790497' }) }
        ];
        const p = new StatusPoster({ stateFile: o.stateFile || path.join(TMP, 'st_' + Math.random() + '.json'), mediaDir, getSessions: () => sessions, now: () => now, logger: { log() {}, warn() {}, error() {} },
            ownNumbers: () => own, ownNumberOf: id => ({ sim_636: '916367810227', canada: '14502790497' })[id],
            audienceFor: () => ['919100000000', '919100000001', '916367810227'] });
        return { p, log, sessions, clock: { set: v => { now = v; }, add: ms => { now += ms; }, get: () => now } };
    }
    await t('post now: image + caption to status@broadcast with statusJidList (contacts + own number), msg id recorded', async () => {
        const h = sp();
        const r = await h.p.post({ lineId: 'sim_636', mediaFile: 'poster.jpg', caption: 'राम राम जी 🙏' });
        assert.ok(r.ok, r.error);
        assert.strictEqual(h.log[0].jid, 'status@broadcast');
        assert.deepStrictEqual(h.log[0].o.statusJidList.sort(), ['916367810227@s.whatsapp.net', '919100000000@s.whatsapp.net', '919100000001@s.whatsapp.net']);
        assert.ok(h.log[0].content.image && h.log[0].content.caption === 'राम राम जी 🙏');
        assert.strictEqual(r.post.msgId, 'MSG1'); assert.strictEqual(r.post.recipients, 3);
        const del = await h.p.remove(r.post.id); assert.ok(del.ok); assert.ok(h.log[1].content.delete);
    });
    await t('text status gets a background colour + font; canada test line only reaches our own numbers', async () => {
        const h = sp();
        const r = await h.p.post({ lineId: 'canada', text: 'टेस्ट स्टेटस' });
        assert.ok(r.ok, r.error); assert.ok(r.post.test);
        assert.deepStrictEqual(h.log[0].o.statusJidList.sort(), ['14502790497@s.whatsapp.net', '916367810227@s.whatsapp.net']);
        assert.ok(/^#[0-9a-f]{6}$/i.test(h.log[0].o.backgroundColor) && Number.isInteger(h.log[0].o.font));
    });
    await t('retired poster / pdf / missing file / disconnected line are refused', async () => {
        const h = sp();
        assert.ok(/Retired/.test((await h.p.post({ lineId: 'sim_636', mediaFile: 'poster_sankalp.png' })).error));
        assert.ok(/not found/.test((await h.p.post({ lineId: 'sim_636', mediaFile: 'nope.jpg' })).error));
        assert.ok(/Retired/.test(h.p.addSchedule({ lineId: 'sim_636', time: '09:30', mediaFile: 'poster_sankalp.png' }).error));
        h.sessions[0].status = 'DISCONNECTED';
        assert.strictEqual((await h.p.post({ lineId: 'sim_636', mediaFile: 'poster.jpg' })).status, 503);
        assert.strictEqual(h.log.length, 0);
    });
    await t('schedules: max 4 a day per line, post once at the time, survive a restart, missed > 45 min skipped', async () => {
        const stateFile = path.join(TMP, 'status_sched.json');
        const h = sp({ stateFile });
        for (const tm of ['09:30', '13:00', '17:30', '20:00']) assert.ok(h.p.addSchedule({ lineId: 'sim_636', time: tm, mediaFile: 'poster.jpg', caption: 'c ' + tm }).ok);
        assert.ok(/At most 4/.test(h.p.addSchedule({ lineId: 'sim_636', time: '21:00', text: 'x' }).error));
        assert.ok(h.p.addSchedule({ lineId: 'canada', time: '09:30', text: 'test' }).ok, 'other line has its own 4');
        h.clock.set(Date.UTC(2026, 10, 6, 3, 59)); // 09:29 IST
        assert.strictEqual((await h.p.tick()).length, 0);
        h.clock.add(90e3); // 09:30:30
        const r = await h.p.tick();
        assert.strictEqual(r.length, 2); assert.ok(r.every(x => x.ok));
        const h2 = sp({ stateFile, now: h.clock.get() + 60e3 }); // restart
        assert.strictEqual((await h2.p.tick()).length, 0, 'not posted twice after restart');
        h2.clock.set(Date.UTC(2026, 10, 6, 8, 30)); // 14:00 IST — 13:00 missed by 60 min
        await h2.p.tick();
        assert.ok(/skipped: missed/.test(h2.p.state.schedules.find(s => s.time === '13:00').lastResult));
        assert.strictEqual(h2.log.length, 0);
        h2.clock.set(Date.UTC(2026, 10, 6, 12, 1)); // 17:31 IST
        const r3 = await h2.p.tick(); assert.strictEqual(r3.length, 1);
        h2.clock.set(Date.UTC(2026, 10, 7, 4, 0)); // next day 09:30
        assert.strictEqual((await h2.p.tick()).length, 2, 'daily schedules repeat next day');
    });

    await t('status route: canada test status → only our CONNECTED own numbers (never the offline baba_aux)', async () => {
        const express = require('express');
        const app = express(); app.use(express.json());
        process.env.STATUS_POSTS_PATH = path.join(TMP, 'sr.json');
        const log = [];
        const SESSIONS = [{ id: 'sim_636', status: 'CONNECTED', sock: fakeSock(log) }, { id: 'baba_aux', status: 'DISCONNECTED', sock: null }, { id: 'canada', status: 'CONNECTED', sock: fakeSock(log, { self: '14502790497' }) }];
        contactsManager.contacts = [{ phone: '919100000000', line: 'sim_636', tags: [] }];
        const { poster } = require('./status_routes.js').install(app, { SESSIONS, contactsManager, isOptedOut: () => false });
        poster.stop(); poster.mediaDir = mediaDir;
        const r = await poster.post({ lineId: 'canada', mediaFile: 'poster.jpg', caption: 'test' });
        assert.ok(r.ok, r.error);
        assert.deepStrictEqual(log[0].o.statusJidList.sort(), ['14502790497@s.whatsapp.net', '916367810227@s.whatsapp.net']);
        contactsManager.contacts = [];
    });

    console.log('— ④ agenda slot → bulk (route)');
    await t('POST /api/scheduled/from-agenda: morning slot → 09:00–11:30 window, slot hook, day-lock poster; retired lock media dropped', async () => {
        const express = require('express');
        const oc = require('./operator_control.js');
        const realMedia = path.join(__dirname, 'media');
        oc.setDay('2026-11-06', { goal: 'पानी', locked: true, media: ['poster.jpg', 'poster_sankalp.png'] });
        assert.deepStrictEqual(oc.load().days['2026-11-06'].media.map(m => m.file), ['poster.jpg']);
        const app = express(); app.use(express.json());
        const ops = require('./ops_routes.js');
        const SESSIONS = [{ id: 'sim_636', name: 'P', status: 'CONNECTED', sock: fakeSock([]) }];
        const agenda = require('./campaign_agenda.js');
        const { scheduler } = ops.install(app, { SESSIONS, broadcastEngine: null, userMemory, liveSelfTest: { ownLineOf: () => null, isActive: () => false }, engagementPolicy: { broadcastBlockReason: () => null }, followupPlanner: { inSilencePeriod: () => false }, contactsManager, samasyaStore: { list: () => [] }, mulaqatStore: { list: () => [] }, campaignAgenda: agenda, replyBrain: require('./reply_brain.js'), logMessage() {}, onBulkSent() {}, dailyIstDate: () => '2026-11-06', resolveAudience: (b) => ({ phones: b.phones || '', csvText: '', contacts: b.contactTag ? contactsManager.getAll({ tag: b.contactTag }) : [] }) });
        scheduler.stop(); scheduler.mediaDir = realMedia;
        contactsManager.contacts = []; ci.commit(ci.analyze(mock150().slice(0, 20)), { contactsManager, tag: '📥 Bulk 6 Nov' });
        const srv = app.listen(0); const port = srv.address().port;
        try {
            const res = await fetch(`http://127.0.0.1:${port}/api/scheduled/from-agenda`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date: '2026-11-06', slot: 'morning', contactTag: '📥 Bulk 6 Nov', previewOnly: true, lines: ['sim_636'] }) });
            const d = await res.json();
            assert.ok(d.success, JSON.stringify(d));
            assert.strictEqual(d.preview.recipients, 20);
            assert.deepStrictEqual(d.preview.window, ['2026-11-06 09:00 IST', '2026-11-06 11:30 IST']);
            assert.deepStrictEqual(d.slot.mediaFiles, ['poster.jpg']);
            assert.ok(d.preview.samples[0].text.length > 10 && d.preview.samples[0].media === 'poster.jpg');
            const csv = await fetch(`http://127.0.0.1:${port}/api/scheduled/nope/results.csv`); assert.strictEqual(csv.status, 404);
            scheduler.state.campaigns = { t1: { test: true, status: 'cancelled', items: [] }, t2: { test: true, status: 'running', items: [] }, r1: { test: false, status: 'done', items: [] } };
            app.post('/api/test-records/cleanup', (req, res) => res.json({ success: true }));
            const cl = await fetch(`http://127.0.0.1:${port}/api/test-records/cleanup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            assert.strictEqual(cl.headers.get('x-ops-test-campaigns-removed'), '1');
            assert.deepStrictEqual(Object.keys(scheduler.state.campaigns).sort(), ['r1', 't2']);
        } finally { srv.close(); contactsManager.contacts = []; }
    });

    console.log(`\nBULK 6 NOV: ${passed} passed, ${failed} failed`);
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
    process.exit(failed ? 1 : 0);
})();
