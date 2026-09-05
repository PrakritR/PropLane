# Move-in and move-out inspections

The same inspection record appears in three places:

- Manager sidebar: `/portal/inspections/move-in` and `/portal/inspections/move-out`; append a report UUID to open a saved report directly.
- Manager resident detail: `/portal/residents/current/{applicationId}/inspections` (also under `past`).
- Resident My home: the dedicated `/resident/move-in/inspections` tab is the only workspace; `/resident/move-in/instructions` links to it rather than rendering a second copy of the panel.

`InspectionsPanel` and `InspectionEditor` compose the existing portal list, row, command bar, modal, collapsible section, and button primitives. New reports cover only the assigned room: overview, surfaces, windows, access and electrical fixtures. Furniture and an ensuite appear only when the assigned room's listing specifies them. No room is inferred from array order or rent; missing or mismatched assignments block creation. `document.roomScope` pins the stable assignment and display label. The original 15-area reports remain preserved; their working view exposes only the private-room section, while the original document and completed baseline remain readable. Photos in the reference PDF are not imported into anyone's residency.

The list has only Move-in / Move-out tabs, report rows and ADD. Section rows have checkboxes and open one room section at a time. The detail uses the shared back header and pinned bottom actions, matching lease detail. Upload photos, optional notes and a live document preview replace the repeated save/reload controls. Conditions remain optional and are never inferred as Good from an uploaded image.

## Storage and permissions

`resident_inspections` is a service-role-only table with RLS enabled. A report pins the application, property, manager, resident identity, room assignment, type, date, revision, and optional completed move-in baseline. Creation resolves the property owner on the server. Baselines must belong to the same application, property, manager and room assignment, and cannot postdate move-out. At most one unfinished report per application/type exists. Charges and deposits are unaffected.

`src/lib/inspections/server.ts` is the shared service behind the API and tool layer. Managers use ownership or an explicit `residents` co-manager grant at the requested read/edit level. Residents need unlocked lease access and matching email/user identity. Lists and by-id lookups apply scope in their queries; another resident of the same landlord cannot read the report. The private API requires a resolved role and same-origin mutations. No real fetches or writes run under `/demo`.

Manager and resident observations are separate. Saves accept only condition/notes for the caller's side; identity, history, acknowledgment and photo metadata are server-owned. Every write uses a revision compare-and-swap and records an audit intent/outcome; successful snapshots retain their history. Notes save after a 650ms typing pause; uploads and transitions flush outstanding edits. Inputs lock during writes to prevent returned snapshots overwriting newer typing. Conflicts preserve browser edits and offer explicit Review latest; a pending photo survives that refresh for retry. Browser/native back preserves drafts in a user/role/report-scoped, bounded, one-hour memory cache. Restoring against a newer revision stops autosave until the conflict is reviewed. Closing/reloading the tab still uses the unsaved-work guard. Browser account changes remount the workspace. List caching uses a 30-second TTL, viewer/portal/application keys, and the shared coalesced refresher for forced reads after writes.

## Review lifecycle

1. Either party creates a **Draft**, uploads photos and optionally records notes, saved automatically. Unchecked is different from Good or Not applicable.
2. **Submit for review** requires at least one observation from the submitting party and freezes both sides for review.
3. The resident explicitly **acknowledges review** of the saved revision. Resident submission includes that acknowledgment in the confirmation, then sends submit and acknowledge in sequence using the returned revision. A failed acknowledgment remains retryable; manager submission still requires subsequent resident review. This is not agreement with charges or liability.
4. The manager **completes** the acknowledged report. Completion is permanent and allows a move-in report to serve as a baseline.
5. A manager may **reopen a submitted report**, clearing acknowledgment so the revised report must be reviewed again. A completed report cannot be reopened.

## Photos and PDF

`inspection-evidence` is private. The server validates actual JPEG/PNG/WebP bytes (5 MB input and 60 photos per report), removes metadata through re-encoding, and bounds dimensions to 1800px. Filenames are unique and long cached. Signed URLs expire after 15 minutes; idle background reads renew them after 12 minutes. Reads overlapping typing, writes or navigation are discarded. A failed record write removes the newly uploaded orphan. Removing evidence detaches it only from the caller's side; private objects remain for retention.

Uploads use `useNativeCamera`; PDF downloads use `downloadBlobFile`, giving Capacitor its native picker and share/save flow. PDFs are generated from the saved server snapshot, contain observations, photos, comparison baseline, history and acknowledgment, and never accept client-supplied storage paths or document bodies.

## Assistant and observability

Both role registries expose `list_inspections`, `get_inspection`, `create_inspection`, `save_inspection_observations`, and `change_inspection_status`. Writes use `defineWriteTool`, full previews, server revalidation, and the existing confirmation/audit pipeline. Notes are explicitly untrusted data. Status changes are marked destructive because completion is irreversible, so manager SMS automatically withholds that tool. No new inline writes or assistant surface exist; existing Langfuse tracing covers the new tools. File uploads remain an interactive portal operation.

PostHog outcomes are `inspection_created`, `inspection_submitted`, and `inspection_completed` (ids/enums only). Controls use `data-attr`; notes are excluded from autocapture.

## Validation

Focused tests: `tests/unit/inspections-{model,server,client}.test.ts`, `inspection-room-template.test.ts`, `inspection-editor-autosave.test.tsx`, and `inspection-evidence-privacy.test.tsx`. They cover lifecycle, acknowledgment invalidation, ownership, co-manager read-only grants, resident isolation, baseline compatibility, conflicting writes, invalid uploads, and scoped/coalesced caching. Portal/native navigation, MCP scope and resident registry tests cover the integration.

Apply `supabase/migrations/20260905193000_resident_inspections.sql` before deploying the feature to a new environment. The development database has the migration; staging and production follow their normal release process.
