"use client";

import { useEffect, useRef, useState } from "react";
import { AssistantPanelHeader, AssistantEmptyState, AssistantMessageList } from "@/components/portal/assistant-panel-chrome";
import { AssistantChatComposer } from "@/components/portal/assistant-chat-composer";
import { AssistantChatHistoryPanel } from "@/components/portal/assistant-chat-history-panel";
import { AxisAssistantChatIcon } from "@/components/portal/assistant-shared";
import type { ChatMessage } from "@/lib/axis-assistant/use-assistant-conversation";
import type { DemoPortal } from "./site/product-mock/demo-nav";
import type { DemoStory } from "./site/product-mock/world";
import { PREVIEW_ASSISTANT_PROMPTS, previewAssistantAnswer } from "./home-preview-assistant-data";

/** The production assistant's presentation, backed exclusively by this mounted preview's memory. */
export default function HomePreviewAssistant({ portal, name, story, onClose }: {
  portal: DemoPortal; name: string; story?: DemoStory; onClose(): void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [history, setHistory] = useState<{ id: string; title: string; updatedAt: string; messages: ChatMessage[] }[]>([]);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const nextId = useRef(0);
  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [messages]);
  const send = (prompt = input) => {
    const question = prompt.trim().slice(0, 2000);
    if (!question) return;
    setMessages((prior) => [...prior.slice(-22), { role: "user", content: question }, { role: "assistant", content: previewAssistantAnswer(portal, question, story) }]);
    setInput("");
  };
  const newChat = () => {
    if (messages.length) setHistory((prior) => [{ id: String(++nextId.current), title: messages[0]!.content, updatedAt: new Date().toISOString(), messages }, ...prior].slice(0, 10));
    setMessages([]);
    setInput("");
    setHistoryOpen(false);
    inputRef.current?.focus();
  };
  return <aside ref={setHost} className="pls-assistant pls-assistant-live" aria-label="PropLane assistant" onKeyDown={(event) => {
    if (event.key === "Escape" && !historyOpen) { event.stopPropagation(); onClose(); }
  }}>
    <AssistantPanelHeader onNew={newChat} onOpenHistory={() => setHistoryOpen(true)} onClose={onClose} />
    <div className="min-h-0 flex-1 overflow-y-auto p-3" ref={logRef}>
      {messages.length ? <div role="log" aria-label="Sample assistant conversation" aria-live="polite"><AssistantMessageList messages={messages} ratings={{}} onRate={() => undefined} loading={false} /></div> : <AssistantEmptyState firstName={name} hint="Sample records" showQueue={false} onPick={send} suggestions={PREVIEW_ASSISTANT_PROMPTS[portal].map((prompt) => ({ label: prompt, prompt, icon: <AxisAssistantChatIcon />, toneClass: "text-primary" }))} />}
    </div>
    <form className="shrink-0 p-3" onSubmit={(event) => { event.preventDefault(); send(); }}>
      <AssistantChatComposer input={input} setInput={setInput} onSend={() => send()} inputRef={inputRef} inputAriaLabel="Ask PropLane about this sample" placeholder="Ask PropLane…" attachments={[]} onAttachmentsChange={() => undefined} allowAttachments={false} compact />
    </form>
    <AssistantChatHistoryPanel open={historyOpen} threads={history.filter((thread) => thread.title.toLowerCase().includes(search.toLowerCase()))} activeThreadId="" searchQuery={search} onSearchQueryChange={setSearch} portalContainer={host} onNewChat={newChat} onClose={() => setHistoryOpen(false)} onSelect={async (id) => { const thread = history.find((row) => row.id === id); if (thread) setMessages(thread.messages); setHistoryOpen(false); }} onDelete={async (id) => { setHistory((prior) => prior.filter((row) => row.id !== id)); return true; }} />
  </aside>;
}
