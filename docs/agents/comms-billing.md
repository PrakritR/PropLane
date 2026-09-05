# Manager communication billing (pay-as-you-go)

Pure PAYG for SMS, voice, and AI on manager work numbers.

## Enable

```bash
COMMS_PAYG_BILLING_ENABLED=1
```

Apply migration `20260905130000_manager_comms_billing.sql`.

## Rules

- **Free tier:** no SMS or voice on work numbers.
- **Paid tier:** requires Stripe customer + default payment method before send/receive.
- **Inbound:** always billed to the work-number owner.
- **Notifications:** email on budget 80%/100%, payment method update, payment failed (pauses comms).

## Retail rates (USD)

| Meter | Rate |
| --- | --- |
| Outbound SMS segment | $0.03 |
| Inbound SMS segment | $0.02 |
| Voice minute | $0.04 |
| Speech gather | $0.05 |
| AI agent turn | $0.15 |
| Work number monthly | $3.00 |
| Recording minute | $0.01 |

## API

- `GET /api/manager/comms-billing` — usage summary + gate status
- `PATCH /api/manager/comms-billing` — `{ monthlyBudgetCents }`, `{ clearBillingPause: true }`

## Code

- `src/lib/comms-billing/*` — rates, eligibility, metering, notifications
- Wired at SMS dispatcher, inbound webhook, voice, and `runSmsAgentTurn`

Stripe metered invoicing (Phase 2) is not yet connected — usage is recorded in `manager_comms_usage_events` for dashboard + future billing.
