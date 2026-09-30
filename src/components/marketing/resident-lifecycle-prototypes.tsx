"use client";

import "./resident-lifecycle-prototypes.css";
import { useEffect, useRef, useState } from "react";
import { ArrowRight, Check, RotateCcw } from "lucide-react";
import Link from "next/link";
import { AppStoreBadge } from "@/components/marketing/app-store-badge";
import { BOOK_DEMO_HREF, GET_STARTED_HREF } from "@/lib/marketing/public-contact";
import { ResidentLifecycleManager, type Chapter, type SampleMessage } from "./resident-lifecycle-manager";
import { ResidentLifecyclePhone } from "./resident-lifecycle-phone";
import { ResidentLifecycleAtmosphere } from "./resident-lifecycle-atmosphere";

const startingMessages: SampleMessage[] = [
  { from: "resident", text: "Is room 3 at 61 Willow Court still available?", stage: "message" },
];
const steps: { chapter: Chapter; target: string; instruction: string; activity: string[] }[] = [
  { chapter: "message", target: "suggest", instruction: "Prepare a reply", activity: ["Checking listing availability", "Reply ready for review"] },
  { chapter: "message", target: "send", instruction: "Send the reply", activity: ["Sending approved reply", "Tour time offered"] },
  { chapter: "tour", target: "accept-tour", instruction: "Jordan confirms this time", activity: ["Checking offered time", "Tour confirmed"] },
  { chapter: "application", target: "approve", instruction: "Approve Jordan’s application", activity: ["Manager approval recorded", "Lease ready for review"] },
  { chapter: "lease", target: "send-lease", instruction: "Send the lease", activity: ["Preparing signature handoff", "Resident review requested"] },
  { chapter: "lease", target: "open-lease", instruction: "Open Jordan’s lease", activity: ["Opening resident portal", "Lease ready to review"] },
  { chapter: "lease", target: "resident-sign", instruction: "Jordan signs after review", activity: ["Resident signature recorded", "Manager signature requested"] },
  { chapter: "lease", target: "manager-sign", instruction: "Countersign the lease", activity: ["Manager signature recorded", "Signed lease available"] },
  { chapter: "home", target: "service", instruction: "Send a service request", activity: ["Request submitted", "Manager service queue updated"] },
];

