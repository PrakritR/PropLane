import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { HomeSectionHeader } from "@/components/marketing/home-section-header";
import {
  MANAGER_GET_STARTED_HREF,
  RESIDENT_GET_STARTED_HREF,
  VENDOR_GET_STARTED_HREF,
} from "@/lib/marketing/public-contact";

/** Each row signs up to its own role: a resident finds housing by text, a vendor gets jobs by text, a manager runs
 *  their homes by text (captain #29). The number lives in the hero and the footer, not on these rows (captain #23). */
const ROWS = [
  { id: "resident", role: "Resident", line: "Find housing by text", href: RESIDENT_GET_STARTED_HREF },
  { id: "vendor", role: "Vendor", line: "Get jobs by text", href: VENDOR_GET_STARTED_HREF },
  { id: "manager", role: "Manager", line: "Run your homes by text", href: MANAGER_GET_STARTED_HREF },
] as const;

export function HomeJoinFree() {
  return (
    <section className="home-join" aria-labelledby="home-join-title">
      <div className="swiss-wrap home-join-wrap">
        <HomeSectionHeader id="home-join-title">Join free</HomeSectionHeader>
        <ul className="home-join-rows">
          {ROWS.map((row) => (
            <li key={row.id}>
              <span className="home-join-role">{row.role}</span>
              <span className="home-join-line">{row.line}</span>
              <span className="home-join-actions">
                <Link href={row.href} prefetch={false} className="home-join-cta" data-attr={`home-join-${row.id}`}>
                  Sign up free
                  <ArrowRight aria-hidden="true" size={16} />
                </Link>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
