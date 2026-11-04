# Brain v2 — a campaign worker with memory

Owner's ask: the bot was "too dumb". It gave the same pitch again and again, forgot what the voter said, and quoted things the sheets don't allow. Brain v2 aims to answer like a good campaign worker. It answers the question first, remembers the voter, uses only the fact sheets, and moves every chat warmly toward a committed vote for Abhay Singh.

## Pipeline (one voter message)

1. **STOP / बंद / रुको** is handled before anything else (`engagement_policy.js`). It is permanent: no replies, no follow-ups and no bulk sends until the voter writes START.
2. **Consent.** A new contact gets the intro prompt in their own script (Hinglish or Devanagari). If their first reply is a real question or problem, it counts as consent *and is answered*. They no longer get a canned menu.
3. **Memory update** (`voter_memory.js`). The rule extractor always runs. When an LLM key is configured, an LLM JSON extractor also runs (2.5s budget), and its output is whitelisted field by field. Facts kept per voter in `user_memory.json → user.memory`:
   - name, gender (from verb endings such as *raha/rahi*, रहा/रही), age / age group, village and ward (village is inferred from the ward)
   - family members, household votes ("ghar ke 4 vote")
   - concerns (topic, text, ward, how often raised), objections, questions
   - works already told (never re-told), commitment stage, language/dialect (Haryanvi / Rajasthani markers), last topic
   - open follow-up ("asked about road in ward 5"), proactive counters
   - a **rolling summary** of turns older than the last 10. It survives history trimming.
4. **Intent.** The v1 intents are kept, and these are new: `introduce`, `who_are_you`, `joke`, `off_topic` (party politics is answered neutrally), `opponent`, `memory_check` ("yaad hai?"), `was_sarpanch`, and `family_votes`.
5. **Retrieval** (`knowledge_base.js`). The three fact sheets load into 134 structured items: 12 major works, 15 sankalp and 107 category-wise works with places. Each item has a title, category, villages and type (done/future). Retrieval returns the top 3-5 items by Hindi/Hinglish/dialect synonyms, village names and type wanted. It skips items the voter was already told.
   - **Content hold.** All 49 CC/interlocking lane items, the "45+ CC roads" headline and the khel-maidan tile approach road are held. The bot says the lane-wise list is under verification and asks for the lane or ward.
   - **Conflict.** The category list marks the Gayasi Ram → Sube Singh Panwar road as *done*. `campaign_profile.json` (operator, 4 Nov) lists it as a *future* commitment, so that item is held until the operator confirms.
   - Budgets and rupee figures are stripped on load. Work totals are never rendered.
6. **Compose.** The answer comes first. It refers back to what the voter told earlier (their concern, ward or family votes). It then adds one short persuasive close tied to *their* concern ("आपकी सड़क वाली बात पर काम अभय सिंह जी ही करवाएँगे—16 नवंबर को उनका साथ देंगे ना?"). Rules:
   - The honorific follows gender and age (माता जी / ताई जी / बहन जी / दादा जी / ताऊ जी / भाई साहब).
   - The reply uses the voter's script.
   - A committed voter is asked for household votes once, then offered the booth and a voter slip.
7. **LLM (if keys).** The LLM writes from the full context. That context is:
   - the memory card and rolling summary
   - the last 10 turns
   - the retrieved fact lines, each marked DONE or FUTURE and "already told"
   - the stage, today's goal, the hard rules and the grounded draft

   The output is rejected if it has any of these:
   - the wrong script, or more than 480 characters
   - a number that is not in the facts
   - "बाबा जी", a sarpanch-before claim, rupees/budget, a work count, an opponent attack, caste/religion, a bribe or threat, a claim that a slip was sent
   - a repeat of an earlier reply

   When the output is rejected, the grounded draft is sent instead.
8. **No repeats.** A reply that matches or nearly matches any of the last 6 bot messages is swapped for a varied, memory-aware redirect. Canned lines rotate, so the same one never goes out twice in a row.

The legacy `getFastLocalAnswer` engine is neutralised. `server.js` never calls it now; every backstop uses `aiService.getSafeFallback()`, which is the synchronous v2 composer. Its output also passes through `sanitizeLegacy()`, which removes "बाबा जी", counts and budgets, for the old tests and `REPLY_BRAIN=off`.

## Hard rules (enforced in code)
- The candidate is "अभय सिंह जी" or "बाबा अभय सिंह", never a bare "बाबा जी".
- **Never** claim he was sarpanch before. If asked, the bot says he was not; he worked as सरपंच प्रतिनिधि and is known for 40 साल की सच्ची समाज सेवा.
- No threats, bribes, caste/religion appeals or invented facts. Opponents are never attacked; the bot moves to Abhay Singh's work instead.
- STOP/बंद/रुको is honoured permanently.

