import { HomeScrollStage } from "./home-scroll-stage";
import { HomeIphonePhone } from "./home-iphone-phone";
import { STORIES, type PhoneItem } from "./resident-lifecycle-script";
import { PROPERTY_ROWS, RESIDENT_ROWS, SERVICE_ROWS, WILLOW_INQUIRIES } from "./site/product-mock/fixtures";
import { BOOKING_ROWS, FINANCE_BY_PROPERTY } from "./site/product-mock/fixtures-more";
import { OPS_REPORTS } from "./site/product-mock/fixtures-popups-ops";
import { BigNumber } from "./big-number";

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
const roles = ["Prospects", "Residents", "Vendors", "Owners"] as const;

function NetworkScene() {
  return (
    <figure className="swiss-number-network">
      <div className="swiss-network-map">
        <svg
          viewBox="0 0 420 560"
          role="img"
          aria-label={`Network: ${homes.length} homes connected to prospects, residents, vendors and owners through PropLane`}
        >
          <g className="swiss-network-lines" fill="none">
            <path d="M210 232V158M72 158H348M72 158V86M210 158V86M348 158V86" />
            <path d="M210 328V402M54 402H366M54 402V436M158 402V436M262 402V436M366 402V436" />
          </g>
          {homes.map((home, index) => (
            <g key={home.id} className="swiss-network-home">
              <rect x={12 + index * 138} y="22" width="120" height="64" rx="10" />
              <text x={24 + index * 138} y="60">
                {home.title}
              </text>
            </g>
          ))}
          {roles.map((role, index) => (
            <g key={role} className="swiss-network-person">
              <rect x={8 + index * 104} y="436" width="92" height="96" rx="10" />
              <text x={18 + index * 104} y="460">
                {role}
              </text>
              <circle cx={30 + index * 104} cy="494" r="13" />
              <text
                className="swiss-network-initial"
                x={30 + index * 104}
                y="498"
                aria-hidden="true"
              >
                {role[0]}
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

export function HomeNumberStage() {
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
  return (
    <HomeScrollStage
      id="how"
      title="How it works"
      sectionNumber="01"
      className="home-number-stage"
      travel={500}
      steps={[
        {
          id: "prospects",
          label: "Prospects",
          caption: "Ask about a room. Book the tour.",
          content: (
            <PhoneScene role="Prospect" items={beatItems("resident", "tour")} />
          ),
        },
        {
          id: "residents",
          label: "Residents",
          caption: "Pay rent. Report a leak.",
          content: (
            <PhoneScene role="Resident" items={beatItems("resident", "pay")} />
          ),
        },
        {
          id: "vendors",
          label: "Vendors",
          caption: "Accept the job. Keep everyone posted.",
          content: (
            <PhoneScene
              role="Vendor"
              items={[
                ...beatItems("vendor", "quote"),
                ...beatItems("vendor", "visit"),
              ]}
            />
          ),
        },
        {
          id: "managers",
          label: "Managers",
          caption: "Ask about your houses and prospects.",
          content: <PhoneScene role="Manager" items={managerItems()} />,
        },
        {
          id: "owners",
          label: "Owners",
          caption: "Ask how your home is doing.",
          content: <PhoneScene role="Owner" items={ownerItems} />,
        },
        {
          id: "homes",
          label: "Every home",
          caption: "A home connects the people who keep it running.",
          content: <NetworkScene />,
        },
      ]}
    />
  );
}
