import { HomeScrollStage } from "./home-scroll-stage";
import { HomeIphonePhone } from "./home-iphone-phone";
import { STORIES, type PhoneItem } from "./resident-lifecycle-script";
import { PROPERTY_ROWS, RESIDENT_ROWS, SERVICE_ROWS, WILLOW_INQUIRIES } from "./site/product-mock/fixtures";
import { BOOKING_ROWS, FINANCE_BY_PROPERTY } from "./site/product-mock/fixtures-more";
import { OPS_REPORTS } from "./site/product-mock/fixtures-popups-ops";
import { BigNumber } from "./big-number";
import { HOME_ROLES, type HomeRoleId } from "@/lib/marketing/home-roles";
import { HomeSectionHeader } from "./home-section-header";

/** A scene shows only its beat, not the cumulative thread from every earlier portal step. */
function beatItems(role: "resident" | "vendor", id: string): PhoneItem[] {
  return STORIES[role]
    .find((beat) => beat.id === id)!
    .messages.flatMap((message): PhoneItem[] => [
      { kind: message.kind, text: message.text },
      ...(message.card ? [{ kind: "card" as const, ...message.card }] : []),
    ]);
}

function PhoneScene({ role, items }: { role: string; items: PhoneItem[] }) {
  return (
    <div className="home-number-phone">
      <HomeIphonePhone label={`${role}’s phone`} items={items} showNumber={false} />
    </div>
  );
}

/** The Managers step: two questions about the houses, each answered from the same fixture rows the portal mock draws. */
function managerItems(): PhoneItem[] {
  const tours = WILLOW_INQUIRIES.filter((inquiry) => inquiry.tour);
  const alder = PROPERTY_ROWS.find((home) => home.id === "prop-alder")!;
  const inAlder = (place: string) => place.endsWith(alder.title) || place.startsWith(`${alder.title} ·`);
  const occupied = new Set([
    ...RESIDENT_ROWS.filter((row) => row.tab === "current" && inAlder(row.place)).map((row) => row.place.split(" · ")[0]),
    ...BOOKING_ROWS.filter((row) => row.bucket === "inhouse" && inAlder(row.place)).map((row) => row.place.split(" · ")[1]),
  ]).size;
  const rent = FINANCE_BY_PROPERTY.find((row) => row.title === alder.title)!.in;
  const services = SERVICE_ROWS.filter((row) => row.property === alder.title);
  const open = services.filter((row) => row.state === "open");
  const scheduled = services.filter((row) => row.state === "scheduled");
  return [
    { kind: "out", text: "Any new prospects for Willow Court?" },
    {
      kind: "in",
      text: [
        `${WILLOW_INQUIRIES.length} new inquiries for Room 3.`,
        ...tours.map((inquiry) => `Tour booked: ${inquiry.name}, ${inquiry.tour}.`),
      ].join("\n"),
    },
    { kind: "out", text: `How is ${alder.title}?` },
    {
      kind: "in",
      text: [
        `${occupied} of ${alder.rooms} rooms occupied`,
        `Rent collected: $${rent.toLocaleString("en-US")}`,
        `Open services: ${open.length}${open.length ? ` (${open.map((row) => row.title).join(", ")})` : ""}`,
        ...scheduled.map((row) => `Scheduled: ${row.title}`),
      ].join("\n"),
    },
  ];
}

const homes = PROPERTY_ROWS.slice(0, 3);
/** The five people across the bottom of the diagram, 76 wide on an 82 pitch inside the 420 viewBox. */
const PERSON_X = (index: number) => 6 + index * 82;

