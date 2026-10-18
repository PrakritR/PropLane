"use client";

import { useCallback, useEffect, useState } from "react";
import { BedDouble, Megaphone, MessagesSquare, RefreshCw, User } from "lucide-react";
import { PortalPropertyRecordRow, PortalRowFact, PortalRowIconTile } from "@/components/portal/portal-record-row";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { RowActionsMenu } from "@/components/portal/row-actions-menu";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { fetchWithTimeout } from "@/lib/auth/fetch-with-timeout";

type HouseChat = {
  enabled: boolean;
  maxPostsPerDay: number;
  canManage: boolean;
  group: { members: { firstName: string; roomLabel: string }[] } | null;
  overflow: number;
  waiting: number;
};

const ANNOUNCE_MAX = 320;

async function postAction(body: Record<string, unknown>): Promise<{ ok: boolean; message?: string; error?: string }> {
  try {
    const res = await fetchWithTimeout(
      "/api/portal/house-groups",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
      30_000,
    );
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string; error?: string };
    return { ok: res.ok && json.ok !== false, message: json.message, error: json.error };
  } catch {
    return { ok: false, error: "Could not reach the server." };
  }
}

/**
 * The house's group chat, as rows in the House details list: its status, a row per member (first name
 * and room only), an over-nine warning, and icon actions to announce and to refresh members. Managers
 * do not join the thread; they post through PropLane. The route answers 404 unless the workspace is on
 * the shared line, which draws nothing at all. Renders nothing until the first load answers.
 */
export function PropertyHouseChatList({ propertyId, showToast }: { propertyId: string; showToast?: (message: string) => void }) {
  const [chat, setChat] = useState<HouseChat | null>(null);
  const [busy, setBusy] = useState(false);
  const [announceOpen, setAnnounceOpen] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [requestId, setRequestId] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetchWithTimeout(`/api/portal/house-groups?propertyId=${encodeURIComponent(propertyId)}`, {}, 20_000);
      if (!res.ok) {
        setChat(null);
        return;
      }
      setChat((await res.json()) as HouseChat);
    } catch {
      setChat(null);
    }
  }, [propertyId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!chat) return null;

  const members = chat.group?.members ?? [];
  const toast = (message: string) => showToast?.(message);

  const setEnabled = async (enabled: boolean) => {
    setBusy(true);
    const result = await postAction({ action: "settings", enabled });
    setBusy(false);
    if (!result.ok) toast(result.error ?? "Could not save.");
    await load();
  };

  const refresh = async () => {
    setBusy(true);
    const result = await postAction({ action: "sync", propertyId });
    setBusy(false);
    toast(result.ok ? "Members updated." : result.error ?? "Could not update members.");
    await load();
  };

  const openAnnounce = () => {
    setText("");
    setError(null);
    setRequestId(`${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
    setAnnounceOpen(true);
  };

  const announce = async () => {
    if (!text.trim()) {
      setError("Write the announcement first.");
      return;
    }
    setBusy(true);
    setError(null);
    const result = await postAction({ action: "announce", propertyId, text, requestId });
    setBusy(false);
    if (!result.ok) {
      setError(result.message ?? result.error ?? "Could not post.");
      return;
    }
    toast(result.message ?? "Posted.");
    setAnnounceOpen(false);
  };

  return (
    <>
      <PortalPropertyRecordRow
        title="House chat"
        leading={<PortalRowIconTile icon={MessagesSquare} />}
        leadingShape="square"
        facts={[
          <PortalRowFact key="s" icon={User} srLabel="Members">
            {!chat.enabled ? "Off" : chat.group ? `${members.length} residents` : "No group yet"}
          </PortalRowFact>,
        ]}
        actions={
          <>
            {chat.enabled && chat.group ? (
              <PortalIconAction icon={Megaphone} label="Announce" disabled={busy} data-attr="house-chat-announce" onClick={openAnnounce} />
            ) : null}
            {chat.enabled ? (
              <PortalIconAction icon={RefreshCw} label="Update members" disabled={busy} data-attr="house-chat-refresh" onClick={() => void refresh()} />
            ) : null}
            {chat.canManage ? (
              <RowActionsMenu
                label="Actions for house chat"
                items={[
                  chat.enabled
                    ? { id: "off", label: "Turn off", danger: true, disabled: busy, onSelect: () => void setEnabled(false) }
                    : { id: "on", label: "Turn on", disabled: busy, onSelect: () => void setEnabled(true) },
                ]}
              />
            ) : null}
          </>
        }
        dataAttr="property-house-chat-row"
      />
      {chat.enabled
        ? members.map((m, index) => (
            <PortalPropertyRecordRow
              key={`${m.firstName}-${m.roomLabel}-${index}`}
              title={m.firstName || "Resident"}
              leading={<PortalRowIconTile icon={User} />}
              leadingShape="square"
              facts={m.roomLabel ? [<PortalRowFact key="r" icon={BedDouble} srLabel="Room">{m.roomLabel}</PortalRowFact>] : undefined}
              dataAttr="property-house-chat-member"
            />
          ))
        : null}
      {chat.enabled && chat.overflow > 0 ? (
        <PortalPropertyRecordRow
          title={`${chat.overflow} more ${chat.overflow === 1 ? "resident gets" : "residents get"} texts one on one`}
          leading={<PortalRowIconTile icon={User} />}
          leadingShape="square"
          attention
          dataAttr="property-house-chat-overflow"
        />
      ) : null}
      {chat.enabled && chat.waiting > 0 ? (
        <PortalPropertyRecordRow
          title={`${chat.waiting} ${chat.waiting === 1 ? "resident has" : "residents have"} not joined yet`}
          leading={<PortalRowIconTile icon={User} />}
          leadingShape="square"
          dataAttr="property-house-chat-waiting"
        />
      ) : null}

      <Modal
        open={announceOpen}
        title="Announce to the house"
        onClose={() => setAnnounceOpen(false)}
        presentation="dialog"
        dense
        panelClassName="max-w-xl"
        stackClassName="fixed inset-0 z-[80] overflow-y-auto overscroll-contain"
        footer={
          <ModalFooter>
            <Button type="button" variant="primary" className="rounded-full" disabled={busy} data-attr="house-chat-announce-post" onClick={() => announce()}>
              Post
            </Button>
          </ModalFooter>
        }
      >
        <div className="space-y-3">
          <Textarea
            value={text}
            maxLength={ANNOUNCE_MAX}
            rows={4}
            onChange={(e) => setText(e.target.value)}
            placeholder="Water is off Tuesday 9 to 12."
            aria-label="Announcement"
            data-attr="house-chat-announce-text"
          />
          {error ? (
            <p className="text-sm text-danger" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      </Modal>
    </>
  );
}