## Proactive follow-ups (`followup_planner.js`)
Every 15 minutes per line it sends up to 3 messages, with 20-45s gaps. A voter gets one only when all of these hold:
- consented, never opted out, autopilot on
- outside quiet hours (21:00-08:00 IST)
- before the **silence period**
- 1 per voter per IST day at most
- fewer than 2 unanswered follow-ups (a voter reply resets the count)
- not active in the last 3 hours, not opposed, on their sticky line
- under 120 per line per day

What it sends depends on the voter:
- With an open concern: a concern follow-up plus a matching sankalp or work.
- Committed, household votes not yet asked: an ask for household votes.
- Committed: a poll reminder with booth, household votes and a slip offer.
- Everyone else: a work matching their concern that they haven't been told, plus days left and a soft ask.

The silence period is `campaign_profile.json → campaign.silenceStartIST` (default `2026-11-14T18:00:00+05:30`, 48h before the poll). During it, follow-ups, consent reminders and **bulk sends** stop. Replies to voters who write in continue.

## Live Self-Test
Dashboard → **🧪 Live Self-Test**, or the PIN-protected API:
- `POST /api/self-test/start {testerLine, targetLine, script?}` (script: one message per line, with optional `|| word1, word2` context words)
- `GET /api/self-test/status`
- `GET /api/self-test/runs`
- `GET /api/self-test/result/<runId>.json|.md`
- `POST /api/self-test/stop`

The tester line sends each scripted message to the target line and waits up to 60s for the real reply. Each turn is checked for:
- a reply within 60s
- no banned claims
- no repeat
- reference to earlier context (the `||` words)
- on topic

Loop safety: outside a run, our lines ignore each other. During a run, only the target treats only the tester as a voter, and the tester never runs its brain. The tester's temporary voter record is removed afterwards.

## Tests
`npm run test:brainv2` runs 28 conversations (each at least 6 turns) through a fake socket and the real pipeline, or through the brain with stub LLM and stub extractor. It also covers the knowledge-base unit checks, the planner rules and the self-test harness with two fake lines. `npm run test:all` runs everything.

To regenerate the dialogues below: `git archive dd67584 | tar -x -C /tmp/before && BEFORE_DIR=/tmp/before node brain_v2_before_after.cjs`.

<!-- DIALOGUES:START -->
## 20 before/after dialogues

"Before" = `reply_brain.js` at dd67584 (v1, template path). "After" = Brain v2 (fact-sheet retrieval + per-voter memory + concern-tied closers + non-repetition), also template path — no LLM keys in the sandbox. With keys on the VM, the LLM rewrites the v2 draft from the full context and is validated against the same rules.

## 1. Road concern, then asked to recall it

| Voter | Before (v1) | After (v2) |
|---|---|---|
| Ram ram | Ram Ram ji! 🙏 Ghar-parivar me sab kushal-mangal? Aapke mohalle me is baar chunav ka kya mahaul hai? | Ram Ram ji! 🙏 Ghar-parivar me sab kushal-mangal? Aapke mohalle me is baar chunav ka kya mahaul hai? |
| main ward 5 Sihali Khurd se hu | Ward 5 note kar liya ji. Aapka booth 96, room 2 rahega. 16 November ko Abhay Singh ji ka saath denge na? | Ji, aapse judkar bahut achha laga! 🙏 Ward 5 note hai—aapka booth 96, room 2 rahega. Aapke yahan sabse zaroori kaam kaun sa hai—paani, sadak, naali ya kuch aur? |
| hamare ward me sadak tooti padi hai, kab banegi? | Aapki baat note kar li hai ji, ise seedhe Abhay Singh ji ki priority list me daal rahi hoon. Sihali Kalan–Hadahedi main road pakki damar bani, aur Ashram se Sihali Kalan ka rasta bhi dobara bana. Bas itna sochiyega—40 saal se gaon ke sukh-dukh me kaun saath khada raha. 16 Nov ko Abhay Singh ji ka saath denge na? | Aapki baat note kar li hai ji, ise seedhe Abhay Singh ji ki priority list me daal rahi hoon. Sihali Khurd se Hadahedi ko jodne wali mukhya sadak ka chaudikaran aur achhi damar sadak banwane ka sankalp hai. Aapki sadak wali baat par kaam Abhay Singh ji hi karwayenge—16 Nov ko unka saath denge na? |
| meri sadak wali baat yaad hai? | Sihali Kalan–Hadahedi main road pakki damar bani, aur Ashram se Sihali Kalan ka rasta bhi dobara bana. Galiyon ki interlocking/CC ki poori list abhi verify ho rahi hai, isliye us par pakka karke hi bolenge. Gaon ki izzat aur kaam dono dekh kar faisla kijiye. Abhay Singh ji par bharosa karke dekhenge na? | Bilkul yaad hai ji! Aapne ward 5 ki sadak wali baat batayi thi—wo Abhay Singh ji ki priority list me darj hai. (ward 5 bhi note hai.) Sihali Kalan se Hadahedi main road, Ashram marg, Baniya Wala Kundi marg aur Radwa marg pakki damar sadak ke roop me dobara bane aur chaude hue. Bas itna sochiyega—40 saal se gaon ke sukh-dukh me kaun saath khada raha. 16 Nov ko Abhay Singh ji ka saath denge na? |

