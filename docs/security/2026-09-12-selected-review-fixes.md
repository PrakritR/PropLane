# Selected review findings F7–F11

F7 is a replacement-payload defect: the vendor editor now retains existing fields before applying its edited fields. F8 is a shared-read boundary defect: both catalog and ordinary shared-directory responses use an explicit public projection; owner and granted team reads retain their existing authorization paths. F9–F10 are incomplete shared inbox adoption: per-conversation menus retain exact merged identities and existing deletion confirmation, and all three chat portals use status filtering. F11 is CSS precedence within record menus: menu backgrounds override inherited inline button fills while destructive text remains red.

Scope evidence: `git diff 1164c1d4 8f7e7606 -- src/hooks/use-autosave-draft.ts src/components/portal/pro-task-form-modal.tsx` is empty. The same comparison for `pro-vendor-detail.tsx` only changes the completed-service bucket from `done` to `completed`. F1–F6 remain excluded as requested. No hosted data, messages, tickets, PRs, or branch promotions are part of this fix round.

Recovered the completed edits from the local validator transcript after its account limit terminated the run and removed its scratch worktree. Focused verification: 50 tests across 9 suites passed. The full build also exposed an unrelated invalid Next route export; DATA_EXPORT_WINDOW_MS is now module-private with its rate-limit behavior unchanged.
