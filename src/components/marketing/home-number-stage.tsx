import { HomeScrollStage } from "./home-scroll-stage";
import { ResidentLifecyclePhone } from "./resident-lifecycle-phone";
import { STORIES, type PhoneItem } from "./resident-lifecycle-script";
import { PROPERTY_ROWS } from "./site/product-mock/fixtures";
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
      <ResidentLifecyclePhone
        caption={`${role}’s phone`}
        contact={{ initials: "PL", name: "PropLane", sub: `${role}’s phone` }}
        items={items}
        readOnly
        hideCaption
      />
      <span className="home-sample-label">Sample conversation</span>
    </div>
  );
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
          aria-label={`Sample network: ${homes.length} homes connected to prospects, residents, vendors and owners through PropLane`}
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
      <figcaption>Sample homes</figcaption>
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
      title={
        <>
          One number.
          <br />
          Every home.
        </>
      }
      sectionNumber="01"
      sectionLabel="The number"
      sectionNote="One number connects every home"
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