## 2. Same question three times

| Voter | Before (v1) | After (v2) |
|---|---|---|
| kya kaam kiya? | Sihali Khurd aur Sihali Kalan me JJM ki tankiyan, ghar-ghar nal connection aur pipeline ka kaam hua hai, aur 6 naye borewell motor ke saath lage hain. Jin gharon tak nal abhi nahi pahuncha, wahan JJM ka bacha kaam poora karna pehla sankalp hai. Bas itna sochiyega—40 saal se gaon ke sukh-dukh me kaun saath khada raha. 16 Nov ko Abhay Singh ji ka saath denge na? | Jal Jeevan Mission ke tahat paani ki tankiyan, ghar-ghar nal connection aur paani ki kami wali jagahon par naye borewell lage. Bas itna sochiyega—40 saal se gaon ke sukh-dukh me kaun saath khada raha. 16 Nov ko Abhay Singh ji ka saath denge na? |
| kya kaam kiya? | Sihali Khurd aur Sihali Kalan me JJM ki tankiyan, ghar-ghar nal connection aur pipeline ka kaam hua hai, aur 6 naye borewell motor ke saath lage hain. Jin gharon tak nal abhi nahi pahuncha, wahan JJM ka bacha kaam poora karna pehla sankalp hai. Gaon ki izzat aur kaam dono dekh kar faisla kijiye. Abhay Singh ji par bharosa karke dekhenge na? | Panchayat ke purane johad aur jalashay gehre khudwakar theek karwaye gaye, aur kisanon ke liye farm pond bana. Gaon ki izzat aur kaam dono dekh kar faisla kijiye. Abhay Singh ji par bharosa karke dekhenge na? |
| kya kaam kiya? | main pichhli baat repeat nahi karunga. Voter parchi, ward information, ya gaon ki problem me kya help chahiye? | Jal Jeevan Mission me jo ghar abhi bache hain, wahan tak meetha paani pahunchana pehli prathmikta hai. Jo kaam karke dikhaye, usi par bharosa banta hai. Is baar Abhay Singh ji ka saath denge na? |

## 3. Water question in Hindi from Hadahedi woman

| Voter | Before (v1) | After (v2) |
|---|---|---|
| मैं हाड़ाहेड़ी से बोल रही हूँ | माफ़ कीजिए जी, ठीक से समझ नहीं पाई। आपको वोटर पर्ची चाहिए, गाँव की कोई समस्या बतानी है, या अभय सिंह जी से कुछ पूछना है? | बहन जी, आपसे जुड़कर बहुत अच्छा लगा! 🙏 आपके यहाँ सबसे ज़रूरी काम कौन-सा है—पानी, सड़क, नाली या कुछ और? |
| हमारे यहाँ पानी की बहुत दिक्कत है | आपकी बात नोट कर ली है जी, इसे सीधे अभय सिंह जी की प्राथमिकता सूची में डाल रही हूँ। सिहाली खुर्द और सिहाली कलां में JJM की पानी की टंकियाँ, घर-घर नल कनेक्शन और पाइपलाइन का काम हुआ है, और 6 नए बोरवेल मोटर समेत लगे हैं। किस वार्ड/गली की बात है, बता देंगे? | आपकी बात नोट कर ली है बहन जी, इसे सीधे अभय सिंह जी की प्राथमिकता सूची में डाल रही हूँ। संकल्प: जल जीवन मिशन के अंतर्गत शेष रहे हर घर तक मीठे पानी की आपूर्ति को प्राथमिकता पर पूर्ण किया जाएगा। किस वार्ड/गली की बात है, बता देंगे? |
| आगे क्या करेंगे पानी के लिए? | जिन घरों तक नल अभी नहीं पहुँचा, वहाँ JJM का बचा काम पूरा करना पहला संकल्प है। बस इतना सोचिएगा—40 साल से गाँव के सुख-दुख में कौन साथ खड़ा रहा। 16 नवंबर को अभय सिंह जी का साथ देंगे ना? | जैसा बताया था—JJM शेष जल आपूर्ति पूर्णता। आपकी पानी वाली बात पर काम अभय सिंह जी ही करवाएँगे—16 नवंबर को उनका साथ देंगे ना? |

