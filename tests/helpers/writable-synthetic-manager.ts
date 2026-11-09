import type { Browser } from "@playwright/test";
import {
  createSyntheticPublicTourManager,
  cleanupSyntheticPublicTourManager,
  type SyntheticPublicTourManager,
} from "./synthetic-public-tour-manager";
import { createSyntheticProperty } from "./synthetic-property-e2e";

/**
 * A fresh manager who OWNS a writable workspace, plus the owned properties a test needs.
 *
 * Several portal tests were signing in as the canonical manager and then asserting a write — a
 * Properties row menu with Edit and Unlist, a promotion created through the real modal, a
 * property-scope save in Settings. That account's workspace is PropLane-managed and View only,
 * so the product correctly answered `403 read_only_managed` and the menus correctly had no write
 * actions. The tests were wrong, not the guards: a write test needs an owner.
 *
 * And the canonical free-plan manager already has nine listed properties, so the listing editor
 * correctly refuses to open past the plan limit. A fresh signup starts below it.
 *
 * Nothing here weakens a guard or writes with the service role as proof: the account signs up
 * for real through the emailed `token_hash` proof, its mandatory phone gate is cleared as
 * fixture setup (never as an OTP claim), and every property is created and deleted through the
 * ordinary authenticated API with the owner, id shape and run marker re-checked each time.
 */
export type WritableSyntheticManager = SyntheticPublicTourManager & {
  /** Every property created for this fixture, the first being `property`. */
  properties: Array<{ id: string; name: string }>;
};

type EmptyWritableSyntheticManager = Omit<SyntheticPublicTourManager, "property"> & { property: null; properties: [] };

export function createWritableSyntheticManager(browser: Browser, options: { properties: 0; tier?: "free" | "pro" }): Promise<EmptyWritableSyntheticManager>;
export function createWritableSyntheticManager(browser: Browser, options?: { properties?: number; tier?: "free" | "pro" }): Promise<WritableSyntheticManager>;
export async function createWritableSyntheticManager(
  browser: Browser,
  options: { properties?: number; tier?: "free" | "pro" } = {},
): Promise<WritableSyntheticManager | EmptyWritableSyntheticManager> {
  const wanted = options.properties ?? 1;
  if (!Number.isInteger(wanted) || wanted < 0) throw new Error("Synthetic property count must be a nonnegative integer.");
  if (wanted === 0) {
    const manager = await createSyntheticPublicTourManager(browser, { createProperty: false, tier: options.tier });
    return { ...manager, properties: [] };
  }
  const manager = await createSyntheticPublicTourManager(browser, { tier: options.tier });
  const properties = [manager.property];
  try {
    for (let i = 1; i < wanted; i += 1) properties.push(await createSyntheticProperty(manager.page));
  } catch (error) {
    await cleanupWritableSyntheticManager({ ...manager, properties });
    throw error;
  }
  return { ...manager, properties };
}

/**
 * Deletes only this fixture's own tracked properties and restores the phone stamp. A failure is
 * reported, never hidden: a leaked synthetic property or a left-behind verified flag has to be
 * visible in the run.
 */
export async function cleanupWritableSyntheticManager(manager: WritableSyntheticManager | EmptyWritableSyntheticManager): Promise<void> {
  await cleanupSyntheticPublicTourManager(manager);
}
