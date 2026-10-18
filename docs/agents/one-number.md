# One-number SMS: implementation map

> The captain's spec is [`one-number-spec.md`](one-number-spec.md). This file maps what was
> built where. One section per workstream; keep to facts: files, invariants, flags.

## W7a - Vendor dispatch engine (manager in the loop)

Source: `src/lib/vendor-dispatch/`. Tables: `vendor_dispatch_*` (`20261018120000`), engine
columns + `vendor_dispatch` audit domain (`20261018120100`). Product notes for the rule
editor and the portal UI belong to W7b; research behind the numbers is
[`vendor-dispatch-research.md`](vendor-dispatch-research.md).

**The loop.** A trigger calls `createDispatchRun` -> the run is `awaiting_approval` and the
owner is texted one segment (`Lockout 5259 Brooklyn Ave NE R3 #7. Send Sam Locksmith $120,
then Lee, Kim if busy? Y/N or 1-3 to pick one`). **Nothing reaches a vendor before an
approval.** Approve -> `offering`: sequential offers position 0, broadcast the first
`broadcast_size`. A vendor's `YES [time] [$price]` accepts, `NO` declines, `BUSY [2h]` parks
the vendor (skipped by `matchDispatchRule` until `busy_until`), a timeout moves on. First YES
wins: the run flips `offering|exhausted -> accepted` in one conditional UPDATE, every other
offered attempt becomes `superseded` and is texted "taken". An exhausted chain texts
`No one took #7. R to retry, B to offer all cleaners at once, or handle it yourself`.
`DONE` -> resident asked "Is it fixed? Reply YES or NO" -> YES completes the service, NO
reopens it and alerts the manager. `INVOICE $amount` -> existing vendor-invoice rails
(`vendor_invoices`, `submitted`), manager `Y` approves and creates the bill; it never pays.

**Files.**

| File | Owns |
| --- | --- |
| `match.server.ts` | Rule precedence + chain (`matchDispatchRule`), roster fallback, reachability |
| `runs.server.ts` | `createDispatchRun`, `approve/decline/retry/cancelDispatchRun` (the portal and SMS both call these) |
| `engine.server.ts` | load helpers, approvers, `advanceRun`, `offerAttempt`, `exhaustRun` |
| `responses.server.ts` | vendor YES / NO / BUSY / timeout, price-over-cap hold, `acceptAttempt`, work-order assignment |
| `completion.server.ts` | DONE, the resident's fixed answer, invoice by text |
| `inbound.server.ts` | deterministic reply handlers called by the inbound pipeline |
| `triggers.server.ts` | service filed, tour booked, checkout -> cleaner |
| `sweep.server.ts` | scheduler tick; `/api/cron/vendor-dispatch-sweep` every 2 minutes |
| `send.server.ts` | the four outbound doors (vendor, teammate, resident, shared-line check) |
| `text.ts` `reply-parse.ts` `time.ts` `triage.ts` | pure: composing, parsing, Pacific time, triage |
| `src/lib/tools/domains/vendor-dispatch.ts` | `list_vendor_dispatches`, `approve_vendor_dispatch`, `dispatch_vendor` |

**Invariants.**

- Rule precedence: a `selected` rule naming the property beats `all`; an issue rule beats
  trade-only; `urgencies` and `hours` (business = Mon-Fri 8-18 Pacific) filter; ties go to
  the newest. No rule: the trade-and-fairness roster ranking. A vendor with no phone, an
  opt-out, `busy_until` in the future or `active: false` is not in the chain.
- Workspace scoping: a run's owner and workspace are read from the run; `handleManagerDispatchReply`
  takes them from the work number the text arrived on (never the body). Handles are per owner
  (`unique (owner_user_id, handle)`). An approver is the owner or a teammate holding Services on the
  house who is not a viewer; a stranger's `Y` is not claimed.
- Replies are parsed before any agent: manager (`Y`, `Y 7`, `N 7`, `2`, `2 7`, `R`, `B`) in
  `inbound-pipeline.server.ts` ahead of the Team chat; vendor (`YES/NO/BUSY/DONE/INVOICE`) ahead of
  `resolveVendorAgentSessionForInbound`; resident YES/NO ahead of the resident agent. Two pending
  items make a bare `Y` refuse with `Which one? Reply Y 8 or Y 7`; an open assistant confirmation
  also blocks a bare `Y`.
- Privacy: an offered vendor reads the general area only (`workOrderGeneralArea`), the job number,
  pay or "quote" and a first name; the street address and entry note go out after they accept;
  a resident's phone or email is stripped from anything a vendor reads (`stripContactDetails`).
- Price: `YES $amount` above `nte_cents ?? pay_cents` (or any price when neither is set) is held
  (`quote_status = pending`), the manager is asked `Mike quotes $240 (cap $180) #7. Y/N`, and the
  vendor's timeout is paused.
- A lockout dispatches only for a texter matched to the house (verified phone + a lease at that
  property); otherwise no dispatch and the manager is alerted. Gas smell, fire and smoke never
  dispatch (`NEVER_AUTO_DISPATCH_ISSUES`, `textIsDangerous`).
- Every decision writes an `action_events` row (domain `vendor_dispatch`, category `maintenance`,
  idempotent on `event_key`) with the verbatim reply. Reported, not hidden: `recordDispatchEvent`
  returns whether the row landed.

**Triggers.** `prepareDispatch` (both service-intake paths) tries `maybeCreateRuleRunForWorkOrder`
first and returns when it made, found or refused a run; with no active rule the legacy proposal path
is untouched. `willDispatchRun` also answers true when a rule would run, so legacy auto-timing and
preferred-vendor offers stand down. Tours: `mutateConfirmedTourSchedule` (append) and
`confirmProspectSmsTourOffer` call `maybeDispatchTourHost`. Checkouts: the sweep reads
`channelStays`/`leaseStays`/`roomDateBlockStays` and opens a `cleaner`/`turnover` run due by the
next check-in at the same house and room. Manager by text: `dispatch_vendor` (the confirm is the approval).

**Flags / config.** No new flag: runs exist only where the manager made a rule. Line mode:
`workspaceOnSharedLine` (`sms_runtime_config.line_mode = shared`) sends through
`sendSharedLineMessage`, falling back to the per-workspace number while that returns
`not_shared_mode`. Prod runs code before migrations: a missing table (42P01, 42703, PGRST205)
reads as "no rules".

**Not done here.** Portal UI (W7b). Vendor accepting an offer from the vendor portal still goes
through bids; a portal decline is mirrored by the sweep. SMS-only vendors (no login) cannot file a
`vendor_invoices` row, so their texted invoice is a manager Y/N on the run only.
