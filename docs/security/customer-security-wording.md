# Customer security wording

Updated September 5, 2026 (production rollout continued September 6 UTC). This answers only Marc's second question. It makes no acquisition, shutdown, export, certification or guaranteed-security commitments.

## Marc email — question 2

**How is my data protected and secured while it is stored on the platform?**

- **Encrypted connections and storage:** PropLane uses HTTPS to protect information as it travels between your device and the platform. Our database provider also encrypts stored customer data at rest.
- **An additional layer for sensitive information:** Selected applicant and co-signer identity fields, application-uploaded documents, and connected-calendar credentials are encrypted before storage, using encryption keys stored separately from the database. We have also migrated the existing production records and documents covered by this layer.
- **Controlled access:** Protected application records and documents are accessed through authenticated, permission-checked routes. Direct browser access to the sensitive application, co-signer and calendar database tables is blocked, and application document storage is private.
- **Ongoing security checks:** We review security-sensitive changes, test unauthorized access attempts, scan dependencies and source code, and address identified issues. Our testing includes open-source security tooling from Trail of Bits.

## Internal assessment — do not paste into the email

The additional encryption layer is deployed in production. Backfill evidence: 24 calendar tokens, 39 applicant identity fields and 12 application documents encrypted; post-migration inventories show zero plaintext in the covered fields and zero legacy document candidates or pending origin cleanup. There are no existing production co-signer submissions; the co-signer path passed synthetic staging checks. See [production rollout](2026-09-05-production-rollout.md).

Keep “selected” and “application-uploaded” in the wording. Applicant SSN/date of birth/license and co-signer masked SSN/date of birth/license are the canonical identity scope. Lease snapshots, other document categories, generated exports, free-text answers, historical backups and telemetry copies remain separate work. A database export may contain those other readable values. Do not claim all stolen data would be unusable.

Keys currently use server secrets and a verified local Keychain recovery copy. Independent organizational key recovery, KMS integration and a full restore/rotation drill are unfinished. A compromised runtime or an authorized account may still access information the application can decrypt.

Production direct PostgreSQL SSL enforcement and reduced browser privileges are verified. Administrator MFA is prepared but not deployed/enrolled; provider-account MFA is unverified. All four strict-read settings were configured true and the production redeploy is READY; deliberate plaintext rejection was verified in staging. The staging access checks cover specified application/document flows, not every resident/vendor/delegated route. CDN expiration and historical copies must be considered separately from origin deletion.

Provider encryption is based on [Supabase's security statement](https://supabase.com/security), rechecked September 5. Our testing is not a paid Trail of Bits audit, independent penetration test, SOC 2 certification or HIPAA compliance assessment. Avoid “100% secure,” “hack-proof,” “end-to-end encrypted,” “zero knowledge” or claims that a breach is impossible.
