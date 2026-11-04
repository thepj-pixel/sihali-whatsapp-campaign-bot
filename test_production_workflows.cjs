const fs = require('fs');
const path = require('path');
const policy = require('./engagement_policy.js');
const replyQuality = require('./reply_quality.js');
const campaignAgenda = require('./campaign_agenda.js');
const userMemory = require('./user_memory.js');
const aiService = require('./ai_assistant_service.js');
const conversationContext = require('./conversation_context.js');
const campaignProfile = require('./campaign_profile.js');
const contactsManager = require('./contacts_manager.js');
const vm = require('vm');
const { spawn } = require('child_process');

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

async function waitForDashboard(url, attempts = 40) {
    for (let i = 0; i < attempts; i++) {
        try {
            const response = await fetch(url);
            if (response.ok) return response;
        } catch (error) {}
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Dashboard did not start at ${url}`);
}

async function run() {
    const serverSource = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
    check('dashboard exposes operations status', serverSource.includes('/api/operations-status') && serverSource.includes('ops-summary'));
    check('dashboard exposes editable media times', serverSource.includes('schedule-morning-start') && serverSource.includes('dailySchedule: dailySchedule'));
    check('dashboard exposes verified facts and talking style', serverSource.includes('/api/campaign-profile') && serverSource.includes('campaign-verified-facts'));
    check('media uploads use an allowlist and production Git sync', serverSource.includes('MEDIA_UPLOAD_TARGETS') && serverSource.includes('syncUploadedMediaToGit'));
    for (const tab of ['feed', 'diagnostics', 'studio', 'playground', 'voters', 'contacts', 'media']) {
        check(`dashboard tab ${tab} is wired`, serverSource.includes(`id="tab-btn-${tab}"`) && serverSource.includes(`id="tab-${tab}"`));
    }
    check('CRM can filter chats by WhatsApp line', serverSource.includes('crm-line-filter') && serverSource.includes('lastSessionId === line'));
    check('dashboard-only test mode disables WhatsApp connections', serverSource.includes("process.env.DASHBOARD_ONLY === 'true'") && serverSource.includes('if (!DASHBOARD_ONLY) setInterval'));
    check('fixed public domain is dashboard-configurable', serverSource.includes('PUBLIC_DASHBOARD_URL') && serverSource.includes('Fixed domain'));
    check('Cloudflare tunnel process is not used by runtime diagnostics', !serverSource.includes('pm2 logs tunnel'));

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
    const nearDuplicateUser = {
        languagePreference: 'hinglish',
        context: { currentTopicLabel: 'water supply', lastConcern: 'pani nahi aa raha' },
        history: [{ role: 'bot', text: 'Aapki pani ki samasya note kar li hai, ward aur jagah bata dijiye.' }]
    };
    const nearDuplicateReply = 'Pani ki samasya humne note kar li hai. Kripya jagah aur ward bata dijiye.';
    check('near-duplicate reply is replaced with topic-aware follow-up', replyQuality.improve(nearDuplicateReply, 'haan wahi', nearDuplicateUser) !== nearDuplicateReply && /water supply/i.test(replyQuality.improve(nearDuplicateReply, 'haan wahi', nearDuplicateUser)));

    const contextualUser = { languagePreference: 'hinglish', voteIntent: null, context: {}, proactivePingCount: 1 };
    conversationContext.updateFromMessage(contextualUser, 'user', 'hamare ward me pani ki problem hai');
    check('conversation context detects the latest topic', contextualUser.context.currentTopic === 'water');
    check('new user reply resets proactive counter', contextualUser.proactivePingCount === 0);
    const contextualNudge = conversationContext.buildProactiveMessage(contextualUser);
    check('proactive message refers to the actual concern', /water|pani/i.test(contextualNudge));
    const doubtfulUser = { languagePreference: 'hinglish', voteIntent: 'no', context: {} };
    check('vote disagreement asks for the reason', /concern|issue/i.test(conversationContext.buildProactiveMessage(doubtfulUser)));
    check('facts input is normalized line by line', campaignProfile.normalizeFacts(' Fact one \n\n Fact two ').length === 2);
    const parsedFacts = campaignProfile.parseImportedFile('- Fact one\n- Fact two', 'facts.md');
    check('one-click facts file import parses markdown lists', parsedFacts.verifiedFacts.length === 2 && parsedFacts.verifiedFacts[0] === 'Fact one');
    const parsedJsonFacts = campaignProfile.parseImportedFile('{"facts":["Verified A"],"style":"Short replies"}', 'facts.json');
    check('one-click facts JSON imports style and facts', parsedJsonFacts.verifiedFacts[0] === 'Verified A' && parsedJsonFacts.talkingStyle === 'Short replies');
    const liveProfile = campaignProfile.load();
    check('updated fact sheet is active', liveProfile.verifiedFacts.some(fact => fact.includes('16 November 2026')) && liveProfile.verifiedFacts.some(fact => fact.startsWith('Future commitment:')));
    check('held road-work details are not published as facts', !liveProfile.verifiedFacts.some(fact => /interlocking/i.test(fact)));

    const originalContacts = contactsManager.contacts;
    const originalContactSave = contactsManager.save;
    contactsManager.contacts = [];
    contactsManager.save = () => {};
    const voterNameCounts = new Map();
    for (const voter of contactsManager.voters) {
        const name = voter.name_en || voter.name || voter.name_hi;
        const normalized = contactsManager.normalizeName(name);
        if (normalized) voterNameCounts.set(normalized, (voterNameCounts.get(normalized) || 0) + 1);
    }
    const uniqueVoter = contactsManager.voters.find(voter => {
        const name = voter.name_en || voter.name || voter.name_hi;
        return name && voterNameCounts.get(contactsManager.normalizeName(name)) === 1;
    });
    const uniqueName = uniqueVoter && (uniqueVoter.name_en || uniqueVoter.name || uniqueVoter.name_hi);
    const importedCsv = contactsManager.parseCSV(`Name,Phone,Ward,Notes\n"${uniqueName}",9876504321,,"CSV, quoted note"`);
    check('CSV contact import handles quoted commas', importedCsv.length === 1 && importedCsv[0].notes === 'CSV, quoted note');
    check('CSV contact can match one unique voter', importedCsv[0]?.voterMatch?.matched === true);
    const importedVcf = contactsManager.parseVCF('BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Contact Only\r\nTEL;TYPE=CELL:+919876504322\r\nEND:VCARD\r\n');
    check('VCF contact import remains supported', importedVcf.length === 1 && importedVcf[0].phone === '919876504322');
    check('voter database import does not fabricate phone numbers', !fs.readFileSync(path.join(__dirname, 'contacts_manager.js'), 'utf8').includes('pseudoPhone'));
    const voterEngineSource = fs.readFileSync(path.join(__dirname, 'voter_engine.js'), 'utf8');
    const contactsSource = fs.readFileSync(path.join(__dirname, 'contacts_manager.js'), 'utf8');
    check('clean deployments load the tracked voter database', voterEngineSource.includes('voters_cleaned.json') && contactsSource.includes('voters_cleaned.json'));
    contactsManager.contacts = originalContacts;
    contactsManager.save = originalContactSave;

    const testPhone = '919000009999';
    const memoryUser = userMemory.getUser(testPhone, 'Test User');
    memoryUser.languagePreference = 'hinglish';
    const firstReply = aiService.getFastLocalAnswer('ram ram', testPhone);
    memoryUser.history.push({ role: 'bot', text: firstReply });
    const secondReply = aiService.getFastLocalAnswer('ram ram', testPhone);
    check('local AI avoids exact repeated reply', replyQuality.normalize(firstReply) !== replyQuality.normalize(secondReply));
    const heldRoadReply = aiService.getFastLocalAnswer('cc road aur interlocking ka detail batao', testPhone);
    check('local fallback holds unverified road details', /verification|सत्यापन/i.test(heldRoadReply) && !/45\+|1000\+/i.test(heldRoadReply));
    const generalWorksReply = aiService.getFastLocalAnswer('baba ne kya kaam karwaya', testPhone);
    check('local fallback uses updated major-work facts', !/45\+|interlocking|सी\.सी/i.test(generalWorksReply) && /library|लाइब्रेरी/i.test(generalWorksReply));
    delete userMemory.users[testPhone];

    const schedule = campaignAgenda.getAgenda().dailySchedule;
    check('daily agenda avoids held road-work claims', !/interlocking|सी\.सी\./i.test(campaignAgenda.getAgenda().topic + ' ' + campaignAgenda.getAgenda().talkingPoints));
    check('four media slots are configured', ['morning', 'dopahar', 'evening', 'night'].every(slot => schedule[slot]));
    check('all media slot ranges are valid', Object.values(schedule).every(slot => slot.startHour < slot.endHour));
    const originalAgenda = JSON.parse(JSON.stringify(campaignAgenda.agenda));
    const originalSaveAgenda = campaignAgenda.saveAgenda;
    campaignAgenda.saveAgenda = () => {};
    campaignAgenda.updateAgenda({ dailySchedule: { morning: { startHour: 9, endHour: 10, timeWindow: '09:00 - 10:00' } } });
    check('dashboard media time update is applied', campaignAgenda.getAgenda().dailySchedule.morning.startHour === 9);
    campaignAgenda.agenda = originalAgenda;
    campaignAgenda.saveAgenda = originalSaveAgenda;

    const smokePort = 32000 + Math.floor(Math.random() * 1000);
    const smokeContacts = path.join(__dirname, 'dashboard_test_contacts.json');
    if (fs.existsSync(smokeContacts)) fs.unlinkSync(smokeContacts);
    const dashboardProcess = spawn(process.execPath, ['server.js'], {
        cwd: __dirname,
        env: {
            ...process.env,
            DASHBOARD_ONLY: 'true',
            PORT: String(smokePort),
            CAMPAIGN_PIN: '2026',
            CONTACTS_DB_PATH: smokeContacts,
            CAMPAIGN_PROFILE_PATH: path.join(__dirname, 'campaign_profile.json')
        },
        stdio: 'ignore'
    });
    try {
        const pageResponse = await waitForDashboard(`http://127.0.0.1:${smokePort}/?pin=2026`);
        const html = await pageResponse.text();
        const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
        let scriptSyntaxOk = scripts.length > 0;
        for (const script of scripts) {
            try { new vm.Script(script); } catch (error) { scriptSyntaxOk = false; }
        }
        check('rendered dashboard inline JavaScript parses', scriptSyntaxOk);
        const health = await (await fetch(`http://127.0.0.1:${smokePort}/health`)).json();
        check('dashboard-only server health is ready', health.status === 'ok' && health.mode === 'dashboard-only');
    } finally {
        dashboardProcess.kill();
        if (fs.existsSync(smokeContacts)) fs.unlinkSync(smokeContacts);
    }

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
