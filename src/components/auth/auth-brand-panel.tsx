import { SiteBackdrop } from "@/components/marketing/site/site-backdrop";
import { formatUsPhoneDisplay } from "@/lib/phone-e164";

/** Who texts the line, as on the homepage cover. */
const WHO_TEXTS = [
  { n: "01", title: "Renters", line: "Looking for a room" },
  { n: "02", title: "Residents", line: "Rent, repairs" },
  { n: "03", title: "Vendors", line: "Jobs, invoices" },
  { n: "04", title: "Owners", line: "How is my house" },
] as const;

/**
 * The right half of every auth screen on a wide web window, edge to edge: the
 * homepage's blue slab with its own wavy-line atmosphere, "Text us" and (when
 * configured) the PropLane number as one big figure, a short thread showing the
 * product, and the four people who text it.
 *
 * Purely decorative: `aria-hidden`, no controls, no links. The number is never
 * a literal here; it arrives from the server's public texting snapshot and the
 * line is omitted when there is none. Hidden below `lg` and in the native
 * shells by `auth-split.css`.
 */
export function AuthBrandPanel({ phone }: { phone: string | null }) {
  const display = phone ? formatUsPhoneDisplay(phone) : "";
  return (
    <aside className="auth-brand-panel" data-auth-brand aria-hidden="true">
      <SiteBackdrop />
      <div className="auth-brand-stage">
        <div className="auth-brand-head">
          <p className="auth-brand-lead">Text us</p>
          {display ? <p className="auth-brand-number">{display}</p> : null}
        </div>

        <div className="auth-thread">
          <p className="auth-bubble auth-bubble-in">
            <span className="auth-bubble-who">Renter</span>
            Is the room on Alder still open?
          </p>
          <p className="auth-bubble auth-bubble-out">
            <span className="auth-bubble-who">PropLane</span>
            Yes. Tours tomorrow 4 to 6 pm. Want one?
          </p>
        </div>

        <ul className="auth-who">
          {WHO_TEXTS.map((item) => (
            <li key={item.n}>
              <span className="auth-who-n">{item.n}</span>
              <strong>{item.title}</strong>
              <span className="auth-who-line">{item.line}</span>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}
