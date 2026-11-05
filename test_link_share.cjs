/* (harness copied from test_brain_live_fixes.cjs)
 * Routing mirrors server.js: slip_flow.preempt -> nlu.understand (rules; LLM verdict stubbed where the live model
 * mattered) -> nlu_router.plan -> direct reply | slip_flow.decide | reply brain (getAIResponse, LLM off). */
process.env.DEFAULT_SCRIPT = 'hindi';
process.env.SCRIPT_ASK = 'off';
const userMemory = require('./user_memory.js');
userMemory.save = () => {};
const nlu = require('./nlu.js');
const router = require('./nlu_router.js');
const slipFlow = require('./slip_flow.js');
const voterEngine = require('./voter_engine.js');
const ai = require('./ai_assistant_service.js');
const brain = require('./reply_brain.js');
const policy = require('./engagement_policy.js');
const linkShare = require('./link_share.js');
const linkPreview = require('./link_preview.js');

let pass = 0, fail = 0;
const failures = [];
function check(cond, label, extra) { if (cond) pass++; else { fail++; failures.push(label); console.log('  ✗ ' + label + (extra ? '  -> ' + String(extra).replace(/\n/g, ' / ').slice(0, 220) : '')); } }

let phoneN = 0;
function freshUser() {
    const phone = '919555' + String(100000 + (++phoneN));
    const u = userMemory.getUser(phone);
    Object.assign(u, { consented: true, consentStatus: 'ACCEPTED', history: [] });
    return { u, phone };
}
// STUB: the live model's verdicts that caused failures (keyed by message)
const STUB = {
    'kab hai vote dalna': { intent: 'other', wants_slip: false, script: 'roman' },
    'or kitne baje tak vote': { intent: 'other', wants_slip: false, script: 'roman' },
    'ye booth kaha pe h': { intent: 'other', wants_slip: false, script: 'roman' },
    'vote ke kitne paise doge': { intent: 'political_talk', sentiment: 'concerned', script: 'roman' },
    'jeet ke koi nahi aata': { intent: 'political_talk', sentiment: 'concerned', script: 'roman' },
    'vote pakka bhai': { intent: 'support', sentiment: 'positive', script: 'roman' },
    'dusra candidate jyada acha h': { intent: 'opposition', sentiment: 'neutral', script: 'roman' },
    'bas vaade hi karte ho': { intent: 'political_talk', sentiment: 'angry', script: 'roman' },
    'baba se milna h': { intent: 'contact_request', wants_contact: true, script: 'roman' },
    'ghar pe aa jayenge kya': { intent: 'contact_request', wants_contact: true, script: 'roman' },
    'baba jitenge is baar': { intent: 'support', sentiment: 'positive', script: 'roman' },
    'or wife ka naam?': { intent: 'slip_request', wants_slip: true, target_person: 'other', person_name_roman: 'manoj kumar', person_name_hi: 'मनोज कुमार', script: 'roman' },
    'Hello, who is this?': { intent: 'unclear', script: 'roman' },
    'What has Abhay Singh done for the village?': { intent: 'unclear', script: 'roman' },
    'When is the election?': { intent: 'unclear', script: 'roman' }
};
const stubLLM = async (sys, prompt) => {
    const m = prompt.match(/NEW VOTER MESSAGE: ([\s\S]*?)\n\nJSON:/);
    const k = m ? m[1].trim() : '';
    return STUB[k] ? JSON.stringify(STUB[k]) : null;
};

async function turn(user, phone, msg) {
    user.history.push({ role: 'user', text: msg, at: new Date().toISOString() });
    let reply = '', kind = 'brain', voter = null;
    const pre = slipFlow.preempt(msg, user);
    let sp = pre, p = null, n = null;
    if (!pre) {
        n = await nlu.understand(msg, user, { callLLM: stubLLM });
        p = router.plan(n, user, { text: msg, lineDisplay: '+91 63678 10227' });
        if (p.reply) { reply = linkShare.addLink(p.reply.text, user, { msg, intent: p.reply.intent }); kind = 'nlu_' + p.reply.intent; }
        else {
            const opts = p.slipOpts ? { ...p.slipOpts, blocked: false } : { slipIntent: voterEngine.isLikelyNameOrVoterQuery(msg) && !p.noSlip, searchText: msg, blocked: brain.inFlow(user), noSlip: !!p.noSlip };
            sp = slipFlow.decide(msg, user, opts);
        }
    }
    if (!reply && sp) {
        kind = 'slip_' + sp.kind; voter = sp.voter || null;
        if (sp.kind === 'deliver') reply = linkShare.addLink(slipFlow.deliverCaption(user, sp.voter, false, !!sp.other), user, { msg, kind: 'voter', intent: 'deliver' });
        else if (sp.kind === 'family') reply = linkShare.addLink(slipFlow.familyCaption(sp, false), user, { msg, kind: 'voter', intent: 'family' });
        else reply = (sp.kind === 'not_found' || sp.kind === 'choose') ? linkShare.addLink(sp.text, user, { msg, kind: 'voter', intent: sp.kind }) : sp.text;
    } else if (!reply) {
        const clar = n && n.intent === 'unclear' && ['unclear', 'short_reply'].includes(brain.classify(msg, user).intent) ? router.clarify(user) : null;
        reply = clar || await ai.getAIResponse(msg, null, [], phone, { nlu: n, noSlip: !!(p && (p.noSlip || p.slipOpts)) });
        reply = linkShare.addLink(reply, user, { msg, intent: (brain.classify(msg, user) || {}).intent || '' });
    }
    user.history.push({ role: 'bot', text: reply, at: new Date().toISOString() });
    return { reply, kind, voter, n };
}
async function convo(label, msgs) {
    const { u, phone } = freshUser();
    const out = [];
    for (const m of msgs) out.push(await turn(u, phone, m));
    return { u, out };
}


