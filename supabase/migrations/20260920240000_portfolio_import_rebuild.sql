-- Portfolio import rebuild (docs/agents/portfolio-import.md).
--
-- The pre-rebuild import (removed in 8302fa69) stored exactly one file per
-- `manager_portfolio_imports` row (`file_name`/`source_kind`/`file_sha256`
-- all `not null`, one `preset`). The rebuilt import accepts up to 50 files in
-- one upload, so those single-file columns can no longer be required on
-- every row. Nothing is dropped or renamed — existing rows and every reader
-- of the old columns keep working unchanged; new rows populate `files` (the
-- authoritative multi-file list) and leave the legacy columns as a
-- best-effort single-file mirror (`store.server.ts`'s `legacyMirror`).
--
-- The `draft` jsonb column is reused as-is for the new proposal shape,
-- distinguished by an explicit version tag: `{version: 2, proposal}` is the
-- rebuilt `PortfolioImportProposal` (src/lib/portfolio-import/types.ts);
-- `{version: 1, table, draft}` is the pre-rebuild shape and is never written
-- by any code after this migration. No schema change is needed for that —
-- jsonb already holds either shape, and `store.server.ts` never reads a
-- version-1 row as a proposal.
--
-- Idempotent: safe to run more than once.

alter table public.manager_portfolio_imports
  alter column file_name drop not null,
  alter column file_sha256 drop not null,
  alter column source_kind drop not null;

alter table public.manager_portfolio_imports
  add column if not exists files jsonb not null default '[]'::jsonb;

comment on column public.manager_portfolio_imports.files is
  'Rebuilt import: [{name, kind}] for every uploaded file. Replaces the single file_name/source_kind for a multi-file upload; file_name/source_kind/file_sha256 stay as a best-effort single-file mirror on new rows and the authoritative value on pre-rebuild rows.';

comment on column public.manager_portfolio_imports.draft is
  'Rebuilt import: {version: 2, proposal: PortfolioImportProposal} (src/lib/portfolio-import/types.ts). {version: 1, table, draft} is the pre-rebuild shape and is never written by new code.';
