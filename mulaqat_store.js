/**
 * Mulaqat register — voters who want Abhay Singh ji to visit their home / meet / call them.
 * The bot only collects the request (preferred date+time, place/landmark, family members, purpose);
 * the team confirms. Runtime data: mulaqat_requests.json (gitignored).
 * Statuses: requested -> confirmed -> done (or cancelled).
 */
const os = require('os');
const path = require('path');
const { RecordStore } = require('./record_store.js');

const IS_TEST = /^test/.test(process.env.npm_lifecycle_event || '') || /test_/.test(process.argv[1] || '');
const FILE = process.env.MULAQAT_PATH || (IS_TEST ? path.join(os.tmpdir(), `mulaqat_test_${process.pid}.json`) : path.join(__dirname, 'mulaqat_requests.json'));

const store = new RecordStore({
    file: FILE,
    prefix: 'M',
    statuses: ['requested', 'confirmed', 'done', 'cancelled'],
    columns: ['id', 'status', 'type', 'createdAtIST', 'name', 'phone', 'village', 'ward', 'preferredWhen', 'preferredDate', 'place', 'familyMembers', 'purpose', 'samasyaId', 'line', 'notes', 'test']
});
store.FILE = FILE;
module.exports = store;
