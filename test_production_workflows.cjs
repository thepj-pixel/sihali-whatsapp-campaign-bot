const fs = require('fs');
const path = require('path');
const policy = require('./engagement_policy.js');
const replyQuality = require('./reply_quality.js');
const campaignAgenda = require('./campaign_agenda.js');
const userMemory = require('./user_memory.js');
const aiService = require('./ai_assistant_service.js');

userMemory.save = () => {};

let passed = 0;
let failed = 0;

function check(name, condition) {
    if (condition) {
        passed++;
        console.log(`PASS ${name}`);
    } else {
        failed++;
        console.error(`FAIL ${name}`);
    }
}

async function run() {
    const serverSource = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
    check('dashboard exposes operations status', serverSource.includes('/api/operations-status') && serverSource.includes('ops-summary'));
    check('dashboard exposes editable media times', serverSource.includes('schedule-morning-start') && serverSource.includes('dailySchedule: dailySchedule'));
    check('media uploads use an allowlist and production Git sync', serverSource.includes('MEDIA_UPLOAD_TARGETS') && serverSource.includes('syncUploadedMediaToGit'));

    for (const lineId of ['sim_636', 'baba_aux', 'canada']) {
        const card = policy.buildCampaignVCard(lineId);
        const contact = policy.getLineContact(lineId);
        check(`${lineId} vCard has one number`, (card.match(/TEL;type=/g) || []).length === 1);
        check(`${lineId} vCard uses selected number`, card.includes(contact.waid) && card.includes(contact.display));
    }

    const prompt = policy.buildConsentPrompt('Ravi');
    check('permission prompt is conversational', !prompt.includes('1️⃣') && !prompt.includes('2️⃣'));
    check('normal reply starts requested conversation', policy.parseConsentResponse('meri voter parchi dekhni hai') === 'accepted');
    check('explicit refusal is respected', policy.parseConsentResponse('message mat karo') === 'rejected');

    const pending = { consented: null, consentStatus: 'PENDING', autoPilot: true };
    policy.markConsentPrompted(pending);
    pending.consentPromptedAt = new Date(Date.now() - 4 * 3600000).toISOString();
    check('one reminder becomes due after a few hours', policy.canSendConsentReminder(pending));
    pending.consentReminderCount = 1;
    check('permission reminder is never repeated', !policy.canSendConsentReminder(pending));

    const accepted = { consented: null, consentStatus: 'PROMPTED', autoPilot: true };
    policy.applyConsentDecision(accepted, 'accepted');
    check('accepted contact can receive opted-in follow-up', policy.canSendProactive(accepted));
    policy.applyConsentDecision(accepted, 'rejected');
    check('rejected contact cannot receive proactive follow-up', !policy.canSendProactive(accepted));

    const qualityUser = { languagePreference: 'hinglish', history: [{ role: 'bot', text: 'Same answer again' }] };
    check('duplicate reply is replaced', replyQuality.improve('Same answer again', 'hello', qualityUser) !== 'Same answer again');

    const testPhone = '919000009999';
    const memoryUser = userMemory.getUser(testPhone, 'Test User');
    memoryUser.languagePreference = 'hinglish';
    const firstReply = aiService.getFastLocalAnswer('ram ram', testPhone);
    memoryUser.history.push({ role: 'bot', text: firstReply });
    const secondReply = aiService.getFastLocalAnswer('ram ram', testPhone);
    check('local AI avoids exact repeated reply', replyQuality.normalize(firstReply) !== replyQuality.normalize(secondReply));
    delete userMemory.users[testPhone];

    const schedule = campaignAgenda.getAgenda().dailySchedule;
    check('four media slots are configured', ['morning', 'dopahar', 'evening', 'night'].every(slot => schedule[slot]));
    check('all media slot ranges are valid', Object.values(schedule).every(slot => slot.startHour < slot.endHour));
    const originalAgenda = JSON.parse(JSON.stringify(campaignAgenda.agenda));
    const originalSaveAgenda = campaignAgenda.saveAgenda;
    campaignAgenda.saveAgenda = () => {};
    campaignAgenda.updateAgenda({ dailySchedule: { morning: { startHour: 9, endHour: 10, timeWindow: '09:00 - 10:00' } } });
    check('dashboard media time update is applied', campaignAgenda.getAgenda().dailySchedule.morning.startHour === 9);
    campaignAgenda.agenda = originalAgenda;
    campaignAgenda.saveAgenda = originalSaveAgenda;

    for (const file of ['poster.jpg', 'campaign_reel.mp4']) {
        const target = path.join(__dirname, 'media', file);
        check(`${file} exists and is not empty`, fs.existsSync(target) && fs.statSync(target).size > 0);
    }

    console.log(`RESULT ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exitCode = 1;
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
