# HARK_CHANGES — OPS v4 (4–5 Nov 2026): Overview, विरोधी list, contact card per line, Scheduled Bulk

All new logic lives in new modules; `server.js` only has small hooks (`ops_routes.install(app, deps)`, three `${opsRoutes.ui.*()}` inserts in the page, the per-line card check). `reply_brain.js` has exactly one new line (the विरोधी gentle hook at the end of `think()`).

| Feature | Files | API |
|---|---|---|
| 📊 Overview / निष्कर्ष tab | `overview.js`, `ops_routes.js` | `GET /api/overview?stance=&line=&ward=&q=&includeTest=1` |
| 🚫 विरोधी list + gentle mode | `contact_tags.js` (state `contact_tags.json`, gitignored), 1 line in `reply_brain.js` | `GET /api/virodhi`, `POST /api/virodhi/add {text, note}`, `POST /api/virodhi/remove {phone}` |
| 📇 Contact card once per contact **per line** (+ single-send) | `contact_card.js`, `server.js` (`sendLineContactCardOnce`, anti-ban hook, `/api/send-message` → `contactCardQueued`) | — |
| 🗓️ Scheduled Bulk (windowed, randomized, rotating, resumable) | `scheduled_campaigns.js` (state `scheduled_campaigns.json`, gitignored), `ops_routes.js` | `POST /api/scheduled/preview`, `/create`, `/from-agenda {date, slot, …audience}`; `GET /api/scheduled`, `/api/scheduled/:id`; `POST /api/scheduled/:id/pause|resume|cancel` |
| Self-test "fresh contact" mode | `self_test.js` (`freshContact: true` → consent prompt + card like a brand-new number) | `POST /api/self-test/start {…, freshContact:true}` |
| Tests | `test_ops_v4.cjs` (`npm run test:ops`, part of `test:all`) | — |

