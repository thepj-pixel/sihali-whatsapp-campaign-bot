# HARK_CHANGES — Brain v2 (4 Nov 2026, evening)

Pushed to `hark/production-ready`, `codex/production-readiness` (live) and `main`. Full design and 20 before/after dialogues: **`BRAIN_V2.md`**.

| Item | What changed | Files |
|---|---|---|
| 1. Knowledge retrieval | The 3 fact sheets load into 134 structured items (title, category, villages, done/future, location). Top 3-5 items are picked by Hindi/Hinglish/dialect synonyms and village names, and feed both the LLM prompt and the local fallback. Budgets are stripped and work counts are never rendered. **Held:** all CC/interlocking lane items and the "45+ CC roads" headline (CONTENT HOLD in `campaign_profile.json`), plus the Gayasi Ram → Sube Singh Panwar road, which the category sheet calls *done* and the operator profile calls *future*. | `knowledge_base.js` (new) |
| 2. Long-term voter memory | `user.memory` holds: name, gender (from verb endings), age group, village/ward, family + household votes, concerns, objections, questions, works already told, commitment, language/dialect, last topic, open follow-up, a rolling summary of older turns and proactive counters. A rule extractor always runs, plus an LLM JSON extractor when keys exist; its output is whitelisted per field. `MEMORY_LLM_EXTRACT=off` disables the LLM extractor. | `voter_memory.js` (new), `user_memory.js` |
| 3. Context | The LLM prompt carries the memory card, rolling summary, last 10 turns, retrieved facts (DONE/FUTURE/already told), stage and goal. Each reply answers the question first, refers back to the voter's own earlier words, never re-tells a work, and closes with one step tied to their concern. The honorific follows gender and age; the reply follows the voter's script. | `reply_brain.js` (rewritten), `ai_assistant_service.js` |
| 4. Proactive follow-ups | The planner checks: consented, not opted out, quiet hours 21-08 IST, max 1 per voter per day, stop after 2 unanswered, sticky line, max 120 per line per day, 3 per 15-minute cycle with 20-45s gaps. It sends a concern follow-up, a household-votes ask, a poll reminder with booth and slip offer, or a matching untold work. **Silence period** from `campaign.silenceStartIST` (default 2026-11-14 18:00 IST) stops follow-ups, consent reminders **and bulk sends**. | `followup_planner.js` (new), `server.js`, `broadcast_engine.js` (`isSilenced`), `campaign_profile.json` (`campaign` block, `opponentNames`) |
| 5. Less dumb | `getFastLocalAnswer` is no longer called by the server; every backstop is `getSafeFallback()`, the grounded v2 composer. Its legacy output is sanitised (no "बाबा जी", counts or budgets), and the invented "toppers" lines and the opponent-attack copy are removed. Canned lines rotate and never repeat back-to-back. New intents: `introduce`, `who_are_you` (honest "automated"), `joke`, `off_topic` (party politics answered neutrally), `opponent` (never attack; move to his work), `memory_check`, `was_sarpanch`, `family_votes`, and jobs (honest: no sankalp). A substantive first reply to the consent prompt is answered instead of getting a canned menu. The consent prompt and STOP ack follow the voter's script. | `reply_brain.js`, `ai_assistant_service.js`, `engagement_policy.js`, `server.js` |
| 6. Hard rules | Validator + tests cover: no "बाबा जी"; no "sarpanch before" claim (asked → "नहीं… सरपंच प्रतिनिधि… 40 साल की सच्ची समाज सेवा"); no money, work counts, caste/religion, threats/bribes, opponent attacks, or fake "slip sent". STOP is permanent. The slogan "5 साल का सच्चा विकास" became "40 साल की सच्ची सेवा". | `reply_brain.js`, `user_memory.js` |
| 7. Live Self-Test | Dashboard tab **🧪 Live Self-Test** plus PIN-checked APIs `/api/self-test/{start,stop,status,runs,result/<id>.json|.md}`. The tester line plays a script to the target line and waits ≤60s per reply. Checks: replied, no banned claims, no repeat, earlier context (`|| words`), on topic. **Own lines now ignore each other outside a run** (loop guard). During a run, only the target treats only the tester as a voter, and the tester never runs its brain. The temporary tester record is deleted afterwards. Results go to `self_test_runs/` (gitignored). | `self_test.js` (new), `server.js` |
| 8. Offline tests | `npm run test:brainv2`: 28 conversations (≥6 turns each) through a fake socket and the real pipeline, or with a stub LLM/extractor. Also knowledge-base, planner and self-test (two fake lines) checks: 2112 assertions. Added to `test:all`. The legacy `test_5step_ladder.cjs` assertion that *required* "15 प्रमुख संकल्प" now requires that **no** count is quoted. | `test_brain_v2_conversations.cjs` (new), `test_5step_ladder.cjs`, `package.json` |
| 9. Docs | This section, plus `BRAIN_V2.md` (generated dialogues via `brain_v2_before_after.cjs`). | |

