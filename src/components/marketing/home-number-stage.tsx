import { House } from "lucide-react";
import { HomeScrollStage } from "./home-scroll-stage";
import { ResidentLifecyclePhone } from "./resident-lifecycle-phone";
import { phoneScriptFor, type PhoneItem } from "./resident-lifecycle-script";
import { PROPERTY_ROWS } from "./site/product-mock/fixtures";
import { OPS_REPORTS } from "./site/product-mock/fixtures-popups-ops";
import { BigNumber } from "./big-number";

function PhoneScene({ role, items }: { role: string; items: PhoneItem[] }) {
  return (
    <div className="home-number-phone">
      <ResidentLifecyclePhone
        caption={`${role}’s phone`}
        contact={{ initials: "PL", name: "PropLane", sub: "Text message" }}
        items={items}
        readOnly
        hideCaption
      />
      <span className="home-sample-label">Sample conversation</span>
    </div>
  );
}

function NetworkScene({
  beat,
}: {
  beat: "homes" | "residents" | "vendors" | "everyone";
}) {
  return (
    <div
      className="home-network"
      data-beat={beat}
      aria-label="Illustration of homes connected through the PropLane number"
    >
      <div className="home-network-homes">
        {PROPERTY_ROWS.slice(0, 3).map((home) => (
          <div key={home.id}>
            <House aria-hidden="true" />
            <span>{home.title}</span>
          </div>
        ))}
      </div>
      <div className="home-network-lines" aria-hidden="true">
        <i />
        <i />
        <i />
      </div>
      <div className="home-network-hub">
        <span>PropLane</span>
        <BigNumber dataAttr="home-network-number" />
      </div>
      <div
        className="home-network-lines home-network-lines-bottom"
        aria-hidden="true"
      >
        <i />
        <i />
        <i />
      </div>
      <div className="home-network-people">
        {(["Renters", "Residents", "Vendors"] as const).map((role) => (
          <span
            key={role}
            data-emphasis={
              beat === "everyone" ||
              (beat === "residents" && role === "Residents") ||
              (beat === "vendors" && role === "Vendors")
            }
          >
            <b aria-hidden="true">{role[0]}</b>
            {role}
          </span>
        ))}
      </div>
      <small>Sample homes</small>
    </div>
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
      className="home-number-stage"
      travel={600}
      steps={[
        {
          id: "renters",
          label: "Renters",
          caption: "Text one number to find a room.",
          content: (
            <PhoneScene
              role="Renter"
              items={phoneScriptFor("resident", "tour").items}
            />
          ),
        },
        {
          id: "residents",
          label: "Residents",
          caption: "Your home, a text away.",
          content: (
            <PhoneScene
              role="Resident"
              items={phoneScriptFor("resident", "pay").items}
            />
          ),
        },
        {
          id: "vendors",
          label: "Vendors",
          caption: "The job. The details. The same conversation.",
          content: (
            <PhoneScene
              role="Vendor"
              items={phoneScriptFor("vendor", "visit").items}
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
          caption: "Every listing. One PropLane number.",
          content: <NetworkScene beat="homes" />,
        },
        {
          id: "move",
          label: "Every home",
          caption: "Move homes. Keep the PropLane number.",
          content: <NetworkScene beat="residents" />,
        },
        {
          id: "next-job",
          label: "Every home",
          caption: "The next approved job reaches the same number.",
          content: <NetworkScene beat="vendors" />,
        },
        {
          id: "connected",
          label: "Every home",
          caption: "A home connects the people who keep it running.",
          content: <NetworkScene beat="everyone" />,
        },
      ]}
    />
  );
}
