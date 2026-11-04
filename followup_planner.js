/**
 * Proactive follow-up planner — personalised nudges that use each voter's memory.
 *
 * Eligibility (all must hold):
 *   - consented (engagement_policy.canSendProactive), never opted out (STOP/बंद/रुको), autopilot on
 *   - not inside quiet hours (default 21:00-08:00 IST) and not inside the pre-poll silence period
 *     (campaign_profile.json -> campaign.silenceStartIST, default 2026-11-14 18:00 IST, 48h before poll)
 *   - at most 1 proactive message per voter per IST day
 *   - stop after 2 proactive messages left unanswered (counter resets when the voter writes)
 *   - the voter has not written in the last `minIdleHours` (we never interrupt a live chat)
 *   - not opposed, not a self-test record, not after the poll
 *   - per-line daily cap (campaign.proactivePerLinePerDay) and per-cycle cap
 *
 * What it says (first match):
 *   1. open follow-up on a concern  -> "आपने वार्ड 5 की सड़क की बात बताई थी…" + matching work/sankalp + soft ask
 *   2. committed, family votes unknown -> ask once for the household's votes
 *   3. committed                     -> poll-date reminder + booth (if ward known) + slip offer (if no slip yet)
 *   4. undecided / leaning / unknown -> concern- or audience-matched work not yet told + days-left + soft ask
 */
const campaignProfile = require('./campaign_profile.js');
const engagementPolicy = require('./engagement_policy.js');
const replyQuality = require('./reply_quality.js');
const kb = require('./knowledge_base.js');
const voterMemory = require('./voter_memory.js');

const DEFAULTS = {
    pollDate: '2026-11-16',
    pollStartIST: '2026-11-16T07:30:00+05:30',
    silenceStartIST: '2026-11-14T18:00:00+05:30',
    quietStartHour: 21,
    quietEndHour: 8,
    maxProactivePerVoterPerDay: 1,
    maxUnansweredProactive: 2,
    proactivePerLinePerDay: 120,
    proactivePerCycle: 3,
    minIdleHours: 3
};

function config() {
    const p = campaignProfile.load();
    return { ...DEFAULTS, ...((p && p.campaign) || {}) };
}

const IST_OFFSET_MS = 5.5 * 3600 * 1000;
function istParts(now = new Date()) {
    const d = new Date(now.getTime() + IST_OFFSET_MS);
    return { hour: d.getUTCHours(), minute: d.getUTCMinutes(), day: d.toISOString().slice(0, 10) };
}

function inQuietHours(now = new Date(), cfg = config()) {
    const h = istParts(now).hour;
    const s = Number(cfg.quietStartHour), e = Number(cfg.quietEndHour);
    return s > e ? (h >= s || h < e) : (h >= s && h < e);
}

function inSilencePeriod(now = new Date(), cfg = config()) {
    const t = Date.parse(cfg.silenceStartIST);
    return Number.isFinite(t) && now.getTime() >= t;
}

function daysToPoll(now = new Date(), cfg = config()) {
    const poll = Date.parse(cfg.pollDate + 'T00:00:00+05:30');
    const today = Date.parse(istParts(now).day + 'T00:00:00+05:30');
    return Math.round((poll - today) / 86400000);
}

/** Why this voter may NOT get a proactive message right now (null = eligible). */
function blockReason(user, now = new Date(), cfg = config()) {
    if (!user || !user.phone) return 'no_user';
    if (user.selfTest) return 'self_test_record';
    if (user.broadcastOptOut) return 'opted_out';
    if (!engagementPolicy.canSendProactive(user)) return 'no_consent';
    if (inSilencePeriod(now, cfg)) return 'silence_period';
    if (inQuietHours(now, cfg)) return 'quiet_hours';
    if (daysToPoll(now, cfg) < 0) return 'after_poll';
    const m = voterMemory.ensure(user);
    if (user.persuasionStage === 'opposed' || m.commitment.status === 'opposed') return 'opposed';
    if (m.condolenceAt && now.getTime() - Date.parse(m.condolenceAt) < 3 * 86400e3) return 'condolence_pause';
    if (m.wrongNumberAt) return 'wrong_number';
    const p = m.proactive;
    if ((p.unanswered || 0) >= cfg.maxUnansweredProactive) return 'unanswered_limit';
    const today = istParts(now).day;
    if (p.lastDay === today && (p.todayCount || 1) >= cfg.maxProactivePerVoterPerDay) return 'daily_limit';
    const lastUser = Date.parse(p.lastUserAt || user.lastSeen || 0) || 0;
    if (lastUser && (now.getTime() - lastUser) < cfg.minIdleHours * 3600e3) return 'recently_active';
    // legacy fields (older records): honour the old 2-unanswered counter as well
    if ((user.proactivePingCount || 0) >= cfg.maxUnansweredProactive && !p.lastUserAt) return 'unanswered_limit';
    return null;
}

