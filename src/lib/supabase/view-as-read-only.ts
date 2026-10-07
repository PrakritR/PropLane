import type { SupabaseClient } from "@supabase/supabase-js";
import {
  isViewAsSessionOpen,
  VIEW_AS_WRITABLE_TABLES,
  VIEW_AS_WRITE_BLOCKED_ERROR,
} from "@/lib/auth/view-as-guard";

/**
 * Defense in depth for "View as": while a view-as session is open, the
 * service-role client refuses to write and refuses to mint private-file access,
 * whatever code path asked.
 *
 * The middleware already refuses every non-read request, so no write can arrive
 * from a client. This catches the remaining way a session could change the
 * account it is looking at: a GET handler or server-rendered page that heals,
 * backfills or provisions as a side effect of being read. Those resolve to the
 * same Supabase error shape an RLS refusal does, so callers' existing
 * `if (error)` paths run instead of a write.
 *
 * Covered: `insert` / `update` / `upsert` / `delete` on every table except the
 * audit trail; storage `upload` / `update` / `move` / `copy` / `remove` and the
 * private-bytes calls `createSignedUrl(s)` / `createSignedUploadUrl` /
 * `download`. NOT covered: `rpc()` (indistinguishable from a read by name) and
 * `auth.admin.*`. The check is request-scoped (the signed cookie); outside a
 * request (cron, webhooks) it is a no-op.
 */

const WRITE_VERBS = new Set(["insert", "update", "upsert", "delete"]);
const BLOCKED_STORAGE_MEMBERS = new Set([
  "upload",
  "update",
  "move",
  "copy",
  "remove",
  "createSignedUrl",
  "createSignedUrls",
  "createSignedUploadUrl",
  "uploadToSignedUrl",
  "download",
]);

type Thenable = { then: (onFulfilled?: unknown, onRejected?: unknown) => unknown };

function isThenable(value: unknown): value is Thenable {
  return Boolean(value) && typeof (value as Thenable).then === "function";
}

function blockedResult() {
  return { data: null, error: { ...VIEW_AS_WRITE_BLOCKED_ERROR }, count: null, status: 403, statusText: "read_only_view_as" };
}

/** A write builder: chainable like the original, but its terminal `then` checks the session first. */
function guardWriteBuilder<B extends object>(builder: B): B {
  const proxy: B = new Proxy(builder, {
    get(target, property) {
      if (property === "then") {
        return (onFulfilled?: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
          isViewAsSessionOpen().then((open) =>
            open
              ? Promise.resolve(blockedResult()).then(onFulfilled, onRejected)
              : (target as unknown as Thenable).then(onFulfilled, onRejected),
          );
      }
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const out = (value as (...a: unknown[]) => unknown).apply(target, args);
        if (out === target) return proxy;
        return out && typeof out === "object" && isThenable(out) ? guardWriteBuilder(out as object) : out;
      };
    },
  });
  return proxy;
}

function guardTable<T extends object>(table: T, name: string): T {
  if (VIEW_AS_WRITABLE_TABLES.has(name)) return table;
  return new Proxy(table, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof property === "string" && WRITE_VERBS.has(property) && typeof value === "function") {
        return (...args: unknown[]) => guardWriteBuilder((value as (...a: unknown[]) => object).apply(target, args));
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function guardBucket<T extends object>(bucket: T): T {
  return new Proxy(bucket, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof property === "string" && BLOCKED_STORAGE_MEMBERS.has(property) && typeof value === "function") {
        return async (...args: unknown[]) => {
          if (await isViewAsSessionOpen()) return { data: null, error: { ...VIEW_AS_WRITE_BLOCKED_ERROR } };
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function guardStorage<T extends object>(storage: T): T {
  return new Proxy(storage, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === "from" && typeof value === "function") {
        return (bucket: string) => guardBucket((value as (b: string) => object).call(target, bucket));
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export function withViewAsReadOnly<T extends SupabaseClient>(db: T): T {
  return new Proxy(db, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === "from" && typeof value === "function") {
        return (table: string) => guardTable((value as (t: string) => object).call(target, table), table);
      }
      if (property === "storage" && value && typeof value === "object") return guardStorage(value as object);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
