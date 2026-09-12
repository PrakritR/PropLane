# Prospect SMS release integration

Akhil explicitly requested production release on 2026-09-12 after reviewing the local implementation status. This authorizes keeper → main → staging → production, with normal QA and fast-forward gates. GPT comparison stays disabled because FINAL-1/P2 is unresolved and no designated keys were supplied. This is release integration with newer upstream code, not authorization for a third scorer correction cycle.

## Source and target

Original workspace `/Users/akhilvemuri/coding/AXIS-2`, branch `prospect-agent-eval-loop`, base `6f24d93b712f140d16af5f10e14b1fd88edd61aa`, substantial unrelated dirty work must remain untouched. The task-only export is `/tmp/prospect-sms-release-scope/manifest.json`, `tracked.patch`, and `new/`. It excludes pre-existing workflow, Linear, evaluation harness and process work; package.json includes only the QStash dependency.

Release pool checkout `/Users/akhilvemuri/.treehouse/AXIS-2-ea44f0/5/AXIS-2` is clean/detached at `b6085cd66e18da232640b4bc57d05e4499eb71a3`, the fetched main/staging/production head. Upstream advanced 289 commits, including SMS credit reservations, delivered quiet handoff, richer listing facts and owner/thread authorization. Preserve those current behaviors when integrating the reviewed SMS work. Use a keeper branch `prospect-sms-release`; do not force any push. Root controls all commits and remote mutations.

## Implementation manager task

Follow the feature cycle as fresh Sol-medium manager with Terra/Luna delegates. Read latest checkout instructions and original source plans/reviews via exported new docs. Apply the task patch with three-way conflict resolution and copy only manifest-listed new files. Keep current upstream listing facts, transit tools, quiet manager handoff and paid-credit/consent controls. Integrate durable batching/revision fencing/atomic outbox preparation with those behaviors; do not replace upstream files with old versions. Current-turn trace evidence remains isolated, Claw remains retired, and no GPT model/sends/network tool tests are authorized.

Use Terra for substantive SMS runtime/outbox conflicts and behavioral tests; Luna for independent inventory and regression verification in non-overlapping files. Run necessary focused tests including upstream billing/quiet handoff and new burst tests, typecheck, lint, full unit, lockfile verification and 4GB build. Do not change the known scorer P2. Report any architectural incompatibility rather than silently dropping billing, dedupe or consent. Refresh graph via installed supported workflow if available. Save integrated handoff and exact evidence under docs/plans/prospect-sms-release-handoff.md. Do not deploy, write shared DB, send SMS/email, invoke paid models, PR, Linear, no-mistakes or change original workspace.

## Release gates owned by root

Fresh reviews on merged code; actual seeded-data read/browser QA; preflight; clean selective keeper commit/push; main fast-forward then staging. Schema from staging checkout only, staging-only writes. Final production migration requires manual operator execution under the production data lock, not an agent SQL write. No QStash variables exist in Vercel production or branch-scoped staging as of read-only inspection. User asked asynchronously whether a QStash account exists. Never enable bursts without schema, credentials, signed callback and recovery QA. Do not claim main/staging/production release complete unless branch deployment and necessary activation actually succeed.