## 4. Committed voter gives family votes

| Voter | Before (v1) | After (v2) |
|---|---|---|
| pakka vote denge | Dil se dhanyavad ji! 🙏 Aapka yahi bharosa Abhay Singh ji ki asli taakat hai. Ghar ke baaki voters ko bhi saath laaiyega—subah 7:30 se shaam 5:30, Govt. Sr. Sec. School, Sihali Khurd. | Dil se dhanyavad ji! 🙏 Aapka yahi bharosa Abhay Singh ji ki asli taakat hai. Ghar me kitne vote hain? Sabko 16 November ko saath lekar aaiyega. |
| ghar ke 4 vote hain | Ji ji. Apne parivar aur padosiyon tak bhi Abhay Singh ji ki baat pahunchaiyega, yahi asli saath hai. | Dil se dhanyavad ji! 🙏 Ghar ke 4 vote note kar liye—aapka yahi bharosa Abhay Singh ji ki asli taakat hai. Parchi chahiye to apna poora naam aur pita/pati ka naam bhej dijiye. |
| dhanyavad | Ji ji 🙏 | Ji 🙏 |

## 5. Opponent mentioned

| Voter | Before (v1) | After (v2) |
|---|---|---|
| dusra candidate bolta hai abhay singh ne kuch nahi kiya | Sawal poochna aapka haq hai ji. Sihali Khurd aur Sihali Kalan me JJM ki tankiyan, ghar-ghar nal connection aur pipeline ka kaam hua hai, aur 6 naye borewell motor ke saath lage hain. Jis jagah kaam adhoora lage, us gali/ward ka naam bataiye—Abhay Singh ji khud dekhenge. Bas itna sochiyega—40 saal se gaon ke sukh-dukh me kaun saath khada raha. 16 Nov ko Abhay Singh ji ka saath denge na? | Ji, hum kisi ummeedwar ke baare me bura nahi kehte—sabka samman hai. Faisla kaam dekh kar kijiye: Jal Jeevan Mission ke tahat paani ki tankiyan, ghar-ghar nal connection aur paani ki kami wali jagahon par naye borewell lage. Bas itna sochiyega—40 saal se gaon ke sukh-dukh me kaun saath khada raha. 16 Nov ko Abhay Singh ji ka saath denge na? |
| aur kya kaam kiya? | Sihali Khurd aur Sihali Kalan me JJM ki tankiyan, ghar-ghar nal connection aur pipeline ka kaam hua hai, aur 6 naye borewell motor ke saath lage hain. Jin gharon tak nal abhi nahi pahuncha, wahan JJM ka bacha kaam poora karna pehla sankalp hai. Gaon ki izzat aur kaam dono dekh kar faisla kijiye. Abhay Singh ji par bharosa karke dekhenge na? | Panchayat ke purane johad aur jalashay gehre khudwakar theek karwaye gaye, aur kisanon ke liye farm pond bana. Gaon ki izzat aur kaam dono dekh kar faisla kijiye. Abhay Singh ji par bharosa karke dekhenge na? |

## 6. "Was he sarpanch before?"

| Voter | Before (v1) | After (v2) |
|---|---|---|
| kya abhay singh pehle sarpanch the? | Maaf kijiye ji, theek se samajh nahi paayi. Aapko voter parchi chahiye, gaon ki koi samasya batani hai, ya Abhay Singh ji se kuch poochna hai? | Nahi ji, Abhay Singh ji khud pehle sarpanch nahi rahe. Pichhle karyakal me sarpanch pratinidhi ke taur par aur 40 saal ki sachchi samaj seva me unhone gaon ke kaam karwaye—is baar wo khud sarpanch pratyashi hain. Bas itna sochiyega—40 saal se gaon ke sukh-dukh me kaun saath khada raha. 16 Nov ko Abhay Singh ji ka saath denge na? |
| achha | Ji ji. 16 November ko Abhay Singh ji ka saath denge na? | Ji. Gaon ki izzat aur kaam dono dekh kar faisla kijiye. Abhay Singh ji par bharosa karke dekhenge na? |

## 7. Who are you / bot?

| Voter | Before (v1) | After (v2) |
|---|---|---|
| tum kaun ho? | Abhay Singh ji (Moti Aangli wale) Gram Panchayat Sihali Khurd se Sarpanch pratyashi hain—40 saal se gaon ki seva aur bhaichare me lage hain. Apni pushtaini zameen daan karke gaon ka up-swasthya kendra banwaya. Bas itna sochiyega—40 saal se gaon ke sukh-dukh me kaun saath khada raha. 16 Nov ko Abhay Singh ji ka saath denge na? | Main Suman hoon ji—Baba Abhay Singh jansampark team ki digital sahayika (automated). Voter parchi, booth, gaon ke kaam ya koi shikayat—sabme madad karti hoon; zaroorat ho to team ka koi saathi khud phone karega. |
| bot ho kya? | Maaf kijiye ji, theek se samajh nahi paayi. Aapko voter parchi chahiye, gaon ki koi samasya batani hai, ya Abhay Singh ji se kuch poochna hai? | Ji, main automated digital sahayika hoon, insaan nahi—par aapki har baat team tak pahunchti hai. Baat karni ho to team ka saathi khud phone karega. |

