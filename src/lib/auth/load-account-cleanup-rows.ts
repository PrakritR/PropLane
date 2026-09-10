import { assertAccountCleanupSucceeded } from "@/lib/auth/account-deletion-errors";

/** Discover every file reference before deletion; PostgREST caps ordinary SELECTs. */
export async function loadAccountCleanupRows<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { code?: string; message: string } | null }>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += 100) {
    const { data, error } = await page(from, from + 99);
    assertAccountCleanupSucceeded(error);
    rows.push(...(data ?? []));
    if (!data || data.length < 100) return rows;
  }
}
