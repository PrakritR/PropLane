> Moved out of AGENTS.md to keep every-session context lean. This file is the
> source of truth for its area — READ IT BEFORE changing code in this area.

# Documents module (Phase 1: document library foundation)

A general-purpose, manager-owned document store distinct from the ephemeral
generated tax/financial PDFs. Only the manager-level Library ships this phase;
resident/vendor sharing, auto-filing, templates, e-signature, and
compliance/expiration reminders are later phases (`docs`/scope prompt Part 2 §3-7).

**Data model** — `public.manager_documents`
(`supabase/migrations/20260711120000_manager_documents.sql`): file metadata
(`display_name`, `original_filename`, `mime_type`, `size_bytes`, `checksum`,
unique `storage_path`), `category` check-constrained to
`lease|insurance|tax|notice|invoice|inspection|photo|other`, and **polymorphic
scope** columns matching the loosely-typed identifier convention used across
`ledger_entries`/`manager_expense_entries` — nullable `property_id text`,
`unit_label text`, `lease_id text`, `resident_user_id uuid`, `resident_email
text`, `vendor_id text`, `work_order_id text` (a row with none set is
manager-level; these are app-level ids, NOT DB FKs — there is no `units`
table). Forward-provisioned columns whose UI lands later: `visibility`
(`manager|resident|vendor`, only `manager` used now — Phase 2), `expires_at`
(Phase 3 compliance), `superseded_by_document_id` self-ref (versioning),
`uploaded_by`, `deleted_at` (soft delete). RLS is the
`manager_expense_entries_owner` pattern: one `manager_documents_owner` policy
`for all using (manager_user_id = auth.uid())` — no resident/vendor policies yet.

**Storage** — PRIVATE bucket `manager-documents` (25 MB limit, MIME allowlist:
pdf, jpeg/png/webp/gif/heic, docx/xlsx/doc/xls). Paths are namespaced
`manager/<manager_user_id>/...`. **Never public**: this is the first
`createSignedUrl` use in the codebase (all prior storage is public
`getPublicUrl`). Bytes are reachable only via a server-minted short-lived
signed URL AFTER an ownership check. A defense-in-depth
`manager_documents_owner_objects` storage.objects policy scopes by
`(storage.foldername(name))[2] = auth.uid()::text`, but real access is
service-role.

**API** (`src/app/api/manager-documents/`) — every route gates on
`getReportsAuthContext({ preferRole: "manager" })` + `assertManagerFinancialsAccess`
(already tier-gates the `"documents"` section) and scopes every query by
`manager_user_id = auth.userId`; `manager_user_id`/`uploaded_by` come from the
authenticated context, never the request body. `route.ts` = GET (list/filter by
category/scope/property/search, excludes soft-deleted) + POST (multipart upload,
validates MIME+size, sha256 checksum, rolls back the storage object if the row
insert fails). `[id]/route.ts` = PATCH rename/recategorize (a blank/whitespace `displayName`
is a 400, never silently renamed to the "Untitled document" fallback) + DELETE
soft-delete. `[id]/signed-url/route.ts` = GET signed URL, always JSON — never a
302 redirect: with `?download=1` it adds a `resolveDownloadName`-derived
`fileName` and the client fetches the signed URL and saves it as a blob
(`triggerDocumentDownload`), because a 302 to storage opens a new tab in the
Capacitor WebView instead of downloading. Shared types/constants/mappers live in
`src/lib/documents/manager-documents.ts`.

