# Customer security wording

## Narrow wording supported today

> PropLane uses HTTPS to encrypt traffic to our website. Our database hosting provider, Supabase, states that customer data is encrypted at rest using AES-256. We are strengthening our application-level controls and can share the scope and status of those improvements transparently.

Evidence: HTTPS/HSTS observed on the public site; [Supabase's security statement](https://supabase.com/security). Provider encryption at rest does not make a stolen logical database export unreadable.

## Marc email — answer to question 2 only

> Your information is encrypted as it travels between your device and PropLane using HTTPS. Our database hosting provider, Supabase, also encrypts stored customer data using AES-256. We’re adding another layer of encryption for selected sensitive applicant information and application documents, using keys stored separately from the database. These enhancements are currently being tested, and we’ll confirm when they have completed testing and are live.

This version describes the current production state and the work in progress. Supabase's encryption statement was rechecked on September 5. Do not change the last two sentences to completed protection until the production release and migration evidence is complete. This answers only the stored-data security question; it makes no acquisition, shutdown or export commitments.

## Draft for release after the checks below pass

Use only the bullets whose release evidence is complete. This is a prepared draft, **not a statement that the local patch is live**.

Engineering update: separate keys, prerequisite schemas, reduced browser database privileges and database SSL enforcement are configured in development/staging. Calendar, canonical applicant/co-signer identity and application-document encryption code is implemented. Hosted field-backfill dry runs and a synthetic document encryption/alias probe passed; the full unit suite passed 7,569 tests. Existing customer data has not been backfilled and the application changes are not deployed. The final production-mode build passed; deployed staging QA and production rollout remain outstanding, so these results do **not** expand today's production customer claims.

> - **Encrypted connections and storage:** PropLane uses HTTPS to protect information in transit, and our database provider encrypts stored data at rest.
> - **Restricted access:** Access to customer records is authenticated and limited by account, role and property permissions. Private documents are delivered through authorized access paths and time-limited links.
> - **Additional encryption for connected-calendar credentials:** Calendar access and refresh tokens are encrypted before storage with a separate server-held key. A database copy alone does not reveal those credentials.
> - **Additional protection for identity fields and application uploads:** Designated applicant and co-signer identity fields and application-uploaded document contents are encrypted before storage, with keys managed separately. Access through PropLane still requires authorization.
> - **Security testing and maintenance:** We review security-sensitive changes, test access boundaries, scan dependencies and source code, and address identified issues. Our tooling includes open-source security rules from Trail of Bits.

| Claim | Required evidence before use |
| --- | --- |
| Restricted access/private documents | Verify deployed RLS/storage configuration and negative tests between managers, residents and vendors, including delegated access and signed-link expiry. Source code alone is insufficient. |
| Extra calendar encryption | Separate production key provisioned; encrypting code deployed; both storage locations backfilled; zero plaintext tokens; strict reads enabled; rotation/recovery tested. |
| Applicant/co-signer identity protection | Verify production encryption for canonical applicant SSN/DOB/license and existing co-signer masked SSN/DOB/license, all reader/writer paths, backfill, negative access tests, PDF/screening flows, strict reads and recovery. Resolve duplicate lease/form/export copies before suggesting a database export cannot reveal these values. Do not imply full co-signer SSNs are retained. |
| Application document protection | Deploy encrypted uploads/downloads and service-only alias schema; verify existing-object backfill, plaintext origin cleanup **and CDN expiration/purge**, upload/preview/mobile behavior, key recovery and ownership checks. The hosted synthetic probe observed a cached plaintext response after origin deletion. This does not cover manager/vendor/inbox documents or retained exports/backups. |
| Testing and maintenance | Retain scan/review reports, release tests and remediation record. Describe this as our testing with open-source tools, never a Trail of Bits audit. |

The identity/upload bullet is conditional on **both** corresponding gates above. Keep the scope precise; do not expand it to “all data” while snapshots, exports, backups or traces can retain plaintext. The current server secret store and local Keychain recovery copies are not an independently controlled KMS or a tested organizational recovery process.

Production inspection also found no verified application MFA enrollment, including the explicit-role administrator, and disabled direct PostgreSQL SSL enforcement. Do not claim administrator MFA enforcement, complete tenant-isolation verification, universal encrypted database connections, or verified telemetry retention/deletion until those controls are implemented and tested. Website HTTPS is separately verified.

Avoid “100% secure,” “hack-proof,” “end-to-end encrypted,” “zero knowledge,” “SOC 2 certified,” “audited by Trail of Bits,” and promises that anyone who gains access cannot use any data. None is supported by this work. A compromised runtime or authorized account may still see data the application can decrypt.
