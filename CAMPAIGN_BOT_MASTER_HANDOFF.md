# 🚩 BABA ABHAY SINGH WHATSAPP CAMPAIGN BOT — MASTER HANDOFF & ARCHITECTURE SPEC
**Election:** Gram Panchayat Sihali Khurd, Sihali Kalan & Hadahedi Sarpanch Election 2026  
**Candidate:** Baba Abhay Singh (Moti Aangli Wale Baba)  
**Primary Campaign Contact:** +91 63678 10227 / +91 95093 52067  
**Overseas Canadian Helpline:** +1 (450) 279-0497  
*(⚠️ Note: Number +91 87648 70431 is strictly removed from all voter contact cards).*

---

## 1. Executive Summary & Core Rules
This bot is a high-concurrency (1,200+ req/min), multi-session, anti-ban compliant WhatsApp campaign system designed to serve 400–500 voters daily, deliver instant official voter slips (from a database of 3,636 voters), generate personalized status posters, and convert village voters through a charismatic 5-step conversation ladder.

### ⚠️ Strict Campaign Guardrails (Must Never Violate):
1. **NO "सेवा केंद्र" (Seva Kendra):** Never identify as a government/kiosk "Seva Kendra". The bot speaks naturally as Baba Abhay Singh's personal digital outreach team.
2. **NO "ठेकेदारी" (Thekedari):** Never use the word "ठेकेदारी" or "thekedar". Always use *"बिना किसी स्वार्थ या लालच के"* or *"निस्वार्थ जनसेवा"*.
3. **NO Rupee Amounts & NO Bigha Numbers:** Never claim budget numbers or numerical land acres. State: *"अपनी निजी जमीन दान देकर उप-स्वास्थ्य केंद्र बनवाया"*.
4. **NO Robotic Essays (Zero Ramayan):** Output short, punchy 1–2 line chat bubbles (10–25 words per bubble).
5. **Dual-Language Engine:** Respects voter choice — either **Romanized Hinglish ("ABC format")** or **Devanagari Hindi**.

---

## 2. Complete File Directory & Responsibility Map

