#!/usr/bin/env node
// Fail closed when a non-production Vercel pull still points at the live
// production Supabase project. Used by the backup Vercel Deploy workflow
// after `vercel pull` for main / staging.
const prodRef = (process.env.AXIS_PROD_SUPABASE_REF || "").trim();
const url = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
if (!prodRef) {
  console.log("assert-nonprod-supabase-url: AXIS_PROD_SUPABASE_REF unset — skip");
  process.exit(0);
}
if (!url.trim()) {
  console.error(
    "assert-nonprod-supabase-url: NEXT_PUBLIC_SUPABASE_URL is empty after vercel pull. " +
      "Staging/main must resolve the shared dev/test project.",
  );
  process.exit(1);
}
if (url.includes(`${prodRef}.supabase.co`)) {
  console.error(
    `assert-nonprod-supabase-url: NEXT_PUBLIC_SUPABASE_URL points at the live production project (${prodRef}). ` +
      `main and staging must use the shared dev/test project. See docs/database-environments.md.`,
  );
  process.exit(1);
}
console.log("assert-nonprod-supabase-url: ok (not the live production project)");
