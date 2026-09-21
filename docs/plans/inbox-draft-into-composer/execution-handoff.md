# Inbox draft into composer - execution handoff

## End state

- Branch: `akhil/inbox-draft-into-composer`
- Worktree: `/Users/akhilvemuri/.treehouse/AXIS-2-ea44f0/10/AXIS-2`
- Base and end HEAD: `794b7de5a29f553c0b03f9887fca94fa775af670`
- State: coherent uncommitted feature and correction diff
- No production writes, deploys, force pushes, Linear, Lavish, or no-mistakes

## Original execution

Draft with PropLane reuses the existing manager and resident draft routes and
inserts generated or hydrated text into the normal reply composer. The second
editable AI composer was removed. Dirty composer text is preserved, with an
explicit **Insert draft** action for replacement. Send, channels, attachments,
and scheduling remain on the normal composer. Dedicated SMS-only drafting is
deferred because no safe reusable draft endpoint exists.

The original browser run used seeded non-demo manager data at
`http://localhost:3010/portal/communication`. It verified generation, normal
composer insertion and focus, editing, no second composer, clearing, a simulated
draft-route failure, retry presentation, and mobile layout. The task server was
stopped. Send was not pressed to avoid an external dogfood email.

## Correction cycle 1 - 2026-09-20

### P1 result

**Closed.** Adopted status now means the normal composer currently contains the
current pending AI draft text, using trim-equality. A stale thread id or
insertion-history flag no longer hides **Insert draft** after the user edits the
composer or a newer draft fails dirty-composer insertion.

Dirty protection remains unchanged. The explicit Insert action force-replaces
the composer with the current draft. The second editable AI composer was not
restored.

The corrected semantics are mirrored in:

- `src/components/portal/pro-inbox.tsx`
- `src/components/portal/pro-resident-detail-inbox.tsx`
- `src/components/portal/resident-inbox-panel.tsx`

`tests/unit/manager-inbox-ai-draft.test.tsx` covers stored draft hydration, user
edit, Redraft, dirty-protection toast, visible Insert draft, explicit
replacement, and the Insert action disappearing after adoption.

### Verification

- `npx vitest run tests/unit/manager-inbox-ai-draft.test.tsx --maxWorkers=2`
  - Exit 0 - 1 file, 4 tests passed.
- `npx vitest run tests/unit/manager-inbox-ai-draft.test.tsx tests/unit/inbox-reply-channel-picker.test.tsx tests/unit/unified-conversation-inbox.test.tsx tests/unit/resident-conversation-inbox.test.tsx --maxWorkers=2`
  - Exit 0 - 4 files, 28 tests passed.
- `npx eslint --quiet src/components/portal/pro-inbox.tsx src/components/portal/pro-resident-detail-inbox.tsx src/components/portal/resident-inbox-panel.tsx tests/unit/manager-inbox-ai-draft.test.tsx`
  - Exit 0.
- `git diff --check`
  - Exit 0.
- `npx graphify hook-rebuild`
  - Exit 1 because npm could not resolve a Graphify executable in this worktree.

## Remaining risks

- No P1 risk remains.
- The prior repository-wide typecheck attempt OOMed at the default heap; the
  heap was not raised.
- SMS-only drafting remains deferred.
- The original browser run did not send an external dogfood email.
