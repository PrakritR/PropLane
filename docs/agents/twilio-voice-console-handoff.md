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


---

## Nov 12 2026: AI calling end to end (production steps)

What the code now does (flag-gated, `MANAGER_VOICE_AGENT_ENABLED` stays the kill switch):

- **Routing is the SMS routing.** A call to a workspace's own work number belongs to that workspace. A call to the shared PropLane
  line (the 206) goes through `decideSharedLineCall` (`inbound-seam.server.ts`, the same pieces `handleSharedLineInbound` uses, with
  none of the text-only effects): a verified manager / staff gets the manager agent, a verified resident the resident agent (read-only
  by voice, plus `escalate_to_manager`), a prospect the leasing agent (listing facts through tools only), a stranger the leasing agent
  over PropLane's own managed homes (`serviceCatalog`), an unclear caller ONE question ("Is this about A or B?", settled by a spoken
  house name and remembered on the router session), someone whose only ties are to a workspace with its own number is told that
  number, and a vendor is told to text. Voice never adds a write the SMS surface does not allow.
- **Consent before recording.** With `TWILIO_VOICE_RECORDING` on, the first thing a caller hears is the recording line; `<Start><Recording>`
  appears only in the response to a yes ("yes", "okay", "sure"). Silence is asked once more; a no ends the call and settles the
  recording hold to zero.
- **Silence and goodbye.** A silent Gather redirects back to the turn route with `attempt` + 1 (the URL Twilio signs includes it);
  one re-ask, then a goodbye. "That's all" / "bye" ends the call gracefully. An agent that has nothing promises a text and the browse
  page is texted after the call.
- **A person.** A caller who asks for one, an emergency word, a frustrated caller, an agent that called `escalate_to_manager` or had no
  answer, or a caller who keeps going unheard gets "One moment, connecting you to <first name>" and a `<Dial>` (20 s ring, callerId
  = the line, a whisper to the answerer saying who is calling). Target, server-side: the covering staff seat / co-manager with the
  house grant and a verified phone, else the owner's verified phone, else (PropLane-managed workspaces, the 206, an unplaced caller)
  PropLane's admin alert phone read from `workspace_work_number_recipients`. No answer: the assistant takes the call back ("They're
  not available right now. I'll have them call you back."), the target is texted one line with the caller's number, and the thread
  logs it. Quiet hours: a routine escalation is a call-back text, an emergency always rings.
- **After the call** (`/api/twilio/voice/status`, terminal status): the minutes are settled by whoever held them, the manager summary
  goes out as before, the caller is texted the pages the call offered (tour / apply / listing, only from tool results) from the dialed
  line through the normal outbound path (once per call: `voice-links:<CallSid>`), and PropLane's alert phones get the same one-line
  alert an inbound text raises (`alertOpsOfInboundText`, idempotent on `voice:<CallSid>`).
- **Billing.** A workspace's own wallet pays first; on a PropLane-run line (the 206, a PropLane-managed workspace) PropLane's wallet is
  the backstop with no wallet limit, so an empty client wallet never turns a caller away. A self-serve workspace with an empty wallet is
  still refused (`VOICE_CREDIT_UNAVAILABLE`).

Production steps, in order (nothing here is done by code):

1. Vercel (production): set `MANAGER_VOICE_AGENT_ENABLED=1`. Optional: `TWILIO_VOICE_RECORDING=1` (consent line + recording), `TWILIO_VOICE_POLLY_VOICE`.
   Leave `TWILIO_VOICE_*_WEBHOOK_URL` unset unless a proxy rewrites the host (they are part of the signed URL).
2. Twilio Console, number +12066781909 and every work number: Voice "A call comes in" is already `https://proplane.ai/api/twilio/voice/inbound`
   (POST). No other change is required: the call's status callback is attached to each call by the app when it bounds the call. If you
   prefer it on the number as well: "Call status changes" = `https://proplane.ai/api/twilio/voice/status` (POST).
3. Confirm `TWILIO_AUTH_TOKEN` is the account's token (signature validation fails closed on Vercel).
4. Smoke test from a verified phone: call the 206, say "yes" to the recording line, ask about a house, say "text me the link", say
   "that's all". Expect the links text within a minute of hanging up, and one alert text on the admin alert phone.
5. Roll back by unsetting the flag: callers hear "The voice assistant is not enabled yet" again.