function lang(user) {
    if (user.languagePreference === 'hinglish') return 'en';
    if (user.languagePreference === 'hi') return 'hi';
    const m = voterMemory.ensure(user);
    return m.language === 'en' ? 'en' : 'hi';
}

function daysLine(n, l) {
    if (n === 0) return l === 'hi' ? 'आज मतदान का दिन है।' : 'Aaj matdaan ka din hai.';
    if (n === 1) return l === 'hi' ? 'कल सोमवार 16 नवंबर को मतदान है।' : 'Kal Somvar 16 November ko matdaan hai.';
    return l === 'hi' ? `मतदान सोमवार 16 नवंबर को है—बस ${n} दिन बाकी।` : `Matdaan Somvar 16 November ko hai—bas ${n} din baaki.`;
}

/** Build the personalised message for one voter (no eligibility checks). */
function planFor(user, { goal = {}, now = new Date(), cfg = config(), dryRun = false } = {}) {
    const brain = require('./reply_brain.js');
    const m = voterMemory.ensure(user);
    const l = lang(user);
    const person = brain.personOf(user, '');
    const hon = brain.honorific(person, l);
    const name = brain.nameFor(user, l);
    const greet = (l === 'hi' ? 'राम राम ' : 'Ram Ram ') + (name ? `${name} ${hon}` : hon) + '! 🙏';
    const n = daysToPoll(now, cfg);
    const stage = user.persuasionStage || (m.commitment.status === 'committed' ? 'committed' : 'unknown');
    const facts = (campaignProfile.load().verifiedFacts || []).join('\n');
    const ward = user.ward || m.ward;
    let kind = null, text = null, used = [];

    const pickItem = (topic, type = null) => {
        const items = kb.byTopic(topic, { type, exclude: m.toldItems, villages: m.village ? [m.village] : [] });
        const { lines, used: u } = kb.renderList(items, l, 1);
        used = u;
        return lines[0] || null;
    };

    const fu = m.openFollowUp;
    if (fu && fu.status === 'open' && (!fu.dueAt || Date.parse(fu.dueAt) <= now.getTime() + 6 * 3600e3)) {
        kind = 'concern_followup';
        const where = fu.ward ? (l === 'hi' ? `वार्ड ${fu.ward} की ` : `ward ${fu.ward} ki `) : '';
        const label = kb.topicLabel(fu.topic, l);
        const line = pickItem(fu.topic, 'future') || pickItem(fu.topic);
        const sid = fu.samasyaId || ((m.samasyaIds || []).slice(-1)[0]) || null;
        text = `${greet} ` + (l === 'hi'
            ? `${where}${label} वाली आपकी शिकायत${sid ? ` (${sid})` : ''} टीम के पास है—कोई नई बात हो तो बताइए।`
            : `${where}${label} wali aapki shikayat${sid ? ` (${sid})` : ''} team ke paas hai—koi nayi baat ho to bataiye.`)
            + (line ? ' ' + line : '') + ' ' + (stage === 'committed'
                ? (l === 'hi' ? 'आपका साथ बना रहे 🙏' : 'Aapka saath bana rahe 🙏')
                : (l === 'hi' ? '16 नवंबर को अभय सिंह जी का साथ देंगे ना?' : '16 November ko Abhay Singh ji ka saath denge na?'));
    } else if (['leaning', 'committed'].includes(stage) && (m.familyVotes || m.told.familyAsk) && !m.told.mulaqatOffer && !(m.mulaqatIds || []).length && !dryRun) {
        kind = 'mulaqat_invite';
        text = `${greet} ` + (l === 'hi'
            ? `आपके साथ के लिए दिल से धन्यवाद। क्या आप अभय सिंह जी को अपने घर बुलाना चाहेंगे? सुविधा का समय बता दीजिए।`
            : `Aapke saath ke liye dil se dhanyavad. Kya aap Abhay Singh ji ko apne ghar bulana chahenge? Suvidha ka samay bata dijiye.`);
        m.told.mulaqatOffer = new Date(now).toISOString();
        m.flow = { type: 'mulaqat_offer', step: 'answer', at: new Date(now).toISOString() };
    } else if (['leaning', 'committed'].includes(stage) && (m.familyVotes || m.told.familyAsk) && !m.told.mulaqatOffer && !(m.mulaqatIds || []).length && dryRun) {
        kind = 'mulaqat_invite';
        text = `${greet} ` + (l === 'hi' ? 'क्या आप अभय सिंह जी को अपने घर बुलाना चाहेंगे? सुविधा का समय बता दीजिए।' : 'Kya aap Abhay Singh ji ko apne ghar bulana chahenge? Suvidha ka samay bata dijiye.');
    } else if (stage === 'committed' && !m.familyVotes && !m.told.familyAsk) {
        kind = 'family_votes_ask';
        text = `${greet} ` + (l === 'hi'
            ? `आपके भरोसे के लिए फिर से धन्यवाद। आपके घर में कुल कितने वोट हैं? सबको 16 नवंबर को साथ लेकर आइएगा।`
            : `Aapke bharose ke liye phir se dhanyavad. Aapke ghar me kul kitne vote hain? Sabko 16 November ko saath lekar aaiyega.`);
        if (!dryRun) m.told.familyAsk = true;
    } else if (stage === 'committed') {
        kind = 'poll_reminder';
        const b = brain.boothForWard(ward, facts);
        text = `${greet} ${daysLine(n, l)} ` + (l === 'hi' ? 'सुबह 7:30 से शाम 5:30, राजकीय उच्च माध्यमिक विद्यालय, सिहाली खुर्द।' : 'Subah 7:30 se shaam 5:30, Govt. Sr. Sec. School, Sihali Khurd.')
            + (b ? (l === 'hi' ? ` आपका बूथ ${b.booth}, कमरा ${b.room}।` : ` Aapka booth ${b.booth}, room ${b.room}.`) : '')
            + (m.familyVotes ? (l === 'hi' ? ` घर के ${m.familyVotes} वोट साथ लेकर आइएगा।` : ` Ghar ke ${m.familyVotes} vote saath lekar aaiyega.`) : '')
            + (!user.lastFoundVoter && !m.told.slipOffer ? (l === 'hi' ? ' पर्ची चाहिए तो नाम और पिता/पति का नाम भेज दीजिए।' : ' Parchi chahiye to naam aur pita/pati ka naam bhej dijiye.') : '');
        if (!user.lastFoundVoter && !dryRun) m.told.slipOffer = true;
    } else {
        kind = 'persuasion';
        const concern = m.concerns.length ? m.concerns[m.concerns.length - 1] : null;
        const audience = person.gender === 'F' ? ['water', 'safety', 'seniors', 'education'] : ['road', 'farming', 'youth', 'water'];
        const topics = [concern && concern.topic, m.lastTopic, ...audience].filter(Boolean);
        let line = null;
        for (const t of topics) { line = pickItem(t); if (line) break; }
        text = `${greet} ` + (line ? (l === 'hi' ? 'एक बात बताना चाहती थी: ' : 'Ek baat batana chahti thi: ') + line + ' ' : '')
            + daysLine(n, l) + ' ' + (concern
                ? (l === 'hi' ? `आपकी ${kb.topicLabel(concern.topic, 'hi')} वाली बात का हल अभय सिंह जी ही करवाएँगे—साथ देंगे ना?` : `Aapki ${kb.topicLabel(concern.topic, 'en')} wali baat ka hal Abhay Singh ji hi karwayenge—saath denge na?`)
                : (l === 'hi' ? 'इस बार अभय सिंह जी का साथ देंगे ना?' : 'Is baar Abhay Singh ji ka saath denge na?'));
    }
    if (goal && goal.task && goal.targetWard && String(goal.targetWard) === String(ward)) text += ' ' + String(goal.task).slice(0, 200);
    text = text.replace(/\s{2,}/g, ' ').trim();
    if (replyQuality.isRepeated(text, user)) return null;
    return { kind, text, used };
}

