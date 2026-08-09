// Stub for Next's `server-only` / `client-only` marker packages.
//
// Next aliases both internally so importing one is a build-time assertion about
// where a module may be used; vitest does not, so any module importing
// `server-only` fails to resolve under test. That is not hypothetical — it took
// `tests/unit/resident-portal-multirole-unlock-render.test.tsx` out entirely
// (via `co-manager-notification-recipients.server.ts`), which is the suite
// pinning the manager+resident account that AGENTS.md names as the first
// account to test any portal-gating change against. It contributed zero
// coverage while appearing to exist.
//
// Importing the marker has no runtime behaviour, so an empty module is the
// faithful stand-in. Wired up in `vitest.config.ts`'s `resolve.alias`.
export {};