## 8. Joke and party politics

| Voter | Before (v1) | After (v2) |
|---|---|---|
| joke sunao | Ji ji. 16 November ko Abhay Singh ji ka saath denge na? | 😄 Hansi-mazaak se hi to gaon ki chaupal me raunak hai ji! Waise sachchi khushi tab hogi jab har ghar nal me meetha paani aayega—usi ka sankalp hai. 16 November ko Abhay Singh ji ka saath denge na? |
| modi ke baare me kya kehna hai | Maaf kijiye ji, theek se samajh nahi paayi. Aapko voter parchi chahiye, gaon ki koi samasya batani hai, ya Abhay Singh ji se kuch poochna hai? | Ji, ye panchayat ka chunav hai—isme kisi party ki baat nahi, bas gaon ke kaam aur bharose ki baat hai. Aapke ghar-mohalle me sabse zaroori kaam kya hai? |

## 9. Lane CC/interlocking (content hold)

| Voter | Before (v1) | After (v2) |
|---|---|---|
| hamari gali me interlocking kab lagegi? | Maaf kijiye ji, theek se samajh nahi paayi. Aapko voter parchi chahiye, gaon ki koi samasya batani hai, ya Abhay Singh ji se kuch poochna hai? | Aapki baat note kar li hai ji, ise seedhe Abhay Singh ji ki priority list me daal rahi hoon. Galiyon ki CC/interlocking ka gali-war byora abhi jaanch me hai, isliye us par pakka karke hi bataungi. Toot chuki sadkon ko dobara majboot banwane ka sankalp hai. Kis ward/gali ki baat hai, bata denge? |
| kitni cc sadkein bani? | main pichhli baat repeat nahi karunga. Voter parchi, ward information, ya gaon ki problem me kya help chahiye? | Galiyon ki CC/interlocking ka gali-war byora abhi jaanch me hai, isliye us par pakka karke hi bataungi. Apni gali/ward bataiye, note karke Abhay Singh ji tak pahunchaungi. Aapki gali ki CC/interlocking wali baat par kaam Abhay Singh ji hi karwayenge—16 Nov ko unka saath denge na? |

## 10. Jobs (no sankalp in sheets)

| Voter | Before (v1) | After (v2) |
|---|---|---|
| naukri ka kya? | Khel maidan me running track, basketball-badminton-kho kho court aur open gym laga hai, aur library bhi bani hai. Aage Hadahedi va Sihali Kalan me khel maidan aur Sihali Khurd me mini stadium ka sankalp hai. Bas itna sochiyega—40 saal se gaon ke sukh-dukh me kaun saath khada raha. 16 Nov ko Abhay Singh ji ka saath denge na? | Sach kahun to rozgar par alag se koi sankalp hamari list me darj nahi hai, isliye jhootha vaada nahi karungi. Yuvaon ke liye: Sihali Khurd khel maidan me running track, basketball-badminton-kho kho court aur open gym bana, saath me pakki chaardiwari ka bada hissa bana. |
| gym kahan hai? | Khel maidan me running track, basketball-badminton-kho kho court aur open gym laga hai, aur library bhi bani hai. Aage Hadahedi va Sihali Kalan me khel maidan aur Sihali Khurd me mini stadium ka sankalp hai. Gaon ki izzat aur kaam dono dekh kar faisla kijiye. Abhay Singh ji par bharosa karke dekhenge na? | Gym Sihali Khurd me hai. Bas itna sochiyega—40 saal se gaon ke sukh-dukh me kaun saath khada raha. 16 Nov ko Abhay Singh ji ka saath denge na? |

## 11. Bribe asked twice

| Voter | Before (v1) | After (v2) |
|---|---|---|
| paisa doge kya vote ke | Ji, yahan koi paisa, daaru ya laalach nahi diya jata—ye kanoon ke khilaf bhi hai. Abhay Singh ji 40 saal ki seva aur kaam ke bharose vote maangte hain. 🙏 | Ji, yahan koi paisa, daaru ya laalach nahi diya jata—ye kanoon ke khilaf bhi hai. Abhay Singh ji 40 saal ki seva aur kaam ke bharose vote maangte hain. 🙏 |
| daru milegi? | main pichhli baat repeat nahi karunga. Voter parchi, ward information, ya gaon ki problem me kya help chahiye? | Nahi ji, 5 din ki daru se gaon ka bhavishya nahi sanwarta. Abhay Singh ji ka saaf niyam hai—sharab aur pralobhan mukt chunav. 🙏 |