const NEXT_WINDOW_LABEL = { quiet_hours: 'after quiet hours (08:00 IST)', daily_limit: 'tomorrow 08:00 IST', recently_active: 'after the voter is idle', silence_period: 'none — pre-poll silence (replies only)', after_poll: 'none — poll is over' };
/**
 * Dashboard "Plan" view: what the bot will do next for this voter and roughly when (no side effects).
 * @returns { kind, text, when (ISO|null), whenLabel, blockedBy }
 */
function nextAction(user, now = new Date(), cfg = config()) {
    const clone = JSON.parse(JSON.stringify(user || {}));
    const why = blockReason(clone, now, cfg);
    let when = now, label = 'next planner cycle (≤15 min)';
    if (why) {
        const p = istParts(now);
        const nextMorning = new Date(Date.parse(p.day + 'T08:00:00+05:30') + (p.hour >= 8 ? 86400e3 : 0));
        if (why === 'quiet_hours') { when = nextMorning; label = NEXT_WINDOW_LABEL.quiet_hours; }
        else if (why === 'daily_limit') { when = new Date(Date.parse(p.day + 'T08:00:00+05:30') + 86400e3); label = NEXT_WINDOW_LABEL.daily_limit; }
        else if (why === 'recently_active') { const m = voterMemory.ensure(clone); const last = Date.parse(m.proactive.lastUserAt || clone.lastSeen || 0) || now.getTime(); when = new Date(Math.max(now.getTime(), last + cfg.minIdleHours * 3600e3)); if (inQuietHours(when, cfg)) when = nextMorning; label = 'after ' + cfg.minIdleHours + 'h idle'; }
        else return { kind: null, text: null, when: null, whenLabel: NEXT_WINDOW_LABEL[why] || ('no proactive message: ' + why), blockedBy: why };
    }
    const plan = planFor(clone, { now: when, cfg, dryRun: true });
    if (!plan) return { kind: null, text: null, when: null, whenLabel: 'nothing fresh to say (avoids repeating)', blockedBy: why || 'no_fresh_message' };
    return { kind: plan.kind, text: plan.text, when: when.toISOString(), whenLabel: label, blockedBy: why || null };
}

