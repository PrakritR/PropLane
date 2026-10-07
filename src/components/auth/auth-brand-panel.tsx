import "./auth-split.css";
import { AuthIconManager, AuthIconResident, AuthIconVendor } from "@/components/auth/auth-role-icons";
import { SiteBackdrop } from "@/components/marketing/site/site-backdrop";

/**
 * The right half of every auth screen on a wide web window: PropLane blue with
 * the public site's wavy atmosphere and a loose collage of tilted product cards
 * (a resident text thread, a property row, a rent-paid chip, the three roles).
 *
 * Purely decorative — `aria-hidden`, no controls, no links, no personal names and
 * no figures beyond the one rent line a resident sees. It is hidden below `lg`,
 * on native, and on the wide plan chooser by `auth-split.css`.
 */
export function AuthBrandPanel() {
  return (
    <aside className="auth-brand-panel" data-auth-brand aria-hidden="true">
      <SiteBackdrop />
      <div className="auth-brand-glow" />

      <div className="auth-brand-stage">
        <div className="auth-brand-phone">
          <div className="auth-brand-phone-notch" />
          <div className="auth-brand-phone-head">
            <span className="auth-brand-phone-avatar">
              <AuthIconResident className="h-4 w-4" />
            </span>
            <span className="auth-brand-phone-title">Resident</span>
          </div>
          <div className="auth-brand-thread">
            <p className="auth-brand-bubble auth-brand-bubble-in">The kitchen faucet is dripping.</p>
            <p className="auth-brand-bubble auth-brand-bubble-out">Thanks, a vendor is on the way.</p>
            <p className="auth-brand-bubble auth-brand-bubble-in">Great, I will be home all day.</p>
            <p className="auth-brand-bubble auth-brand-bubble-out">Booked for Thursday morning.</p>
          </div>
          <div className="auth-brand-phone-composer">
            <span>Message</span>
            <i />
          </div>
        </div>

        <div className="auth-brand-row-card">
          <span className="auth-brand-row-tile">
            <AuthIconManager className="h-6 w-6" />
          </span>
          <span className="auth-brand-row-body">
            <strong>Room 2</strong>
            <small>Manager</small>
            <span className="auth-brand-row-facts">
              <em>2 beds</em>
              <em>Available now</em>
            </span>
          </span>
          <span className="auth-brand-row-figure">$1,080</span>
        </div>

        <div className="auth-brand-chip">
          <span className="auth-brand-chip-check">
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none">
              <path d="m3.5 8.5 3 3 6-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <span>
            Rent paid <b>$1,080</b>
          </span>
        </div>

        <div className="auth-brand-service">
          <span className="auth-brand-service-icon">
            <AuthIconVendor className="h-5 w-5" />
          </span>
          <span>
            <strong>Faucet repair</strong>
            <small>Vendor · Scheduled</small>
          </span>
        </div>

        <span className="auth-brand-badge auth-brand-badge-a">
          <AuthIconManager className="h-6 w-6" />
        </span>
        <span className="auth-brand-badge auth-brand-badge-b">
          <AuthIconResident className="h-6 w-6" />
        </span>
        <span className="auth-brand-badge auth-brand-badge-c">
          <AuthIconVendor className="h-6 w-6" />
        </span>
      </div>
    </aside>
  );
}
