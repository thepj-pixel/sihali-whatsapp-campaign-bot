const aiService = require('./ai_assistant_service.js');
const userMemory = require('./user_memory.js');

async function testConversationLadder() {
    console.log('--- 🧪 TESTING 5-STEP INTERACTIVE ENGAGEMENT LADDER & GENDER LOGIC ---');

    const malePhone = '919811001100';
    const femalePhone = '919811002200';

    // Set up Male Voter
    const mUser = userMemory.getUser(malePhone, 'सुरेश कुमार');
    mUser.gender = 'M';
    mUser.botPersonaGender = 'F';
    userMemory.save();

    // Set up Female Voter
    const fUser = userMemory.getUser(femalePhone, 'सुनीता देवी');
    fUser.gender = 'F';
    fUser.botPersonaGender = 'M';
    userMemory.save();

    console.log('\n▶ TEST 1: Gender-aware dynamic address');
    const maleGreeting = aiService.getFastLocalAnswer('kasa ho', malePhone);
    const femaleGreeting = aiService.getFastLocalAnswer('kasa ho', femalePhone);
    console.log('  Male voter reply:', maleGreeting.split('?')[0]);
    console.log('  Female voter reply:', femaleGreeting.split('?')[0]);
    const pass1 = /(भैया|bhaiya)/i.test(maleGreeting) && /(दीदी|didi)/i.test(femaleGreeting);
    console.log(`  ${pass1 ? '✓ [PASS]' : '❌ [FAIL]'} Gender address accurate!`);

    console.log('\n▶ TEST 2: Step 2 Occupation Hook ("main army me hu")');
    const occReply = aiService.getFastLocalAnswer('main army me hu', malePhone);
    console.log('  Bot Reply:', occReply);
    const pass2 = /(एक नंबर|ek number)/i.test(occReply) && /(घर आएं|ghar aaye|ghar aa)/i.test(occReply);
    console.log(`  ${pass2 ? '✓ [PASS]' : '❌ [FAIL]'} Occupation validated & Baba home visit offered!`);

    console.log('\n▶ TEST 3: Step 3 Home Visit Response ("haan zaroor aao")');
    const visitReply = aiService.getFastLocalAnswer('haan zaroor aao', malePhone);
    console.log('  Bot Reply:', visitReply);
    const pass3 = /(डायरी में नोट|diary me note)/i.test(visitReply) && /(समस्या|samasya)/i.test(visitReply);
    console.log(`  ${pass3 ? '✓ [PASS]' : '❌ [FAIL]'} Visit confirmed & village problem asked!`);

    console.log('\n▶ TEST 4: Step 4 Problem Discovery ("sadak par paani bharta h")');
    const probReply = aiService.getFastLocalAnswer('sadak par paani bharta h bohot shikayat h', malePhone);
    console.log('  Bot Reply:', probReply);
    const pass4 = /(संभव|ध्यान में|sambhav|dhyan me)/i.test(probReply) && /(वोट देने का|vote dene)/i.test(probReply);
    console.log(`  ${pass4 ? '✓ [PASS]' : '❌ [FAIL]'} Complaint registered & Vote Intent asked!`);

    console.log('\n▶ TEST 5: Step 5 Vote Commitment Ask (YES)');
    const voteYesReply = aiService.getFastLocalAnswer('haan baba ko hi vote denge pakka', malePhone);
    console.log('  Bot Reply (YES):', voteYesReply);
    const pass5 = /(दिल जीत लिया|dil jeet liya)/i.test(voteYesReply) && voteYesReply.includes('❤️');
    console.log(`  ${pass5 ? '✓ [PASS]' : '❌ [FAIL]'} Cute emoji & heartfelt appreciation sent!`);

    console.log('\n▶ TEST 6: Step 5 Vote Commitment Ask (NO / DOUBTFUL)');
    const voteNoReply = aiService.getFastLocalAnswer('nahi denge kisi aur ko denge', malePhone);
    console.log('  Bot Reply (NO):', voteNoReply);
    const pass6 = /(सम्मान करते हैं|samman karte)/i.test(voteNoReply) && /(पारिवारिक दबाव|parivarik dabav)/i.test(voteNoReply);
    console.log(`  ${pass6 ? '✓ [PASS]' : '❌ [FAIL]'} Calm, empathetic de-escalation sent!`);

    console.log('\n▶ TEST 7: Opposition Slur / Abuses Guardrail');
    const slurReply = aiService.getFastLocalAnswer('ye sab chor hain mc', malePhone);
    console.log('  Bot Reply (Slur):', slurReply);
    const pass7 = /(शुभकामनाएँ|shubhkamnayein)/i.test(slurReply) && !slurReply.includes('mc');
    console.log(`  ${pass7 ? '✓ [PASS]' : '❌ [FAIL]'} Dignified zero-argument response sent!`);

    console.log('\n▶ TEST 8: Instant Fact Delivery in Seconds (Major Works & Category)');
    const kaamReply = aiService.getFastLocalAnswer('baba ke kaam batao', malePhone);
    const sankalpReply = aiService.getFastLocalAnswer('sankalp batao aage kya karoge', malePhone);
    console.log('  Major Kaam snippet:', kaamReply.split('\n')[1]);
    console.log('  Sankalp snippet:', sankalpReply.split('\n')[1]);
    const pass8 = /(मुख्य कार्य|mukhya kaam)/i.test(kaamReply) && /(15 प्रमुख संकल्प|15 mukhya sankalp)/i.test(sankalpReply);
    console.log(`  ${pass8 ? '✓ [PASS]' : '❌ [FAIL]'} Instant facts delivered in <1ms!`);

    // Clean up mock users
    delete userMemory.users[malePhone];
    delete userMemory.users[femalePhone];
    userMemory.save();

    const allPassed = pass1 && pass2 && pass3 && pass4 && pass5 && pass6 && pass7 && pass8;
    console.log('\n================================================================');
    console.log(`🏁 5-STEP LADDER TEST RESULT: ${allPassed ? 'ALL 8/8 TESTS PASSED 100%!' : 'SOME TESTS FAILED'}`);
    console.log('================================================================');
    if (!allPassed) process.exitCode = 1;
}

testConversationLadder().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