## 12. Abuse then real issue

| Voter | Before (v1) | After (v2) |
|---|---|---|
| bc bakwas band karo | Aapki narazgi samajh sakte hain ji. Gaali se baat nahi banegi—koi asli shikayat ho to bataiye, seedhe Abhay Singh ji tak pahunchaungi. 🙏 | Aapki narazgi samajh sakti hoon ji. Gaali se baat nahi banegi—koi asli shikayat ho to bataiye, seedhe Abhay Singh ji tak pahunchaungi. 🙏 |
| sorry gussa tha, naali ki gandagi hai | Aapki baat note kar li hai ji, ise seedhe Abhay Singh ji ki priority list me daal rahi hoon. Hadahedi aur Sihali Khurd me kai jagah underground naali line dali hai; aage lagatar naali aur pakki safai vyavastha ka sankalp hai. Kis ward/gali ki baat hai, bata denge? | Aapki baat note kar li hai ji, ise seedhe Abhay Singh ji ki priority list me daal rahi hoon. Keechad aur jalbharav se mukti ke liye bhumigat sewerage/naali line dali gayi, jaise Mahipal Tanwar ke ghar se johad ki taraf aur Madan Panch ke ghar se school ki taraf. Kis ward/gali ki baat hai, bata denge? |
| ward 9 | Ward 9 note kar liya ji. Aapki shikayat isi ward ke naam se team ko bhej di hai. Aapka booth 98, room 4 rahega. Bas itna sochiyega—40 saal se gaon ke sukh-dukh me kaun saath khada raha. 16 Nov ko Abhay Singh ji ka saath denge na? | Ward 9 note kar liya ji. Aapki shikayat isi ward ke naam se team ko bhej di hai. Aapka booth 98, room 4 rahega. Aapki naali-nikasi wali baat par kaam Abhay Singh ji hi karwayenge—16 Nov ko unka saath denge na? |

## 13. Elder introduces himself

| Voter | Before (v1) | After (v2) |
|---|---|---|
| ram ram beta | Ram Ram Tau ji! 🙏 Ghar-parivar me sab kushal-mangal? Aapke mohalle me is baar chunav ka kya mahaul hai? | Ram Ram Tau ji! 🙏 Ghar-parivar me sab kushal-mangal? Aapke mohalle me is baar chunav ka kya mahaul hai? |
| meri umar 70 saal ki hai, main vote dalne zaroor aaunga | Maaf kijiye ji, theek se samajh nahi paayi. Aapko voter parchi chahiye, gaon ki koi samasya batani hai, ya Abhay Singh ji se kuch poochna hai? | Dil se dhanyavad Dada ji! 🙏 Aapka yahi bharosa Abhay Singh ji ki asli taakat hai. Ghar me kitne vote hain? Sabko 16 November ko saath lekar aaiyega. |
| pension nahi milti budhape ki | Aapki baat note kar li hai ji, ise seedhe Abhay Singh ji ki priority list me daal rahi hoon. Buzurgon ke liye pankhe aur paani wali chaupal ka sankalp hai. Pension ka koi kaam atka ho to naam-ward bataiye, team saath jaakar madad karegi. Kis ward/gali ki baat hai, bata denge? | Aapki baat note kar li hai Dada ji, ise seedhe Abhay Singh ji ki priority list me daal rahi hoon. Buzurgon ke baithne ke liye chhayadar, pankhe aur peene ke paani wali chaupal banwane ka sankalp hai. Kis ward/gali ki baat hai, bata denge? |

## 14. Farmer, Haryanvi flavour

| Voter | Before (v1) | After (v2) |
|---|---|---|
| mhara gaam sihali kalan se hu, kisan hu | Aapki baat note kar li hai ji, ise seedhe Abhay Singh ji ki priority list me daal rahi hoon. Beej, khaad aur dawai ke liye gaon me hi kisan seva kendra banane ka sankalp hai, aur johad-talab gehre karwaye gaye hain. Kis ward/gali ki baat hai, bata denge? | Ji, aapse judkar bahut achha laga! 🙏 Aapke yahan sabse zaroori kaam kaun sa hai—paani, sadak, naali ya kuch aur? |
| khaad beej ki dikkat ghani hai | main pichhli baat repeat nahi karunga. Voter parchi, ward information, ya gaon ki problem me kya help chahiye? | Aapki baat note kar li hai ji, ise seedhe Abhay Singh ji ki priority list me daal rahi hoon. Kisan seva kendra bhawan banwana, taaki khaad, unnat beej aur krishi dawaiyan panchayat me hi sahi sarkari daam par milen. Kis ward/gali ki baat hai, bata denge? |
| patwari ke chakkar lagane padte hain | Maaf kijiye ji, theek se samajh nahi paayi. Aapko voter parchi chahiye, gaon ki koi samasya batani hai, ya Abhay Singh ji se kuch poochna hai? | Aapki baat note kar li hai ji, ise seedhe Abhay Singh ji ki priority list me daal rahi hoon. Panchayat me patwar ghar banwana, taaki namantaran, nakal aur zameen ke kaam ke liye Mundawar na bhatakna pade. Kis ward/gali ki baat hai, bata denge? |