**Overview.** One row per conversation: name, phone, line, ward, stance (commit / समर्थक / सोच रहे / विरोधी / नाराज़), last message time, a one-line rule-based summary (slip found, issues, family votes, last intents, samasya, mulaqat + the voter's last words), samasya and mulaqat. Totals at the top, a ✅ good and ⚠️ needs-care list, all mulaqat with when/place. Filters: stance, line, ward, search, include test. No CSV/export.

**विरोधी.** Paste numbers in Overview → "🚫 विरोधी list". The record gets `user.virodhi = true`. For them every reply is passed through `contactTags.gentle()`: any sentence that asks for the vote / commitment / family votes / home visit is removed and a respectful listening line is used instead; `installGentleMode` also post-filters the LLM path. Samasya logging is untouched. Scheduled Bulk skips them unless "include विरोधी" is ticked.

**Contact card.** `user.contactCardLines = {lineId: time}`. A voter gets the card of the line they talk to right after our first reply, once per line: after the short intro it is the card alone (no extra "please save" text stacked on it); when the first message is substantive the card follows the brain's reply (anti-ban hook). Note: this reverses v4.4's "card later, not on the intro" because the owner asked for the card instantly after the first reply. Old records with `contactCardSent=true` count as sent on their assigned line, so nobody gets a second card after deploy. Dashboard single-send queues the card if that line has not sent it yet.

**Scheduled Bulk.** Pick audience (paste / saved contacts by ward/village), message variants (separate with a `---` line; `{name}` and `{a|b}` work), tick posters to rotate, a window (preset morning 8–11, afternoon 13–16, evening 17–20, or custom), gap (default 20–90 s), lines. Each recipient gets a random time in the window; per line the gap is enforced; text and poster rotate (balanced). Shares the Bulk Send per-line hourly/daily caps; STOP/declined and विरोधी are checked at plan and at send time; not-on-WhatsApp skipped. Restart-safe (a mid-send item is never resent). Anything still unsent 60 min after the window ends is skipped (`window_passed`) so nothing goes out hours late. Quiet hours are OFF unless ticked. **Agenda slot**: "Schedule agenda slot" uses that day's slot hook + poster and the slot's time window for the chosen audience (operator-triggered). Test campaigns (`test:true`) may only target our own line numbers and wait while a Live Self-Test is running.

---

# HARK_CHANGES — v4 (4 Nov 2026, late night: owner's phone test + "no pings" rule)

**Owner rule: "dont send any ping message other than our dashboard".** The bot never starts a conversation by itself any more.
- New `outbound_settings.js` (state in `outbound_settings.json`, gitignored so a toggle never dirties the VM's git tree). `proactiveOutbound` is **OFF by default**: `runProactiveNudges` (planner follow-ups, persuasion nudges, consent reminders) returns at once, and `followup_planner.runCycle` refuses to send unless the toggle is on (`enabled` param, defaults to the setting). The admin boot ping stays opt-in (`ADMIN_BOOT_REPORT=on`). The night summary only builds on the dashboard; it never sends.
- What still goes out: replies to incoming messages (including the contact card on the first replies) and what the operator triggers from the dashboard (Bulk Send, single send, agenda when the operator presses send).
- **Quiet hours** for Bulk Send (21:00–08:00 IST) are a toggle, **OFF by default** since v4.4. Replies are never blocked by it.
- Dashboard → **📣 Bulk Send → 3️⃣ Lines & Safety Caps → 🔒 Outbound rules**: two checkboxes. API: `GET/POST /api/settings/outbound {proactiveOutbound, quietHours}`. `/health` now shows `outbound`.

**Voter slip (core feature) — new `slip_flow.js`, used by `server.js` and `ai_assistant_service.js`.**
- "Krishan/Krishna/Kishan Kumar" matches the full name (कृष्ण कुमार) before any single word. A ward the voter mentioned for a complaint is only a tie-breaker; only a ward written in the slip message filters.
- With a numbered list pending, "1", "1️⃣", "pehla", "no 2", "dusra" select that entry and the slip (image card) goes out. A number is never read as a ward there.
- Privacy rule kept: a single match asks "क्या आपके पिता/पति का नाम … है?" and sends on "हाँ" (or the father's name). A list shows father/husband names and the voter picks their own entry.
- "meri parchi bhejo" reuses the name already given (or the voter already found). "maine abhi bataya" re-shows the pending list/confirmation, or recalls the found voter.
- Abuse, the candidate's name, news and questions never trigger a slip search.

**Brain v4 (`reply_brain.js`).**
- "Kaam bata saara ka saara" / "सारे काम बताओ" / "what work has been done": a short list of the major done works, then "kisi ek kaam ke baare me vistaar se jaanna ho to bataiye".
- "Elon Musk kon h", "zuckerberg ki news": a light, polite line that the bot only helps with Sihali Khurd panchayat and Abhay Singh ji's works (reviewed template, no LLM).
- Abuse ("kutta", "harami", "bsdk", "nalayak", Devanagari too): calm and dignified, no counter-abuse, four varied lines.
- Corruption allegation ("kha gaya saare paise", "ghotala", "भ्रष्ट"): new `corruption` intent. Calm, no figures, 40 saal nishkalank seva, one work on the ground, and an invitation to name the specific concern.
- Plain insults ("bekar aadmi hai", "chup kar"): respect plus an open door, no works pitch. Taunts keep one work.
- Every negative reply takes an opener not used in the last 8 bot messages; the repeat guard uses the same pool for negative intents.
- Emoji-only and gibberish first messages; English "who is abhay singh / how are you / who are you".

**v4.4 (owner, 22:48 IST).**
- Quiet hours toggle now defaults **OFF** ("don't worry about day/night"). Turn it on from the dashboard if needed.
- **Context-loss fix.** "yahi", "itna hi" and "nahi pata" used to re-run the last voter search on *any* later message ("nahi pata kab banegi sadak" sent a slip again and the chat lost its thread). They now count only as a short answer right after our own slip prompt. Long or problem-like messages ("Ramesh Kumar ke ghar ke paas naali band hai") never become a voter search. The slip only fills blanks in memory (never overwrites name/ward told earlier) and stores `memory.slip` (name, father/husband, voter-list ward), which the LLM memory card carries. Memory updates also run on slip turns. "mera naam yaad hai?" no longer stores "Yaad" as a name.
- **First reply to a new contact:** a real opening message (question, problem, parchi ask) is answered directly. A bare greeting gets a 1-line intro ("राम राम जी 🙏 मैं अभय सिंह जी की टीम से हूँ। बताइए, क्या मदद करूँ—पर्ची, बूथ या गाँव का कोई काम?"). The contact card no longer stacks on the intro; it follows a real reply.
- **Abuse / false allegations, people-pleaser style:** "आपकी नाराज़गी सिर आँखों पर 🙏 आपका काम पूरा हो, यही हमारी कोशिश है—बताइए क्या दिक्कत है, मैं आपकी बात सबसे पहले अभय सिंह जी तक पहुँचाती हूँ।" No denial, no argument, female voice throughout. The first "kuch kaam nahi karwaya" gets an acknowledgement and the question of what is stuck (no works pitch). The next problem-like answer within 45 minutes is logged as a samasya, and no vote ask follows an angry message for 45 minutes. "Aapka kaam zaroor poora hoga" was softened to "aapka kaam poora ho, yahi hamari koshish hai" so the bot never guarantees a fix.
- **Variety across turns and days:** openers, closers and canned lines are logged per voter (`memory.lineLog`, last 60). A line not used before is picked first, then the least recently used one. Works already told stay excluded for good (`toldItems`).

**Tests.** `test:brainv3` adds the owner's transcript, abuse variants, first-message cases and a Devanagari negative run (each with the LLM off and with a stub LLM), slip-flow units (full name, "1", "pehla", reuse of the name, "maine abhi bataya", single-match confirmation), and an assertion that with default settings the proactive timer path and the broadcast timer send nothing.

---

# HARK_CHANGES — Brain v3.1–3.5 (4 Nov 2026, night: fixes from the live self-test)

LLM keys are live on the VM (2 NVIDIA keys). These fixes come from a human read of 11 live self-test scripts.

| Problem seen live | Fix | Files |
|---|---|---|
| "hum to dusre candidate ke saath hain" was read as a commitment | Opponent support is recognised before commitment: dusre/doosre/samne wale (candidate/wale) ke saath, unko/usko vote denge, Abhay Singh ko vote nahi denge, against/khilaf. Commitment now needs no negation ("vote pakka nahi" = undecided) and no third party. The reply respects their choice, asks what matters most to them and does not attack anyone. Praise of the other side ("unka parivar purana hai") is answered with respect plus one work. | `reply_brain.js` |
| "dusre wale to de rahe hain" got a deflection | New `bribe_others` intent: holds the line with a swabhimaan appeal and accuses nobody. | `reply_brain.js` |
| "abhay singh me kya khaas hai" was deflected; "library ke baare me batao" returned his bio | `about_baba` (special) answers with 40 saal seva, bhumi daan for the up-swasthya kendra and one key work. "X ke baare me batao" with a topic goes to that topic. | `reply_brain.js`, `knowledge_base.js` (padhne/padhna/छात्र → education) |
| "tum log chunav me hi yaad karte ho" got "samajh nahi paayi" | New `grievance` intent: empathy ("naraazgi jaayaz hai"), 40 saal saath, asks what the problem is. | `reply_brain.js` |
| Bare "Ji." replies | `short_reply`/`thanks` always add something real: a warm line for elders, an open question, or a recall. New intents: `invite` (thanks warmly for a wedding invite), `money_ask` ("kitne crore": the campaign does not share spending figures; offers the works list), "vote ki baat baad me" (no pressure). The offline suite now fails on any bare Ji/Achha. | `reply_brain.js` |
| "bhai kya scene hai" got a vote ask; "haryanvi me bol" was ignored | Greets naturally first. `dialect_switch` remembers `user.dialectPref` (Haryanvi/Rajasthani), adds a light dialect touch to templates and tells the LLM to write in that dialect. LLM output that ignores the dialect is rejected. Haryanvi "tai/te" (= se) is read as "since". | `reply_brain.js`, `conversation_flows.js` |
| A question mid-samasya ("ladkiyon ke padhne ke liye kya hai") was stored as the location | A question never fills a samasya field. It is answered, then the flow asks its pending question once. "kya hoga iska" gets "no date promised, it is in the register" and the location is asked again. | `conversation_flows.js`, `reply_brain.js` |
| Ghar-visit: "haan ghar bulana hai" saved as the time, the place lost when sent with "8 log", "gaon ki baat karni hai" got "Ji." | One message can fill several fields (when, place, ward, family, purpose). A repeated "ghar bulana hai" re-asks the time. The confirmation shows time, place, ward, purpose and family. A purpose or change sent after logging updates the same record. An already-open request takes new details instead of repeating "pehle se darj". | `conversation_flows.js` |
| "mera naam aur ward yaad hai?" answered with a register number; the name triggered the voter-slip list | A self-introduction ("mera naam X") is stored and answered by the brain. The slip search does not run on it, in either `server.js` or the service, unless the voter asks for a parchi or gives a father/husband name. `memory_check` answers name and ward first. Register numbers show only when asked. | `server.js`, `ai_assistant_service.js`, `reply_brain.js` |
| "hmm" after a sadak complaint re-logged it | Filler after a detour asks the location once and never creates or re-confirms a record. | `conversation_flows.js` |
| Kab se asked before the gali; the visit question pushed again after "theek hai, dhanyavad" | When only the profile ward is known, the bot asks for the gali first. Thanks to the visit offer closes it warmly. The planner may ask again after 20h. "vote pakka" is not taken as a yes to the visit. | `conversation_flows.js` |
| Elder (72) addressed neutrally; knee pain got a works list | "saal ka/ki hu" sets gender, so a 72-year-old man is addressed as Dada ji. Pain plus doctor/hospital gets empathy first, then the up-swasthya kendra and the doctor sankalp. | `voter_memory.js`, `reply_brain.js` |
| "अभय सिंह ने क्या काम करवाए?" got a future sankalp | Past-tense works questions use only DONE items. With no topic, the major works are used (JJM, library, khel maidan, health centre). | `reply_brain.js` |

**LLM path.** The LLM now writes conversational intents: works, topic, future, about, taunt, undecided, positive, daily life, grievance, invite, health, joke, off-topic and unclear/short. Sensitive or fact-exact intents stay on reviewed templates: opposition, bribes, money, the sarpanch question, memory, dialect switch, greeting/thanks/intro and commitment. Beyond the old rules, the validator now also rejects LLM output that:
- drops the draft's facts (`dropped_facts`)
- adds a vote push the draft didn't have (`unasked_vote_push`)
- guesses the voter's gender (`gender_guess`)
- ignores an asked dialect (`no_dialect`/`bad_dialect`)

`<think>` blocks and "Reply:" labels are stripped, and temperature is 0.4. `/api/ai-status` now carries `replyStats`: counts by source (llm / template / flow / llm_rejected), rejection reasons, per-intent counts and the last 60 replies with any rejected LLM text.

**v3.4–3.5 (from the second and third live reads).**
- The LLM may not add a question when the draft has none. A pending samasya question is re-appended after the LLM.
- Self-promises ("prayas karti hoon"), "hum ... samajhti hoon" grammar, and voting pushes in any wording are rejected.
- Robotic tail questions ("kya aapko aur jaankari chahiye?") are stripped.
- Works answers never present a sankalp as done: it is labelled "aage ka sankalp". Major works come first.
- "vote kahan dena hai" goes to polling. Devanagari "भरता है" counts as a complaint.
- Filler after a re-asked place closes the samasya quietly.

**Tests.** `test:brainv3` adds 11 regression conversations, each run with the LLM off and with a stub LLM, plus a pipeline memory conversation, classification units and validator units. Every reply in the suite is now checked for "never a bare Ji/Achha".

---

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

## Dashboard UI fix + mobile quick-add + one identity (2026-11-05)
- **Root cause of "tabs not clickable"**: the tab bar was a single `nowrap` row with `overflow-x: auto`; with 15 tabs the
  newer buttons (Bulk Send, Goal, Self-Test, Samasya, Mulaqat, Voter Plan, Overview, Scheduled) sat off the right edge with
  no visible scrollbar, so on desktop/mouse they could not be reached. JS handlers were fine. Tabs now wrap (desktop) and
  form a 2-column tap grid on phones; one delegated tab handler backs up the per-module listeners; ES5-safe (no `?.`).
- Media Bank reloads on every open and shows an error + retry instead of "empty" when the list call fails.
- Mobile: proper viewport (zoom allowed), 16px inputs, 44px+ tap targets, wide tables scroll inside their card, CRM stacks.
- **➕ Add contact & send now** panel at the top → `POST /api/quick-add-send {phone, name?, ward?, lineId, message:'intro'|'custom', customText?, poster?, forceCard?}`:
  saves the contact on that line, sends intro/custom (+ Media Bank image), then the line's contact card (once per contact per
  line unless `forceCard`). Refuses STOP/declined numbers (409) and disconnected lines (503).
- **identity.js**: one phone normalizer (91XXXXXXXXXX / intl digits; JID → number; @lid → not a phone) and one name source
  (operator-saved Contacts name > voter-memory name > user name > WhatsApp name; placeholders never win). A GET middleware
  applies it to messages, voters, contacts, samasya, mulaqat, voter-plan, overview, scheduled, virodhi, voter/:phone.
- Tests: `test:ui` (real headless Chromium, desktop+mobile, clicks every tab at its on-screen position, fails on console
  errors; skips if no Chromium unless UI_REQUIRED=1; UI_BASE_URL=... to run against live), `test:identity`. Both in test:all.
- HTTP/HTTPS: all dashboard fetches/assets are relative, no https redirect/HSTS in app code, `trust proxy` on, PIN cookie
  is SameSite=Lax + HttpOnly and only `Secure` when the request is https → works on http://IP and behind Cloudflare.
  Real https without SSH: Cloudflare DNS `dash.abhaysinghsihali.in` A → 136.80.218.29 (proxied, orange cloud), SSL/TLS mode
  **Flexible** (origin stays on port 80). Full/Strict would need port 443 + a cert on the VM (needs SSH/Nginx change).
