# PRP-437 final security review

- Review time: 2026-09-08T22:45:37-04:00
- Worktree: `/private/tmp/axis-prp-437-20260908`
- Base: `6f24d93b712f140d16af5f10e14b1fd88edd61aa`
- Combined diff and untracked inventory SHA-256: `36344cad967de496dbc59d013e52ab1cce5bb2e265f7f9f68e04650dfdf318da`
- Database migration applied: no
- Provider SMS sent: no

## Scope reviewed

Modified: `docs/agents/tours-scheduling.md`; tour inquiry accept, cancel,
propose-reschedule, and reschedule routes; calendar/tours components; leasing
bot; demo scheduling; manager notification routing; tour inquiry confirmation,
notification delivery, planned-change client/server; and their unit tests.

Untracked and reviewed: `src/lib/tour-reschedule-sms-reply.server.ts`,
`tests/unit/tour-notification-channel-forwarding.test.ts`,
`tests/unit/tour-reschedule-sms-reply.test.ts`, and
`tests/unit/tour-reschedule-sms-routing-contract.test.ts`.

## Findings

No release-blocking security finding in the reviewed snapshot.

The inbound reply path derives manager, guest phone, work number, and event
window from the scoped schedule record, then rechecks all of them inside its
CAS mutation. A reply cannot select a different owner or event from request
input. Explicit manager notices use the existing preference-aware Assistant/SMS
router with a stable inbound-SID idempotency key; an undelivered or suppressed
notice does not terminally consume the guest reply. The work-number and guest
phone participate in the proposal generation, so a rotation cannot reuse an
old reply authorization. Each real planned reschedule persists a generation
which names its delivery and reply operation, preventing historical
A-to-B-to-A-to-B moves from being suppressed while keeping a retry of one
persisted move stable.

## Final cross-record ambiguity correction

A pending inquiry stores its reply proposal in the inquiry singleton. Before
selecting any target, the inbound handler now loads both that singleton and the
planned-tour singleton and validates owner, normalized guest phone, work number,
consent, active window, proposal version, and delivery generation. A read error
on either inventory fails closed. More than one combined match records a durable
manager follow-up and confirms neither row. YES on a unique inquiry updates only
the proposal receipt; it does not book the inquiry.

The notification path records reply state only after the SMS transport reports
sent or durably accepted. If that follow-up persistence fails, it reports the
accepted-SMS/state mismatch and does not roll back the already persisted tour
window.

Final focused source SHA-256:

- reply handler: `fb6fd76559a0123708308c3719c9684b1ab7b78a4909325ae21f6a98d11e5e3b`
- reply tests: `4f123acb5019be44e26b91a0a16059a6db9ac992516d50effa2a25f70ffb5a34`
- notification delivery: `faf4e3e680d8be3ff31b72d61dc595e66f3373bdd134bfec65055e01df456ab0`
- inbound leasing route helper: `f5848509fcd68dbdd39af9325ab9b9c2bcb041b2278f1cba5a19d9910ed10d56`

Coordinator final copy review: duplicate inquiry confirmation says the manager already has acceptance of the proposed time, never that the tour is booked. Stale affirmative inquiry history is handled like planned history. Reply/route focused suite19tests exited0. Final reply-helper SHA-256 `a5d4ba5fea984d6a15f4fd8f9cf8281e2d10a350aebfe90c1f316c42cae615e4`.
