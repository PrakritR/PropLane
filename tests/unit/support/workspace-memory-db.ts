/** The in-memory Supabase double already carries the workspace RPCs; this alias names that intent. */
import { createMemoryDb, type MemoryDb } from "./memory-supabase";

export type WorkspaceMemoryDb = MemoryDb;

export function createWorkspaceMemoryDb(seed: Record<string, Record<string, unknown>[]> = {}): WorkspaceMemoryDb {
  return createMemoryDb({ portal_workspaces: [], manager_sms_numbers: [], manager_assistant_emails: [], ...seed });
}
