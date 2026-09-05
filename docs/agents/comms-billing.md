# Manager communication billing (pay-as-you-go)

Pure PAYG for SMS, voice, and AI on manager work numbers.

## Two switches, and they are not the same switch

| Env | Default | Controls |
| --- | --- | --- |
| `COMMS_LIMITS_ENFORCED` | **on** (set `0` to disable) | Metering and the per-plan allowance |
| `COMMS_PAYG_BILLING_ENABLED` | off (set `1` to enable) | Actually charging a card |

Limits default ON because that flag **fails open**: with metering off nothing
stops, so every plan — Free included — gets unlimited texting, calling and AI,
and an unlimited account looks exactly like a working one. Billing defaults OFF
because money leaving a card must never start moving because an env var went
missing.

A manager past their allowance with billing off is asked to add a card and
blocked; nothing is charged until PAYG is on too.

Apply migration `20260905130000_manager_comms_billing.sql`.

## Rules

- **The work number is FREE on every plan, including Free.** Setup and monthly
  are zero-rated. A manager cannot evaluate PropLane without a number, so it is
  never the paywall — what is limited is what the number *does*.
- **Every plan includes a real allowance**, so a number can be set up and used
  with no card at all. A card is required only once the allowance is spent.
- **Past the allowance, a card bills rather than blocks** — that is how a
  manager buys more without changing plan.
- **Inbound:** always billed to the work-number owner.
- **Notifications:** email on budget 80%/100%, payment method update, payment failed (pauses comms).

## Included allowance by plan

Cents of USAGE VALUE, not a message count — the meters are not comparable, and
one number per plan stays correct when a rate changes.

| Plan | Price | Included | Roughly |
| --- | --- | --- | --- |
| Free | $0 | **$2.50** | ~83 texts, or ~16 AI turns, or ~62 voice minutes |
| Pro | $20/mo | **$15.00** | ~500 texts, or ~100 AI turns |
| Business | $200/mo | **$150.00** | ~5,000 texts, or ~1,000 AI turns |

Business is capped rather than unmetered: "no limit" is not a price, it is an
unbounded liability on a fixed fee, and the cap is the only signal that an
account has started doing something nobody priced. It sits far above real use,
and with a card on file passing it bills rather than blocks.

## Retail rates (USD)

| Meter | Rate |
| --- | --- |
| Outbound SMS segment | $0.03 |
| Inbound SMS segment | $0.02 |
| Voice minute | $0.04 |
| Speech gather | $0.05 |
| AI agent turn | $0.15 |
| Recording minute | $0.01 |
| Work number setup | **free** |
| Work number monthly | **free** |

## API

- `GET /api/manager/comms-billing` — usage summary + gate status
- `PATCH /api/manager/comms-billing` — `{ monthlyBudgetCents }`, `{ clearBillingPause: true }`

## Code

- `src/lib/comms-billing/*` — rates, eligibility, metering, notifications
- Wired at SMS dispatcher, inbound webhook, voice, and `runSmsAgentTurn`

Stripe metered invoicing (Phase 2) is not yet connected — usage is recorded in `manager_comms_usage_events` for dashboard + future billing.