export function ResidentLifecyclePrototypes() {
  const [phase, setPhase] = useState(0);
  const [chapter, setChapter] = useState<Chapter>("message");
  const [messages, setMessages] = useState<SampleMessage[]>(startingMessages);
  const [tourAccepted, setTourAccepted] = useState(false);
  const [applicationApproved, setApplicationApproved] = useState(false);
  const [leaseStep, setLeaseStep] = useState<0 | 1 | 2 | 3>(0);
  const [serviceRecord, setServiceRecord] = useState<{ title: string; details: string } | null>(null);
  const [suggestedReply, setSuggestedReply] = useState(false);
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState<string[]>([]);
  const [guideHidden, setGuideHidden] = useState(false);
  const [guideEntered, setGuideEntered] = useState(false);
  const [viewVersion, setViewVersion] = useState(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const busyRef = useRef(false);
  const active = steps[phase];

  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  useEffect(() => {
    if (!active || guideHidden || busy || !guideEntered) return;
    const target = document.querySelector<HTMLElement>(`[data-guide-target="${active.target}"]`);
    if (!target) return;
    if (window.matchMedia("(max-width: 850px)").matches) {
      target.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "center" });
    }
  }, [phase, chapter, viewVersion, guideHidden, busy, active, guideEntered]);

  const advance = (target: string, action: () => void): boolean => {
    if (busyRef.current) return false;
    action();
    if (!active || active.target !== target) return true;
    setGuideEntered(true);
    const next = steps[phase + 1];
    busyRef.current = true;
    setBusy(true);
    setActivity((items) => [...items.slice(-2), active.activity[0]!]);
    timers.current.push(setTimeout(() => {
      setActivity((items) => [...items.slice(-2), active.activity[1]!]);
      timers.current.push(setTimeout(() => {
        if (next) setChapter(next.chapter);
        setPhase((current) => current + 1);
        busyRef.current = false;
        setBusy(false);
      }, 410));
    }, 520));
    return true;
  };
  const replay = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    busyRef.current = false;
    setPhase(0);
    setChapter("message");
    setMessages(startingMessages);
    setTourAccepted(false);
    setApplicationApproved(false);
    setLeaseStep(0);
    setServiceRecord(null);
    setSuggestedReply(false);
    setBusy(false);
    setActivity([]);
    setGuideHidden(false);
    setGuideEntered(false);
    setViewVersion((value) => value + 1);
  };
  const restartGuide = () => {
    replay();
    setGuideEntered(true);
  };
  const guideTarget = guideHidden || busy ? undefined : active?.target;
  const guideInstruction = guideHidden || busy ? undefined : active?.instruction;

  return <div className="rlp-page">
    <section className="rlp-hero" aria-labelledby="rlp-hero-title">
      <ResidentLifecycleAtmosphere />
      <div className="rlp-hero-copy">
        <h1 id="rlp-hero-title">From first question<br />to feeling at home.</h1>
        <div className="rlp-hero-actions">
          <Link href={GET_STARTED_HREF} data-attr="home-hero-get-started">Start free - no card</Link>
          <Link href={BOOK_DEMO_HREF} data-attr="home-hero-book-demo">Book a demo</Link>
          <AppStoreBadge tone="dark" size="lg" dataAttr="home-hero-app-store" className="rlp-app-store" />
        </div>
        <a href="#resident-lifecycle-walkthrough" className="rlp-follow-story" data-attr="resident-lifecycle-explore" onClick={(event) => {
          setGuideEntered(true);
          if (window.matchMedia("(max-width: 850px)").matches) {
            event.preventDefault();
            window.history.replaceState(null, "", "#resident-lifecycle-walkthrough");
            document.querySelector<HTMLElement>('[data-guide-target="suggest"]')?.scrollIntoView({
              behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
              block: "center",
            });
          }
        }}>Follow the story <ArrowRight aria-hidden /></a>
      </div>
    </section>
    <section id="resident-lifecycle-walkthrough" className="rlp-walkthrough" aria-labelledby="rlp-walkthrough-title">
      <div className="rlp-walkthrough-heading"><h2 id="rlp-walkthrough-title">One conversation. Every next step.</h2></div>
      <div className="rlp-guide-line" aria-live="polite">
        <div className="rlp-guide-copy">
          <span className="rlp-sample-tag">Sample demo</span>
          {active ? <strong>{guideHidden ? "Explore the sample at your pace" : busy ? activity.at(-1) : active.instruction}</strong> : <strong><Check aria-hidden /> Jordan’s request reached the manager</strong>}
        </div>
        <div className="rlp-guide-actions">
          {active && guideHidden ? <button type="button" onClick={restartGuide}>Restart guide</button> : null}
          {active && !guideHidden ? <button type="button" onClick={() => setGuideHidden(true)}>Explore freely</button> : null}
          {!active ? <button type="button" onClick={replay}><RotateCcw aria-hidden /> Replay</button> : null}
        </div>
      </div>
      <div className="rlp-dual-labels"><span>Manager workspace</span><span>Jordan’s phone</span></div>
      <div className="rlp-dual-view">
        <ResidentLifecycleManager
          key={`manager-${chapter}-${viewVersion}`}
          chapter={chapter} tourAccepted={tourAccepted} applicationApproved={applicationApproved}
          leaseStep={leaseStep} serviceRecord={serviceRecord} messages={messages}
          busy={busy}
          guideTarget={guideTarget} guideInstruction={guideInstruction} suggestedReply={suggestedReply}
          onSuggest={() => advance("suggest", () => setSuggestedReply(true))}
          onReply={(text) => advance("send", () => setMessages((items) => [...items, { from: "manager", text, stage: chapter }]))}
          onApprove={() => advance("approve", () => setApplicationApproved(true))}
          onSendLease={() => advance("send-lease", () => setLeaseStep(1))}
          onManagerSign={() => advance("manager-sign", () => setLeaseStep(3))}
          onChapter={setChapter}
          onExplore={() => setGuideHidden(true)}
        />
        <ResidentLifecyclePhone
          key={`phone-${chapter}-${viewVersion}`}
          stage={chapter} tourAccepted={tourAccepted} applicationApproved={applicationApproved}
          leaseStep={leaseStep} serviceCreated={Boolean(serviceRecord)} messages={messages}
          busy={busy}
          guideTarget={guideTarget} guideInstruction={guideInstruction}
          onAcceptTour={() => advance("accept-tour", () => {
            setTourAccepted(true);
            setMessages((items) => [...items,
              { from: "resident", text: "YES - Thursday at 5:30 PM works for me.", stage: "tour" },
              { from: "manager", text: "Your tour is confirmed for Thursday at 5:30 PM.", stage: "tour" },
            ]);
          })}
          onResidentSign={() => advance("resident-sign", () => setLeaseStep(2))}
          onOpenLease={() => advance("open-lease", () => {})}
          onCreateService={(title, details) => advance("service", () => setServiceRecord({ title, details }))}
          onReply={(text) => {
            setMessages((items) => [...items, { from: "resident", text, stage: chapter }]);
            return true;
          }}
        />
      </div>
      <div className="rlp-activity" aria-label="Sample activity" aria-live="polite">
        <span className="rlp-activity-label">ACTIVITY</span>
        {activity.length ? activity.map((item, index) => <span key={`${item}-${index}`} className={index === activity.length - 1 ? "rlp-activity-current" : ""}>{item}</span>) : <span>Jordan asks about Room 3</span>}
      </div>
    </section>
  </div>;
}
