# Resident Save and portal QA — manual bug review

Review date: 2026-11-08 (America/Los_Angeles).
Review base: `b985bc63c07f3dd5a0540a7bd99e76f56a65e157`.
Reviewed code/test head: `3195db37e6bc6fef59b83bea958e8b5794f69074`.
Product build/typecheck source: `208c98104924ce27296f7f60be6a8140e1b462b3`.
The commit adding this report is a documentation-only delta after the reviewed head.

This is a manual bugbot-style engineering review, not a claim that the hosted Bugbot service ran. It examines the resident edit, approval, lease/billing confirmation, resident access, inbox, service draft and related QA changes in this branch. The independent security, cache/native, migration transport and release reviews are separate gates owned by the release coordinator. This report does not waive those gates or approve deployment.

## Findings and resolutions

| Finding | Severity before fix | Resolution and evidence |
| --- | --- | --- |
| One resident Save broadcast an optimistic application mirror before its authoritative write, producing a self-conflicting second request; lease writes could similarly race. | High | Acknowledged application/lease writes, bounded waits and uncertain-response reconciliation. Actual Chrome happy path recorded one application, lease and charge write without409; an intentionally lost lease response retained the draft and retried successfully. Commits through `d2d7f28cb`; regression in `resident-profile-edit-save-latency.test.ts`. |
| An amount-only resident edit materialized previously absent occupancy fields and revalidated a later imported room block. | High | `15eb8e7bd`, `83ad6908f` preserve exact stored placement representation only when property/room/bundle/date/term controls are unchanged. Safe capacity messages are allowlisted. Synthetic Chrome before409/after200, real date change409, then rent change persisted through reload. The last rent change's exact request status was not retained. |
| Approval could proceed from unavailable pricing and report incomplete billing/setup as success. | High | `540d6335a`, `1279c6b62` require verified placement/pricing and preserve negotiated rent before setup; partial confirmation remains visible. Approval placement, negotiated-rent and dialog regressions cover unavailable source and occupied bed. |
| Resident edit lease regeneration could select a different application sharing an email. | High | `9a74aff5b` scopes raw stored lease identity to exact application, owner and prior/current property, with targeted voiding and explicit joint-member handling. Real-store and selector adversarial tests. |
| Signed legacy leases with a null subject were readable but did not unlock resident access/check-in. | Medium | `05f88990b` uses one resolver requiring verified email, exact approved bound application, matching owner/property and null subject; conflicting identity and unsupported legacy joint fallback fail closed. Four focused files/56 tests passed. Final runtime move-in/check-in proof remains a gate. |
| Countersign persisted stale whole applications and an optimistic full batch, then ignored billing acknowledgement. | High | `e876fbaaf` adds a narrow missing-money freeze action against the current authorized application and exact executed lease, with strict identity opening and CAS. It preserves non-money changes, explicit overrides, signed HTML and signatures. Client publication refuses changed target/scope while awaiting ACK. |
| Billing generation could restamp foreign owners, modify unrelated cached rows or publish uncertain charges. | High | `e876fbaaf` isolates synchronous generation without transient storage/events/mirroring; confirms scoped writes before conditional publication. Complete, coalesced authoritative reads support lost-response retries without duplicate IDs. Scope changes, incomplete reads, changed targets, observed paid money and newer manual overrides refuse unsafe publication; benign receipt metadata is allowed. Seven focused files/43 tests passed across this and the preceding finding. |
| SQL NULL provider status passed the identity-event guard. | Medium | Additive `9cf32eb01`, exact SQL SHA `d855c3bed7ad146d3b99e43897b3f36bd44ed4a9de4a3a1b6f2420a3c23a1188`, changes the condition to `IS NOT TRUE`. Actual DEV rollback proof covered NULL approved/expired, mismatch, valid, stale, duplicate and service-only ACL; manifest/transport/runbook18 tests and recovery digest2 tests passed. Feature flags remain disabled by default. |
| Admin compose could add a local sent record before delivery was acknowledged; initial inbox/recipient reads could hide updates. | Medium | `c49da5e09`, `fcc82e88a`, `23f2f31cf` await confirmed send and preserve loading/change state. Focused compose, recipient and inbox readiness tests. No external delivery is claimed by the no-delivery QA harness. |
| Relationship mirrors could collide across writers. | High | `500485321` scopes stored relationship IDs by writer; route isolation and sanitizer typing regressions cover foreign rows and owner continuity. |
| Escape from a service dropdown closed the wizard, and queued initialization overwrote restored drafts. | Medium | `208c98104` consumes dropdown Escape while returning focus and makes default initialization exclusive with restoration. Draft scope includes actor and stable initial property/resident context. Three focused files/13 tests passed; actual final-build modal verification remains a gate. |
| Long resident change summaries overlapped on mobile; settings navigation could not scroll independently. | Low | `cd6cf5b1f`, `85fe3897e` wrap the change value below its label and restore independent rail scrolling. Actual390px Chrome resident review screenshot confirmed no overlap and one Save control. |

## React and request-flow review

Applied the available `vercel:react-best-practices` condensed checklist and its effect-dependency/event-listener guidance. Final service initialization uses stable primitive context rather than a changing object dependency; listener cleanup and focus return remain explicit. No conditional hook or new heavy client dependency was introduced. The signed-document parser was extracted into a pure module for server reuse.

The additional billing read is deliberately fresh and bounded: it supplies authoritative money state before generation. Coalescers are keyed by viewer, workspace and oversight URL. Dependent freeze/write acknowledgements are sequenced; unrelated application and property reads remain parallel where safe. This is a correctness review, not a measured performance benchmark.

## Evidence limits and remaining release gates

No unresolved High/Critical finding remains in the reviewed fixes. This is not a whole-suite pass. The earlier full browser baseline was red (127 passed,65 failed,15 skipped,1 unrun); selector/fixture repairs and targeted successes do not replace a fresh complete run. Optional-provider skips must remain explicit.

Raw Node22 typecheck on the product source above exited0 without diagnostics. Final full lint, build, units, browser suite, current-build Save/billing/move-in/service proof, independent reviews, staged migration/app QA and deployment verification remain separately recorded gates.

Root Chrome already exercised a real Stripe TEST checkout, resident signature and manager countersign, and the vendor service path through bid, schedule, completion-photo validation and invoice. Final-build verification must still preserve the executed document/signature hashes and paid deposit without duplicate charges. Persona and live provider-refund end-to-end testing are not claimed; their flags are disabled.

Production diagnosis was read-only, including the exact room-capacity assertion and owner billing counts (75 charges/14 profiles, below read caps). Locked listings and the user's unsaved production draft were not modified. Test writes use isolated DEV fixtures; test email/SMS delivery and the exact synthetic calendar feed are intercepted and must not be described as live-provider delivery.

The E2E fixture revisions retain assertions while aligning them with current behavior: email-first token-hash signup, eligible public tour ownership, destination-calendar non-echo, exact owned cleanup and a separately verified unsigned resident for stage locks. Private credentials/storage states are supplied by the harness and are not committed.

