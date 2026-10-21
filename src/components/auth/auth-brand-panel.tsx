import { SiteBackdrop } from "@/components/marketing/site/site-backdrop";
import { HOME_ROLES } from "@/lib/marketing/home-roles";

/** Who texts the line: the homepage's shared roles (names, order and lines from HOME_ROLES, captain #27). */
const WHO_TEXTS = HOME_ROLES.map((role, index) => ({
  n: String(index + 1).padStart(2, "0"),
  title: role.label,
  line: role.caption,
}));

/**
 * The right half of every auth screen on a wide web window, edge to edge: the
 * homepage's blue slab with its own wavy-line atmosphere, "Text us", a short thread
 * showing the product, and the five people who text it.
 *
 * Purely decorative: `aria-hidden`, no controls, no links. It never carries the PropLane
 * number: a request made on the website is answered on the website, and only the homepage
 * shows the line. Hidden below `lg` and in the native shells by `auth-split.css`.
 */
export function AuthBrandPanel() {
  return (
    <aside className="auth-brand-panel" data-auth-brand aria-hidden="true">
      <SiteBackdrop />
      <div className="auth-brand-stage">
        <div className="auth-brand-head">
          <p className="auth-brand-lead">Text us</p>
        </div>

        <div className="auth-thread">
          <p className="auth-bubble auth-bubble-in">
            <span className="auth-bubble-who">Prospect</span>
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
