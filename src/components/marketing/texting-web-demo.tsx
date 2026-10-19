"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUp, RotateCcw, X } from "lucide-react";
import { ProPlaneMarkIcon } from "@/components/brand/axis-logo";
import type { ActionPreview } from "@/lib/tools/registry";

type Message = { role: "user" | "assistant"; content: string };
type DemoAction = { id: "demo"; simulated: true; preview: ActionPreview };
type RequestBody = { messages: Message[] } | { actionId: "demo" };
const ENDPOINT = "/api/agent/demo-chat";
const GREETING: Message = {
  role: "assistant",
  content: "Hi! Try managing Seattle Homes with me. Ask about rent, upcoming tours, or a repair. This is a sandbox: no messages are sent and no records are changed.",
};
const STARTERS = ["What rent is outstanding?", "Show upcoming tours", "What repairs need attention?"];

function isDemoAction(value: unknown): value is DemoAction {
  if (!value || typeof value !== "object") return false;
  const action = value as Partial<DemoAction>;
  return action.id === "demo" && action.simulated === true && !!action.preview
    && typeof action.preview.title === "string" && Array.isArray(action.preview.fields)
    && (action.preview.warnings === undefined || (Array.isArray(action.preview.warnings) && action.preview.warnings.every((warning) => typeof warning === "string")))
    && action.preview.fields.every((field) => typeof field?.label === "string" && typeof field?.value === "string");
}

function TypingDots() {
  return <div role="status" aria-label="PropLane is replying" className="flex w-fit items-center gap-1 rounded-[20px] rounded-bl-md bg-slate-100 px-4 py-4">
    {[0, 1, 2].map((dot) => <span key={dot} aria-hidden="true" className="h-2 w-2 rounded-full bg-slate-400 motion-safe:animate-pulse" style={{ animationDelay: `${dot * 180}ms` }} />)}
  </div>;
}