Also fixed: a **privacy hole** in the voter-slip flow. When the ward was known and several voters matched a bare name, the first match's slip was sent without asking for the father's or husband's name. Now any name match asks for confirmation first, or shows the existing disambiguation list.

### How to run the Live Self-Test (owner)
1. Open the dashboard with your PIN → **🧪 Live Self-Test**.
2. Pick two **connected** lines, for example tester **Canada Line**, target **Primary Line** (the bot under test).
3. Leave the script empty for the default 8 turns, or paste your own (one message per line, optional `|| word1, word2`). Press **▶ Start test**.
4. Watch the transcript fill in. Download **JSON** or **Markdown** from the run line or *Past runs*.

API: `curl -X POST -H "x-campaign-pin: <PIN>" -H "Content-Type: application/json" -d '{"testerLine":"canada","targetLine":"sim_636"}' http://136.80.218.29/api/self-test/start`, then `GET /api/self-test/status`.

---

# HARK_CHANGES — 4 Nov 2026 (earlier: Bulk Send, reply brain v1)

Branch `hark/production-ready`, built on `origin/codex/production-readiness` (7a11870). Local commits only, nothing pushed.

## Shipping it (merge to main + fast-forward codex)

```bash
git checkout codex/production-readiness && git merge --ff-only hark/production-ready
git checkout main && git merge --ff-only hark/production-ready   # main is an ancestor of codex, so this is a fast-forward too
git push origin codex/production-readiness main           # the VM picks this up within ~35s (ff-only auto-update)
```

Do these on the VM once, **before** the update lands:

1. **Rotate both NVIDIA keys.** The old keys are still in Git history and in every clone. Put the new keys in `api_config.json` (already gitignored, and it keeps working) or in `NVIDIA_API_KEYS=key1,key2` in PM2.
2. Set `CAMPAIGN_PIN` on the VM if you want a PIN other than the built-in one.
3. After the update: `pm2 restart whatsapp-bot --update-env`, then `curl localhost:3000/health`. The health output now includes `incomingQueue`.

## What changed

| Area | Files |
|---|---|
| Keys from env, `.env`, or `api_config.json` | `api_keys.js`, `ai_assistant_service.js`, `vision_service.js`, `server.js`, `test_live_nvidia.js`, `CAMPAIGN_FEATURES_ROADMAP.md` |
| Bulk Send | `broadcast_engine.js`, `server.js` (`/api/broadcast/*`, Bulk Send tab) |
| Contacts paste, CSV, and dialer export | `contact_utils.js`, `contacts_manager.js`, `/api/contacts/bulk-add`, `/api/export/dialer.csv` |
| Opt-out policy | `engagement_policy.js` (`isOptOutMessage`, `applyOptOut/applyOptIn`, `broadcastBlockReason`, and a fixed consent-parsing bug) |
| Reply brain | `reply_brain.js`, `ai_assistant_service.js` (`getAIResponse` calls the brain, and `callLLMCascade` has a 7s budget) |
| Volume | `chat_queue.js`, `server.js` (messages.upsert goes through the queue) |
| Media Bank, agenda, daily goal | `server.js` (`/api/media/*`, `/api/agenda/day`, `/api/daily-goal/*`, `/api/voter/stage`), `campaign_agenda.js`, `daily_goal.js` |
| First contact | `server.js`: `autoSaveContact`, `sendLineContactCardOnce`, `queueWhatsAppContactSync` |
| Tests | `test_broadcast_engine.cjs`, `test_reply_brain.cjs`, `test_chat_queue.cjs`, `test_dashboard_tabs.cjs`; `npm run test:all` runs them all |

New runtime files (gitignored): `broadcast_state.json`, `campaign_agenda.json`.

## How to use Bulk Send

Open the dashboard and go to **📣 Bulk Send**.

