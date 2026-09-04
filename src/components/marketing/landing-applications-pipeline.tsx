"use client";

/**
 * Homepage hero mock of the manager Applications portal — self-playing AND
 * interactively browsable.
 *
 * Copy and structure mirror `src/components/portal/pro-applications.tsx`:
 * the "Applications" page title + Invite action, the Pending / Approved /
 * Rejected status tabs with counts plus the property filter pill, applicant
 * rows (avatar initials, name with inline chevron, "property · room"
 * subtitle, status badge from `applicationStatusPill`), and the expanded row's
 * real Approve / Reject / Send reminder actions and the Checkr screening chip.
 * Every label here exists in the portal — do not invent copy.
 *
 * By default it auto-runs ONE pending applicant through the review flow: open
 * her, Run screening flips the Checkr chip Pending → Clear and the badge to
 * Screened, then Approve moves her OUT of Pending into Approved. Because the
 * list is strictly filtered by the active tab, the approved applicant actually
 * leaves the Pending list and the pill counts stay exact (Pending 3 → 2,
 * Approved 4 → 5). It rests, then resets and repeats. The Pending / Approved /
 * Rejected tabs are real, keyboard-accessible tabs: a visitor can click one to
 * browse that bucket, which pauses the loop; after ~4s of no interaction it
 * resumes on the Pending tab. Purely scripted and presentational — no API,
 * money, or auth calls. Honors prefers-reduced-motion with a static snapshot.
 */
import { useEffect, useRef, useState } from "react";
import {
  createTimerPool,
  useAutoplayGate,
  usePrefersReducedMotion,
} from "@/components/marketing/use-marketing-demo";
import "./landing-applications-pipeline.css";

type Stage = "new" | "screening" | "screened" | "approved" | "rejected";
type Screening = "pending" | "running" | "complete";
type Tone = "pending" | "success" | "info" | "danger";
type Bucket = "pending" | "approved" | "rejected";

const BADGE: Record<Stage, { label: string; tone: Tone }> = {
  new: { label: "New", tone: "info" },
  screening: { label: "Screening", tone: "pending" },
  screened: { label: "Screened", tone: "info" },
  approved: { label: "Approved", tone: "success" },
  rejected: { label: "Rejected", tone: "danger" },
};

const TABS: { id: Bucket; label: string }[] = [
  { id: "pending", label: "Pending" },
  { id: "approved", label: "Approved" },
  { id: "rejected", label: "Rejected" },
];

const bucketOf = (stage: Stage): Bucket =>
  stage === "approved" ? "approved" : stage === "rejected" ? "rejected" : "pending";

type Applicant = { id: string; name: string; subtitle: string };

/** Full roster so every tab has real content. The first three are the animated
 * "cast" the loop works through; the rest are static Approved / Rejected rows. */
const APPLICANTS: Applicant[] = [
  { id: "maya", name: "Maya Chen", subtitle: "Cascade Lofts · Room 4B" },
  { id: "priya", name: "Priya Nair", subtitle: "Cascade Lofts · Room 2A" },
  { id: "dev", name: "Dev Ramos", subtitle: "Ballard Commons · Room 1C" },
  { id: "aisha", name: "Aisha Rahman", subtitle: "Cascade Lofts · Room 3C" },
  { id: "leo", name: "Leo Martins", subtitle: "Ballard Commons · Room 2B" },
  { id: "sofia", name: "Sofia Reyes", subtitle: "Cascade Court · Room 1A" },
  { id: "noah", name: "Noah Kim", subtitle: "Cascade Lofts · Room 5D" },
  { id: "ethan", name: "Ethan Cole", subtitle: "Ballard Commons · Room 4A" },
];

const INITIAL_STAGE: Record<string, Stage> = {
  maya: "screened",
  priya: "screening",
  dev: "new",
  aisha: "approved",
  leo: "approved",
  sofia: "approved",
  noah: "approved",
  ethan: "rejected",
};
const INITIAL_SCREENING: Record<string, Screening> = {
  maya: "complete",
  priya: "pending",
  dev: "pending",
  aisha: "complete",
  leo: "complete",
  sofia: "complete",
  noah: "complete",
  ethan: "complete",
};

/** The single applicant the loop demonstrates end to end. */
const FEATURED_ID = "priya";