function NetworkScene() {
  return (
    <figure className="swiss-number-network">
      <div className="swiss-network-map">
        <svg
          viewBox="0 0 420 560"
          role="img"
          aria-label={`Network: ${homes.length} homes connected to ${HOME_ROLES.map((role) => role.label.toLowerCase()).join(", ")} through PropLane`}
        >
          <g className="swiss-network-lines" fill="none">
            <path d="M210 232V158M72 158H348M72 158V86M210 158V86M348 158V86" />
            <path d={`M210 328V402M${PERSON_X(0) + 38} 402H${PERSON_X(HOME_ROLES.length - 1) + 38}${HOME_ROLES.map((_, index) => `M${PERSON_X(index) + 38} 402V436`).join("")}`} />
          </g>
          {homes.map((home, index) => (
            <g key={home.id} className="swiss-network-home">
              <rect x={12 + index * 138} y="22" width="120" height="64" rx="10" />
              <text x={24 + index * 138} y="60">
                {home.title}
              </text>
            </g>
          ))}
          {HOME_ROLES.map((role, index) => (
            <g key={role.id} className="swiss-network-person">
              <rect x={PERSON_X(index)} y="436" width="76" height="96" rx="10" />
              <text x={PERSON_X(index) + 7} y="460">
                {role.label}
              </text>
              <circle cx={PERSON_X(index) + 20} cy="494" r="13" />
              <text
                className="swiss-network-initial"
                x={PERSON_X(index) + 20}
                y="498"
                aria-hidden="true"
              >
                {role.label[0]}
              </text>
            </g>
          ))}
          <g className="swiss-network-junction" aria-hidden="true">
            <rect x="205" y="153" width="10" height="10" />
            <rect x="205" y="397" width="10" height="10" />
          </g>
        </svg>
        <div className="swiss-network-hub">
          <BigNumber dataAttr="home-network-number" />
          <span>PropLane · One number</span>
        </div>
      </div>
    </figure>
  );
}

type Role = { id: string; label: string; caption: string; items: PhoneItem[] };

/** The five roles in reading order. Desktop draws each as a phone; the small-screen list draws two of its bubbles. */
function roleSteps(): Role[] {
  const statement = OPS_REPORTS.find(
    (report) => report.id === "owner-statement",
  )!;
  const home = statement.rows[0];
  const ownerItems: PhoneItem[] = [
    { kind: "out", text: `How is ${home[0]} doing?` },
    {
      kind: "in",
      text: `${home[0]}\n${statement.columns
        .slice(1)
        .map((label, index) => `${label}: ${home[index + 1]}`)
        .join("\n")}`,
    },
  ];
  const items: Record<HomeRoleId, PhoneItem[]> = {
    prospects: beatItems("resident", "tour"),
    residents: beatItems("resident", "pay"),
    vendors: [...beatItems("vendor", "quote"), ...beatItems("vendor", "visit")],
    managers: managerItems(),
    owners: ownerItems,
  };
  // Names, order and lines come from the one shared list (HOME_ROLES); this file only supplies the conversations.
  return HOME_ROLES.map((role) => ({ id: role.id, label: role.label, caption: role.detail, items: items[role.id] }));
}

/** One short exchange: the first message the person sends and the first PropLane answers, in the order the phone shows them. */
export function firstExchange(items: PhoneItem[]): Extract<PhoneItem, { kind: "in" | "out" }>[] {
  const out = items.find((item) => item.kind === "out");
  const answer = items.find((item) => item.kind === "in");
  return [out, answer]
    .filter((item): item is Extract<PhoneItem, { kind: "in" | "out" }> => item !== undefined)
    .sort((a, b) => items.indexOf(a) - items.indexOf(b));
}

/**
 * Tablet and phone (up to 1024px): a plain list of the roles, each with its caption and one two-bubble exchange drawn
 * from the same items the desktop phones play. No phone frame and no network diagram. CSS shows it only there.
 */
function HomeHowList({ roles: list }: { roles: Role[] }) {
  return (
    <section className="home-how-list" aria-labelledby="home-how-list-title">
      <HomeSectionHeader id="home-how-list-title">How it works</HomeSectionHeader>
      <ol className="home-how-roles">
        {list.map((role) => (
          <li key={role.id} id={`how-${role.id}-list`} className="home-how-role" data-role={role.id}>
            <h3>{role.label}</h3>
            <p>{role.caption}</p>
            <div className="home-how-chat" role="group" aria-label={`${role.label} example`}>
              {firstExchange(role.items).map((message, index) => (
                <div key={index} className={`home-how-bubble home-how-bubble--${message.kind}`}>
                  <span>{message.text}</span>
                </div>
              ))}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function HomeNumberStage() {
  const list = roleSteps();
  return (
    <div id="how" className="home-how">
      <div className="home-how-wide">
        <HomeScrollStage
          id="how"
          rootId="how-stage"
          title="How it works"
          sectionNumber="01"
          className="home-number-stage"
          travel={500}
          steps={[
            ...list.map((role) => ({
              id: role.id,
              label: role.label,
              caption: role.caption,
              content: <PhoneScene role={role.label.replace(/s$/, "")} items={role.items} />,
            })),
            {
              id: "homes",
              label: "Every home",
              caption: "A home connects the people who keep it running.",
              content: <NetworkScene />,
            },
          ]}
        />
      </div>
      <HomeHowList roles={list} />
    </div>
  );
}
