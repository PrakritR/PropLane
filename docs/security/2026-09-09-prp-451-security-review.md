# PRP-451 security review

- Reviewed at: 2026-09-08T23:23:00-04:00
- Base: `2cb8eedaf88dc479b4152c3e22ebe92a4c5b00e3`
- Uncommitted source diff SHA-256: `f2d1e2b456219f32d50bb0a1520932e2a130d4ab478079a7bad0198162730354`
- Inventory: agent prompt; manual reminder and generic messaging tools; portal inbox delivery; application lifecycle wrapper; new server-only existing-conversation resolver; four focused test files. `.graphify/` is ignored and is not review source.

No blocking security finding in the reviewed diff.

The generic due-soon action still resolves recipients through the existing manager-scoped recipient filter before its audit record and delivery call. Canonical `profile_roles` are consulted for recipient classification and an error fails closed. SMS target identity is read from a verified profile and then matched against a single owner-scoped conversation with durable message evidence for the exact recipient and work-number pair. The resolved target carries that verified phone snapshot, and the delivery helper requires its fresh profile read to match before dispatch. Missing, duplicate, changed-phone, role-mismatched, or lookup-failed candidates produce no synthesized key and an unavailable SMS outcome. Portal and email do not grant SMS authority.

The shared application wrapper continues to limit lifecycle approval texts to prospect/applicant roles; its existing tests cover exact match, ambiguity, changed phone, and unavailable work number. The generic resolver supports the role that the resolved recipient profile holds, with residents additionally able to retain one exact prospect/applicant thread.

The shared delivery result now exposes one email outcome per recipient (`submitted`, `failed`, or `skipped`) as well as the existing SMS outcome. Suppressed, preference-disabled, and sandbox-skipped email cannot be reported as submitted. A provider rejection or thrown identity/transport call remains failed while the independent portal copy remains stored and SMS continues.

Residual validation limit: these are mocked delivery/outbox tests. No real provider, resident phone, or database write was used. The owner dispatcher validates an explicit conversation key before logging but not before provider submission; the PRP-451 helper's fresh phone check closes this action's stale-target path without claiming dispatcher-wide authorization.
