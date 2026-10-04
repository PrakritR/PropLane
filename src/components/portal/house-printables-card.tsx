"use client";

import { useCallback, useEffect, useState } from "react";
import { Lock, Printer, QrCode } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { Input } from "@/components/ui/input";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { PortalPropertyRecordRow, PortalRowFact, PortalRowIconTile } from "@/components/portal/portal-record-row";
import { RowActionsMenu } from "@/components/portal/row-actions-menu";
import type { ManagerRoomSubmission } from "@/lib/manager-listing-submission";

/**
 * Printables — everything on the wall or in the welcome folder, drawn from the
 * house details so it can never drift from what the manager typed.
 *
 * Rendered as rows inside the House details "For residents" list (tile + title
 * + one fact line + one ⋯, no boxed card, no pills, no subtext). House details
 * passes `kinds={["rules", "welcome"]}`: the door card's one home is Promotion →
 * Flyers & printables. The door card and the rules poster carry a QR to
 * the house's PUBLIC page: rules and trash days only. The welcome sheet carries
 * the codes and the Wi-Fi, so it is printed and handed over — it never becomes
 * a link.
 */
type LinkState = { url: string | null; issuedAt: string | null } | null;

export type HousePrintableKind = "door" | "rules" | "welcome";

const ALL_KINDS: ReadonlyArray<HousePrintableKind> = ["door", "rules", "welcome"];

export function HousePrintablesCard({
  propertyId,
  rooms,
  showToast,
  kinds = ALL_KINDS,
}: {
  /** Which rows to draw; all three by default. */
  kinds?: ReadonlyArray<HousePrintableKind>;
  propertyId: string;
  rooms: ReadonlyArray<Pick<ManagerRoomSubmission, "id" | "name" | "floor">>;
  showToast?: (message: string) => void;
}) {
  const [link, setLink] = useState<LinkState>(null);
  const [busy, setBusy] = useState(false);
  const [welcomeOpen, setWelcomeOpen] = useState(false);
  const [roomId, setRoomId] = useState<string>(rooms[0]?.id ?? "");
  const [residentName, setResidentName] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/portal/house-public-link?propertyId=${encodeURIComponent(propertyId)}`);
      if (!res.ok) return;
      const data = (await res.json()) as { url?: string | null; issuedAt?: string | null };
      setLink({ url: data.url ?? null, issuedAt: data.issuedAt ?? null });
    } catch {
      /* the print routes still work; the link action just stays out of the menu */
    }
  }, [propertyId]);

  useEffect(() => {
    void load();
  }, [load]);

  const revoke = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/portal/house-public-link", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ propertyId }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        showToast?.(data.error ?? "Could not turn the link off.");
        return;
      }
      setLink({ url: null, issuedAt: null });
      showToast?.("Link turned off. Printed posters no longer open. Print again for a new one.");
    } finally {
      setBusy(false);
    }
  }, [propertyId, showToast]);

  const welcomeHref = `/print/welcome/${encodeURIComponent(propertyId)}?${new URLSearchParams({
    ...(roomId ? { room: roomId } : {}),
    ...(residentName.trim() ? { resident: residentName.trim() } : {}),
  }).toString()}`;

  const openPrint = (href: string) => {
    if (typeof window !== "undefined") window.open(href, "_blank", "noopener,noreferrer");
  };

  const publicRow = (title: string, href: string, dataAttr: string) => (
    <PortalPropertyRecordRow
      title={title}
      leading={<PortalRowIconTile icon={QrCode} />}
      leadingShape="square"
      facts={
        <PortalRowFact icon={Lock} srLabel="Audience">
          Public · no codes
        </PortalRowFact>
      }
      onOpen={() => openPrint(href)}
      dataAttr={dataAttr}
      actions={
        <RowActionsMenu
          label={title}
          items={[
            { id: "open", label: "Open to print", onSelect: () => openPrint(href) },
            link?.url
              ? { id: "revoke", label: "Turn the link off", danger: true, onSelect: () => !busy && void revoke() }
              : null,
          ]}
        />
      }
    />
  );

  return (
    <>
      {kinds.includes("door")
        ? publicRow("Door card", `/print/door-card/${encodeURIComponent(propertyId)}`, "house-printables-door-card")
        : null}
      {kinds.includes("rules")
        ? publicRow("House rules poster", `/print/house-rules/${encodeURIComponent(propertyId)}`, "house-printables-rules")
        : null}
      {kinds.includes("welcome") ? (
      <PortalPropertyRecordRow
        title="Welcome sheet"
        leading={<PortalRowIconTile icon={Printer} />}
        leadingShape="square"
        facts={
          <PortalRowFact icon={Lock} srLabel="Audience">
            Private · has codes
          </PortalRowFact>
        }
        onOpen={() => setWelcomeOpen(true)}
        dataAttr="house-printables-welcome-row"
        actions={
          <RowActionsMenu
            label="Welcome sheet"
            items={[{ id: "open", label: "Choose room and print", onSelect: () => setWelcomeOpen(true) }]}
          />
        }
      />
      ) : null}

      <Modal open={welcomeOpen} title="Welcome sheet" onClose={() => setWelcomeOpen(false)}>
        <div className="space-y-3" data-attr="house-printables-welcome-form">
          {rooms.length > 0 ? (
            <FieldSingleSelect
              label="Room"
              value={roomId}
              onChange={setRoomId}
              options={rooms.map((room) => ({
                value: room.id,
                label: room.floor?.trim() ? `${room.name} · ${room.floor}` : room.name,
              }))}
            />
          ) : null}
          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-muted">Resident (optional)</span>
            <Input
              value={residentName}
              onChange={(e) => setResidentName(e.target.value)}
              placeholder="Maya"
              aria-label="Resident name"
            />
          </label>
        </div>
        <ModalFooter>
          <Button asChild variant="primary" className="rounded-full">
            <a href={welcomeHref} target="_blank" rel="noreferrer" data-attr="house-printables-welcome">
              Open welcome sheet
            </a>
          </Button>
        </ModalFooter>
      </Modal>
    </>
  );
}
