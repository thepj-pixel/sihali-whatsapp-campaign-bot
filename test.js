const engine = require('./voter_engine.js');

console.log('Testing: Satish (सतीश)');
const r1 = engine.searchVoters('mera naam satish h');
console.log(`Found ${r1.length} match(es)`);
if (r1.length) {
    console.log(engine.formatSlipResponse(r1[0]));
}

console.log('\n----------------------------------------\n');
console.log('Testing EPIC: IED1618552');
const r2 = engine.searchVoters('IED1618552');
console.log(`Found ${r2.length} match(es)`);
if (r2.length) {
    console.log(engine.formatSlipResponse(r2[0]));
}
