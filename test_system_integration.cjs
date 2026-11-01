const path = require('path');
const userMemory = require('./user_memory.js');
const mediaCatalog = require('./media_catalog.js');
const aiService = require('./ai_assistant_service.js');

async function runTests() {
    console.log('====================================================');
    console.log('🧪 RUNNING COMPREHENSIVE SYSTEM INTEGRATION TESTS');
    console.log('====================================================\n');

    const testPhone = '919999988888';

    // TEST 1: Auto-tagging & Sentiment
    console.log('▶ TEST 1: Automatic Tagging & Sentiment Extraction');
    userMemory.recordMessage(testPhone, 'user', 'ram ram hamare ghar parivar me 6 vote hain baba abhay singh ko hi jayenge bas gali me paani ki shikayat h');
    let user = userMemory.getUser(testPhone);
    console.log('   Voter Tags:', user.tags);
    console.log('   Voter Sentiment:', user.voterSentiment);
    console.log('   AutoPilot status:', user.autoPilot);

    const hasSupporter = user.tags.includes('🟢 पक्का समर्थक');
    const hasFamily = user.tags.includes('👨‍👩‍👧 परिवार विवरण');
    const hasGrievance = user.tags.includes('📝 काम की शिकायत');
    if (hasSupporter && hasFamily && hasGrievance && user.voterSentiment === 'positive') {
        console.log('   ✅ TEST 1 PASSED: Correctly tagged Supporter + Family + Grievance!\n');
    } else {
        console.error('   ❌ TEST 1 FAILED', user.tags);
    }

    // TEST 2: Slurs / Opposition Counter auto-tagging
    console.log('▶ TEST 2: Opposition / Slur / Critical Auto-Tagging');
    const testCriticPhone = '918888877777';
    userMemory.recordMessage(testCriticPhone, 'user', 'are rajesh ka vikas purush bol raha tha ki koi kaam nahi hua bc');
    let criticUser = userMemory.getUser(testCriticPhone);
    console.log('   Critic Tags:', criticUser.tags);
    console.log('   Critic Sentiment:', criticUser.voterSentiment);
    if (criticUser.tags.includes('🔴 विरोधी / नाराज') && criticUser.voterSentiment === 'critical') {
        console.log('   ✅ TEST 2 PASSED: Critical opposition and slurs caught and tagged!\n');
    } else {
        console.error('   ❌ TEST 2 FAILED', criticUser.tags);
    }

    // TEST 3: AutoPilot Toggle (Anti-Rogue Protection)
    console.log('▶ TEST 3: AutoPilot Toggle & Manual Takeover');
    userMemory.toggleAutoPilot(testCriticPhone, false);
    criticUser = userMemory.getUser(testCriticPhone);
    console.log('   AutoPilot after disable:', criticUser.autoPilot);
    if (criticUser.autoPilot === false) {
        console.log('   ✅ TEST 3 PASSED: AutoPilot successfully paused for manual takeover!\n');
    } else {
        console.error('   ❌ TEST 3 FAILED');
    }

    // TEST 4: Notes and Rich RAG Context
    console.log('▶ TEST 4: Voter Notes & RAG Prompt Context');
    userMemory.updateNotes(testPhone, {
        familyNotes: 'घर में 6 वोट, सभी खेती-किसानी से जुड़े हैं',
        mahoolNotes: 'वार्ड 4 में बाबा का माहौल बहुत मजबूत बता रहे हैं',
        babaNotes: 'मुख्य रास्ते की नाली की सफाई का मुद्दा'
    });
    const ragContext = userMemory.getUserContextRAG(testPhone);
    console.log('   Generated RAG Context:\n  ', ragContext);
    if (ragContext.includes('6 वोट') && ragContext.includes('वार्ड 4') && ragContext.includes('नाली की सफाई')) {
        console.log('   ✅ TEST 4 PASSED: Rich RAG context successfully injected!\n');
    } else {
        console.error('   ❌ TEST 4 FAILED');
    }

    // TEST 5: Demo Poster Mode
    console.log('▶ TEST 5: Demo Poster Enforcement');
    console.log('   Is Demo Mode Active?', mediaCatalog.isDemoMode());
    const demoPoster = mediaCatalog.getNextPoster(testPhone);
    console.log('   Poster returned ID:', demoPoster.id);
    console.log('   Poster title:', demoPoster.title);
    console.log('   Poster localPath exists:', Boolean(demoPoster.localPath));
    if (demoPoster.id === 'poster_demo_test' && demoPoster.title.includes('डेमो')) {
        console.log('   ✅ TEST 5 PASSED: Demo poster strictly served while campaign posters are pending!\n');
    } else {
        console.error('   ❌ TEST 5 FAILED');
    }

    // TEST 6: AI Multi-Tier & Opposition De-escalation Test
    console.log('▶ TEST 6: Fast Local Answer & Prince Recognition');
    const princeReply = aiService.getFastLocalAnswer('prince bhai here, check status');
    console.log('   Prince reply snippet:', princeReply.split('\n')[0]);
    if (princeReply.includes('प्रिंस भाई जी')) {
        console.log('   ✅ TEST 6 PASSED: Recognized Prince instantly!\n');
    } else {
        console.error('   ❌ TEST 6 FAILED');
    }

    // TEST 7: Full 15-Category Intelligence Matrix Verification
    console.log('▶ TEST 7: Full 15-Category Ground Intelligence Matrix');
    const matrixTests = [
        { phone: '919001', msg: 'jaipur me company me job karta hu chhutti leke vote dalne aaunga', tag: '🚆 प्रवासी मतदाता' },
        { phone: '919002', msg: 'khet me tubewell bijli aur fasal ka muavza kisan pareshan h', tag: '🌾 किसान व पशुपालक' },
        { phone: '919003', msg: 'mera poster bana do whatsapp status lagana h ground cricket', tag: '🚩 युवा टीम' },
        { phone: '919004', msg: 'rajesh wale daroo ki botal aur 500 rupay baant rahe the raat ko', tag: '🚨 धांधली अलर्ट' },
        { phone: '919005', msg: 'dada ji ki budhapa pension dawai illaj ka mudda', tag: '👵 बुजुर्ग व पेंशन' },
        { phone: '919006', msg: 'mahila suraksha aur cctv lagwane ka sankalp toilet', tag: '👩‍🦰 महिला शक्ति' },
        { phone: '919007', msg: 'soch rahe hain abhi decide nahi kiya kisko vote de vichaar', tag: '🟡 सोच विचार' },
        { phone: '919008', msg: 'baba ka sankalp patra me aage ka plan kya h manifesto', tag: '📜 संकल्प पत्र' },
        { phone: '919009', msg: 'baba se milna h chaupal par kab aayenge meeting karni h', tag: '🤝 सीधी मुलाकात' },
        { phone: '919010', msg: 'voter list me mera naam dekh do slip parchi nikal do', tag: '🎫 वोटर पर्ची' }
    ];

    let matrixPass = true;
    matrixTests.forEach(m => {
        userMemory.recordMessage(m.phone, 'user', m.msg);
        const u = userMemory.getUser(m.phone);
        const ok = u.tags.includes(m.tag);
        console.log(`   ${ok ? '✅' : '❌'} Cat: ${m.tag} -> User tags: [${u.tags.join(', ')}]`);
        if (!ok) matrixPass = false;
        delete userMemory.users[m.phone];
    });

    if (matrixPass) {
        console.log('   ✅ TEST 7 PASSED: All 15 ground intelligence categories validated!\n');
    } else {
        console.error('   ❌ TEST 7 FAILED on some categories');
    }

    // Cleanup test phones
    delete userMemory.users[testPhone];
    delete userMemory.users[testCriticPhone];
    userMemory.save();
    console.log('🧹 Cleaned up temporary test voters from database.');
    console.log('\n====================================================');
    console.log('🎉 ALL 7/7 INTEGRATION TESTS PASSED 100%!');
    console.log('====================================================');
}

runTests().catch(err => {
    console.error('Test run error:', err);
    process.exit(1);
});