## 15. Medicine cost vs doctor

| Voter | Before (v1) | After (v2) |
|---|---|---|
| अस्पताल में डॉक्टर नहीं आता | आपकी बात नोट कर ली है जी, इसे सीधे अभय सिंह जी की प्राथमिकता सूची में डाल रही हूँ। अभय सिंह जी ने अपनी पुश्तैनी ज़मीन दान देकर सिहाली खुर्द में उप-स्वास्थ्य केंद्र का भवन बनवाया। किस वार्ड/गली की बात है, बता देंगे? | आपकी बात नोट कर ली है जी, इसे सीधे अभय सिंह जी की प्राथमिकता सूची में डाल रही हूँ। संकल्प: ग्राम पंचायत के चिकित्सालय व उपस्वास्थ्य केंद्र में नियमित डॉक्टर की उचित व्यवस्था करवाई जाएगी। किस वार्ड/गली की बात है, बता देंगे? |
| दवाई बहुत महंगी है | मैं पिछली बात दोहराऊँगा नहीं। मतदाता पर्ची, वार्ड जानकारी या गाँव की समस्या में क्या सहायता चाहिए? | आपकी बात नोट कर ली है जी, इसे सीधे अभय सिंह जी की प्राथमिकता सूची में डाल रही हूँ। संकल्प: सस्ती जेनेरिक दवाइयों हेतु प्रधानमंत्री जन औषधि केंद्र खुलवाना। किस वार्ड/गली की बात है, बता देंगे? |

## 16. Returning voter greets again

| Voter | Before (v1) | After (v2) |
|---|---|---|
| paani ki dikkat hai ward 2 me | Aapki baat note kar li hai ji, ise seedhe Abhay Singh ji ki priority list me daal rahi hoon. Sihali Khurd aur Sihali Kalan me JJM ki tankiyan, ghar-ghar nal connection aur pipeline ka kaam hua hai, aur 6 naye borewell motor ke saath lage hain. Kis ward/gali ki baat hai, bata denge? | Aapki baat note kar li hai ji, ise seedhe Abhay Singh ji ki priority list me daal rahi hoon. Jal Jeevan Mission me jo ghar abhi bache hain, wahan tak meetha paani pahunchana pehli prathmikta hai. Aapki paani wali baat par kaam Abhay Singh ji hi karwayenge—16 Nov ko unka saath denge na? |
| ok | Ji ji 🙏 Bas itna sochiyega—40 saal se gaon ke sukh-dukh me kaun saath khada raha. 16 Nov ko Abhay Singh ji ka saath denge na? | Ji 🙏 Aapne ward 2 ki paani wali baat batayi thi—wo Abhay Singh ji ki priority list me darj hai. Bas itna sochiyega—40 saal se gaon ke sukh-dukh me kaun saath khada raha. 16 Nov ko Abhay Singh ji ka saath denge na? |
| ram ram | Ram Ram ji! 🙏 Ghar-parivar me sab kushal-mangal? Aapke mohalle me is baar chunav ka kya mahaul hai? | Ram Ram ji! 🙏 Phir se baat karke achha laga. Ward 2 ki paani wali aapki baat main bhooli nahi hoon—register me darj hai, batayi thi aapne. |

## 17. Student wants a ground

| Voter | Before (v1) | After (v2) |
|---|---|---|
| main student hu, khel ka maidan chahiye | Aapki baat note kar li hai ji, ise seedhe Abhay Singh ji ki priority list me daal rahi hoon. Sihali Khurd me bachchon aur yuvaon ke liye modular library bani hai; Hadahedi aur Sihali Kalan me bhi library ka sankalp hai. Kis ward/gali ki baat hai, bata denge? | Aapki baat note kar li hai ji, ise seedhe Abhay Singh ji ki priority list me daal rahi hoon. Hadahedi aur Sihali Kalan ke khel maidan ka vikas, aur Sihali Khurd me naya bada khel maidan (open gym, running track) ka sankalp hai. Kis ward/gali ki baat hai, bata denge? |
| library kahan hai? | Sihali Khurd me bachchon aur yuvaon ke liye modular library bani hai; Hadahedi aur Sihali Kalan me bhi library ka sankalp hai. Bas itna sochiyega—40 saal se gaon ke sukh-dukh me kaun saath khada raha. 16 Nov ko Abhay Singh ji ka saath denge na? | Library Sihali Khurd me hai. Aapki khel-yuva wali baat par kaam Abhay Singh ji hi karwayenge—16 Nov ko unka saath denge na? |

