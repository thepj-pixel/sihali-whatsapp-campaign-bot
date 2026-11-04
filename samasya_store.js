/**
 * Samasya (problem) register — every problem a voter reports on WhatsApp, with the details the bot asked
 * for (what, where/ward/gali, since when). Runtime data: samasya_log.json (gitignored).
 * Statuses: new -> in-progress -> resolved. Linked to the matching parcha sankalp when one exists.
 */
const os = require('os');
const path = require('path');
const { RecordStore } = require('./record_store.js');

const IS_TEST = /^test/.test(process.env.npm_lifecycle_event || '') || /test_/.test(process.argv[1] || '');
const FILE = process.env.SAMASYA_PATH || (IS_TEST ? path.join(os.tmpdir(), `samasya_test_${process.pid}.json`) : path.join(__dirname, 'samasya_log.json'));

const store = new RecordStore({
    file: FILE,
    prefix: 'S',
    statuses: ['new', 'in-progress', 'resolved'],
    columns: ['id', 'status', 'createdAtIST', 'name', 'phone', 'village', 'ward', 'category', 'description', 'location', 'since', 'sankalpId', 'sankalp', 'line', 'notes', 'test']
});
store.FILE = FILE;
module.exports = store;
