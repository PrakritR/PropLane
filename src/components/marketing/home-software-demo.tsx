import { Building2, House, Wrench, type LucideIcon } from "lucide-react";
import { HomeSectionHeader } from "./home-section-header";
import { HomeSoftwareDemoPlayer } from "./home-software-demo-player";

/** The three portals, one line each: what the small-screen Software section shows instead of the live demo. */
export const SOFTWARE_PORTALS: readonly { id: string; name: string; line: string; Icon: LucideIcon }[] = [
  { id: "resident", name: "Resident", line: "Find a home, pay rent, request a service.", Icon: House },
  { id: "property", name: "Property", line: "Leasing, rent, services and messages for every house.", Icon: Building2 },
  { id: "vendor", name: "Vendor", line: "Get jobs by text, schedule visits, get paid.", Icon: Wrench },
];

/**
 * The homepage Software section. Desktop (1025px and up): the REAL manager portal as three chapters (an iframe of
 * `/demo/home-embed`). Tablet and phone: the player is `display: none` — so its viewport observer never fires and
 * the iframe never loads — and three static portal cards stand in. The anchor `#dashboard` belongs to the wrapper.
 */
export function HomeSoftwareDemo() {
  return (
    <div id="dashboard" className="home-software">
      <div className="home-software-wide">
        <HomeSoftwareDemoPlayer id="software-demo" />
      </div>
      <section className="home-software-compact" aria-labelledby="home-dashboard-compact-title">
        <HomeSectionHeader id="home-dashboard-compact-title">Software</HomeSectionHeader>
        <ul className="home-software-cards">
          {SOFTWARE_PORTALS.map(({ id, name, line, Icon }) => (
            <li key={id} className="home-software-card" data-portal={id}>
              <span className="home-software-card-icon" aria-hidden="true"><Icon size={26} strokeWidth={1.75} /></span>
              <h3>{name}</h3>
              <p>{line}</p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
