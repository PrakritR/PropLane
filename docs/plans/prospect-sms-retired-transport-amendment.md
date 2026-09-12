# Prospect SMS plan amendment: preserve retired transport

Root Astra planning decision, 2026-09-12, during correction-cycle-1 review.

The original plan incorrectly treated the old Claw gateway as an active supported rail. The authoritative `docs/agents/sms-system.md` section “Shared Claw line retired (August 6, 2026)” states that the transport is disabled and environment flags cannot reactivate it. `isClawMessengerConfigured()` returns false unconditionally; the gateway webhook returns 503 before ingestion. The historical gateway sections are not current deployment guidance. Akhil requested improvements to the chatbot and recent Twilio/Langfuse incidents, not reactivation of a retired shared phone.

## Corrected scope

- Keep Claw retired. Do not change its configuration function, webhook retirement guard, sender assignment, or public listing behavior to reactivate it.
- The deliverable is durable duplicate prevention, grounded retrieval, and GPT comparison for the active manager-owned Twilio SMS path. The shared historical handler name does not imply an active Claw transport.
- Remove the new managed-Claw provider linkage and claims that supplying credentials activates gateway delivery. Explicitly reject an unsupported/retired rail before accepting new durable work or submitting an outbox row. Never silently switch a retired shared-line reply to a different sender.
- The new durable submission path must not call a provider helper that retries uncertain sends. Preserve the existing Twilio terminal-unknown boundary. Historical retired helpers can remain outside the new path.
- Retain the proven atomic preparation, lease/revision fencing, current identity checks, and service-only database controls. Avoid unnecessary schema churn; compatibility metadata can remain if it cannot enable retired delivery.
- Replace mocked-Claw-success acceptance tests with real retirement-guard/unsupported-rail tests, and add the required actual Twilio-handler → agent/provider-stub incident tests.
- Update the original and correction handoffs/activation instructions to state the supported scope accurately. No deployment instructions should tell an operator to enable the retired gateway.

This supersedes the dual-rail activation portion of C2 in the first correction plan. It does not waive active Twilio duplicate prevention, C1 recovery, C3 receipt retry integrity, C4 honest escalation outcomes, C5 usable conservative comparison evidence, or final validation. No production release or live message is authorized by this amendment.
