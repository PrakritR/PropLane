# Resident identity and evidence rollout

| Flag | Off | On |
| --- | --- | --- |
| `RESIDENT_IDENTITY_ENABLED` | Existing application, tour and stay behavior remains unchanged. | New protected actions require the authenticated resident's provider-approved identity. Existing rent and services are unaffected. Missing Persona configuration is unavailable, not a bypass. A stored approval remains valid without provider configuration. |
| `RESIDENT_EVIDENCE_ENABLED` | Property-specific evidence requirements are not enforced. The separate baseline identity flag still applies. | The server must resolve the current property policy, purpose, jurisdiction and approved products. Missing policy, jurisdiction, legal review or required evidence fails closed. |
| `RESIDENT_SCREENING_ENABLED` | The new resident screening product is unavailable. | The product still requires an authorized application, approved policy and consent, payment, provider credentials and signed webhook configuration. A flag alone does not authorize a charge or an order. |

Persona `completed` is not an approval. Only the signed provider decision confirmed against Persona can attest identity; manual review records a support request and cannot attest identity. Never store identity documents or SSNs in these records or send them to analytics.

The current screening adapter and policy foundation are not a complete purchase, report sharing or enforcement flow. Keep screening rollout off until those paths and their real provider, database and browser proof are complete. The baseline gate must be wired to every protected entry point before identity rollout is enabled.

`RESIDENT_IDENTITY_PROVIDER` picks the provider (default `checkr`, or `persona`); the Persona rows above apply only when it is `persona`. The default Checkr ID check rides the applicant's screening order and is not a pre-application gate. Stripe Identity is refused: its terms bar FCRA-covered eligibility decisions. See [`identity-and-screening.md`](identity-and-screening.md).
