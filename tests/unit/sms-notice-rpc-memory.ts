type Thread = { id: string; owner_user_id: string; scope: string; thread_type: string; row_data: Record<string, unknown>; updated_at: string };
type Control = { manager_user_id: string; conversation_key: string; archived: boolean; updated_at: string };

/** In-memory transaction model for the service-role notice RPC. */
export function noticeRpcMemory(
  threads: Map<string, Thread>,
  controls?: Map<string, Control>,
  options?: { failControlWrite?: () => boolean },
) {
  return async (_name: string, p: Record<string, unknown>) => {
    const id = String(p.p_thread_id);
    const messageId = String(p.p_message_id);
    const incoming = p.p_incoming as Record<string, unknown>;
    const message = p.p_message as Record<string, unknown>;
    const existing = threads.get(id);
    const data = { threadId: id, messageId };
    if (!existing) {
      threads.set(id, { id, owner_user_id: String(p.p_owner), scope: String(incoming.scope),
        thread_type: String(p.p_thread_type), row_data: structuredClone(incoming), updated_at: new Date().toISOString() });
      return { data, error: null };
    }
    if (existing.owner_user_id !== p.p_owner) return { data: null, error: new Error("ownership mismatch") };
    const prior = existing.row_data;
    const messages = Array.isArray(prior.messages) ? prior.messages as Record<string, unknown>[] : [];
    if (prior.rootMessageId === messageId || messages.some((m) => m.id === messageId)) return { data, error: null };
    const reopens = p.p_inbound === true && prior.folder === "trash";
    if (reopens && options?.failControlWrite?.()) return { data: null, error: new Error("control write failed") };
    threads.set(id, { ...existing, updated_at: new Date().toISOString(), row_data: {
      ...prior, folder: p.p_inbound ? "inbox" : prior.folder ?? "inbox", preview: incoming.preview,
      time: incoming.time, unread: Boolean(prior.unread || incoming.unread), messages: [...messages, structuredClone(message)],
    } });
    if (reopens) for (const control of controls?.values() ?? []) {
      if (control.manager_user_id === p.p_owner && (p.p_control_keys as string[]).includes(control.conversation_key) && control.archived) {
        control.archived = false;
      }
    }
    return { data, error: null };
  };
}
