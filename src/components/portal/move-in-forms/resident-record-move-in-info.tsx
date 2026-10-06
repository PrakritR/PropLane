"use client";

/**
 * The read-only panels of the manager's resident record › Move-in hub: Move-in info, House rules
 * and Roommates. Everything shown is exactly what the manager authored on the property
 * (ManagerListingSubmissionV1) resolved for this resident; nothing is invented and nothing is edited
 * here ("Edit in property" lives in the toolbar).
 */
import type { ReactNode } from "react";
import { HouseInfoReadSections } from "@/components/portal/house-info-sections";
import { ResidentMoveInMediaGallery } from "@/components/portal/move-in-media-fields";
import { PortalDataTableEmpty } from "@/components/portal/portal-data-table";
import { Button } from "@/components/ui/button";
import { splitLineList } from "@/data/manager-listing-presets";
import { residentDirectoryStage } from "@/lib/current-resident";
import type { DemoApplicantRow } from "@/data/demo-portal";
import type { MockProperty } from "@/data/types";
import {
  HOUSE_INFO_MOVE_IN_SECTION_IDS,
  houseInfoIsEmpty,
  normalizeHouseInfo,
  type HouseInfoSectionId,
  type HouseInfoV1,
} from "@/lib/house-info";
import {
  isEntireHomeListing,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import {
  isRoommatePlacement,
  resolveResidentMoveInFromApplications,
  type ResidentMoveInResidentSection,
} from "@/lib/resident-move-in-resolve";

/** Everything the three read panels need, resolved once per property/resident. */
export type ResidentMoveInHubData = {
  hasProperty: boolean;
  houseInstructions: string | null;
  housePhotoDataUrls: string[];
  houseVideoDataUrl: string | null;
  roomLabel: string;
  roomInstructions: string | null;
  roomPhotoDataUrls: string[];
  roomVideoDataUrl: string | null;
  spot: ResidentMoveInResidentSection | null;
  houseInfo: HouseInfoV1;
  generalHouseInfo: string | null;
  houseRulesText: string | null;
  amenities: string[];
};

const NO_DATA: ResidentMoveInHubData = {
  hasProperty: false,
  houseInstructions: null,
  housePhotoDataUrls: [],
  houseVideoDataUrl: null,
  roomLabel: "",
  roomInstructions: null,
  roomPhotoDataUrls: [],
  roomVideoDataUrl: null,
  spot: null,
  houseInfo: normalizeHouseInfo(null),
  generalHouseInfo: null,
  houseRulesText: null,
  amenities: [],
};

/** The property's move-in data for this resident; falls back to the property's own (house-level) data when the resident cannot be resolved. */
export function buildResidentMoveInHubData(input: {
  propertyId: string;
  sub: ManagerListingSubmissionV1 | null;
  row: DemoApplicantRow | undefined;
  residentEmail: string;
}): ResidentMoveInHubData {
  const { propertyId, sub, row, residentEmail } = input;
  if (!sub) return NO_DATA;
  const property = {
    id: propertyId,
    title: "",
    buildingName: "",
    listingSubmission: sub,
  } as unknown as MockProperty;
  const resolved =
    row && residentEmail.trim()
      ? resolveResidentMoveInFromApplications(residentEmail, [row], {
          [propertyId]: property,
        })
      : null;
  if (resolved) {
    return {
      hasProperty: true,
      houseInstructions: resolved.houseInstructions,
      housePhotoDataUrls: resolved.houseMoveInPhotoDataUrls,
      houseVideoDataUrl: resolved.houseMoveInVideoDataUrl,
      roomLabel: resolved.roomLabel,
      roomInstructions: resolved.instructions,
      roomPhotoDataUrls: resolved.moveInPhotoDataUrls,
      roomVideoDataUrl: resolved.moveInVideoDataUrl,
      spot: resolved.residentSection,
      houseInfo: resolved.houseInfo,
      generalHouseInfo: resolved.generalHouseInfo,
      houseRulesText: resolved.houseRulesText,
      amenities: resolved.amenities,
    };
  }
  const entire = isEntireHomeListing(sub);
  const text = sub.houseMoveInInstructions?.trim() || null;
  const photos = sub.houseMoveInPhotoDataUrls ?? [];
  const video = sub.houseMoveInVideoDataUrl ?? null;
  return {
    ...NO_DATA,
    hasProperty: true,
    houseInstructions: entire ? null : text,
    housePhotoDataUrls: entire ? [] : photos,
    houseVideoDataUrl: entire ? null : video,
    roomInstructions: entire ? text : null,
    roomPhotoDataUrls: entire ? photos : [],
    roomVideoDataUrl: entire ? video : null,
    houseInfo: normalizeHouseInfo(sub.houseInfo),
    generalHouseInfo: sub.generalHouseInfo?.trim() || null,
    houseRulesText: sub.houseRulesText?.trim() || null,
    amenities: splitLineList(sub.amenitiesText ?? ""),
  };
}

/** A copy of the house info holding only the given sections (and, optionally, "Good to know"). */
function pickHouseInfo(
  info: HouseInfoV1,
  ids: readonly HouseInfoSectionId[],
  includeOther: boolean,
): HouseInfoV1 {
  const next = normalizeHouseInfo(null);
  for (const id of ids) next[id] = { ...info[id] };
  next.other = includeOther ? info.other : "";
  return next;
}

const RULES_IDS: readonly HouseInfoSectionId[] = ["rules"];
const REST_IDS: readonly HouseInfoSectionId[] = [
  "trash",
  "laundry",
  "contacts",
  "safety",
];

const CARD = "rounded-2xl border border-border bg-card shadow-sm";

/** The record-page card: a titled, bordered section (optional actions on the right). */
export function MoveInCard({
  title,
  actions,
  children,
  dataAttr,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
  dataAttr: string;
}) {
  return (
    <section
      className={`mb-4 flex min-w-0 flex-col ${CARD}`}
      data-attr={dataAttr}
    >
      <div className="flex items-center gap-1 border-b border-border/70 px-4 py-2.5">
        <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold tracking-[-0.01em] text-foreground">
          {title}
        </h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

function TextBlock({
  title,
  text,
  photos,
  video,
  dataAttr,
}: {
  title?: string;
  text: string | null;
  photos: string[];
  video: string | null;
  dataAttr: string;
}) {
  if (!text && photos.length === 0 && !video) return null;
  return (
    <section
      className="border-t border-border/70 px-4 py-3 first:border-t-0"
      data-attr={dataAttr}
    >
      {title ? (
        <h3 className="mb-1.5 text-sm font-semibold text-foreground">
          {title}
        </h3>
      ) : null}
      {text ? (
        <div className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
          {text}
        </div>
      ) : null}
      <ResidentMoveInMediaGallery photoDataUrls={photos} videoDataUrl={video} />
    </section>
  );
}

function EmptyInProperty({
  message,
  onAdd,
  dataAttr,
}: {
  message: string;
  onAdd?: () => void;
  dataAttr: string;
}) {
  return (
    <PortalDataTableEmpty
      icon="default"
      message={message}
      action={
        onAdd ? (
          <Button
            type="button"
            variant="outline"
            data-attr={dataAttr}
            onClick={onAdd}
          >
            Add in property
          </Button>
        ) : undefined
      }
    />
  );
}

/** Move-in info: the instructions, media, access, Wi-Fi and amenities the resident received. */
export function ResidentMoveInInfoPanel({
  data,
  first,
  onAddInProperty,
}: {
  data: ResidentMoveInHubData;
  first: string;
  onAddInProperty?: () => void;
}) {
  const accessInfo = pickHouseInfo(
    data.houseInfo,
    HOUSE_INFO_MOVE_IN_SECTION_IDS,
    false,
  );
  const hasAccess = !houseInfoIsEmpty(accessInfo);
  const hasHouse =
    Boolean(data.houseInstructions) ||
    data.housePhotoDataUrls.length > 0 ||
    Boolean(data.houseVideoDataUrl);
  const hasRoom =
    Boolean(data.roomInstructions) ||
    data.roomPhotoDataUrls.length > 0 ||
    Boolean(data.roomVideoDataUrl);
  const hasSpot = Boolean(data.spot);
  const hasInstructions = hasHouse || hasRoom || hasSpot;
  if (!hasInstructions && !hasAccess && data.amenities.length === 0) {
    return (
      <MoveInCard
        title={`Move-in details ${first} received`}
        dataAttr="resident-record-move-in-details"
      >
        <EmptyInProperty
          message="No move-in info on this property yet"
          onAdd={onAddInProperty}
          dataAttr="resident-move-in-info-empty-add"
        />
      </MoveInCard>
    );
  }
  const roomTitle = hasHouse
    ? data.roomLabel.trim() || "Their room"
    : undefined;
  return (
    <>
      {hasInstructions ? (
        <MoveInCard
          title={`Move-in details ${first} received`}
          dataAttr="resident-record-move-in-details"
        >
          <TextBlock
            title="The whole house"
            text={data.houseInstructions}
            photos={data.housePhotoDataUrls}
            video={data.houseVideoDataUrl}
            dataAttr="resident-move-in-house-section"
          />
          <TextBlock
            title={roomTitle}
            text={data.roomInstructions}
            photos={data.roomPhotoDataUrls}
            video={data.roomVideoDataUrl}
            dataAttr="resident-move-in-room-section"
          />
          {data.spot ? (
            <TextBlock
              title={`Their spot · Resident ${data.spot.slot}`}
              text={data.spot.instructions}
              photos={data.spot.photoDataUrls}
              video={data.spot.videoDataUrl}
              dataAttr="resident-move-in-resident-section"
            />
          ) : null}
        </MoveInCard>
      ) : null}
      {hasAccess ? (
        <div className="mb-4" data-attr="resident-move-in-access">
          <HouseInfoReadSections info={accessInfo} />
        </div>
      ) : null}
      {data.amenities.length > 0 ? (
        <MoveInCard
          title="Amenities"
          dataAttr="resident-record-move-in-amenities"
        >
          <ul className="list-disc space-y-1 px-4 py-3 pl-9 text-sm leading-relaxed text-foreground">
            {data.amenities.map((amenity) => (
              <li key={amenity}>{amenity}</li>
            ))}
          </ul>
        </MoveInCard>
      ) : null}
    </>
  );
}

/** House rules: the rules section and legacy rules text first, then the other "For residents" sections. */
export function ResidentHouseRulesPanel({
  data,
  onAddInProperty,
}: {
  data: ResidentMoveInHubData;
  onAddInProperty?: () => void;
}) {
  const rulesInfo = pickHouseInfo(data.houseInfo, RULES_IDS, false);
  const restInfo = pickHouseInfo(data.houseInfo, REST_IDS, true);
  const hasRules = !houseInfoIsEmpty(rulesInfo);
  const hasRest = !houseInfoIsEmpty(restInfo);
  const hasLegacy = Boolean(data.houseRulesText || data.generalHouseInfo);
  if (!hasRules && !hasRest && !hasLegacy) {
    return (
      <div
        className={`mb-4 ${CARD}`}
        data-attr="resident-record-house-rules-empty"
      >
        <EmptyInProperty
          message="No house rules on this property yet"
          onAdd={onAddInProperty}
          dataAttr="resident-house-rules-empty-add"
        />
      </div>
    );
  }
  return (
    <div className="mb-4 space-y-3" data-attr="resident-record-house-rules">
      {hasRules ? <HouseInfoReadSections info={rulesInfo} /> : null}
      {hasLegacy ? (
        <section
          className="rounded-2xl border border-border bg-card px-4 py-3"
          data-attr="resident-house-rules-legacy"
        >
          <div className="space-y-4 whitespace-pre-wrap text-sm leading-relaxed text-foreground">
            {data.houseRulesText ? <div>{data.houseRulesText}</div> : null}
            {data.generalHouseInfo ? <div>{data.generalHouseInfo}</div> : null}
          </div>
        </section>
      ) : null}
      {hasRest ? <HouseInfoReadSections info={restInfo} /> : null}
    </div>
  );
}

export type ResidentRoommateRow = {
  id: string;
  name: string;
  roomLabel: string;
  moveInLabel: string;
  status: string;
  /** Shares this resident's own room, not just the house. */
  sharesRoom: boolean;
};

function placedPropertyId(row: DemoApplicantRow): string {
  return (
    row.assignedPropertyId?.trim() ||
    row.propertyId?.trim() ||
    row.application?.propertyId?.trim() ||
    ""
  );
}

/**
 * The other people actually living at this property, derived from the stored application rows.
 *
 * "Roommate" means a CURRENT resident, which is `residentDirectoryStage`'s answer and nothing
 * looser: an approved row whose lease nobody executed is still only a potential resident, and one
 * whose tenancy ended (a move-out date gone by, a previous-resident stage) has moved out. Both are
 * excluded — listing either as a roommate tells the manager somebody lives there who does not.
 * `leaseExecuted` is supplied by the caller because the answer lives in the lease pipeline.
 */
export function deriveResidentRoommates(input: {
  rows: readonly DemoApplicantRow[];
  propertyId: string;
  selfApplicationId: string;
  selfResidentId?: string;
  sub: ManagerListingSubmissionV1 | null;
  now: Date;
  leaseExecuted: (row: DemoApplicantRow) => boolean;
}): ResidentRoommateRow[] {
  const { rows, propertyId, selfApplicationId, selfResidentId, sub, now, leaseExecuted } =
    input;
  if (!propertyId) return [];
  const property = sub
    ? ({
        id: propertyId,
        title: "",
        buildingName: "",
        listingSubmission: sub,
      } as unknown as MockProperty)
    : undefined;
  const placement = (row: DemoApplicantRow) => {
    const email = row.email?.trim() ?? "";
    const resolved =
      email && property
        ? resolveResidentMoveInFromApplications(email, [row], {
            [propertyId]: property,
          })
        : null;
    const manualRoom = row.manualResidentDetails?.roomNumber?.trim() ?? "";
    return {
      roomId: resolved?.roomId ?? null,
      roomLabel: resolved ? resolved.roomLabel : manualRoom || "Room TBD",
      moveInLabel:
        resolved?.earliestMoveInDateLabel ??
        (row.manualResidentDetails?.moveInDate?.trim() ||
          row.application?.leaseStart?.trim() ||
          ""),
      moveInIso:
        row.manualResidentDetails?.moveInDate?.trim() ||
        row.application?.leaseStart?.trim() ||
        "",
    };
  };
  const self = rows.find((row) => row.id === selfApplicationId);
  const selfPlacement = self ? placement(self) : null;
  const selfEmail = self?.email?.trim().toLowerCase() ?? "";
  const out: ResidentRoommateRow[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.withdrawnAt) continue;
    if (row.id === selfApplicationId || row.id === selfResidentId) continue;
    if (selfEmail && row.email?.trim().toLowerCase() === selfEmail) continue;
    if (placedPropertyId(row) !== propertyId || seen.has(row.id)) continue;
    if (
      residentDirectoryStage(row, { leaseExecuted: leaseExecuted(row) }, now.getTime()) !==
      "current"
    ) {
      continue;
    }
    seen.add(row.id);
    const mine = placement(row);
    const when = mine.moveInIso ? new Date(mine.moveInIso) : null;
    const upcoming = Boolean(
      when && !Number.isNaN(when.getTime()) && when.getTime() > now.getTime(),
    );
    out.push({
      id: row.id,
      name: row.name.trim() || row.email?.trim() || "Resident",
      roomLabel: mine.roomLabel,
      moveInLabel: mine.moveInLabel || "Not set",
      status: upcoming ? "Moving in" : "Current",
      sharesRoom: selfPlacement
        ? isRoommatePlacement(
            { roomId: selfPlacement.roomId ?? "", roomLabel: selfPlacement.roomLabel },
            { roomId: mine.roomId ?? "", roomLabel: mine.roomLabel },
          )
        : false,
    });
  }
  return out;
}

/** Roommates: the other residents at the property, one clickable row each. */
export function ResidentRoommatesPanel({
  roommates,
  onOpenResident,
}: {
  roommates: readonly ResidentRoommateRow[];
  onOpenResident?: (residentId: string) => void;
}) {
  if (roommates.length === 0) {
    return (
      <div
        className={`mb-4 ${CARD}`}
        data-attr="resident-record-roommates-empty"
      >
        <PortalDataTableEmpty
          icon="residents"
          message="No roommates at this property yet"
        />
      </div>
    );
  }
  return (
    <section
      className={`mb-4 min-w-0 ${CARD}`}
      data-attr="resident-record-roommates"
    >
      <div className="border-b border-border/70 px-4 py-2.5">
        <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-foreground">
          Roommates
        </h2>
      </div>
      <ul className="divide-y divide-border/70">
        {roommates.map((mate) => {
          const body = (
            <>
              <span className="min-w-0 flex-1">
                <span className="ph-no-capture ph-no-record block truncate text-sm font-semibold text-foreground">
                  {mate.name}
                </span>
                <span className="mt-0.5 block truncate text-xs text-muted">
                  {mate.roomLabel}
                  {mate.sharesRoom ? " · shares their room" : ""}
                </span>
              </span>
              <span className="shrink-0 text-right text-xs text-muted">
                <span className="block font-medium text-foreground">
                  {mate.status}
                </span>
                <span className="block">{mate.moveInLabel}</span>
              </span>
            </>
          );
          return (
            <li key={mate.id}>
              {onOpenResident ? (
                <button
                  type="button"
                  className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  data-attr="resident-roommate-row"
                  onClick={() => onOpenResident(mate.id)}
                >
                  {body}
                </button>
              ) : (
                <div
                  className="flex w-full items-center gap-3 px-4 py-3"
                  data-attr="resident-roommate-row"
                >
                  {body}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
