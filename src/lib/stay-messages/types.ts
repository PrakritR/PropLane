/** Shared shapes for the automated check-in / check-out messages (design-1112 §7). No IO. */
import type { HouseInfoV1 } from "@/lib/house-info";
import type { StaySource, StayMessageSettings } from "@/lib/stay-messages/templates";

export type StayMessageKind = "check_in" | "check_out" | "check_in_correction";
export type StayMessageStatus = "scheduled" | "sending" | "sent" | "partial" | "failed" | "held" | "cancelled";
export type StayHoldReason = "room_code_missing" | "foreign_code" | "no_contact" | "source_off" | "cancelled";
export type ChannelName = "sms" | "email" | "inbox";
export type ChannelOutcome = { status: "sent" | "failed" | "skipped"; reason?: string };
export type ChannelResults = Partial<Record<ChannelName, ChannelOutcome>> & { attempts?: number };

/** One stay a message could go to: a room-date block (`block:<id>`) or a long-term lease (`lease:<application id>`). */
export type StayCandidate = {
  stayKey: string;
  stayKind: "block" | "lease";
  workspaceId: string | null;
  ownerUserId: string;
  propertyId: string;
  roomId: string;
  source: StaySource;
  status: "confirmed" | "hold" | "cancelled";
  guestName: string;
  guestEmail: string | null;
  guestPhone: string | null;
  /** The guest's account, when they have one (their resident inbox gets the in-app copy). */
  guestUserId: string | null;
  checkIn: string;
  /** Null for an open-ended stay or a lease: there is no check-out message. */
  checkOut: string | null;
  checkInTime: string;
  checkOutTime: string;
  createdAt: string | null;
  /** A lease needs both signatures before any code is sent (the reveal rule); a block is always true. */
  leaseSigned: boolean;
};

export type StayRoom = { id: string; label: string; doorCode: string };

export type StayProperty = {
  propertyId: string;
  label: string;
  addressLine: string;
  timeZone: string;
  /** The FULL house details. The builder reads access / wifi / rules / checkout only; Internal is used solely as a deny list. */
  houseInfo: HouseInfoV1;
  rooms: StayRoom[];
};

export type LedgerRow = {
  id: string;
  stayKey: string;
  kind: StayMessageKind;
  status: StayMessageStatus;
  holdReason: StayHoldReason | null;
  dueAt: string;
  sentAt: string | null;
  roomId: string | null;
  factsHash: string | null;
  channels: ChannelResults;
  threadId: string | null;
  updatedAt: string;
};

export type LedgerInsert = {
  workspaceId: string;
  stayKey: string;
  kind: StayMessageKind;
  status: StayMessageStatus;
  holdReason?: StayHoldReason | null;
  dueAt: string;
  roomId: string | null;
  factsHash: string | null;
};

export interface StayMessageLedger {
  /** The row for (stayKey, kind); a correction is found by its facts hash too. */
  find(stayKey: string, kind: StayMessageKind, factsHash?: string | null): Promise<LedgerRow | null>;
  /** Insert-then-send: the unique (stay_key, kind) index makes a second insert a no-op that returns the existing row. */
  insert(row: LedgerInsert): Promise<{ row: LedgerRow; created: boolean }>;
  /**
   * Claim-before-send: compare-and-set on `updatedAt` that moves the row to `sending` under a fresh claim token. True only for
   * the one caller that won it; a row another sweep is sending refuses (a claim older than ten minutes is stale and re-claimable).
   */
  claim(row: LedgerRow): Promise<boolean>;
  update(id: string, patch: Partial<Pick<LedgerRow, "status" | "holdReason" | "sentAt" | "roomId" | "factsHash" | "channels" | "threadId">>): Promise<void>;
}

export type StayMessageSendInput = {
  candidate: StayCandidate;
  property: StayProperty;
  kind: StayMessageKind;
  subject: string;
  body: string;
  smsBody: string;
  /** Channels already delivered on an earlier attempt (never sent twice). */
  already: ChannelResults;
  /** Stable per (stay, kind[, facts hash]): the idempotency key every downstream send carries. */
  dedupeBase: string;
  /** Persist each channel's result the moment it lands, so a crash after the text never repeats the text. */
  checkpoint?: (results: ChannelResults) => Promise<void>;
};

export type StayManagerFlag = {
  workspaceId: string | null;
  ownerUserId: string;
  propertyId: string;
  text: string;
  key: string;
};

export interface StayMessageDeps {
  now(): Date;
  loadCandidates(): Promise<StayCandidate[]>;
  loadProperty(propertyId: string): Promise<StayProperty | null>;
  loadSettings(scope: { ownerUserId: string; workspaceId: string | null }): Promise<StayMessageSettings>;
  ledger: StayMessageLedger;
  send(input: StayMessageSendInput): Promise<ChannelResults>;
  flagManager(flag: StayManagerFlag): Promise<void>;
  /** A failed channel: visible on the thread (`recordDeliveryIssue`). Never throws. */
  recordIssue(input: { candidate: StayCandidate; kind: StayMessageKind; channel: ChannelName; reason: string; eventId: string }): Promise<void>;
}

export type StayMessageSweepSummary = {
  examined: number;
  sent: number;
  partial: number;
  failed: number;
  held: number;
  cancelled: number;
  corrections: number;
};