/* Website links in voter replies (owner 6 Nov 03:04): placement, 6 h rate limit, explicit ask, never on STOP / abuse /
 * grief / complaint, link alone on its line and the first URL; slip flow unbroken with links in history; preview cache. */
const SITE = 'https://abhaysinghsihali.in', VD = 'https://abhaysinghsihali.in/voter-directory';
const WL = 'पूरी लिस्ट और सारे काम वेबसाइट पे देख लो जी 👇';
const lines = r => r.split('\n');
function placed(r, url, line) {
    const L = lines(r); const i = L.indexOf(url);
    const firstUrl = (r.match(/https?:\/\/\S+/) || [])[0];
    return i > 0 && L[i - 1] === line && firstUrl === url && i === L.length - 1;
}
(async () => {
    console.log('== works question -> short answer, link line, URL alone on the next line');
    {
        const { u, out } = await convo('w1', ['baba ke kaam ki poori list']);
        check(out[0].kind === 'nlu_vikas_menu' && placed(out[0].reply, SITE, WL), '"baba ke kaam ki poori list" -> works menu, then the works line + site URL', out[0].kind + ' ' + out[0].reply);
        check(out[0].reply.indexOf(SITE) > 20, 'short answer comes first', out[0].reply);
        check(!!u.linkSharedAt, 'linkSharedAt tracked on the voter');
    }
    {
        const { out } = await convo('w2', ['baba ne kya kaam kiye', '1', 'aur kya kaam kiye']);
        check(placed(out[0].reply, SITE, WL), 'first works reply carries the link', out[0].kind + ' ' + out[0].reply);
        check(!/https?:/.test(out[1].reply) && !/https?:/.test(out[2].reply), 'next works replies within 6 h: no link', out[1].reply + ' || ' + out[2].reply);
    }
    {
        const { out } = await convo('w3', ['baba ne kya kaam kiye', 'website ka link bhejo']);
        check(out[1].reply.includes(SITE), 'explicit "website ka link" overrides the 6 h limit', out[1].kind + ' ' + out[1].reply);
    }
    {
        const { out } = await convo('w4', ['sankalp kya hai']);
        check(placed(out[0].reply, SITE, WL), 'sankalp question carries the works link', out[0].kind + ' ' + out[0].reply);
    }
    console.log('== voter list / parchi -> voter-directory');
    {
        const { out } = await convo('v1', ['voter slip rajesh devi ki', 'manoj', 'parivaar']);
        check(out[0].kind === 'slip_choose' && placed(out[0].reply, VD, linkShare.VOTER_LINE), 'ward question + voter-directory link', out[0].reply);
        check(out[1].kind === 'slip_deliver' && !/https?:/.test(out[1].reply), 'slip delivered (no second link within 6 h)', out[1].kind + ' ' + out[1].reply);
        check(out[2].kind === 'slip_family', 'link in history never breaks the slip flow (family card)', out[2].kind + ' ' + out[2].reply);
    }
    {
        const { out } = await convo('v2', ['meri parchi bhejo', 'sunil kumar pita lal singh']);
        check(out[1].kind === 'slip_deliver' && placed(out[1].reply, VD, linkShare.VOTER_LINE), 'slip caption then voter-directory link', out[1].reply);
        check(out[0].kind === 'slip_ask_name' && !/https?:/.test(out[0].reply), 'name ask (waiting for an answer) has no link', out[0].reply);
    }
    {
        const { out } = await convo('v3', ['rajesh devi ki parchi bhejo ward 3', 'haan']);
        check(out[0].kind === 'slip_confirm' && !/https?:/.test(out[0].reply), 'confirm question has no link', out[0].reply);
        check(out[1].kind === 'slip_deliver', '"haan" still delivers after a confirm', out[1].kind);
    }
    console.log('== never on STOP / abuse / grief / complaint');
    for (const m of ['naali tooti padi hai ward 3 me', 'kutte kamine', 'mere papa ka nidhan ho gaya', 'STOP', 'baba ke kaam bekar hai shikayat hai']) {
        const { out } = await convo('blk', [m]);
        check(!/https?:/.test(out[0].reply), `"${m}" -> no link`, out[0].reply);
    }
    console.log('== unit: rate limit, explicit, placement, strip');
    {
        const u = {}; const t0 = Date.parse('2026-11-06T00:00:00Z');
        const a = linkShare.addLink('जवाब', u, { msg: 'kaam batao', intent: 'works', now: t0 });
        check(placed(a, SITE, WL), 'unit: first works reply linked');
        check(!/http/.test(linkShare.addLink('जवाब', u, { msg: 'kaam batao', intent: 'works', now: t0 + 5 * 3600e3 })), 'unit: 5 h later -> no link');
        check(/http/.test(linkShare.addLink('जवाब', u, { msg: 'poori list bhejo', intent: 'works', now: t0 + 5 * 3600e3 })), 'unit: explicit "list" within 6 h -> link');
        check(/voter-directory/.test(linkShare.addLink('जवाब', u, { msg: 'mera naam voter list me', now: t0 + 6.1 * 3600e3 })), 'unit: after 6 h a voter-list ask -> voter-directory');
        check(!/http/.test(linkShare.addLink('जवाब', {}, { msg: 'ok', intent: 'greeting' })), 'unit: a plain greeting gets no link');
        check(/http/.test(linkShare.addLink('जवाब', {}, { msg: 'vote pakka', intent: 'commit' })), 'unit: once per conversation on a friendly turn');
        check(!/http/.test(linkShare.addLink('जवाब', { linkSharedAt: new Date(t0).toISOString() }, { msg: 'vote pakka', intent: 'commit', now: t0 + 3600e3 })), 'unit: friendly turn after a link -> none');
        check(!/abhaysinghsihali/.test(linkShare.addLink('देखिए https://x.y/z', {}, { msg: 'kaam batao', intent: 'works' })), 'unit: our link is never placed after another URL');
        check(!/http/.test(linkShare.addLink('जवाब', { broadcastOptOut: true }, { msg: 'kaam batao', intent: 'works' })), 'unit: opted-out voter -> none');
        check(linkShare.strip(a) === 'जवाब', 'unit: strip() removes the block for history checks');
    }
    console.log('== preview: og tags, 6 h cache, 4 s cap, never blocks');
    {
        const html = '<html><head><meta property="og:title" content="अभय सिंह"><meta property="og:description" content="विकास"><meta property="og:image" content="https://abhaysinghsihali.in/og-image.jpg?v=2"></head></html>';
        const jpg = await require('sharp')({ create: { width: 1200, height: 630, channels: 3, background: { r: 200, g: 80, b: 20 } } }).jpeg().toBuffer();
        let fetches = 0;
        const fetchImpl = async (url) => { fetches++; return { buf: /og-image/.test(url) ? jpg : Buffer.from(html), finalUrl: url }; };
        let uploads = 0; const upload = async () => { uploads++; return { mediaUrl: 'https://mmg.whatsapp.net/x', directPath: '/v/t62/x' }; };
        linkPreview.cache.clear();
        const info = await linkPreview.forText('बात\n' + WL + '\n' + SITE, null, { fetchImpl, upload, waitMs: 15000 });
        check(info && info.title === 'अभय सिंह' && info.jpegThumbnail && info.highQualityThumbnail && info['matched-text'] === SITE, 'preview: title + jpegThumbnail + HQ thumbnail (uploaded) + matched-text', JSON.stringify(info && Object.keys(info)));
        const again = await linkPreview.forText('x\n' + SITE, null, { fetchImpl, upload });
        check(again === info && fetches === 2 && uploads === 1, 'preview: cached per URL (no refetch / re-upload)', `fetches=${fetches} uploads=${uploads}`);
        linkPreview.cache.clear();
        const slow = async () => new Promise(r => setTimeout(() => r({ buf: Buffer.from(html), finalUrl: SITE }), 6000));
        const t = Date.now();
        const none = await linkPreview.forText('x\n' + VD, null, { fetchImpl: slow, waitMs: 1500 });
        check(none === null && Date.now() - t < 2000, 'preview: a slow site never blocks the reply (≤1.5 s wait, null = plain text)', `${Date.now() - t}ms`);
        check(linkPreview.FETCH_CAP_MS <= 4000 && linkPreview.CACHE_MS === 6 * 3600e3, 'preview: fetch cap ≤ 4 s, cache 6 h');
        check(require('./package.json').dependencies['link-preview-js'], 'package.json has link-preview-js');
        check(/generateHighQualityLinkPreview:\s*true/.test(require('fs').readFileSync('./server.js', 'utf8')), 'makeWASocket generateHighQualityLinkPreview: true');
    }
    console.log(`\nlink share: ${pass} passed, ${fail} failed`);
    if (fail) { console.log('FAILED:\n - ' + failures.join('\n - ')); process.exit(1); }
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
