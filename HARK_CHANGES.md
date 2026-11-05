# HARK_CHANGES — bulk day 6 Nov 2026: import → scheduled bulk → Status posts (first real 100–200 voters)

New: `contact_import.js`, `status_posts.js`, `status_routes.js`, `test_bulk_6nov.cjs` (`npm run test:bulk`, in `test:all`). Changed: `scheduled_campaigns.js`, `ops_routes.js`, `contacts_manager.js`, `campaign_agenda.js`, `server.js`. Runtime file `status_posts.json` (gitignored).

| Item | Behaviour |
|---|---|
| ① Import | 🗓️ Scheduled Bulk tab → "🚀 Bulk in 3 steps" box (and Contacts → Upload): **.xlsx** (built-in reader, no new npm dependency), **.csv** with any headers (Name/Mobile/Phone/Number/नाम/मोबाइल, Google "First/Last Name" + "Phone 1 - Value"), **.vcf** phone exports (QUOTED-PRINTABLE Hindi names, several TELs), pasted "name number" lines. +91/0/0091/spaces/dashes/Excel numbers → 91XXXXXXXXXX; duplicates and non-Indian-mobile numbers dropped and listed. 👁 Check = dry run (counts: valid, invalid, duplicates, already saved, STOP, virodhi, voter-roll name match); 📥 Import saves with tag **"📥 Bulk 6 Nov"** (default = today). Old `.xls` → "save as xlsx/csv". API `POST /api/contacts/import {fileName, fileBase64|fileText, text, tag, dryRun}`, `GET /api/contacts/tags`, `POST /api/contacts/import-batch/delete {tag}` (undo: deletes contacts the batch created, untags the rest). |
| ② Scheduled bulk | Audience **by tag** (+ "max people"). Presets **morning 09:00–11:30**, **evening 17:30–20:00** IST. Default caps **50/hour, 250/day per line**, gaps 20–90 s. Preview: count, skipped by reason (opted_out / declined / virodhi / already_sent_today / in_other_campaign), duplicates, invalid, text + poster rotation counts, and a warning when the window can't fit everyone at the caps. Nobody gets two scheduled bulk messages within 20 h and nobody is in two active campaigns, so a morning + an evening campaign on the same tag split the list. Retired posters are hidden in the UI and refused server-side at plan and send time. "Send line contact card" per campaign (default on, once per person per line). |
| Auto-pause | A campaign pauses itself (and waits for the operator) after 3 send errors in a row on a line, at once on a ban / rate-limit sign (rate-overlimit, 429/403/401, forbidden, banned, logged out, spam… — the line is also paused for Bulk Send), or when a line is down > 2 min while sends are due. The reason shows in red in the list; Resume clears it. |
| Results | `GET /api/scheduled/:id/results.csv` (phone, name, line, due, status, reason, sent time, text variant, poster, message id; plan-time skips too) — "⬇️ results CSV" link per campaign. |
| ③ 📢 Status posts | New tab: line, optional tag, poster/photo/video from the Media Bank (retired never offered/accepted) or text status, Hindi caption → **Post now** or **Schedule** (HH:MM IST, daily or one date, max 4/day/line). Shown to the line's saved + imported contacts (STOP excluded) + the line itself. The **canada** line is a test line: its status goes to our own numbers only (server-enforced). Schedules persist in `status_posts.json`, survive restarts, never post twice a day, skip a slot missed by > 45 min. Delete a post from the history. API `GET /api/status-posts`, `POST /api/status-posts/{post,audience,schedule}`, `/schedule/:id/{enable,disable,delete}`, `/:id/delete`. |
| ④ Agenda → bulk | `POST /api/scheduled/from-agenda {date, slot, contactTag, …}`: morning/evening use the 09:00–11:30 / 17:30–20:00 windows (or the chosen preset), the operator's texts else the slot hook, the chosen posters else the slot poster else the 🔒 day-lock media (retired dropped). `previewOnly:true` → preview. |

Runbook for the operators: `/workspace/work/live/BULK_RUNBOOK_6NOV.md` (short version below).

