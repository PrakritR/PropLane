"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Modal } from "@/components/ui/modal";
import { ConfirmDeleteModal } from "@/components/portal/confirm-delete-modal";
import { applyDevResetEpoch } from "@/lib/dev/reset-epoch";

type Toast = { id: number; message: string };

/** What {@link AppUiContextValue.confirm} asks the person. */
export type ConfirmRequest = {
  /** Modal heading. Defaults to "Delete" because most confirms are deletes. */
  title?: string;
  /** The question itself, e.g. `Delete "September rent" for Ada?`. */
  description: ReactNode;
  confirmLabel?: string;
  /** Line under the question; pass null when the action IS reversible. */
  note?: ReactNode;
  tone?: "danger" | "primary";
  dataAttr?: string;
};

type AppUiContextValue = {
  toasts: Toast[];
  showToast: (message: string) => void;
  modal: { title: string; body: string } | null;
  openModal: (payload: { title: string; body: string }) => void;
  closeModal: () => void;
  /** Resolves true when the person confirms, false on cancel or dismiss. */
  confirm: (request: ConfirmRequest) => Promise<boolean>;
};

const AppUiContext = createContext<AppUiContextValue | null>(null);

export function AppUiProvider({ children }: { children: ReactNode }) {
  // A dev database wipe leaves the browser's `axis:*` mirror behind, so the
  // portal shows properties that no longer exist and two tabs can disagree
  // (PRP-195). No-ops entirely unless NEXT_PUBLIC_DEV_RESET_EPOCH is set, which
  // it never is in production.
  useEffect(() => {
    applyDevResetEpoch();
  }, []);

  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastSeq = useRef(0);
  const [modal, setModal] = useState<{ title: string; body: string } | null>(
    null,
  );

  const showToast = useCallback((message: string) => {
    const id = Date.now() * 1000 + (toastSeq.current++ % 1000);
    setToasts((t) => [...t, { id, message }]);
    window.setTimeout(() => {
      setToasts((t) => t.filter((x) => x.id !== id));
    }, 3200);
  }, []);

  const openModal = useCallback((payload: { title: string; body: string }) => {
    setModal(payload);
  }, []);

  const closeModal = useCallback(() => setModal(null), []);

  // One confirm dialog for the whole app, driven by a promise so a call site
  // reads like the `window.confirm` it replaced. The resolver is held in a ref
  // rather than state: it must survive the re-render that opens the modal, and
  // it is called exactly once — settling it on close is what keeps a dismissed
  // dialog from leaving the caller awaiting forever.
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null);
  const confirmResolver = useRef<((ok: boolean) => void) | null>(null);

  const settleConfirm = useCallback((ok: boolean) => {
    const resolve = confirmResolver.current;
    confirmResolver.current = null;
    setConfirmRequest(null);
    resolve?.(ok);
  }, []);

  const confirm = useCallback(
    (request: ConfirmRequest) =>
      new Promise<boolean>((resolve) => {
        // A second confirm while one is open would strand the first caller.
        // Decline it rather than overwrite the resolver.
        if (confirmResolver.current) {
          resolve(false);
          return;
        }
        confirmResolver.current = resolve;
        setConfirmRequest(request);
      }),
    [],
  );

  const value = useMemo(
    () => ({
      toasts,
      showToast,
      modal,
      openModal,
      closeModal,
      confirm,
    }),
    [toasts, showToast, modal, openModal, closeModal, confirm],
  );

  return (
    <AppUiContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-[calc(max(1.25rem,env(safe-area-inset-bottom,0px))+3.5rem)] left-4 z-[10050] flex flex-col gap-2 [html:has(.portal-shell)_&]:bottom-[calc(var(--portal-native-bottom-nav-inset)+4.25rem)] sm:left-auto sm:right-4 lg:bottom-[5.75rem] lg:[html:has(.portal-shell)_&]:bottom-[5.25rem]">
        {toasts.map((t) => (
          <div
            key={t.id}
            className="pointer-events-auto rounded-2xl border border-border bg-card px-4 py-3 text-sm text-foreground shadow-lg"
          >
            {t.message}
          </div>
        ))}
      </div>
      <Modal
        open={Boolean(modal)}
        title={modal?.title ?? ""}
        onClose={closeModal}
      >
        <p className="text-sm text-muted">{modal?.body}</p>
      </Modal>
      <ConfirmDeleteModal
        open={Boolean(confirmRequest)}
        title={confirmRequest?.title ?? "Delete"}
        description={confirmRequest?.description ?? ""}
        confirmLabel={confirmRequest?.confirmLabel ?? "Delete"}
        note={confirmRequest?.note === undefined ? "This cannot be undone." : confirmRequest.note}
        tone={confirmRequest?.tone ?? "danger"}
        dataAttr={confirmRequest?.dataAttr}
        onClose={() => settleConfirm(false)}
        onConfirm={() => settleConfirm(true)}
      />
    </AppUiContext.Provider>
  );
}

export function useAppUi() {
  const ctx = useContext(AppUiContext);
  if (!ctx) {
    throw new Error("useAppUi must be used within AppUiProvider");
  }
  return ctx;
}

/** Like {@link useAppUi} but returns null outside a provider (unit tests, isolated renders). */
export function useOptionalAppUi() {
  return useContext(AppUiContext);
}

/**
 * The in-theme replacement for `window.confirm`.
 *
 * Returns a promise, so a call site keeps its original shape:
 * `if (!(await confirm({ description: "Delete Ada?" }))) return;`
 *
 * Outside a provider it falls back to the native dialog rather than throwing —
 * that keeps panels renderable in isolation (unit tests mount many of them bare)
 * without any surface silently losing its confirmation step.
 */
export function useConfirm(): (request: ConfirmRequest) => Promise<boolean> {
  const ctx = useContext(AppUiContext);
  return useCallback(
    (request: ConfirmRequest) => {
      if (ctx) return ctx.confirm(request);
      if (typeof window === "undefined") return Promise.resolve(false);
      const text = typeof request.description === "string" ? request.description : "Are you sure?";
      return Promise.resolve(window.confirm(text));
    },
    [ctx],
  );
}
