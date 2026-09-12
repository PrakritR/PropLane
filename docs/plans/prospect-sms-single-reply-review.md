# Prospect SMS fresh Astra review

2026-09-12, branch `prospect-agent-eval-loop`, starting/current HEAD `6f24d93b712f140d16af5f10e14b1fd88edd61aa`.

**Verdict: changes required.** The core revision/lease design fixes the overlapping-generation direction, but three P1 defects can strand or lose prospect replies or break gateway behavior. Two P2 defects misstate escalation delivery and leave the promised GPT comparison incomplete. Findings with source references and exact verification are in `docs/security/2026-09-12-prospect-sms-bugbot-review.md`; the implementation-ready correction is `docs/plans/prospect-sms-single-reply-correction.md`.

The fresh reviewer independently read the execution plan/handoff and SQL evidence, then inspected source and tests. Eight targeted suites passed with exit 0, 62 tests. Root independently reproduced the insertion/prepare race against isolated PostgreSQL. Passing unit tests and migration assertions do not establish full acceptance because the missing race, gateway recovery/transport, suppressed escalation, and durable comparison cases are not represented.

Retain the current safety properties while correcting: exact claimed-source history; 20-second latest-inbound quiet window; one unique burst/revision intent; no blind retry after uncertain provider submission; typed silence without template fallback; server-derived owner identity and service-only mutations; canonical listing evidence; sealed shadow access without live handlers; explicit unknown evaluation evidence. Preserve unrelated dirty-tree work.

Final full unit/build and seeded browser evidence must be appended after correction, with a Review URL. External managed queue execution, real designated-recipient SMS QA, paid GPT shadow quality validation, and staging preview QA remain unavailable or unauthorized. Those are explicit external limits, separate from the locally fixable findings. No production release or full readiness is approved by this review.