**Runbook (short).** 0) Primary Line 🟢; 🔒 Today's goal → goal/points/media → lock → Save. 1) 🗓️ Scheduled Bulk → "🚀 Bulk in 3 steps": choose the file (.xlsx/.csv/.vcf or paste) → 👁 Check → 📥 Import (tag `📥 Bulk 6 Nov`). 2) Audience: tag + **max people ~110**, 3–4 Hindi variants with `{name}` (separated by `---`), tick 1–3 real posters, window **morning 09:00–11:30** (evening 17:30–20:00 with the same tag takes the rest), lines: **Primary only** (never Canada). 3) 👁 Preview (count, skipped by reason, warnings) → 🗓️ Schedule. Monitor in the list (details / ⬇️ results CSV); pause / resume / cancel per campaign. Red "⏸ auto: …" = the bot stopped itself: errors/disconnect → reconnect, wait 2 min, resume; "possible ban / rate-limit" → stop all bulk from that number for 24 h. 📢 Status posts: line → poster/text → caption → Post now or Schedule (09:30 / 13:00 / 17:30 / 20:00, max 4/day). Safe volume for one number: ~100–110 new people per window, ~200–220 per day, gaps 20–90 s.

---

# HARK_CHANGES — dashboard login per person (5 Nov 2026: family members log in with their own username/password)

New module `dashboard_auth.js` (replaces the inline PIN gate in `server.js`). Files, all gitignored, written 0600 atomically: `dashboard_users.json` (`{username, salt, hash (scrypt N=16384 r=8 p=1, 64 bytes), algo, role admin|member, createdAt, updatedAt, disabled, lastLoginAt}` — never plaintext), `dashboard_sessions.json` (sha256 of the token only, 30-day expiry, survives restarts, max 500 — oldest PIN sessions dropped first), `dashboard_audit.jsonl`. Paths overridable with `DASHBOARD_USERS_PATH` / `DASHBOARD_SESSIONS_PATH` / `DASHBOARD_AUDIT_PATH`.

| Item | Behaviour |
|---|---|
| Login page `/login` | Hindi, mobile (16px inputs). With ≥1 active user: यूज़रनेम + पासवर्ड by default and a small "PIN से लॉगिन" link (`/login?mode=pin`); with no users: PIN only. `POST /login` (form → 303 to `next`, open redirects blocked; JSON → `{success, username, role, via}`). Usernames are case-insensitive (stored lowercase, `[a-z0-9._-]{3,32}`), passwords ≥ 8. |
| Session cookie | `dash_session=<random 32 bytes>`; `HttpOnly; SameSite=Lax; Max-Age=30d`; `Secure` only when `X-Forwarded-Proto: https` (or, from a Cloudflare edge, `CF-Visitor` says https) — plain http keeps working. A disabled/deleted user or a password change ends that user's sessions at once; the role is read live. `POST /logout` clears it. Header shows "👤 username" + 🚪 लॉगआउट. |
| Lockout | 5 failed attempts per IP + username per 15 min → 429 + `Retry-After` (even with the right password); also 25/username across IPs. PIN guesses (header, `?pin=`, PIN form): 5 per IP per 15 min, 100 globally. Visitor IP: the TCP peer, or the last `X-Forwarded-For` hop when the peer is a local proxy (nginx); `CF-Connecting-IP` is trusted only when that hop is a Cloudflare range (spoofed headers on a direct hit are ignored). `DASHBOARD_TRUST_CF=all` trusts the headers unconditionally. |
| PIN fallback | `x-campaign-pin` header, `?pin=` links (a browser page gets a server-side session; the PIN is no longer stored in a cookie), the old `campaign_pin` cookie (accepted once and upgraded), the PIN form. PIN = admin, shown as user `PIN`. Changing `CAMPAIGN_PIN` ends PIN sessions. Redirect pages no longer embed the PIN in links. |
| Roles | member: every operator screen/API. admin only: user admin, audit, `/update`, `/api/debug` (was public!), `/api/request-pairing-code`, `/api/ai-keys`, self-test (PIN or admin session). |
| 401s | every `/api/*` without a session/PIN → 401 JSON; pages → login page (401). Public: `/media/*`, `/webhook/*`, `/login`, `/logout`, `/health` — public `/health` is `{status, mode, uptime, brain, linesConnected, lines}`; the detailed one (sessions, queue, outbound) needs a login or the PIN header. |
| Audit "किसने" | Every operator POST/DELETE (send-message, quick-add-send, quick-action, broadcast create/pause, scheduled create/from-agenda/pause, CRM profile/brief, control voter/day/default-mode, follow-ups run, users, virodhi, samasya/mulaqat edits, contacts, media, settings, self-test, logins) → one line `{ts, username, role, via, action, label, method, path, status, ip, detail}` (detail: phone/target/line/mode/date, counts, first 80 chars of the text; never passwords/PIN/keys). Sent-message feed records from send-message / quick-add / CRM quick actions carry `by`. Diagnostics tab → "👥 लॉगिन यूज़र" (admins): add / change password / role, बंद/चालू, हटाएँ, and "🧾 किसने क्या किया (हाल के 50)". |

