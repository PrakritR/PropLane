"use client";

export type ObservedInboxReadSource = {
  id: string;
  observation: string;
  /** Confirmed state from GET. Optimistic state belongs to the store overlay. */
  unread?: boolean;
};
export type ObservedInboxReadResult = {
  id: string;
  status: "read" | "alreadyRead" | "changed" | "archived" | "failed";
  unread: boolean;
};

/**
 * A visible acknowledgement is consumed after its first attempt, even when a
 * receipt write fails. Deferred means the pane was not eligible to attempt and
 * may retry when it becomes visible. This stops render-driven retry loops while
 * retaining explicit close/reopen recovery.
 */
export type ObservedInboxReadAttemptOutcome =
  | { kind: "deferred" }
  | { kind: "attempted"; nativeReceiptStored: boolean };

type ApplyPhase = "optimistic" | "settled";
type SettledApplyKind = "confirmed" | "withdraw";

/**
 * Starts one viewer-epoch-owned observed-read operation. Native receipts are
 * independent from the email request, so a new text is still opened while the
 * email CAS is pending. Callbacks receive no authority: the React boundary
 * owns that guard, which makes retained A-B-A callbacks inert.
 */
export function startObservedInboxReadOperation({
  viewerKey,
  epoch,
  sources,
  nativeMessageIds,
  pending,
  isCurrent,
  markNativeRead,
  applyUnread,
  post,
  notifyFailure,
}: {
  viewerKey: string;
  epoch: number;
  sources: ObservedInboxReadSource[];
  nativeMessageIds: string[];
  pending: Map<string, symbol>;
  isCurrent: () => boolean;
  markNativeRead: () => void;
  applyUnread: (
    unreadById: Map<string, boolean>,
    operation?: { token: string; phase: ApplyPhase; settled?: SettledApplyKind },
  ) => void;
  post: (sources: ObservedInboxReadSource[]) => Promise<ObservedInboxReadResult[] | null>;
  notifyFailure: () => void;
}): ObservedInboxReadAttemptOutcome {
  if (!isCurrent()) return { kind: "deferred" };
  const applyIfCurrent = (
    unreadById: Map<string, boolean>,
    operation: { token: string; phase: ApplyPhase; settled?: SettledApplyKind },
  ) => {
    if (isCurrent()) applyUnread(unreadById, operation);
  };
  let failureNotified = false;
  const notifyIfCurrent = () => {
    if (!failureNotified && isCurrent()) {
      failureNotified = true;
      notifyFailure();
    }
  };
  let nativeReceiptStored = true;
  if (nativeMessageIds.length > 0) {
    try {
      markNativeRead();
    } catch {
      nativeReceiptStored = false;
      notifyIfCurrent();
    }
  }
  if (sources.length === 0) return { kind: "attempted", nativeReceiptStored };

  const signature = `${viewerKey}:${epoch}:${sources.map((source) => `${source.id}:${source.observation}`).sort().join("|")}`;
  if (pending.has(signature)) return { kind: "attempted", nativeReceiptStored };
  const token = Symbol(signature);
  pending.set(signature, token);
  const operation = { token: signature, phase: "optimistic" as const };
  // Withdrawal does not use these values to change confirmed truth. Keeping the
  // operation-shaped map lets all compatible overlays be located while the
  // reconciler deliberately reveals whichever confirmed truth is current.
  const priorUnread = new Map(sources.map((source) => [source.id, source.unread === true]));
  applyIfCurrent(new Map(sources.map((source) => [source.id, false])), operation);

  void post(sources)
    .then((results) => {
      const requested = new Set(sources.map((source) => source.id));
      const validStatuses = new Set<ObservedInboxReadResult["status"]>([
        "read",
        "alreadyRead",
        "changed",
        "archived",
        "failed",
      ]);
      const confirmedUnread = new Map<string, boolean>();
      const duplicateOrMalformed = new Set<string>();
      for (const result of results ?? []) {
        if (
          !result ||
          typeof result.id !== "string" ||
          !requested.has(result.id) ||
          !validStatuses.has(result.status) ||
          typeof result.unread !== "boolean" ||
          confirmedUnread.has(result.id)
        ) {
          if (result && typeof result.id === "string" && requested.has(result.id)) {
            duplicateOrMalformed.add(result.id);
          }
          continue;
        }
        confirmedUnread.set(result.id, result.unread);
      }
      for (const id of duplicateOrMalformed) confirmedUnread.delete(id);

      // Only an individually valid server result advances confirmed truth.
      // Missing or malformed source outcomes are unknown, even if another
      // source in the same request committed successfully.
      if (confirmedUnread.size > 0) {
        applyIfCurrent(confirmedUnread, { token: signature, phase: "settled", settled: "confirmed" });
      }
      // An unknown outcome must never replay `priorUnread` as confirmed state.
      // This pass only removes this operation's compatible speculative overlay.
      applyIfCurrent(priorUnread, { token: signature, phase: "settled", settled: "withdraw" });

      if (
        !results ||
        confirmedUnread.size !== sources.length ||
        results.some((result) => result?.status === "failed")
      ) notifyIfCurrent();
    })
    .catch(() => {
      applyIfCurrent(priorUnread, { token: signature, phase: "settled", settled: "withdraw" });
      notifyIfCurrent();
    })
    .finally(() => {
      if (pending.get(signature) === token) pending.delete(signature);
    });
  return { kind: "attempted", nativeReceiptStored };
}
