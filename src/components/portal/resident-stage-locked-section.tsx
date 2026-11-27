import {
  ManagerPortalPageShell,
  PORTAL_INLINE_UNLOCK_NOTICE_CLASS,
} from "@/components/portal/portal-metrics";

/**
 * The page a stage-locked resident section opens (the Payments pattern): the section's own title and the
 * one-line notice naming what unlocks it. The nav row is a live link here, never a dead click or a silent
 * bounce home. The copy comes from `residentStageLockCopy`.
 */
export function ResidentStageLockedSection({ label, message }: { label: string; message: string }) {
  return (
    <ManagerPortalPageShell title={label} hideTitleOnMobileNav>
      <p
        className={PORTAL_INLINE_UNLOCK_NOTICE_CLASS}
        data-slot="resident-stage-locked"
        data-attr="resident-stage-locked-notice"
      >
        <span className="font-semibold">{message}</span>
      </p>
    </ManagerPortalPageShell>
  );
}