API (admin = PIN header or admin session): `GET /api/me` → `{success, username, role, via}`; `GET /api/dashboard-users` → `{success, users:[{username, role, createdAt, updatedAt, disabled, lastLoginAt}], roles}`; `POST /api/dashboard-users {username, password, role?, disabled?}` → 201 `{success, created:true, user}` / 200 `{created:false}` (password optional when updating role); `POST /api/dashboard-users/:u/disable` / `/enable` → `{success, user}`; `DELETE /api/dashboard-users/:u` → `{success, deleted}` (an admin session cannot disable/delete itself; 404 unknown); `GET /api/audit?limit=&user=` → `{success, entries:[…]}` newest first.

Tests: `npm run test:login` (`test_login.cjs`, in `test:all`): hashing units, CF ranges, 401s, public /health shape, PIN header/query/form/legacy cookie, admin APIs + validation, no plaintext in the store, member vs admin rights + UI, cookie flags (http vs https), audit (who + no secrets), lockout incl. spoofed headers and per-visitor behind a proxy/CF, disable/enable/password change/delete, logout, session persistence across a restart, PIN lockout.

---

# HARK_CHANGES — v6 operator control (5 Nov 2026: "let me steer the bot")

New module `operator_control.js` (state `operator_control.json`, gitignored) + `operator_control_routes.js` (API + "🔒 आज का लक्ष्य" tab). Hooks in `reply_brain.js`, `nlu.js`, `nlu_router.js`, `voter_memory.js`, `crm_routes.js`/`crm_ui.js`, `overview.js`/`ops_routes.js`, `server.js`.

| Feature | How the operator uses it | Behaviour |
|---|---|---|
| 🔐 Private brief per voter | CRM → chat → 🧾 प्रोफ़ाइल: "इनके बारे में जानकारी" + "बातचीत का तरीका" → 💾 Save | Stored in `user.memory.op`; injected as hidden guidance into the NLU prompt, every LLM reply prompt and the co-pilot. With a brief (or a non-normal mode / locked day) the LLM also writes small-talk turns (greeting after the first, short replies, thanks, positive, commit, family votes) so the brief shapes them. Old "ऑपरेटर नोट्स" moved out of the visible memory card into the same hidden block. |
| Leak guard | — | `leakCheck`: phrases ("मुझे बताया गया", "आपके बारे में नोट/जानकारी", "pata chala", "operator"…), a name from the brief the voter never said (Roman+Devanagari), a content bigram from the brief not in the voter's own messages/style/draft, a number from the brief. On a hit: one regeneration with a warning, else the template. "mere baare me kya pata hai?" / "kisne bataya?" / "kaise pata" → new `privacy_probe` intent with fixed replies ("जो आपने यहाँ बातचीत में बताया, बस वही याद रखती हूँ…"). |
| Mode per voter + global default | Profile: मोड (default / सामान्य / ज़ोरदार / आराम से / नरम), "वोट की बात कितनी बार" (मोड के हिसाब से / हर जवाब / हर 2-3 / कभी-कभार); global default in "🔒 आज का लक्ष्य" | Vote-ask gap: aggressive 0 (may ask every reply, varied asks, hesitation → "किस बात पर सोच रहे हैं—बताइए, मैं साफ़ कर दूँ?"), normal 2, chill 6, gentle never. विरोधी is always gentle. Mode text also goes to the LLM. Badge in the CRM chat header and Overview rows (🔐 = has brief). |
| Operator follow-ups | Profile: फ़ॉलो-अप बंद (default) / रोज़ / हर 2 दिन; "🔁 फ़ॉलो-अप अभी चलाएँ" | 15-min timer (not gated by the proactive toggle — the per-voter setting is the operator trigger). Only if the voter replied before, not STOP/declined, max 1/day, cadence, not within 20h of the last message, quiet hours + pre-poll silence, stops after 2 unanswered. Text = locked bot line (chill/gentle: a hello, no vote push) + the day's media. |
| 🔒 Daily lock | Tab "🔒 आज का लक्ष्य": main goal, talking points (one per line), optional bot line, media (upload from phone or pick from the bank, ≤3, caption), ☑ lock, Save | Keyed by IST date (rolls automatically; 60 days history). Goal + points go to every LLM reply as the locked steer; the bot line is used once per voter per day as the closer; the day's media goes once per voter per day after the first real exchange (or a relevant turn), never to STOP/विरोधी/angry/grieving voters, retired posters can't be attached. Persists across restarts. |
| Memory | — | The LLM memory extractor now also keeps a one-line running `gist` of what the voter said (in the memory card). Prompt rule: never repeat an opener/fact/question, never re-ask known info. |
| Leftovers | — | Hindi replies show a Roman-typed name in Devanagari (no "राम राम Krishan Kumar जी"); "voter card not received" is logged as a samasya (once/24h); the script question never stacks on a reply that already asks something (deferred up to the 3rd reply, then dropped). |

