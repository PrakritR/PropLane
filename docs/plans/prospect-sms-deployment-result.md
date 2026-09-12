# Prospect SMS deployment result

2026-09-12. Akhil explicitly authorized production shipping, removal of the blanket production-write rule, migration reconciliation, and application of the reviewed migrations.

## Released code and databases

- Release commit: `fd82aa1189219f6846d939d81a5469d970bcf356`.
- Fast-forward ladder completed: `prospect-sms-release` -> `main` -> `staging` -> `production`.
- Staging: READY deployment `dpl_7cEdv1qvYmGBogmsyAgBWPpxhD5i` at this SHA.
- Production: READY deployment `dpl_7ZesEoqJSWQaVHAktPF5nYGwye21` at this SHA; authenticated Vercel API confirms `prop-lane.space` resolves to it.
- Staging CI [34716854981](https://github.com/PrakritR/PropLane/actions/runs/34716854981) passed unit, lint, build, integration, public e2e and aggregate check. Manual full e2e was not run by that workflow.
- Reviewed DDL and migration-record repairs completed in both databases. Readback confirms all 197 repository migration names are applied, with zero missing names or identity problems. Historical bundles were preserved and their data backfills were not rerun. See `prospect-sms-release-activation.md` for exact counts and scope.
- Final preflight exited 0, including authenticated production parity. The private CLI transport wrapper established the authorized `postgres` role after pooler login without changing the reviewed transaction runner or its binding and attestation checks.

## Deployed feature QA

On both staging and production, real Chromium browser QA opened the Jain Home tour link, continued as a guest, selected Room 1, and displayed 14 available times on September 14. The mobile viewport was 390 by 844 with no horizontal overflow. Public availability APIs returned HTTP 200 with 263 slot-host keys. No booking or SMS was submitted.

Staging additionally verified the invalid-property link gate and anonymous `/portal` redirect to sign-in. Initial snapshots taken before listing data arrived displayed the link gate; settled snapshots resolved Jain Home. The assertions above use the settled page state.

Production page: <https://prop-lane.space/rent/tours-contact?propertyId=mgr-jain-home-new-listing-p9r2z5uhb6vq>.

Private evidence remains under `/tmp/prospect-sms-reconcile/`; browser snapshots are in the original checkout's ignored `.playwright-cli/` directory. Baseline snapshots were preserved. The isolated PostgreSQL test cluster was stopped after validation.

## Activation still required

- `PROSPECT_SMS_BURSTS_ENABLED=0`: new 20-second grouping is deployed but disabled until QStash credentials and controlled delivery QA are complete. Both environments already have callback URLs and distinct callback secrets.
- Add `QSTASH_URL`, `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, and `QSTASH_NEXT_SIGNING_KEY` to Vercel Production and Preview scoped to `staging`. Keep keys out of tracked files. Then redeploy and verify signed queue delivery, recovery and duplicate handling before enabling the flag.
- `AXIS_PROSPECT_GPT_SHADOW_ENABLED=false`: designated development/production OpenAI keys and the known scoring correction remain prerequisites. No GPT comparison is claimed as active.
- Controlled SMS delivery to a designated recipient remains untested because no recipient was supplied. The recorded unit and SQL concurrency tests do not replace external transport QA.

## TestFlight

Production run [34717334279](https://github.com/PrakritR/PropLane/actions/runs/34717334279) completed successfully, including its secrets check, build/upload, and **Distribute build to internal TestFlight group** step. The internal distribution gate is verified, not inferred from upload alone.