## 18. Undecided voter with a known concern

| Voter | Before (v1) | After (v2) |
|---|---|---|
| bijli ke khambe toote hain ward 3 me | Aapki baat note kar li hai ji, ise seedhe Abhay Singh ji ki priority list me daal rahi hoon. Kis ward/gali ki baat hai, bata denge? | Aapki baat note kar li hai ji, ise seedhe Abhay Singh ji ki priority list me daal rahi hoon. Mukhya raston, galiyon aur sabhi mohallon me road light aur solar street light lagwane ka sankalp hai. Aapki road light wali baat par kaam Abhay Singh ji hi karwayenge—16 Nov ko unka saath denge na? |
| abhi soch rahe hain | Koi baat nahi ji, soch-samajh kar faisla karna hi sahi hai. Sihali Khurd aur Sihali Kalan me JJM ki tankiyan, ghar-ghar nal connection aur pipeline ka kaam hua hai, aur 6 naye borewell motor ke saath lage hain. Bas itna sochiyega—40 saal se gaon ke sukh-dukh me kaun saath khada raha. 16 Nov ko Abhay Singh ji ka saath denge na? | Koi baat nahi ji, soch-samajh kar faisla karna hi sahi hai. Ek baat yaad rakhiyega: Jal Jeevan Mission ke tahat paani ki tankiyan, ghar-ghar nal connection aur paani ki kami wali jagahon par naye borewell lage. Bas itna sochiyega—40 saal se gaon ke sukh-dukh me kaun saath khada raha. 16 Nov ko Abhay Singh ji ka saath denge na? |

## 19. Polling + booth after ward

| Voter | Before (v1) | After (v2) |
|---|---|---|
| vote kab hai? | Matdaan Somvar, 16 November 2026 ko subah 7:30 se shaam 5:30 tak Govt. Sr. Sec. School, Sihali Khurd me hai. Apna ward bataiye, booth-room bhi bata doongi. | Matdaan Somvar, 16 November 2026 ko subah 7:30 se shaam 5:30 tak Govt. Sr. Sec. School, Sihali Khurd me hai. Apna ward bataiye, booth-room bhi bata doongi. |
| ward 7 | Ward 7 note kar liya ji. Aapka booth 97, room 3 rahega. Bas itna sochiyega—40 saal se gaon ke sukh-dukh me kaun saath khada raha. 16 Nov ko Abhay Singh ji ka saath denge na? | Ward 7 note kar liya ji. Aapka booth 97, room 3 rahega. Bas itna sochiyega—40 saal se gaon ke sukh-dukh me kaun saath khada raha. 16 Nov ko Abhay Singh ji ka saath denge na? |
| booth kaun sa hai? | Matdaan Somvar, 16 November 2026 ko subah 7:30 se shaam 5:30 tak Govt. Sr. Sec. School, Sihali Khurd me hai. Aapka booth 97, room 3. Gaon ki izzat aur kaam dono dekh kar faisla kijiye. Abhay Singh ji par bharosa karke dekhenge na? | Matdaan Somvar, 16 November 2026 ko subah 7:30 se shaam 5:30 tak Govt. Sr. Sec. School, Sihali Khurd me hai. Aapka booth 97, room 3. Gaon ki izzat aur kaam dono dekh kar faisla kijiye. Abhay Singh ji par bharosa karke dekhenge na? |

## 20. Unclear twice

| Voter | Before (v1) | After (v2) |
|---|---|---|
| asdf qwer zxcv lorem ipsum dolor sit amet blah | Maaf kijiye ji, theek se samajh nahi paayi. Aapko voter parchi chahiye, gaon ki koi samasya batani hai, ya Abhay Singh ji se kuch poochna hai? | Maaf kijiye ji, theek se samajh nahi paayi. Aapko voter parchi chahiye, gaon ki koi samasya batani hai, ya Abhay Singh ji se kuch poochna hai? |
| qqq www eee rrr ttt yyy uuu iii ooo ppp | main pichhli baat repeat nahi karunga. Voter parchi, ward information, ya gaon ki problem me kya help chahiye? | Ji, thoda khulkar batayenge? Parchi, booth, ya gaon ka koi kaam—kis baare me baat karein? |

<!-- DIALOGUES:END -->
