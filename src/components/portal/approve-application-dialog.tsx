"use client";

/**
 * The ONE Approve popup. Every way into approving an application — the
 * Applications list row ⋯ and record header, the Residents row ⋯ and its
 * Application tab, the resident's "Next step" — opens this and nothing else.
 *
 *   resident · room · bed (a shared room only) · rent · one message row
 *   [ Approve ]
 *
 * The rent is an editable field only when the room is priced per resident (each
 * bed its own rent); every other room shows the rent it already has. The single
 * message row reads "Email · Welcome to <house>" and its pencil opens the note
 * inline; the account-setup link stays in the email around that note.
 *
 * The last open bed is arbitrated by the server when the approval is written. A
 * refusal ("Bed B in Room 8 was just taken — Nora Vance was approved for it a
 * moment ago") swaps this popup to an answer that offers another open bed; Move
 * and review goes straight back to Approve on the new bed. Nothing is written
 * for the refused approval (`transitionApplicationBucket` only publishes after
 * the server accepts).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Pencil } from "lucide-react";
import { PortalDialog } from "@/components/portal/portal-dialog";
import { PreviewPanel } from "@/components/portal/add-workspace/parts";
import { PopupSubjectCard } from "@/components/portal/popup-live-preview";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { Input, Textarea } from "@/components/ui/input";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { useManagerCommunicationDeliverVia } from "@/hooks/use-manager-communication-deliver-via";
import type { DemoApplicantRow } from "@/data/demo-portal";
import {
  applicationRoomPricesPerResident,
  approvalBedOptions,
  bedLabelForSlot,
  residentSlotsForApplicationRow,
  roomForApplicationRow,
} from "@/lib/application-approval-slots";
import { transitionApplicationBucket, type ApplicationBucketTransition } from "@/lib/application-review";
import type { ApplicationAutomationPreferences } from "@/lib/application-automation-preferences";
import {
  readManagerApplicationRows,
  residentSlotOverrideFields,
  syncManagerApplicationsFromServer,
  upsertApplicationRowToServerAwait,
  writeManagerApplicationRows,
} from "@/lib/manager-applications-storage";
import { parseMoneyAmount } from "@/lib/parse-money";
import { resolvePlacementValuesForRow } from "@/lib/rental-application/placement-values";
import { getPropertyById } from "@/lib/rental-application/data";
import { applicantDisplayName } from "@/lib/rental-application/applicant-name";
import { formatRoomPriceAmount } from "@/lib/room-pricing";

function firstNameOf(row: DemoApplicantRow): string {
  return applicantDisplayName(row).trim().split(/\s+/)[0] || "the applicant";
}

function houseTitle(row: DemoApplicantRow): string {
  const propertyId =
    row.assignedPropertyId?.trim() || row.propertyId?.trim() || row.application?.propertyId?.trim() || "";
  return getPropertyById(propertyId)?.title?.trim() || row.property?.trim() || "your new home";
}

/** "Alder House · Room 8" — the place line, house first. */
function placeLine(row: DemoApplicantRow): string {
  const room = roomForApplicationRow(row);
  const house = houseTitle(row);
  const label = room?.name?.trim() || resolvePlacementValuesForRow(row).roomLabel.split(" · ")[0]?.trim() || "";
  return [house, label].filter(Boolean).join(" · ");
}

function channelsLabel(viaEmail: boolean, viaSms: boolean): string {
  if (viaEmail && viaSms) return "Email and text";
  if (viaSms) return "Text";
  if (viaEmail) return "Email";
  return "No message";
}

export type ApproveApplicationDialogProps = {
  /** The application being approved; null keeps the popup closed. */
  row: DemoApplicantRow | null;
  userId: string | null;
  automation?: ApplicationAutomationPreferences;
  onClose: () => void;
  /** Runs after the server accepted the approval and the popup closed. */
  onApproved?: (result: ApplicationBucketTransition, row: DemoApplicantRow) => void;
  /** The toast's one action after an approval — open the Send lease screen for this application. */
  onSendLease?: (applicationId: string) => void;
};