**UI** — new **Library** tab (the first tab, also the section's default landing)
on the manager Documents page: `ManagerDocumentLibrary`
(`src/components/portal/pro-document-library.tsx`), rendered by
`manager-documents-panel.tsx`. Adding/removing a Documents tab id still requires
editing THREE in-sync lists: `DOCUMENT_TABS` (panel), the `documents` section
`tabs` in `src/lib/portals/pro.ts`, and `DOCUMENTS_TABS` in
`src/lib/render-portal-section.tsx` (+ the default-redirect target there). Upload
uses a hidden `<input type="file">` (drag-drop on web, native picker in the
Capacitor WebView) — no new bucket/camera plumbing needed. Preview is a signed-URL
`<iframe>` (pdf) / `<img>` (image) in the shared `Modal`; non-inline types fall
back to Download.

# Documents module (Phase 2: sharing & visibility)

**Goal:** Managers can share library files with residents or vendors; recipients see them in their own Documents portal under a **Shared** tab.

**Schema** — uses existing `visibility` column (`manager|resident|vendor`). Migration `20260711130000_manager_documents_sharing.sql` adds RLS read policies: `manager_documents_resident_read` (visibility resident + `resident_user_id` or email match) and `manager_documents_vendor_read` (visibility vendor + `vendor_id` linked to `manager_vendor_records.vendor_user_id`).

**API**
- Manager upload/PATCH accept `visibility`, `residentEmail`, `vendorId` with `validateDocumentVisibilityScope` + vendor ownership check (`document-scope.server.ts`).
- `GET /api/resident/shared-documents` + `GET /api/resident/shared-documents/[id]/signed-url` — `assertResidentFinancialsAccess`, list via `document-access.ts`.
- `GET /api/vendor/shared-documents` + `GET /api/vendor/shared-documents/[id]/signed-url` — `assertVendorFinancialsAccess`.
- Sharing triggers `deliverPortalInboxMessage` + server `document_shared` PostHog event (`document-share-notify.server.ts`).

**UI**
- Manager Library: visibility picker on upload/edit (`ManagerDocumentLibrary`), vendor dropdown from manager vendor directory.
- Resident Documents: manager-shared docs are folded into the **Other documents** tab (`resident-other-documents.tsx`), one merged table with a Source column ("You" vs "Shared"); the standalone "Shared with you" tab was removed and `/documents/shared` redirects to `/documents/other`. Same `/api/resident/shared-documents` endpoint + signed-URL preview as before.
- Vendor Documents: **From managers** tab (`portal-shared-documents-table.tsx`).

# Documents module (Phase 3: expiration & compliance)

**Goal:** Surface `expires_at` on library uploads, filter/banner for expiring docs, and daily manager inbox reminders.

**Lib** — `src/lib/documents/document-expiration.ts`: bucket helpers (`expired` / `within30` / `within60` / `within90`), category defaults (`insurance` + `inspection` → +1 year on upload when no date supplied), `summarizeDocumentExpiration` for banners.

**API**
- Manager POST/PATCH accept `expiresAt` (`YYYY-MM-DD` or null to clear); POST auto-fills default expiry for insurance/inspection categories.
- `GET /api/manager-documents/expiration-summary` — `{ expired, within30, within60, within90 }` counts for dashboard banner.
- `GET /api/cron/send-document-expiration-reminders` — daily cron (Vercel `0 8 * * *`); inbox message to manager for docs expiring within 30 days, deduped via `portal_outbound_mail_records` id `doc_expiry_reminder_<docId>_<date>`.

**UI**
- Manager Library: expiration date on upload/edit, status pills (All / Expired / Expiring ≤30d / ≤90d), expiry column + compliance banner.
- Manager Dashboard: top banner linking to library with `?expiry=` filter when expired or ≤30d count > 0.

# Documents module (Phase 4: auto-filing)

**Lib** — `src/lib/documents/document-auto-file.server.ts`: `autoFileDocumentToLibrary()` (service-role upload); opt-in per category via `manager_automation_settings.document_auto_file` jsonb (`lease`, `invoice`, `application`, `expense_receipt`).

**Hooks** — call from portal write paths when settings enabled (lease fully signed, work order paid, etc.). Server-side only; never client-trusted storage paths.

# Documents module (Phase 5: versioning)

Library list excludes superseded rows (`superseded_by_document_id is null` on list query). Upload-new-version links prior row → new row via `superseded_by_document_id` on the old document.

# Documents module (Phase 6: templates)

**Schema** — `manager_document_templates` in `20260712140000_documents_advanced.sql`.

**API** — `GET/POST /api/manager-document-templates`; `applyMergeFields` in `document-templates.ts` for filled HTML.

# Documents module (Phase 7: e-signature foundation)

**Schema** — `manager_documents.signature_status`, `signed_at`, `signature_requested_at`.

**API** — `POST /api/manager-documents/[id]/request-signature` (inbox notice to resident; full signing reuses lease-signing flow in a later slice).