| File Path | Purpose & Responsibility |
|---|---|
| [`server.js`](file:///c:/antigravity/W2/WHATSAPP_CAMPAIGN_BOT/server.js) | **Main Express Server & WhatsApp Webhook Engine.** Manages Baileys multi-session sockets (`sim_636`, `baba_aux`), message router, consent gate, language switch, vCard generation, diagnostic dashboard, and mass API endpoints. |
| [`ai_assistant_service.js`](file:///c:/antigravity/W2/WHATSAPP_CAMPAIGN_BOT/ai_assistant_service.js) | **5-Tier AI & Fast Local Answer Engine (<1ms).** Implements the 5-step conversational ladder, opposition de-escalation, dual-language output (Hinglish/Hindi), and locked certified fact sheets. |
| [`voter_engine.js`](file:///c:/antigravity/W2/WHATSAPP_CAMPAIGN_BOT/voter_engine.js) | **Precision Voter Slip Lookup Engine.** Searches 3,636 voters with exact tokenization, phonetic matching, father/husband disambiguation, and ward filtering. Contains zero-false-positive classifier. |
| [`user_memory.js`](file:///c:/antigravity/W2/WHATSAPP_CAMPAIGN_BOT/user_memory.js) | **State Machine & Voter CRM (`user_memory.json`).** Tracks `conversationStage`, `languagePreference` (`hinglish`/`hi`), `voteIntent`, `occupation`, `wantsVisit`, `consented`, and user chat histories. |
| [`campaign_agenda.js`](file:///c:/antigravity/W2/WHATSAPP_CAMPAIGN_BOT/campaign_agenda.js) | **Daily Agenda & 4-Slot Media Scheduler.** Controls Morning (08:30-10:30 AM), Dopahar (01:30-03:30 PM), Evening (05:30-07:30 PM), and Night (08:00-09:30 PM) broadcast slots. |
| [`poster_engine.js`](file:///c:/antigravity/W2/WHATSAPP_CAMPAIGN_BOT/poster_engine.js) | **High-Res Status Poster Generator.** Renders 9:16 WhatsApp status posters in 320ms. Supports Name-only posters and Dual-photo posters (Baba + Voter). |
| [`voter_card_generator.js`](file:///c:/antigravity/W2/WHATSAPP_CAMPAIGN_BOT/voter_card_generator.js) | **SVG to High-Res JPG Voter Slip Generator.** Renders official voter cards featuring Baba's photo, serial number, EPIC, house number, and booth room details. |
| [`media_catalog.js`](file:///c:/antigravity/W2/WHATSAPP_CAMPAIGN_BOT/media_catalog.js) | **Media Catalog & Direct Grievance Register.** Stores video reels, status posters, and manages Baba's direct priority register (`baba_direct_register.json`). |
| [`voters.json`](file:///c:/antigravity/W2/WHATSAPP_CAMPAIGN_BOT/voters.json) | **Certified Voter Database (3,636 voters)** across all 11 wards of Gram Panchayat Sihali Khurd. |
| [`rag_vault/`](file:///c:/antigravity/W2/WHATSAPP_CAMPAIGN_BOT/rag_vault/) | Knowledge base files containing certified works, village history, 15 sankalp resolutions, and sanitized guidelines. |

---

## 3. Conversational State Machine & Message Flow

```
Incoming Message
       │
       ▼
Is User Consented? ───(No / First Time)───► Anti-Spam Gate: Option 1 (Haan) / Option 2 (Nahi)
       │                                            │
  (Yes / Accepted)                                  ├─► Option 2: Stop Autopilot, Polite Exit
       │                                            └─► Option 1: Ask Language (1. Hinglish / 2. Hindi)
       ▼                                                          │
Has Explicit Parchi Keyword / EPIC / Name?                        └─► Store languagePreference
       │
       ├─► YES ──► Voter DB Lookup ──► Found? ──► YES ──► Deliver JPG Voter Card + Details
       │                                  │
       │                                  └──► NO ──► Deliver Polite Parchi Fallback
       ▼
  NO (Casual Chat)
       │
       ▼
Is Question about Works / Dates / Facts?
       │
       ├─► YES ──► Deliver Instant Locked Fact Sheet (<1ms)
       │           (Hospital, JJM Water, 45+ CC Roads, Digital Library, Sports Gym, 15 Sankalp)
       ▼
5-Step Conversion Ladder:
       │
       ├─► Step 1: Mahool & Hal-chal ("Gaon me kya mahol hai?")
       ├─► Step 2: Occupation Hook ("Aap kya karte ho — student, farmer, army, police?")
       │           └─► Voter answers ──► "Arre wah! Ek number! 👏" + Offer Baba Home Visit
       ├─► Step 3: Home Visit Invitation ("Ghar aao") ──► Baba Diary Entry + Ask Village Problem
       ├─► Step 4: Village Problem Stated ──► Grounded Assurance (No fake promises) + Ask Vote Intent
       └─► Step 5: Vote Commitment Ask:
                   ├─► YES ──► Heartfelt appreciation (`❤️🙏🚩`) + cute emoji
                   ├─► NO / DOUBTFUL ──► Calm de-escalation ("Koi kami lagi ya parivarik dabav?")
                   └─► SLURS / OPPOSITION ──► Dignified zero-argument response
```

---

## 4. Multi-Number Contact Card (Anti-Ban Setup)

The bot sends a 2-number campaign contact card during turns 1–3 to encourage users to click **"Add to Contacts"**, preventing WhatsApp spam flagging:
```vcard
BEGIN:VCARD
VERSION:3.0
FN:बाबा अभय सिंह (मोटी आंगली वाले)
ORG:ग्राम पंचायत सिहाली खुर्द
TITLE:सरपंच पद प्रत्याशी 2026
TEL;type=Primary,pref;type=VOICE;waid=916367810227:+91 63678 10227
TEL;type=Helpline (Overseas);type=VOICE;waid=14502790497:+1 (450) 279-0497
NOTE:सिहाली खुर्द, सिहाली कलां व हाड़ाहेड़ी पंचायत 2026। 24/7 मतदाता पर्ची व जनसमस्या सहायता।
END:VCARD
```

---

## 5. Daily Media Drip & Broadcast Slots

The dashboard and autopilot follow 4 dedicated time slots managed in [`campaign_agenda.js`](file:///c:/antigravity/W2/WHATSAPP_CAMPAIGN_BOT/campaign_agenda.js):

| Slot | Time Window | Content Type | Hook / Objective |
|---|---|---|---|
| **Morning** | `08:30 AM - 10:30 AM` | Poster / Status | Daily agenda opener, morning greeting, mahool hook |
| **Dopahar** | `01:30 PM - 03:30 PM` | Work Poster | Major certified work highlight (JJM water, CC road, hospital) |
| **Evening** | `05:30 PM - 07:30 PM` | Status Card | 15 Sankalp resolution card for voters to put on WhatsApp status |
| **Night** | `08:00 PM - 09:30 PM` | Video Reel | 1-minute inspirational campaign video reel before bedtime |

---

## 6. How to Run & Verify All Systems

### Start Bot Server:
```bash
cd c:\antigravity\W2\WHATSAPP_CAMPAIGN_BOT
node server.js
```
* Dashboard URL: `http://localhost:3000`

### Run Test Suites:
1. **50-Message Casual Conversation & Loop Elimination Test:**
   ```bash
   node test_simulate_50_casual_messages.cjs
   ```
   *(Expected: 50/50 PASSED, 0 loops).*

2. **Mass Campaign & Configuration Audit:**
   ```bash
   node test_mass_campaign_readiness.cjs
   ```
   *(Expected: 100% verified — vCard phone count <= 2, Canadian number accurate, Seva Kendra 0, Thekedari 0).*

3. **300-Burst Rapid Concurrency Benchmark:**
   ```bash
   node test_brutal_300_full_pipeline.cjs
   ```
   *(Expected: 300 requests in ~14s, 0 errors, ~1,200 req/min).*

4. **5-Step Interactive Ladder & Gender Logic:**
   ```bash
   node test_5step_ladder.cjs
   ```
   *(Expected: 8/8 tests passed 100%).*

---
*Document verified and locked for Sihali Khurd Election 2026.* 🚩