1. **Audience.** You can paste numbers, one per line, as `phone, name, ward, village`. `+91`, spaces, a leading 0, and 10-digit numbers all work. You can upload a CSV with any of these column names: phone/mobile/number, name, ward, village. You can also tick "Saved contacts", with an optional ward or village filter. Duplicates are removed, invalid numbers are skipped, and opted-out or declined people are excluded automatically.
2. **Message.** Use `{name}` for the person's name and `{राम राम|नमस्ते}` for a random variant. Pick an image, video, or PDF from the Media Bank, or use "Fill from today's agenda slot". Click **Check audience & preview** to see the counts and sample messages.
3. **Lines & caps.** Tick the lines to use. The defaults are 60 per line per hour, 250 per line per day, a 20–60s gap between messages, and quiet hours from 21:00 to 08:00 IST.
4. **Controls.** Start, Pause, Resume, and Cancel. Live progress shows sent, failed, skipped, remaining, and the ETA. Use **Download results CSV** for the full results.

Safety rules the engine always applies:

- Each number is checked with `onWhatsApp()` and skipped if it isn't on WhatsApp.
- A "typing…" indicator shows before every send.
- A line pauses itself after 3 errors in a row. If a line disconnects, it pauses and resumes after 2 minutes of stable connection.
- Lines take turns. Anyone who already talks to one line only ever gets messages from that line.
- The queue is saved to disk after every change, so a pm2 restart picks up where it stopped. A message that was mid-send during a crash is marked `interrupted…` and is never resent.
- Each new recipient gets that line's contact card once, plus a "please save" line.

**STOP / बंद / रुको / मत भेजो** (the whole message has to be one of these): the person is opted out of the bot and all broadcasts for good, and gets one acknowledgement. Only **START / शुरू** re-enrols them.

**Export for calling or IVR** (bottom of the Bulk Send tab, or 📞 Dialer/IVR CSV in Contacts). The columns are `name, phone_10, phone_91, ward, village`. The source can be all contacts (filter by ward or village) or the latest broadcast (filter by status, or reason such as `not_on_whatsapp`). Opted-out numbers are excluded unless you tick the box. There are per-line VCF buttons in Contacts for importing into each phone.

## Other dashboard additions

- **📸 Media tab.** Drag and drop or tap to upload an image, video, or PDF (up to 45 MB). It shows in the list straight away, with "📣 Bulk Send" and delete buttons. Files go to `media/` and are **not** auto-committed.
- **🎯 Goal & Agenda tab.**
  - The goal has a title, a focus for the bot, a target number of people, a target number of पक्के votes, and an optional ward plus a message for that ward.
  - The message is used verbatim in follow-ups to consented people in that ward.
  - Live progress shows people reached, replies, stage changes, and committed votes against the target, broken down per line and per ward.
  - The night summary builds itself at about 21:45 IST, or on a button press.
  - The per-day agenda covers the topic, talking points, and each of the 4 slots' media and hook.
- **CRM.** There's a persuasion-stage filter (unknown, undecided, leaning, committed, opposed, 🚩 needs admin), and each contact shows a stage badge.

## Reply brain in one paragraph

The brain classifies each message into one of these intents: voter slip, complaint, works, future plans, about the candidate, polling, meeting, commitment, undecided, opposed, taunt, bribe, abuse, greeting, thanks, gave a ward, or unclear. It answers that specific thing using only lines from `campaign_profile.json`. Each answer snippet is gated on a matching verified fact, so if the facts are edited out, the claim disappears. It then takes one persuasion step that fits the person's stage, and the step is never repeated word for word.

Persuasion stays within the law: it says no to bribes, sets abuse aside, and asks an opposed person for their reason once and then backs off. It never threatens, appeals to caste or religion, or invents numbers. The person is addressed by gender and age from the voter record (लिंग/आयु) or from their name: माता जी, ताई जी, or बहन जी; दादा जी, ताऊ जी, or भाई साहब. Talking points also follow gender: water, safety, pension, or education for women; roads, farming, or youth for men.

If an LLM key is set, the LLM only *rephrases* the reply. Its output is rejected if it adds numbers, uses banned terms, or repeats an earlier reply, and the grounded template is sent instead. Unclear messages get one short clarifying question and are flagged 🚩 for an admin. `REPLY_BRAIN=off` brings back the old path. Before and after examples are in `REPLY_BRAIN_BEFORE_AFTER.md`.
