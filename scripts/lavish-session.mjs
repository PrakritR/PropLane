#!/usr/bin/env node
/**
 * Track the Lavish plan session agents must poll. Written when a plan opens;
 * cleared when captain approves build or session ends.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(__dirname, "..");
export const LAVISH_DIR = join(REPO_ROOT, ".lavish");
export const ACTIVE_SESSION_PATH = join(LAVISH_DIR, "active-session.json");

export function ensureLavishDir() {
  mkdirSync(LAVISH_DIR, { recursive: true });
}

/** @returns {{ planPath: string, ticket?: string, openedAt: string, status: "awaiting_review" } | null} */
export function readActiveSession() {
  if (!existsSync(ACTIVE_SESSION_PATH)) return null;
  try {
    const data = JSON.parse(readFileSync(ACTIVE_SESSION_PATH, "utf8"));
    if (!data?.planPath || !existsSync(data.planPath)) return null;
    return data;
  } catch {
    return null;
  }
}

export function writeActiveSession({ planPath, ticket }) {
  ensureLavishDir();
  const payload = {
    planPath,
    ticket: ticket ?? null,
    openedAt: new Date().toISOString(),
    status: "awaiting_review",
    pollCommand: `npm run lavish:poll`,
  };
  writeFileSync(ACTIVE_SESSION_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return payload;
}

export function clearActiveSession() {
  if (existsSync(ACTIVE_SESSION_PATH)) unlinkSync(ACTIVE_SESSION_PATH);
}
