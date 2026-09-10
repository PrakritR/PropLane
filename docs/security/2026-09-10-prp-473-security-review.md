# PRP-473 security review

Date: 2026-09-10. Read-only source review of the uncommitted PRP-473 implementation in the pool worktree. Base and HEAD both `0b6d56794407277761ad5f6c680a522e97db2e6d`; this report does not certify a later commit or changed diff.

Scope: the new `src/lib/sms/tour-sms-eligibility.server.ts`, changes to tour notification delivery, reschedule SMS replies, inquiry creation, tours tools, tool context, leasing SMS runtime, notification copy, and their focused tests. Supporting reads covered the consent ledger, outbound dispatcher, application consent helper, and signed email reply-address helper. Root and Akhil instructions, the PRP-473 plan/handoff, and relevant tour/SMS/agent/email architecture documentation informed the review. No source changes, external messages, data writes, or production operations were performed. No no-mistakes pipeline was invoked.

## Findings

### P2 - A START-derived purpose grant bypasses later conversation revocation

Location: `src/lib/sms/tour-sms-eligibility.server.ts:112` (existing-purpose branch); source materialization at line 158.

The resolver accepts `twilio_start` as manager-conversation evidence and copies that source into the tour-purpose grant. On a later call, it checks the current conversation only when the purpose source is `recipient_initiated_inbound`. Therefore the same derived authority is treated differently after START: a current conversation revoke, missing conversation evidence, or unreadable conversation ledger is ignored for the `twilio_start` purpose grant. This contradicts the intended rule that a later source-conversation revoke invalidates materialized authority.

Deterministic local evidence: transpiled the actual resolver in memory and ran it against a scoped mocked ledger with an exact tour-purpose grant and a newer revoked `manager_conversation`. The `recipient_initiated_inbound` variant returned `{eligible:false, reason:"tour_sms_consent_missing"}` and queried both purposes. Changing only the purpose source to `twilio_start` returned `{eligible:true, provenance:"twilio_start"}` and queried only `tour_rescheduled`. Harness exit 0; no files or external state were changed.

The dispatcher does not compensate: `src/lib/sms/owner-sms-dispatcher.server.ts:149` calls `ensureApplicationScopedSmsConsent`, whose granted-purpose branch (`src/lib/sms/application-consent.server.ts:33`) returns immediately without inspecting conversation provenance. Global STOP and an exact tour-purpose revoke still block; this finding concerns a conversation-only revoke or lost source evidence while the tour-purpose grant remains granted.

Suggested correction: preserve whether a purpose grant was derived from the conversation in the authorization read, and revalidate that source for both accepted conversation provenance values. Keep independently restored or explicit tour opt-in semantics deliberate. Add the START variant of the existing revoke-after-derived-grant test.

### P2 - A conversation revoke after enqueue is not enforced at provider dispatch

Location: `src/lib/sms/tour-sms-eligibility.server.ts:158` (durable derived grant), in combination with `src/lib/tour-notification-delivery.server.ts:491` (shared sender enqueue).

A successful lifecycle resolution materializes a tour-purpose grant. If the recipient's source conversation is revoked after enqueue and before provider submission, the outbox worker never calls the new resolver. `dispatchOwnerSmsOutbox` (`src/lib/sms/owner-sms-dispatcher.server.ts:467`) invokes `loadSendPolicy`, which rechecks global suppression and the exact-purpose grant but does not revalidate the conversation on which this new grant depends. Thus even the `recipient_initiated_inbound` branch's retry protection does not cover delayed dispatch. This is a source-confirmed interleaving, not a reproduced provider send.

Suggested correction: enforce derived-source validity at the final dispatch policy boundary, or atomically propagate source-conversation revocation to its derived scopes. Add a queue-before-revoke/dispatch-after-revoke behavioral test with the provider mocked. A global STOP test alone does not exercise this case.

## Other reviewed boundaries

- Positive ledger reads constrain owner, normalized recipient, messaging service, transactional class, purpose, and prospect conversation key. Query errors fail closed.
- The SMS tool pins the supplied phone to authenticated SMS context; explicit channel propagation prevents voice/email from inheriting SMS origin. Inquiry creation strips the public `smsOrigin` field and stamps server-owned provenance.
- Reply CAS retains owner, sender phone, original work number, version/generation, and current row window predicates. Existing proposal eligibility is a persisted snapshot, not a fresh consent read; no additional authorization bypass is claimed here.
- Guest email uses the existing pair-signed reply address. The helper binds the manager id and guest email; no new caller-controlled routing token or key exposure was introduced. When reply configuration is absent the helper returns null, so the unconditional email fallback copy still requires separate product acceptance.
- Lifecycle trace summaries contain ids, enums, and delivery identifiers, without the phone, email, message body, or free-form provider error.

## Validation limits

The dedicated source harness above was independently run. The implementation handoff's full test/lint/build passes were read but not independently rerun in this security pass. No handset delivery, STOP/START round trip, production configuration, or inbound email routing was exercised. Global suppression and exact-purpose revocation behavior remain distinct from the conversation-only cases in these findings.
