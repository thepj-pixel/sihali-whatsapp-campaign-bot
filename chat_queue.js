/**
 * Incoming message queue for high volume (200+ simultaneous chats).
 *  - per-chat serialization: messages from one person are handled strictly one after another,
 *    so a burst of 3 messages never produces 3 parallel (double) replies
 *  - global concurrency limit across all chats/lines (default 12) so LLM calls, voter-card JPG
 *    generation and sends can't exhaust memory or trip WhatsApp rate limits
 *  - duplicate message-id suppression (Baileys can redeliver on reconnect / retries)
 *  - per-job timeout so one stuck handler can't block a chat forever
 */
class ChatQueue {
    constructor({ concurrency = 12, jobTimeoutMs = 45000, dedupeSize = 5000, logger = console } = {}) {
        this.concurrency = concurrency;
        this.jobTimeoutMs = jobTimeoutMs;
        this.dedupeSize = dedupeSize;
        this.log = logger;
        this.running = 0;
        this.waiting = [];           // global FIFO of ready-to-run jobs
        this.chains = new Map();     // chatKey -> { busy, queue: [] }
        this.seen = new Map();       // message id -> ts
        this.stats = { enqueued: 0, done: 0, failed: 0, duplicates: 0, timeouts: 0, maxWaiting: 0 };
    }

    isDuplicate(id) {
        if (!id) return false;
        if (this.seen.has(id)) { this.stats.duplicates++; return true; }
        this.seen.set(id, Date.now());
        if (this.seen.size > this.dedupeSize) this.seen.delete(this.seen.keys().next().value);
        return false;
    }

    /** Queue fn for chatKey. Resolves when fn finishes (never rejects). */
    enqueue(chatKey, fn, msgId = null) {
        if (this.isDuplicate(msgId)) return Promise.resolve({ duplicate: true });
        this.stats.enqueued++;
        return new Promise(resolve => {
            const key = chatKey || 'unknown';
            let chain = this.chains.get(key);
            if (!chain) { chain = { busy: false, queue: [] }; this.chains.set(key, chain); }
            chain.queue.push({ fn, resolve });
            this.pumpChat(key);
        });
    }

    pumpChat(key) {
        const chain = this.chains.get(key);
        if (!chain || chain.busy || !chain.queue.length) {
            if (chain && !chain.busy && !chain.queue.length) this.chains.delete(key);
            return;
        }
        chain.busy = true;
        const job = chain.queue.shift();
        this.waiting.push({ key, job });
        this.stats.maxWaiting = Math.max(this.stats.maxWaiting, this.waiting.length);
        this.pumpGlobal();
    }

    pumpGlobal() {
        while (this.running < this.concurrency && this.waiting.length) {
            const { key, job } = this.waiting.shift();
            this.running++;
            let timer;
            const timeout = new Promise(res => { timer = setTimeout(() => { this.stats.timeouts++; res({ timeout: true }); }, this.jobTimeoutMs); });
            let result;
            Promise.race([Promise.resolve().then(job.fn), timeout])
                .then(r => { this.stats.done++; result = r; })
                .catch(err => { this.stats.failed++; this.log.error('[ChatQueue] job failed:', err && err.message); result = { error: err && err.message }; })
                .finally(() => {
                    clearTimeout(timer);
                    this.running--;
                    const chain = this.chains.get(key);
                    if (chain) chain.busy = false;
                    job.resolve(result);
                    this.pumpChat(key);
                    this.pumpGlobal();
                });
        }
    }

    status() {
        return { running: this.running, waiting: this.waiting.length, activeChats: this.chains.size, concurrency: this.concurrency, ...this.stats };
    }
}

module.exports = { ChatQueue };