/** Record that a proactive message went out (call after a successful send). */
function recordSent(user, plan, lineId, now = new Date()) {
    const m = voterMemory.ensure(user);
    const today = istParts(now).day;
    m.proactive.todayCount = m.proactive.lastDay === today ? (m.proactive.todayCount || 0) + 1 : 1;
    m.proactive.lastDay = today;
    m.proactive.lastAt = now.toISOString();
    m.proactive.lastLine = lineId;
    m.proactive.unanswered = (m.proactive.unanswered || 0) + 1;
    m.proactive.sent = (m.proactive.sent || 0) + 1;
    m.proactive.lastKind = plan && plan.kind;
    if (plan && plan.kind === 'concern_followup' && m.openFollowUp) m.openFollowUp.status = 'sent';
    if (plan && plan.used) voterMemory.markTold(user, plan.used);
    user.proactivePingCount = (user.proactivePingCount || 0) + 1; // legacy counter kept in sync
    user.lastPingTime = now.toISOString();
}

function sentTodayOnLine(users, lineId, now = new Date()) {
    const today = istParts(now).day;
    return users.filter(u => u.memory && u.memory.proactive && u.memory.proactive.lastDay === today && u.memory.proactive.lastLine === lineId)
        .reduce((a, u) => a + (u.memory.proactive.todayCount || 1), 0);
}

/**
 * One planning pass for a line. Pure function apart from the provided `send`.
 * @param {object} p { users, lineId, send: async (user, text) => void, goal, now, cfg, onSent }
 * @returns {Promise<{sent: number, skipped: object, reason?: string}>}
 */
async function runCycle({ users, lineId, send, goal = {}, now = new Date(), cfg = config(), onSent = () => {}, gapMs = null }) {
    const skipped = {};
    if (inSilencePeriod(now, cfg)) return { sent: 0, skipped, reason: 'silence_period' };
    if (inQuietHours(now, cfg)) return { sent: 0, skipped, reason: 'quiet_hours' };
    let budget = Math.max(0, cfg.proactivePerLinePerDay - sentTodayOnLine(users, lineId, now));
    if (!budget) return { sent: 0, skipped, reason: 'line_daily_cap' };
    let sent = 0;
    for (const u of users) {
        if (sent >= cfg.proactivePerCycle || sent >= budget) break;
        if (!u || !u.phone || String(u.phone).length < 10) continue;
        if ((u.assignedLine || 'sim_636') !== lineId) continue; // sticky lines
        const why = blockReason(u, now, cfg);
        if (why) { skipped[why] = (skipped[why] || 0) + 1; continue; }
        const plan = planFor(u, { goal, now, cfg });
        if (!plan) { skipped.no_fresh_message = (skipped.no_fresh_message || 0) + 1; continue; }
        try {
            await send(u, plan.text, plan);
            recordSent(u, plan, lineId, now);
            onSent(u, plan);
            sent++;
            if (gapMs) await new Promise(r => setTimeout(r, gapMs()));
        } catch (e) {
            skipped.send_error = (skipped.send_error || 0) + 1;
        }
    }
    return { sent, skipped };
}

module.exports = { DEFAULTS, config, istParts, inQuietHours, inSilencePeriod, daysToPoll, blockReason, planFor, recordSent, runCycle, sentTodayOnLine, nextAction };
