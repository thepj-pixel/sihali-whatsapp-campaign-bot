/**
 * Festival welcome (owner 6 Nov 2026): a NEW voter's first conversation gets Prince's 'प्रमुख कार्य' report card
 * (9x16) with a short festival wish as its caption. Once per voter, ever; never with a vote ask in the same bubble.
 * Date-based in IST: 6 Nov Dhanteras, 7–8 Nov Diwali, 9–11 Nov belated Diwali/Govardhan/Bhai Dooj, later a plain caption.
 */
const FILE_9x16 = 'report_card_major_works_9x16.jpg';
const FILE_1x1 = 'report_card_major_works_1x1.jpg';
// 7 Nov (owner): no election media during the festival — until 11 Nov the welcome image is the Diwali card.
const FILE_DIWALI = 'diwali_card_ivory.jpg';
function fileFor(now = new Date()) { return istDate(now) <= '2026-11-11' ? FILE_DIWALI : FILE_9x16; }

function istDate(now = new Date()) {
    const d = new Date(now.getTime() + 330 * 60000);
    return d.toISOString().slice(0, 10);
}

function captionFor(now = new Date()) {
    const d = istDate(now);
    if (d === '2026-11-06') return '🪔 आपको और आपके परिवार को धनतेरस की हार्दिक शुभकामनाएं 🙏\nबाबा अभय सिंह (मोटी आंगली वाले) की ओर से।';
    if (d === '2026-11-07' || d === '2026-11-08') return '🪔 आपको और आपके परिवार को दीपावली की हार्दिक शुभकामनाएं 🙏\nबाबा अभय सिंह (मोटी आंगली वाले) की ओर से।';
    if (d >= '2026-11-09' && d <= '2026-11-11') return '🪔 दीपावली, गोवर्धन पूजा और भाई दूज की देर से ही सही, हार्दिक शुभकामनाएं 🙏\nबाबा अभय सिंह (मोटी आंगली वाले) की ओर से।';
    return 'बाबा अभय सिंह (मोटी आंगली वाले) की ओर से राम राम 🙏 ये रहे गाँव के प्रमुख काम।';
}

/** New voter = first ever message from them (or a fresh self-test record), not opted out, not sent before. */
function shouldSend(user, { userMsgCount = 0, sensitive = false } = {}) {
    if (!user || sensitive) return false;
    if (user.festivalWelcomeAt) return false;
    if (user.broadcastOptOut || user.consentStatus === 'REJECTED' || user.consented === false) return false;
    return userMsgCount >= 1 && userMsgCount <= 3; // first conversation only (a sensitive first turn waits for the next)
}
function markSent(user, at = new Date().toISOString()) { if (user) user.festivalWelcomeAt = at; }

module.exports = { FILE_DIWALI, fileFor, FILE_9x16, FILE_1x1, captionFor, shouldSend, markSent, istDate };
