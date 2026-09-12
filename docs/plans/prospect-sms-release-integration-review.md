# Integrated release review

Fresh Astra source review on 2026-09-12, keeper prospect-sms-release in pool5 based on b6085cd66. User authorized production release but no branches have been promoted.

P1: The submission RPC already reserves sms_outbound:<outboxId> atomically. The dispatcher then calls reserveCommsCredit again and rejects its duplicate result, blocking all otherwise successful burst sends. Skip the second reservation only for the successfully sealed burst path; ordinary rows must retain billing. Add a real dispatcher happy-path regression proving one provider call and no second reservation.

P2: Successful quiet_handoff returns ok/replied:false without a terminal marker. The durable callback sees neither suppression nor outboxId, completes failed/503 and requeues indefinitely. Preserve a terminal silence disposition through the callback and cover it behaviorally.

No additional High/Critical findings established in inspected consent, sender ownership, typed suppression, retired-Claw, callback authentication, or SQL transaction boundaries. Root97SQLassertions do not cover these application integration defects. Hold approval pending correction and focused re-review. Existing GPTscorerP2 remains disabled and separate; no third scorer correction authorized.

## Focused re-review

Fresh Astra reviewer inspected both corrections and their behavioral regressions. P1/P2 are resolved: successful atomic burst submissions bypass the second application reservation while ordinary rows still reserve; quiet manager handoff returns explicit suppression and completes at HTTP200. Implementation command `npx vitest run tests/unit/prospect-sms-outbox-dispatch.test.ts tests/unit/prospect-sms-burst-callback.test.ts` passed13/13, exit0. The existing ordinary-dispatch case passed1 test with9 unrelated cases skipped, exit0. Root97realSQLassertions remain distinct evidence; migration SHA d1581654a9dbff50c70d96f073de3c8cfca8c13416997dae2b1d64b4161f79ab unchanged.

No remaining release blocker found in reviewed scope, with burst activation and GPT comparison disabled. Source-level flag-off compatibility verified: new-ingress remains legacy, queue endpoints stop before new-table access, ordinary dispatch avoids the new RPC, and account purge tolerates missing tables. Final broad checks and activation prerequisites remain required; this is not a live deployment or external delivery acceptance.