/** How long a manual interaction pauses the loop before it resumes on its own. */
const RESUME_DELAY_MS = 4000;

function initials(name: string) {
  const parts = name.trim().split(/\s+/);
  return `${parts[0]?.[0] ?? ""}${parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : ""}`;
}

export function ApplicationsPipelinePanel() {
  const { ref, playing } = useAutoplayGate<HTMLDivElement>(0.3);
  const reducedMotion = usePrefersReducedMotion();

  const [stages, setStages] = useState<Record<string, Stage>>(INITIAL_STAGE);
  const [screening, setScreening] = useState<Record<string, Screening>>(INITIAL_SCREENING);
  const [activeId, setActiveId] = useState<string>("priya");
  const [pressed, setPressed] = useState<{ id: string; action: string } | null>(null);
  const [reminderId, setReminderId] = useState<string | null>(null);
  const [filter, setFilter] = useState<Bucket>("pending");
  /** True while the visitor is browsing; the loop is idle until it resumes. */
  const [paused, setPaused] = useState(false);
  const resumeRef = useRef<number | null>(null);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  // Tracks the deferred timers fired by manual handlers (runScreening,
  // sendReminder) so they are cleared on unmount instead of firing setState
  // after the component is gone. Same discipline as the auto-loop's pool.
  const [handlerTimers] = useState(() => createTimerPool());

  // Counts derive straight from the stages, so the tab numbers always equal the
  // actual filtered lists — approving an applicant moves her and updates both.
  const counts: Record<Bucket, number> = { pending: 0, approved: 0, rejected: 0 };
  for (const applicant of APPLICANTS) counts[bucketOf(stages[applicant.id])] += 1;

  const displayed = APPLICANTS.filter((a) => bucketOf(stages[a.id]) === filter);

  // Reduced motion: a representative "ready to approve" snapshot, no animation.
  useEffect(() => {
    if (!reducedMotion) return;
    setStages({ ...INITIAL_STAGE, priya: "screened" });
    setScreening({ ...INITIAL_SCREENING, priya: "complete" });
    setActiveId("priya");
    setFilter("pending");
    setReminderId(null);
    setPressed(null);
  }, [reducedMotion]);

  // Clean up any pending resume timer and deferred handler timers on unmount.
  useEffect(() => {
    return () => {
      if (resumeRef.current) window.clearTimeout(resumeRef.current);
      handlerTimers.cancel();
    };
  }, [handlerTimers]);

  // Self-playing loop: one applicant, open → screen → approve → she moves out of
  // Pending into Approved (counts update), rest, then reset and repeat.
  useEffect(() => {
    if (!playing || reducedMotion || paused) return;

    const pool = createTimerPool();
    const id = FEATURED_ID;
    const flash = async (action: string, ms: number) => {
      setPressed({ id, action });
      await pool.wait(ms);
      if (!pool.cancelled) setPressed(null);
    };

    void (async () => {
      while (!pool.cancelled) {
        // Reset to the start state: Priya back in Pending, screening not yet run.
        setStages(INITIAL_STAGE);
        setScreening(INITIAL_SCREENING);
        setReminderId(null);
        setActiveId(id);
        await pool.wait(1100);
        if (pool.cancelled) break;

        // Run screening: Checkr Pending → Running → Clear, badge → Screened.
        await flash("run", 300);
        if (pool.cancelled) break;
        setScreening((s) => ({ ...s, [id]: "running" }));
        await pool.wait(1500);
        if (pool.cancelled) break;
        setScreening((s) => ({ ...s, [id]: "complete" }));
        setStages((s) => ({ ...s, [id]: "screened" }));
        await pool.wait(1150);
        if (pool.cancelled) break;

        // Approve: she leaves Pending and joins Approved; the counts follow.
        await flash("approve", 340);
        if (pool.cancelled) break;
        setStages((s) => ({ ...s, [id]: "approved" }));
        await pool.wait(2600);
        if (pool.cancelled) break;

        await pool.wait(700);
      }
    })();

    return () => pool.cancel();
  }, [playing, reducedMotion, paused]);

  // Any manual interaction pauses the loop, then schedules it to resume on the
  // Pending tab after a few idle seconds (skipped under reduced motion).
  const takeControl = () => {
    if (reducedMotion) {
      setPaused(true);
      return;
    }
    setPaused(true);
    if (resumeRef.current) window.clearTimeout(resumeRef.current);
    resumeRef.current = window.setTimeout(() => {
      setFilter("pending");
      setPaused(false);
    }, RESUME_DELAY_MS);
  };

  const selectTab = (id: Bucket) => {
    takeControl();
    setFilter(id);
  };

  const onTabKeyDown = (event: React.KeyboardEvent, index: number) => {
    const keys = ["ArrowRight", "ArrowLeft", "Home", "End"];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % TABS.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + TABS.length) % TABS.length;
    else if (event.key === "Home") next = 0;
    else next = TABS.length - 1;
    selectTab(TABS[next].id);
    tabRefs.current[next]?.focus();
  };

  const toggleRow = (id: string) => {
    takeControl();
    setActiveId((current) => (current === id ? "" : id));
  };

  const runScreening = (id: string) => {
    takeControl();
    setScreening((s) => ({ ...s, [id]: "running" }));
    void handlerTimers.wait(900).then(() => {
      if (handlerTimers.cancelled) return;
      setScreening((s) => ({ ...s, [id]: "complete" }));
      setStages((s) => ({ ...s, [id]: s[id] === "new" || s[id] === "screening" ? "screened" : s[id] }));
    });
  };

  const approve = (id: string) => {
    takeControl();
    setStages((s) => ({ ...s, [id]: "approved" }));
  };

  const reject = (id: string) => {
    takeControl();
    setStages((s) => ({ ...s, [id]: "rejected" }));
  };

  const sendReminder = (id: string) => {
    takeControl();
    setReminderId(id);
    void handlerTimers.wait(1800).then(() => {
      if (handlerTimers.cancelled) return;
      setReminderId((current) => (current === id ? null : current));
    });
  };

  return (
    <div className="lp-pipe-frame" ref={ref}>
      <div className="lp-pipe">
        <div className="lp-pipe-chrome">
          <span className="lp-pipe-dots">
            <i />
            <i />
            <i />
          </span>
          <span className="lp-pipe-url">proplane.app/applications</span>
        </div>

        <div className="lp-pipe-body">
          <div className="lp-pipe-head">
            <p className="lp-pipe-heading">Applications</p>
            <span className="lp-pipe-head-action">Invite</span>
          </div>

          <div className="lp-pipe-toolbar">
            <div className="lp-pipe-tabs" role="tablist" aria-label="Filter applications by status">
              {TABS.map((tab, index) => {
                const active = filter === tab.id;
                return (
                  <button
                    key={tab.id}
                    ref={(node) => {
                      tabRefs.current[index] = node;
                    }}
                    type="button"
                    role="tab"
                    id={`applications-tab-${tab.id}`}
                    aria-selected={active}
                    aria-controls="applications-tabpanel"
                    tabIndex={active ? 0 : -1}
                    className={`lp-pipe-pill lp-pipe-tab${active ? " lp-pipe-pill-on" : ""}`}
                    data-attr={`applications-demo-tab-${tab.id}`}
                    onClick={() => selectTab(tab.id)}
                    onKeyDown={(event) => onTabKeyDown(event, index)}
                  >
                    {tab.label}
                  </button>
                );
              })}
            </div>
            <span className="lp-pipe-pill lp-pipe-pill-filter">All properties</span>
          </div>

          <div
            className="lp-pipe-table"
            role="tabpanel"
            id="applications-tabpanel"
            aria-labelledby={`applications-tab-${filter}`}
          >
            {displayed.length === 0 ? (
              <div className="lp-pipe-empty">No applications in this view.</div>
            ) : (
              displayed.map((applicant) => (
                <PipeRow
                  key={applicant.id}
                  applicant={applicant}
                  stage={stages[applicant.id]}
                  screening={screening[applicant.id]}
                  expanded={activeId === applicant.id}
                  pressed={pressed?.id === applicant.id ? pressed.action : null}
                  reminderSent={reminderId === applicant.id}
                  onToggle={() => toggleRow(applicant.id)}
                  onRunScreening={() => runScreening(applicant.id)}
                  onApprove={() => approve(applicant.id)}
                  onReject={() => reject(applicant.id)}
                  onSendReminder={() => sendReminder(applicant.id)}
                />
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function screeningChipLabel(screening: Screening) {
  if (screening === "running") return "Checkr: Running";
  if (screening === "complete") return "Checkr: Clear";
  return "Checkr: Pending";
}

function PipeRow({
  applicant,
  stage,
  screening,
  expanded,
  pressed,
  reminderSent,
  onToggle,
  onRunScreening,
  onApprove,
  onReject,
  onSendReminder,
}: {
  applicant: Applicant;
  stage: Stage;
  screening: Screening;
  expanded: boolean;
  pressed: string | null;
  reminderSent: boolean;
  onToggle: () => void;
  onRunScreening: () => void;
  onApprove: () => void;
  onReject: () => void;
  onSendReminder: () => void;
}) {
  const badge = BADGE[stage];
  const decided = stage === "approved" || stage === "rejected";
  const screeningDone = screening === "complete";

  return (
    <div
      className={`lp-pipe-item${expanded ? " lp-pipe-item-open" : ""}${
        stage === "approved" ? " lp-pipe-item-approved" : ""
      }`}
    >
      <button
        type="button"
        className="lp-pipe-row lp-pipe-row-btn"
        aria-expanded={expanded}
        aria-label={`${applicant.name}, ${applicant.subtitle}, ${badge.label}`}
        data-attr="applications-demo-row"
        onClick={onToggle}
      >
        <span className="lp-pipe-avatar" aria-hidden>
          {initials(applicant.name)}
        </span>
        <span className="lp-pipe-applicant">
          <span className="lp-pipe-name">
            {applicant.name}
            <span aria-hidden className={`lp-pipe-chev${expanded ? " lp-pipe-chev-open" : ""}`}>
              ›
            </span>
          </span>
          <span className="lp-pipe-meta">{applicant.subtitle}</span>
        </span>
        <span className={`lp-pipe-badge lp-pipe-badge-${badge.tone}`}>{badge.label}</span>
      </button>

      {expanded ? (
        <div className="lp-pipe-detail">
          {decided ? (
            <div className={`lp-pipe-decided lp-pipe-decided-${stage}`} role="status">
              <span aria-hidden className="lp-pipe-decided-mark">
                {stage === "approved" ? "✓" : "✕"}
              </span>
              {stage === "approved"
                ? "Approved · resident account created"
                : "Application rejected"}
            </div>
          ) : (
            <>
              <div className="lp-pipe-detail-actions">
                <button
                  type="button"
                  className={`lp-pipe-action lp-pipe-action-primary${
                    pressed === "approve" ? " lp-pipe-action-press" : ""
                  }`}
                  data-attr="applications-demo-approve"
                  onClick={onApprove}
                >
                  Approve
                </button>
                <button
                  type="button"
                  className="lp-pipe-action lp-pipe-action-ghost"
                  data-attr="applications-demo-reject"
                  onClick={onReject}
                >
                  Reject
                </button>
                <button
                  type="button"
                  className="lp-pipe-action lp-pipe-action-ghost"
                  data-attr="applications-demo-reminder"
                  onClick={onSendReminder}
                >
                  {reminderSent ? "Reminder sent" : "Send reminder"}
                </button>
              </div>
              <div className="lp-pipe-detail-screening">
                <span className="lp-pipe-detail-label">Screening</span>
                <span
                  className={`lp-pipe-chip lp-pipe-chip-${screening}`}
                  aria-live={screening === "running" ? "polite" : undefined}
                >
                  {screening === "running" ? <span aria-hidden className="lp-pipe-spin" /> : null}
                  {screeningChipLabel(screening)}
                </span>
                {screeningDone ? (
                  <span className="lp-pipe-detail-note" aria-hidden>
                    No records found
                  </span>
                ) : (
                  <button
                    type="button"
                    className={`lp-pipe-detail-link lp-pipe-detail-linkbtn${
                      pressed === "run" ? " lp-pipe-action-press" : ""
                    }`}
                    data-attr="applications-demo-run-screening"
                    onClick={onRunScreening}
                    disabled={screening === "running"}
                  >
                    {screening === "running" ? "Running" : "Run screening"}
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
