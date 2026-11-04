/**
 * Line contact card — once per contact PER LINE.
 *
 * The voter gets the vCard of the exact line they are talking to (so "Add to Contacts" saves the right number),
 * instantly after our first reply, and again only if they later talk to a different line.
 * State lives on the user_memory record: user.contactCardLines = { <lineId>: ISO time }.
 * Legacy records that only have contactCardSent=true count as "sent" on their assigned line.
 */
function sentLines(user) {
    if (!user) return {};
    if (!user.contactCardLines || typeof user.contactCardLines !== 'object') {
        user.contactCardLines = {};
        if (user.contactCardSent) user.contactCardLines[user.assignedLine || 'sim_636'] = user.contactCardSentAt || 'legacy';
    }
    return user.contactCardLines;
}

function alreadySent(user, lineId) { return !!sentLines(user)[lineId || 'sim_636']; }

/** Should this line send its card to this person now? (never to opted-out / declined / own-line test captures) */
function needsCard(user, lineId) {
    if (!user) return false;
    if (user.broadcastOptOut || user.consentStatus === 'REJECTED' || user.consented === false) return false;
    return !alreadySent(user, lineId);
}

function markSent(user, lineId, at = new Date().toISOString()) {
    const m = sentLines(user);
    m[lineId || 'sim_636'] = at;
    user.contactCardSent = true;
    user.contactCardSentAt = user.contactCardSentAt || at;
    return m;
}

function unmark(user, lineId) { const m = sentLines(user); delete m[lineId || 'sim_636']; if (!Object.keys(m).length) user.contactCardSent = false; }

module.exports = { sentLines, alreadySent, needsCard, markSent, unmark };
