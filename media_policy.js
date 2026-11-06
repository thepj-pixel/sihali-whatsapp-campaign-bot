/**
 * Media policy (5 Nov 2026): which media files may be SENT by any button or engine.
 * Retired posters carry claims that are not on the owner's parcha (budgets, counts, invented sankalp, another
 * person's photo) and the demo poster says "Testing Mode". They stay in the Media Bank for the owner to see,
 * but every send path (CRM quick actions, Bulk Send, Scheduled Bulk, quick add & send, single send) refuses them.
 */
const fs = require('fs');
const path = require('path');

// 7 Nov 2026 (owner): demo reels and the old demo poster taken down from the Media Bank too.
const RETIRED_FILES = new Set(['campaign_reel.mp4', 'baba_namaste_ai.mp4', 'poster.jpg', 'poster_sankalp.png', 'poster_vikas_infra.png', 'poster_statesman.png', 'poster_demo_test.png']);
const RETIRED_IDS = new Set(['reel_sankalp_3d', 'reel_namaste_hero', 'poster_vikas_card', 'poster_sankalp', 'poster_sankalp_3d', 'poster_vikas_infra', 'poster_infra_vikas', 'poster_statesman', 'poster_demo_test']);
const MEDIA_DIR = path.join(__dirname, 'media');

function isRetired(fileOrId) {
    const s = path.basename(String(fileOrId || '')).toLowerCase();
    if (!s) return false;
    return RETIRED_FILES.has(s) || RETIRED_IDS.has(s) || RETIRED_IDS.has(s.replace(/\.[a-z0-9]+$/, ''));
}

function assertSendable(fileOrId) {
    if (isRetired(fileOrId)) throw Object.assign(new Error('Retired media can not be sent: ' + path.basename(String(fileOrId))), { retired: true, noLineError: true });
    return true;
}

/** Approved posters / reels that exist on disk (from media_catalog's own lists, retired excluded). */
function approved(kind, dir = MEDIA_DIR) {
    const mc = require('./media_catalog.js');
    const list = kind === 'video' ? (mc.reels || []) : (mc.posters || []);
    return list.filter(p => !isRetired(p.filename) && !isRetired(p.id) && fs.existsSync(path.join(dir, p.filename)))
        .map(p => ({ id: p.id, title: p.title, file: p.filename, caption: p.caption, path: path.join(dir, p.filename) }));
}

// Source assets the engines use (photo cut-outs, fonts) and retired demo media: kept on disk, not shown in the Media Bank.
const HIDDEN_FROM_BANK = new Set(['baba_face.jpg', 'baba_33_transparent.png', 'NotoSansDevanagari-Bold.ttf', 'NotoSansDevanagari-Regular.ttf']);
function hiddenFromBank(f) { const b = path.basename(String(f || '')); return HIDDEN_FROM_BANK.has(b) || isRetired(b); }

module.exports = { hiddenFromBank, isRetired, assertSendable, approved, RETIRED_FILES };
