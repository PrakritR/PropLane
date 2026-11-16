import { SiteBackdrop } from "@/components/marketing/site/site-backdrop";
import { formatPublicPhone } from "@/lib/marketing/format-public-phone";
import type { PublicTextingConfig } from "@/lib/marketing/public-texting";
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
 * Decorative except for the PropLane line under "Text us" (captain, Nov 15: publish the number as widely as
 * possible): the configured public number from `getPublicTextingConfig()` (never a literal), as an `sms:` link, never a call link.
 * Without a configured number the heading stands alone. Hidden below `lg` and in the native shells by
 * `auth-split.css`.
 */
export function AuthBrandPanel({ texting }: { texting?: PublicTextingConfig | null }) {
  const phone = formatPublicPhone(texting?.phone);
  return (
    <aside className="auth-brand-panel" data-auth-brand>
      <SiteBackdrop />
      <div className="auth-brand-stage">
        <div className="auth-brand-head">
          <p className="auth-brand-lead">Text us</p>
          {phone && texting?.smsHref ? (
            <a className="auth-brand-number" href={texting.smsHref} data-attr="auth-brand-text-number">
              {phone}
            </a>
          ) : null}
        </div>

        <div className="auth-thread" aria-hidden="true">
          <p className="auth-bubble auth-bubble-in">
            <span className="auth-bubble-who">Prospect</span>
            Is the room on Alder still open?
          </p>
          <p className="auth-bubble auth-bubble-out">
            <span className="auth-bubble-who">PropLane</span>
            Yes. Tours tomorrow 4 to 6 pm. Want one?
          </p>
        </div>

        <ul className="auth-who" aria-hidden="true">
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