API (PIN): `GET/POST /api/control/day`, `GET /api/control/history`, `POST /api/control/default-mode`, `GET/POST /api/control/voter/:phone`, `GET /api/control/followups`, `POST /api/control/followups/run`; CRM profile GET/POST also carries `about, style, mode, voteAsk, followup`.

**Live-test fixes (v6.1–6.8).** "mere baare me kya pata hai" was answered by recall_self as "आप अभय सिंह जी हैं" — privacy probes now go to the brain and the candidate's name is never stored as the voter's; a son's job hunt is life talk (no jobs-sankalp pitch, no concern logged); the LLM memory may not store a ward/number the voter didn't write; "parchi mil jayegi kya" and "dhanyavad ji" are no longer roll searches; the locked bot line is kept verbatim (no LLM rewrite) on a calm turn; aggressive keeps its vote ask through the LLM (`dropped_vote_ask`); chill/briefed voters get a family question instead of "chunav ka mahaul" and chill never asks for the vote in the first 5 exchanges; no self re-introduction; grammar/promise guards ("आपका … ध्यान रखिएगा", "नौकरी ज़रूर लगेगी"). Self-Test `POST /api/self-test/start {…, op:{about,style,mode,voteAsk}}` simulates a briefed voter.

Tests: `npm run test:v6` (`test_operator_control_v6.cjs`, in `test:all`): brief injection (reply + NLU prompts), leak-guard units, a leaking stub LLM across adversarial turns, modes (aggressive > normal > chill, gentle 0, never rude), daily lock + media once/day + retired filter, follow-up rules, persistence, leftovers.

---

# HARK_CHANGES — v5 NLU (5 Nov 2026, production day: "the bot can't understand context")

**Understanding before routing (`nlu.js`, `nlu_router.js`).** Every text message is first read by an NLU step: the NVIDIA LLM (same keys/cascade as the brain, `NLU_BUDGET_MS` default 4000) gets the last ~12 turns, the voter-memory summary and the pending slip state and must answer strict JSON `{intent, target_person self|other, person_name_hi/roman, father_name, ward, sentiment, refers_to, wants_slip, wants_contact, complaint, script, short_summary}`. `<think>`/code fences are stripped, trailing commas tolerated, every field is whitelisted and filler is removed from names. If the LLM is slow/off/garbled, a rule parser answers (always computed and used as guard-rails: a message about Baba/Abhay Singh or votes is never a slip; a contact ask is always a contact ask). `NLU=off` disables the step, `NLU_LLM=off` keeps rules only. `user.lastNlu` and a log line record each verdict.

