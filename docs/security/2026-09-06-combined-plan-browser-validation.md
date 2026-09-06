# Shared-room and Sales integration browser checks

Validated against the local production build on port 3114 and the shared
development Supabase project only. All accounts and transactions in these checks
were temporary QA fixtures. No real Sales records were imported.

## Shared room

- At 390px, the manager approved two separate applications assigned to one
  capacity-2 room. Both requests returned 200. The third returned 409 and stayed
  pending, without charges or a provisioned account.
- The two approved residents each received their own $700/month lease draft,
  $700 first-month rent and $700 next-month rent. Rent was not divided between
  roommates. The pending third applicant remains visible in the resident
  directory by its existing design; this is not a third approved placement.
- Separate authenticated resident sessions opened Payments, Lease and Documents
  without horizontal overflow or the other resident's email. My home remained
  locked for draft leases.
- Signed states were then **seeded on those test leases** to exercise post-signing
  views. This is not evidence of completing the browser signature workflow.
  Housemates initially withheld room/name/contact details. After each test
  resident used the sharing form to opt into room/name sharing, both saw their
  peer under “Roommates — your room”; contact and financial details stayed hidden.
- The listing editor displayed “2 residents” and offered a maximum of 20. This
  check opened the editor and inspected its choices; it did not save a capacity
  change through the complete listing wizard.
- Public occupancy reported a single room span with count 2 for the two stays
  and sent `public, s-maxage=60, stale-while-revalidate=120`. Property Bookings
  displayed both independent stays under In-house once its lease load finished.

The application rows were seeded before manager approval. The complete public
application wizard and full browser lease-signature journey remain separate
release QA requirements. These checks do not claim that entire journey passed.

## Sales operating cycle

The first fixture used an incomplete pending-property shape. Portal hydration
treated it as a submission, assigned another listing ID and cleared placement
links on deletion of the pending record. It was unsuitable for end-to-end proof.
The corrected fixture uses `buildMockPropertyFromDraft`, a canonical live record,
and an isolated test manager. The operating cycle was repeated with that fixture:

- Eight import steps completed; all eight were skipped on repeat. Historical
  paid rent, unpaid opening debt and held deposit retained their distinct states.
- Reviewed variable-utility allocation succeeded once; repeat was idempotent,
  and an explicit-zero fixed agreement rejected another allocation.
- Completed move-in baseline, resident review, manager-completed move-out,
  approved repair bill and reviewed deposit disposition preserved all four
  history entries. The $600 original deposit, $100 prior refund and $50 prior
  deduction ended with a new $100 deduction, $350 refund disposition and $0 held.
- CSV intake matched one income and one expense and excluded consumed targets.
  The authenticated 390px browser then previewed and explicitly saved a separate
  statement file and downloaded an 8,929-byte deposit PDF, without horizontal
  overflow or browser runtime errors.
- A post-browser database check confirmed the canonical property and approved
  imported placement survived portal hydration with the same property ID.

Portal selection used the existing authenticated set-active-portal API after
real browser sign-in because the chooser remained on Loading. Bookings checks
waited for lease data rather than treating its first empty render as final.

The source reconciliation and no-mistakes decisions documented in
[the integration review](2026-09-06-sales-migration-review.md) still apply.
This is development evidence, not staging or production QA sign-off.
