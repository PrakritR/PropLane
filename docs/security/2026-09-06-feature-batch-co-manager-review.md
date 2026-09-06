# Co-manager open invite security review — 2026-09-06

Reviewed the feature batch against current main, including create, edit, rotate,
preview and redeem routes; token generation; schema/RLS; plan reconciliation;
serializer; and manager invite entry points. Account deletion was excluded.

Fixed before landing:

- Redemption checked the token before work but claimed only by row id/status.
  It now compares the token hash and assigned-property snapshot at claim time,
  rejecting rotation or scope changes since ownership validation.
- Redemption and rotation did not recheck the inviter's paid plan. Both now do;
  redemption also fails closed on participant profile and invitee-plan errors.
- The Free invitee feature conflicted with downgrade reconciliation. A server-only
  `invitee_plan_inherited` flag preserves incoming open links while the owner is
  paid. A positively Free owner still loses outgoing links; legacy direct-ID
  links retain their existing paid-participant policy.
- Browser writes to the invite table are explicitly revoked in the migration.
  Existing RLS allows participant SELECT alone. Token hashes are not bearer
  credentials and the HTTP serializers do not return them.
- Automatic analytics could capture bearer URLs. The centralized `before_send`
  sanitizer scrubs sensitive URLs recursively, including current/referrer/history
  properties, hrefs, encoded `next=` redirects and legacy invite path tokens.

Merge resolution preserved main's contact-disclosure gate: an outgoing pending
invite does not expose the recipient's email or phone. Nullable open-invite
serialization remains in the shared library, not a Next.js route export.

Validation: six co-manager suites passed (48 tests), including behavioral token
claim/rotation and inherited-plan regression tests. Existing invite security
suite passed (18 tests); shared chooser and analytics suites passed (9 tests).
Browser interaction and live PostHog delivery are not proven by these unit tests;
full-batch build/CI and staging QA are owned by the promotion task.
