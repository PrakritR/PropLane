import Link from "next/link";
import { ArrowRight } from "lucide-react";
import {
  RESIDENT_GET_STARTED_HREF,
  VENDOR_GET_STARTED_HREF,
} from "@/lib/marketing/public-contact";

/** Two quiet rows for the people who do not run homes: each goes straight to its own role's sign-up. */
const ROWS = [
  { id: "resident", role: "Resident", line: "Pay rent, request services", href: RESIDENT_GET_STARTED_HREF },
  { id: "vendor", role: "Vendor", line: "Get jobs by text", href: VENDOR_GET_STARTED_HREF },
] as const;

export function HomeJoinFree() {
  return (
    <section className="home-join" aria-labelledby="home-join-title">
      <div className="swiss-wrap home-join-wrap">
        <h2 id="home-join-title" className="home-join-title">Join free</h2>
        <ul className="home-join-rows">
          {ROWS.map((row) => (
            <li key={row.id}>
              <span className="home-join-role">{row.role}</span>
              <span className="home-join-line">{row.line}</span>
              <Link href={row.href} prefetch={false} className="home-join-cta" data-attr={`home-join-${row.id}`}>
                Sign up free
                <ArrowRight aria-hidden="true" size={16} />
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