type Conflict = { slot?: number; holderName?: string | null; message: string };

export function ApproveApplicationDialog(props: ApproveApplicationDialogProps) {
  const { row } = props;
  // Re-mount per application so no pick or typed note leaks from one resident to the next.
  return row ? <ApproveApplicationDialogBody key={row.id} {...props} row={row} /> : null;
}

function ApproveApplicationDialogBody({ row, userId, automation, onClose, onApproved, onSendLease }: ApproveApplicationDialogProps & { row: DemoApplicantRow }) {
  const { showToast } = useAppUi();
  const { channelsFor } = useManagerCommunicationDeliverVia();
  const channels = channelsFor("applications");
  const [tick, setTick] = useState(0);
  const slots = useMemo(() => {
    void tick;
    return residentSlotsForApplicationRow(row);
  }, [row, tick]);
  const beds = useMemo(() => approvalBedOptions(row, slots), [row, slots]);
  const shared = slots.length > 0;
  const perResident = useMemo(() => applicationRoomPricesPerResident(row), [row]);
  const room = roomForApplicationRow(row);
  const placement = useMemo(() => resolvePlacementValuesForRow(row), [row]);

  const initialSlot = useMemo(() => {
    const own = Number(row.application?.residentSlot);
    if (Number.isInteger(own) && beds.some((b) => b.slot === own)) return own;
    return beds[0]?.slot ?? null;
    // Only the first render picks the default; a conflict move sets it explicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [slot, setSlot] = useState<number | null>(initialSlot);
  const chosenBed = beds.find((b) => b.slot === slot) ?? null;
  const baseRent = chosenBed ? chosenBed.monthlyRent : placement.signedMonthlyRent;
  const [rentText, setRentText] = useState<string | null>(null);
  const rentValue = rentText ?? (baseRent > 0 ? String(baseRent) : "");

  const house = houseTitle(row);
  const defaultNote = `Your application for ${house} is approved. I'll send your lease next.`;
  const [note, setNote] = useState(defaultNote);
  const [noteOpen, setNoteOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [moveTo, setMoveTo] = useState<string>("");

  const name = applicantDisplayName(row);
  const sendsMessage = channels.viaEmail || channels.viaSms;

  // A bed that stopped being open (someone else was approved while the popup sat open) is no longer pickable.
  useEffect(() => {
    if (slot != null && !beds.some((b) => b.slot === slot)) setSlot(beds[0]?.slot ?? null);
  }, [beds, slot]);

  const persistNegotiatedRent = useCallback(
    async (rowId: string, rent: number) => {
      const current = readManagerApplicationRows().find((r) => r.id === rowId);
      if (!current?.application) return;
      const next = { ...current, application: { ...current.application, managerRentOverride: String(rent) } };
      writeManagerApplicationRows(
        readManagerApplicationRows().map((r) => (r.id === rowId ? next : r)),
        { serverConfirmed: true, skipLeaseSeed: true },
      );
      // A second write on an already-placed bed: the server keeps the placement and takes the typed rent.
      await upsertApplicationRowToServerAwait(next);
    },
    [],
  );

  const approve = async () => {
    if (busy) return;
    if (shared && slot == null) {
      setError("No bed is open in this room.");
      return;
    }
    setBusy(true);
    setError(null);
    const picked = slot != null ? slots.find((s) => s.slot === slot) : undefined;
    const result = await transitionApplicationBucket(row.id, "approved", {
      userId,
      automation,
      applicationPatch: picked ? residentSlotOverrideFields(picked.price) : undefined,
      welcomeNote: sendsMessage ? note : undefined,
      skipWelcomeEmail: !channels.viaEmail,
      approvalNotification: { viaEmail: channels.viaEmail, viaSms: channels.viaSms },
    });
    if (!result) {
      setBusy(false);
      setError("Approval could not be saved. Refresh and retry.");
      return;
    }
    if (result.blocked === "capacity") {
      // Refresh who holds what before offering another bed — the winner is now on the server.
      await syncManagerApplicationsFromServer({ force: true, managerUserId: userId }).catch(() => undefined);
      setTick((n) => n + 1);
      setBusy(false);
      setConflict({
        slot: result.conflict?.slot ?? slot ?? undefined,
        holderName: result.conflict?.holderName,
        message: result.message ?? "That bed was just taken.",
      });
      return;
    }
    if (result.blocked) {
      setBusy(false);
      setError(result.message ?? "Approval could not be saved. Refresh and retry.");
      return;
    }
    // A rent the manager typed over the bed's price is their negotiated figure for this resident.
    const typed = parseMoneyAmount(rentValue);
    if (perResident && picked && typed > 0 && typed !== picked.price.monthlyRent) {
      await persistNegotiatedRent(row.id, typed).catch(() => undefined);
    }
    setBusy(false);
    const approvedRow = readManagerApplicationRows().find((r) => r.id === row.id) ?? row;
    const after = residentSlotsForApplicationRow(approvedRow);
    const open = after.filter((s) => !s.holder).length;
    const roomName = room?.name?.trim() || "The room";
    const roomNote = shared ? (open === 0 ? `${roomName} is now full` : `${roomName} · ${open} bed${open === 1 ? "" : "s"} open`) : null;
    if (result.approvalSms && result.approvalSms.sms !== "submitted") {
      const outcome = result.approvalSms.sms === "queued" ? "queued" : result.approvalSms.sms === "unknown" ? "outcome is not yet known" : "failed";
      showToast(`Approved. Text message ${outcome}${result.approvalSms.error ? `: ${result.approvalSms.error}` : "."}`);
    } else {
      showToast(roomNote ? `Approved · ${roomNote}` : "Approved", {
        actionLabel: "Send lease",
        undo: () => onSendLease?.(row.id),
      });
    }
    onApproved?.(result, approvedRow);
    onClose();
  };

  const openBedsForMove = useMemo(
    () => (conflict ? beds.filter((b) => b.slot !== conflict.slot) : []),
    [beds, conflict],
  );

  if (conflict) {
    const roomName = room?.name?.trim() || "The room";
    const holder = conflict.holderName?.trim();
    const first = firstNameOf(row);
    const headline = conflict.slot ? `${bedLabelForSlot(conflict.slot)} in ${roomName} was just taken` : `${roomName} is full`;
    const move = moveTo && openBedsForMove.some((b) => String(b.slot) === moveTo) ? moveTo : String(openBedsForMove[0]?.slot ?? "");
    return (
      <PortalDialog
        open
        title="Bed no longer available"
        onClose={onClose}
        dataAttr="approve-application-conflict"
        primaryAction={
          openBedsForMove.length > 0
            ? {
                label: "Move and review",
                dataAttr: "approve-application-move",
                onClick: () => {
                  setSlot(Number(move));
                  setRentText(null);
                  setConflict(null);
                },
              }
            : null
        }
      >
        <div className="space-y-4" data-attr="approve-application-conflict-body">
          <p className="text-[15px] font-semibold text-foreground">{headline}</p>
          <p className="text-sm text-muted">
            {holder ? `${holder} was approved for it a moment ago. ` : ""}
            {first}&apos;s application stays as it is.
          </p>
          {openBedsForMove.length > 0 ? (
            <FieldSingleSelect
              label={`Move ${first} to`}
              value={move}
              onChange={setMoveTo}
              options={openBedsForMove.map((b) => ({ value: String(b.slot), label: b.label }))}
              dataAttr="approve-application-move-bed"
            />
          ) : (
            <p className="text-sm text-muted">No other bed is open right now.</p>
          )}
        </div>
      </PortalDialog>
    );
  }

  return (
    <PortalDialog
      open
      title="Approve application"
      onClose={() => {
        if (!busy) onClose();
      }}
      dismissBlocked={busy}
      dataAttr="approve-application-dialog"
      contextPanel={<PopupSubjectCard title={name} lines={[row.email, placeLine(row) || "No room yet"]} />}
      previewLabel="Applicant sees"
      preview={
        <PreviewPanel
          title="Approved"
          name={name}
          sub={house}
          facts={[
            { label: "Room", value: placeLine(row) || "Not assigned", warn: !placeLine(row) },
            { label: "Rent", value: (() => { const typed = perResident ? parseMoneyAmount(rentValue) : baseRent; return typed > 0 ? `${formatRoomPriceAmount(typed)} / month` : "Not set"; })() },
            { label: "Message", value: sendsMessage ? channelsLabel(channels.viaEmail, channels.viaSms) : "None" },
          ]}
          creates={[
            { tone: "yes", text: "The applicant is told and a lease can be sent" },
            { tone: "no", text: "Nothing is charged yet" },
          ]}
        />
      }
      primaryAction={{
        label: "Approve",
        loading: busy,
        disabled: busy || (shared && slot == null),
        dataAttr: "approve-application-confirm",
        onClick: () => void approve(),
      }}
    >
      <div className="space-y-1" data-attr="approve-application-body">
        <ApproveRow label="Room">
          <span className="text-sm font-bold text-foreground">{placeLine(row) || "Not assigned"}</span>
        </ApproveRow>

        {shared ? (
          <ApproveRow label="Bed">
            <div className="w-56 max-w-full">
              <FieldSingleSelect
                label="Bed"
                hideLabel
                value={slot != null ? String(slot) : ""}
                onChange={(next) => {
                  setSlot(Number(next));
                  setRentText(null);
                }}
                options={beds.map((b) => ({ value: String(b.slot), label: b.label }))}
                placeholder="No bed open"
                disabled={busy || beds.length === 0}
                dataAttr="approve-application-bed"
              />
            </div>
          </ApproveRow>
        ) : null}

        <ApproveRow label="Rent">
          {perResident ? (
            <span className="inline-flex items-center gap-1.5 font-bold text-muted">
              <span>$</span>
              <Input
                aria-label="Rent per month"
                inputMode="decimal"
                className="!min-h-10 !w-28 !rounded-xl !px-3 !py-1.5 text-right font-semibold"
                value={rentValue}
                disabled={busy}
                onChange={(e) => setRentText(e.target.value)}
                data-attr="approve-application-rent"
              />
              <span className="text-[13px] font-semibold">/ month</span>
            </span>
          ) : (
            <span className="text-sm font-bold text-foreground" data-attr="approve-application-rent-static">
              {baseRent > 0 ? `${formatRoomPriceAmount(baseRent)} / month` : "Not set"}
            </span>
          )}
        </ApproveRow>

        {sendsMessage ? (
          <>
            <div className="flex min-h-11 items-center justify-between gap-3 border-t border-border/60 py-2.5">
              <span className="min-w-0 text-sm font-semibold text-foreground">
                {channelsLabel(channels.viaEmail, channels.viaSms)} · Welcome to {house}
              </span>
              <PortalIconAction
                icon={Pencil}
                label={noteOpen ? "Hide message" : "Edit message"}
                data-attr="approve-application-edit-message"
                active={noteOpen}
                onClick={() => setNoteOpen((v) => !v)}
              />
            </div>
            {noteOpen ? (
              <Textarea
                aria-label="Welcome message"
                rows={3}
                value={note}
                disabled={busy}
                onChange={(e) => setNote(e.target.value)}
                data-attr="approve-application-message"
              />
            ) : null}
          </>
        ) : null}

        {error ? (
          <p className="pt-2 text-sm text-danger" role="alert" data-attr="approve-application-error">
            {error}
          </p>
        ) : null}
      </div>
    </PortalDialog>
  );
}

function ApproveRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-3 border-t border-border/60 py-2.5">
      <span className="text-sm text-muted">{label}</span>
      {children}
    </div>
  );
}