/** Public sandbox only. This component never calls a real account's confirm route. */
export default function TextingWebDemo({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const thread = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const request = useRef<AbortController | null>(null);
  const [messages, setMessages] = useState<Message[]>([GREETING]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<DemoAction | null>(null);
  const [failure, setFailure] = useState<{ body: RequestBody; message: string } | null>(null);

  useEffect(() => {
    const element = dialog.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    element?.showModal();
    return () => {
      request.current?.abort();
      request.current = null;
      element?.close();
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  useEffect(() => {
    if (thread.current) thread.current.scrollTop = thread.current.scrollHeight;
  }, [messages, busy, pending, failure]);

  function close() {
    request.current?.abort();
    request.current = null;
    onClose();
  }

  async function send(body: RequestBody) {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setFailure(null);
    const timeout = window.setTimeout(() => controller.abort(), 60_000);
    try {
      const response = await fetch(ENDPOINT, {
        method: "POST", headers: { "Content-Type": "application/json" },
        credentials: "omit", body: JSON.stringify(body), signal: controller.signal,
      });
      const result = await response.json();
      if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : "The demo couldn't reply. Try again.");
      if (result.pendingAction && !isDemoAction(result.pendingAction)) throw new Error("This action isn't available in the sandbox.");
      if (typeof result.reply !== "string" || (!result.reply.trim() && !result.pendingAction)) throw new Error("The demo couldn't reply. Try again.");
      if (controller.signal.aborted) return;
      if (result.reply.trim()) setMessages((current) => [...current, { role: "assistant", content: result.reply }]);
      setPending(result.pendingAction ?? null);
    } catch (error) {
      // Unmount clears this ref; an abort caused by the time limit stays retryable.
      if (request.current === controller) setFailure({ body, message: controller.signal.aborted
        ? "The demo took too long to reply. Try again."
        : error instanceof Error ? error.message : "The demo couldn't connect. Try again." });
    } finally {
      window.clearTimeout(timeout);
      if (request.current === controller) {
        request.current = null;
        setBusy(false);
      }
    }
  }

  function submit(text = draft) {
    const content = text.trim().slice(0, 4000);
    if (!content || request.current || failure) return;
    const next: Message[] = [...messages, { role: "user", content }];
    setMessages(next);
    setDraft("");
    setPending(null);
    void send({ messages: next.slice(-16) });
  }

  function restart() {
    if (request.current) return;
    setMessages([GREETING]);
    setPending(null);
    setFailure(null);
    setDraft("");
    composer.current?.focus();
  }

  return (
    <dialog ref={dialog} aria-labelledby="texting-demo-title" aria-describedby="texting-demo-sandbox"
      onCancel={(event) => { event.preventDefault(); close(); }}
      className="fixed inset-0 m-0 h-dvh max-h-none w-screen max-w-none border-0 bg-white p-0 text-slate-900 backdrop:bg-slate-950/40">
      <div className="flex h-full flex-col bg-slate-50">
        <header className="shrink-0 border-b border-slate-200 bg-white px-4 pb-3 pt-[max(12px,env(safe-area-inset-top))]">
          <div className="mx-auto flex max-w-2xl items-center gap-3">
            <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-blue-50 text-blue-600"><ProPlaneMarkIcon className="h-6 w-6" /></span>
            <h2 id="texting-demo-title" className="min-w-0 flex-1 text-lg font-semibold tracking-tight">PropLane demo</h2>
            <button type="button" onClick={restart} disabled={busy} aria-label="Start a new demo" title="Start a new demo" className="flex h-11 w-11 items-center justify-center rounded-full hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-blue-600 disabled:opacity-40"><RotateCcw size={19} /></button>
            <button type="button" onClick={close} aria-label="Close demo" title="Close demo" data-attr="homepage-demo-close" className="flex h-11 w-11 items-center justify-center rounded-full hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-blue-600"><X size={22} /></button>
          </div>
        </header>
        <div id="texting-demo-sandbox" className="shrink-0 border-b border-slate-200/70 px-4 py-2 text-center text-xs font-medium text-slate-600">Sandbox · Sample data · Actions are previews only</div>
        <div ref={thread} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-6">
          <div className="mx-auto flex max-w-2xl flex-col gap-3">
            <div role="log" aria-label="Demo conversation" aria-live="polite" aria-relevant="additions" className="flex flex-col gap-3">
              {messages.map((message, index) => <div key={index} className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}>
                <p className={`max-w-[88%] whitespace-pre-wrap break-words rounded-[22px] px-4 py-3 text-[15px] leading-relaxed [overflow-wrap:anywhere] sm:max-w-[80%] ${message.role === "user" ? "rounded-br-md bg-blue-600 text-white" : "rounded-bl-md bg-slate-200/80 text-slate-900"}`}><span className="sr-only">{message.role === "user" ? "You: " : "PropLane: "}</span>{message.content}</p>
              </div>)}
            </div>
            {busy && <TypingDots />}
            {pending && <section aria-label="Sandbox action preview" className="rounded-2xl border border-slate-200 bg-white p-4">
              <h3 className="font-semibold">{pending.preview.title}</h3>
              <dl className="my-3 space-y-3 text-sm">{pending.preview.fields.map((field, index) => <div key={index}>
                <dt className="font-medium text-slate-500">{field.label}</dt><dd className="mt-1 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{field.value}</dd>
              </div>)}</dl>
              {pending.preview.warnings?.filter((warning) => typeof warning === "string").map((warning, index) => <p key={index} className="mb-2 text-sm text-amber-800">{warning}</p>)}
              <div className="flex flex-wrap gap-2">
                <button type="button" disabled={busy || !!failure} onClick={() => void send({ actionId: "demo" })} data-attr="homepage-demo-simulate" className="min-h-11 rounded-full bg-blue-600 px-5 text-sm font-semibold text-white disabled:opacity-40">Try this in sandbox</button>
                <button type="button" disabled={busy || !!failure} onClick={() => setPending(null)} className="min-h-11 rounded-full px-5 text-sm font-medium hover:bg-slate-100 disabled:opacity-40">Dismiss</button>
              </div>
            </section>}
            {failure && <div role="alert" className="rounded-2xl border border-red-100 bg-white p-4 text-sm">
              <p>{failure.message}</p>
              <button type="button" onClick={() => void send(failure.body)} className="mt-2 min-h-11 rounded-full bg-slate-100 px-5 font-semibold text-slate-900">Try again</button>
            </div>}
            {messages.length === 1 && !busy && <div className="mt-4 flex flex-col items-start gap-2" aria-label="Try a question">
              {STARTERS.map((starter) => <button key={starter} type="button" onClick={() => submit(starter)} className="min-h-11 rounded-2xl border border-blue-100 bg-white px-4 py-2 text-left text-sm font-medium text-blue-700 hover:bg-blue-50">{starter}</button>)}
            </div>}
          </div>
        </div>
        <form onSubmit={(event) => { event.preventDefault(); submit(); }} className="shrink-0 border-t border-slate-200 bg-white px-4 pt-3 pb-[max(12px,env(safe-area-inset-bottom))]">
          <div className="mx-auto flex max-w-2xl items-end gap-2 rounded-[26px] border border-slate-300 bg-white p-1.5 focus-within:border-blue-500 focus-within:ring-1 focus-within:ring-blue-500">
            <textarea ref={composer} aria-label="Message PropLane demo" placeholder="Message PropLane…" value={draft} maxLength={4000} rows={1} disabled={busy || !!failure}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); } }}
              className="max-h-32 min-h-11 min-w-0 flex-1 resize-none bg-transparent px-3 py-2.5 text-base leading-6 outline-none placeholder:text-slate-500 disabled:opacity-50" />
            <button type="submit" disabled={busy || !!failure || !draft.trim()} aria-label="Send message" data-attr="homepage-demo-send" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-blue-600 text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:bg-slate-200 disabled:text-slate-400"><ArrowUp size={23} strokeWidth={2.5} /></button>
          </div>
        </form>
      </div>
    </dialog>
  );
}
