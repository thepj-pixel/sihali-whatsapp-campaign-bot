const fs = require('fs');
const path = require('path');

const LOG_FILE = path.join(__dirname, 'operations_log.jsonl');
const MAX_MEMORY_EVENTS = 200;
const events = [];

function sanitizeMeta(meta = {}) {
    const safe = {};
    const allowed = ['lineId', 'mediaType', 'template', 'reason', 'durationMs', 'statusCode', 'feature'];
    for (const key of allowed) {
        if (meta[key] !== undefined) safe[key] = meta[key];
    }
    return safe;
}

function record(type, status = 'ok', meta = {}) {
    const event = {
        timestamp: new Date().toISOString(),
        type: String(type || 'unknown'),
        status: String(status || 'unknown'),
        meta: sanitizeMeta(meta)
    };
    events.unshift(event);
    if (events.length > MAX_MEMORY_EVENTS) events.pop();
    try {
        fs.appendFileSync(LOG_FILE, JSON.stringify(event) + '\n', 'utf8');
    } catch (error) {
        console.warn('[OperationsTracker] Could not write event:', error.message);
    }
    return event;
}

function getStatus() {
    const counts = {};
    for (const event of events) {
        const key = `${event.type}:${event.status}`;
        counts[key] = (counts[key] || 0) + 1;
    }
    return {
        startedAt: processStart,
        eventCount: events.length,
        counts,
        recent: events.slice(0, 30)
    };
}

const processStart = new Date().toISOString();

module.exports = { record, getStatus, LOG_FILE };
