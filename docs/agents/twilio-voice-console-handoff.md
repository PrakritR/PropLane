# Twilio Console handoff — Manager voice AI (work number)

**Audience:** Teammate with Twilio Console access (not the codebase).  
**Goal:** Wire PropLane **voice** on manager work numbers without breaking existing **SMS**.  
**Feature:** Caller dials work number → PropLane answers with AI (tours, etc.). V1 uses webhooks + speech gather, not Twilio Studio.

Copy sections below into Linear/Slack as needed. Replace `{{PLACEHOLDERS}}` before saving in Twilio.

---

## Before you touch Twilio

Confirm with the engineer:

| Item | Value |
| --- | --- |
| Environment | `dev` / `staging` / `production` |
| Public base URL | e.g. `https://abc123.ngrok.io` (dev) or `https://prop-lane.space` (prod) |
| Voice inbound webhook | `{{BASE_URL}}/api/twilio/voice/inbound` |
| Voice turn webhook | `{{BASE_URL}}/api/twilio/voice/turn` |
| Voice status callback (optional V1) | `{{BASE_URL}}/api/twilio/voice/status` |
| Test phone number (E.164) | e.g. `+1XXXXXXXXXX` |
| Recording | **Yes** — spoken consent at start of call (engineer implements TwiML) |

**Do not change** unless explicitly asked:

- SMS **Messaging** webhook (`/api/twilio/inbound`) — must stay as-is
- Messaging Service SID, A2P campaign, Event Streams subscription
- API keys / Auth Token rotation (engineer-owned)
- Numbers in the **SMS relay pool** (separate from work numbers)

---

## Prompt to paste for your co-worker (Twilio Console)

> **Task:** Enable **Voice** on PropLane manager work numbers for AI call handling.  
> **Account:** PropLane Twilio project (same account as production SMS).  
> **Rule:** SMS and Voice share one number — configure **both** sections on the same phone number row.

### Step 1 — Open the number

1. Log in: [Twilio Console](https://console.twilio.com/)
2. **Phone Numbers** → **Manage** → **Active numbers**
3. Open the work number: `{{E164_WORK_NUMBER}}`  
   (If provisioning a new number: buy **Local** US number with **Voice** + **SMS** capabilities.)

### Step 2 — Voice configuration (same number page)

Under **Voice configuration**:

| Field | Set to |
| --- | --- |
| **Configure with** | Webhooks, TwiML Bin, Functions, etc. |
| **A call comes in** | Webhook |
| **URL** | `{{BASE_URL}}/api/twilio/voice/inbound` |
| **HTTP** | `HTTP POST` |
| **Primary handler fails** | (optional) `{{BASE_URL}}/api/twilio/voice/fallback` or leave default |
| **Call status changes** | (optional V1) Webhook `{{BASE_URL}}/api/twilio/voice/status` · HTTP POST |

**Caller ID lookup:** leave default (optional later).

**Emergency calling:** do not change unless compliance asks.

Click **Save configuration**.

### Step 3 — SMS configuration (verify unchanged)

Under **Messaging configuration** on the **same** number:

| Field | Must remain |
| --- | --- |
| **A message comes in** | Webhook |
| **URL** | `{{BASE_URL}}/api/twilio/inbound` (or production `TWILIO_WEBHOOK_URL` value engineering provides) |
| **HTTP** | `HTTP POST` |

If SMS URL was wrong before voice work, **stop** and ask engineering — do not guess.

### Step 4 — Recording (account-level awareness)

V1 records **after** the caller hears a consent line (implemented in app TwiML, not Console toggle alone).

In Console you may see:

- **Voice** → **Settings** → **General** — note default recording policy; engineering controls per-call via TwiML `<Record>` after consent.
- Do **not** enable blanket “record all calls” unless legal/compliance approves.

### Step 5 — Smoke test (with engineer on call)

1. Engineer runs app + ngrok (dev) or confirms deploy (staging/prod).
2. From a **verified manager cell**, call `{{E164_WORK_NUMBER}}`.
3. Expect: greeting → beep → speak → AI reply (not busy signal, not Twilio default error).
4. Check **Monitor** → **Logs** → **Calls** for webhook `200` responses to `/api/twilio/voice/inbound` and `/api/twilio/voice/turn`.

**Red flags in Twilio debugger:**

| Error | Likely cause |
| --- | --- |
| `11200 HTTP retrieval failure` | Wrong URL, ngrok down, or app not running |
| `12200 Schema validation warning` | TwiML malformed — engineering fix |
| `401` / signature errors | Auth token / URL mismatch with `TWILIO_AUTH_TOKEN` |

### Step 6 — Production checklist (when engineering says ship)

- [ ] Voice URL uses `https://prop-lane.space/...` (not ngrok)
- [ ] SMS URL still points at `/api/twilio/inbound` on same host
- [ ] Test call from verified manager phone succeeds
- [ ] Test call from unknown number gets polite rejection (not agent access)
- [ ] No change to Messaging Service sender pool without engineering runbook

---

## Bulk update (many work numbers)

Engineering may run `npm run setup:twilio-vercel` / provisioning scripts after voice URLs are in code. **Console edits are for dev canary numbers only** until that script is updated.

For one-off dev number: manual Console steps above are enough.

---

## What to send back to engineering

Reply with:

1. Screenshot or copy of **Voice** + **Messaging** webhook URLs saved on the number
2. Twilio **Call SID** from a test call (from Logs → Calls)
3. HTTP status codes for inbound + turn webhooks
4. Any Debugger errors (full text)

---

## Related code (for engineers only)

- SMS inbound: `src/app/api/twilio/inbound/route.ts`
- Voice (planned): `src/app/api/twilio/voice/inbound`, `.../turn`
- Number purchase: `src/lib/twilio-provisioning.ts` (`resolveInboundWebhookUrl` — voice twin TBD)
- Identity (reuse): `src/lib/sms/manager-sms-access.server.ts`
- Product plan: `.lavish/plans/PRP-voice-manager-tours/plan.html`

---

## Short Slack message (copy/paste)

```
Twilio voice setup for PropLane work number {{E164}}:

1. Phone Numbers → {{E164}} → Voice → "A call comes in" = Webhook POST
   {{BASE_URL}}/api/twilio/voice/inbound

2. Do NOT change Messaging webhook — must stay POST {{BASE_URL}}/api/twilio/inbound

3. Save, then call the number from verified manager cell while eng is on ngrok/deploy.

4. Send back: Call SID + whether webhooks returned 200 (Monitor → Logs → Calls).
```
