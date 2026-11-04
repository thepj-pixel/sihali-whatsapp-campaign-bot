// Volume test for chat_queue.js: 250 chats x 3 messages arriving at once (+ duplicates).
const { ChatQueue } = require('./chat_queue.js');
let passed = 0, failed = 0;
const check = (n, c) => { if (c) { passed++; console.log('PASS ' + n); } else { failed++; console.error('FAIL ' + n); } };
(async () => {
    const q = new ChatQueue({ concurrency: 12, jobTimeoutMs: 2000, logger: { error() {} } });
    let running = 0, maxRunning = 0;
    const activePerChat = new Map();
    let overlap = false;
    const order = new Map();
    const replies = new Map();
    const jobs = [];
    for (let c = 0; c < 250; c++) {
        for (let k = 0; k < 3; k++) {
            const chat = 'chat' + c;
            const id = chat + '-m' + k;
            const fn = async () => {
                running++; maxRunning = Math.max(maxRunning, running);
                if (activePerChat.get(chat)) overlap = true;
                activePerChat.set(chat, true);
                await new Promise(r => setTimeout(r, 1 + Math.random() * 8));
                (order.get(chat) || order.set(chat, []).get(chat)).push(k);
                replies.set(id, (replies.get(id) || 0) + 1);
                activePerChat.set(chat, false);
                running--;
            };
            jobs.push(q.enqueue(chat, fn, id));
            if (k === 1) jobs.push(q.enqueue(chat, fn, id)); // duplicate delivery
        }
    }
    // one handler that hangs and one that throws must not block their chats
    jobs.push(q.enqueue('hang', () => new Promise(() => {}), 'hang-1'));
    let afterHang = false;
    jobs.push(q.enqueue('hang', async () => { afterHang = true; }, 'hang-2'));
    jobs.push(q.enqueue('boom', async () => { throw new Error('x'); }, 'boom-1'));
    await Promise.all(jobs);
    check('global concurrency never exceeded 12', maxRunning <= 12);
    check('no two messages of one chat ran in parallel', !overlap);
    check('per-chat order preserved', [...order.values()].every(a => a.join(',') === '0,1,2'));
    check('every message handled exactly once (duplicates suppressed)', replies.size === 750 && [...replies.values()].every(v => v === 1) && q.status().duplicates === 250);
    check('hung handler timed out and chat continued', afterHang && q.status().timeouts === 1);
    check('throwing handler did not crash the queue', q.status().failed === 1);
    check('queue drained', q.status().running === 0 && q.status().waiting === 0);
    console.log(`RESULT ${passed} passed, ${failed} failed`, q.status());
    if (failed) process.exitCode = 1;
})();