**Routing.** contact ask → line number + contact card (sent even if it went before); voter card not received → recalls the name the voter told ("आप कृष्ण कुमार जी हैं न—आपने बताया था"), notes it, "टीम से पता करके बताएँगे" (no invented BLO/e-EPIC process), offers the parchi via father-name confirmation; "koin hu m" → own name; political talk ("baba ke 100 vote kam h") → thanks, "हर एक वोट कीमती है", ask to talk to family/friends (no figure echoed); "हम आपके साथ nhai हैं" → respect + asks the concern; "baba jitenge" → warm thanks. These intents block the slip search entirely.

**Slip for self vs another person.** `user.slipTarget = {who, nameHi, nameRoman}`; a different person clears the old pending list/candidate, so "are bhai bataya naa" refers to the person being searched (never resends someone else's slip). Other-person texts ("इनमें से प्रवीण कुमार जी कौन से हैं?", "क्या उनके पिता का नाम … है?") and a family slip never touches the voter's own memory (`memory.familySlips`). A repeated name with the same list on screen gets one line instead of the list again; a repeated not-found gets a different line. A name that is the father of someone in the open list ("bhawani ram") answers that list. Roll search now uses the English names (`name_en`) and a consonant-skeleton match (parveen/pareven ~ Praveen, bhawani ~ Bhavani); NLU searches are strict (first name must really match; a typed surname like yadav must be in the voter's own name) so "babal yadav" says not found + asks the father instead of listing random people.

**Privacy.** `fatherGiven` never counts "baba/abhay" and never fires on a sentence about votes (the live leak: "baba ke 100 vote kam h" matched कृष्ण पिता अभय सिंह and sent the slip). House numbers are no longer shown before confirmation (list + confirm show name, father/husband, ward); EPIC/house/booth only on the delivered slip.

**Dumb fallbacks removed.** "जी, समझ गई 🙏 और बताइए, घर-गाँव में सब ठीक चल रहा है?" and "आपके यहाँ सब ठीक चल रहा है?" are gone; with an open slip search the bot asks one specific question ("प्रवीण कुमार जी की पर्ची चाहिए? उनके पिता का नाम या वार्ड बता दीजिए 🙏").

**Live-test fixes (v5.1–5.4).** The model is never trusted with facts it could copy from the chat: a father's name, a person's name or a ward it returns must be written in the voter's message (Roman/Devanagari/spelling variants via the roll's own Hindi↔English names), or be the person already being searched — the first live run sent प्रवीण पिता लाल सिंह's slip because the model copied "लाल सिंह" from the list. When the model shrugs (unclear/chitchat/question) but the rules see a specific intent, or the rules are sure of a slip ask (name + "kie/ki parchi"), the rules win. A shorter name from the model ("बबल") gives way to the fuller one from the same message. Repeated asks while a list is open rotate four different one-liners (the third names the fathers already shown, the fourth asks the ward/mohalla).

**Tests.** `npm run test:nlu` (`test_nlu_v5.cjs`, in `test:all`): the owner's whole transcript + a family-slip script, each with a stub LLM (realistic JSON with think-tags/fences) and with the LLM off, plus units (filler strip, transliteration, JSON parse, guard-rails, baba≠father).

---

# HARK_CHANGES — CRM + emoji/photo (5 Nov 2026, production day)

| Item | What changed | Files |
|---|---|---|
| Emoji-only replies | `emoji_sense.js` reads mood: 👍 ✅ 🙏 ❤️ right after our vote ask = **soft commit** (stage committed, `memory.commitment.soft=true`, shown in the memory card); 😡/👎 = empathy + the 45-min grievance window (no vote ask; the next problem is logged); 😂 light; 🤔 invites a question; ❤️/🚩 thanks; 😢 concern. Short replies with a fitting emoji. 👍/🙏/✅ also count as "हाँ" to the slip privacy question. | `emoji_sense.js`, `reply_brain.js`, `slip_flow.js` |
| Photos | `vision_service.js` tries Gemini (if a key exists) then **NVIDIA vision** (`meta/llama-3.2-11b-vision-instruct`, `microsoft/phi-3.5-vision-instruct`, `meta/llama-3.2-90b-vision-instruct`; image shrunk to ≤768px; 9s budget; override with `NVIDIA_VISION_MODELS`, off with `VISION_NVIDIA=off`). `media_understanding.js`: civic photo → samasya ("📷 फोटो प्राप्त", category, notes "photo received") + asks the gali if unknown; poster of Abhay Singh ji → warm thanks; selfie → polite; unreadable → warm ack + one-line ask, and the next problem-like answer is logged as a samasya with the photo noted. The old "चुनाव जीतते ही तुरंत करवाया जाएगा" promise is gone. Caption + unreadable photo → the caption drives the reply. Stickers → light emoji; voice → polite ask to type (no ASR available). `GET /api/vision/probe` checks which vision model answers on the VM. | `vision_service.js`, `media_understanding.js`, `server.js` |
| CRM full chat | Chat pane no longer overflows (min-width:0, wrap, vertical scroll, mobile 62vh). Full history: every message is also appended to `chat_archive/<phone>.jsonl` (gitignored; the 50-message memory history is seeded on first open). `GET /api/crm/chat/:phone?limit=&before=` with "⬆️ पुराने संदेश". New messages appear live (8s poll). Text is HTML-escaped. | `crm_routes.js`, `crm_ui.js` |
| AI सह-चालक | "✨ सुझाव दें" reads the whole conversation + voter memory and runs the reply brain (LLM rephrase + validator; template backstop) on a copy of the record — no samasya/mulaqat is created, the chat is untouched. "🔁 दूसरा सुझाव" gives a different line; "📤 भेजें" sends it. Optional operator instruction is LLM-written and validator-checked. `POST /api/crm/copilot`. | `crm_routes.js`, `crm_ui.js` |
| Voter profile & memory | "🧾 प्रोफ़ाइल व मेमरी": name, father/husband, ward, booth (auto), gender, age, stance, family votes, interests, operator notes, family, last commitment, summary, samasya, mulaqat. Save writes to the record and `user.memory` (operator notes, relName, interests go into the LLM memory card). `GET/POST /api/crm/profile/:phone`. | `crm_routes.js`, `voter_memory.js` |
| Quick actions | New `POST /api/quick-action` (old one is `/api/quick-action-legacy`): STOP/declined → 409; 📇 card (marks the line's card sent); 🙏 safe greeting; 📸 **approved posters only**; 📹 approved reel (button hidden if none); 🎫 slip goes through `slip_flow` (confirmation question first, card only after the voter confirmed); 📝 creates a samasya (note required) + optional voter message; 🤝 creates a mulaqat (when/place/purpose) + optional confirmation (no promised time). Toast feedback for every result. Buttons wrap (2-column grid on phones). | `crm_routes.js`, `crm_ui.js`, `server.js` |
| Retired posters | `media_policy.js`: poster_sankalp / poster_vikas_infra / poster_statesman / poster_demo_test can't be sent by Bulk Send, Scheduled Bulk (create and send time), quick add & send, or CRM. Demo poster mode can only be on when the VM sets `USE_DEMO_POSTERS=true`; the badge shows the real state. | `media_policy.js`, `broadcast_engine.js`, `scheduled_campaigns.js`, `media_catalog.js`, `server.js` |
| Script preference (owner 08:52) | Default reply script is **Hindi (Devanagari)** even for Roman typers. Once, in the 1st reply (2nd if the 1st already asks something; never on top of a samasya question or an angry/sad message) the bot adds "वैसे, आप हिंदी में बात करना पसंद करेंगे या Hinglish (Roman) में? 🙏". The answer is saved as `memory.scriptPref` (`hindi`/`hinglish`, mirrored to `languagePreference`); ignored → stays Hindi, never asked again. Switch any time: "hinglish me baat karo", "हिंदी में लिखो". Honoured by templates, slip flow, the LLM (prompt language) and the validator (`wrong_script` rejects LLM output in the other script). Haryanvi/Rajasthani dialect stays separate. CRM profile shows/edits "जवाब की लिपि". `SCRIPT_ASK=off` disables the question; `DEFAULT_SCRIPT=auto` restores follow-the-voter (used only by the older content suites). `npm run test:script` (26 checks). | `reply_brain.js`, `slip_flow.js`, `voter_memory.js`, `server.js`, `crm_routes.js`, `crm_ui.js`, `test_script_pref.cjs`, `package.json` |
| Tests | `npm run test:crm` (83 checks; in `test:all`). `test:brainv3` expects intent `emoji` for ❤️. | `test_crm_emoji_media.cjs` |

---

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
