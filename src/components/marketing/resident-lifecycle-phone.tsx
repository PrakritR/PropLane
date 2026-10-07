"use client";

import "./resident-lifecycle-phone.css";
import { useState, type FormEvent } from "react";
import {
  ArrowLeft,
  BatteryFull,
  CalendarDays,
  Check,
  ChevronRight,
  CreditCard,
  FileText,
  Plus,
  Send,
  Signal,
  Video,
  Wifi,
  Wrench,
} from "lucide-react";
import type { PhoneIcon, PhoneScript } from "./resident-lifecycle-script";

type Stage = "message" | "tour" | "application" | "lease" | "home";
type Props = {
  stage: Stage;
  tourAccepted: boolean;
  applicationApproved: boolean;
  leaseStep: 0 | 1 | 2 | 3;
  serviceCreated: boolean;
  messages: { from: "manager" | "resident"; text: string; stage: Stage }[];
  guideTarget?: string;
  guideInstruction?: string;
  busy: boolean;
  /** A scripted thread for the resident and vendor portals; replaces the manager-story stages. */
  script?: PhoneScript;
  onAcceptTour: () => boolean;
  onOpenLease: () => boolean;
  onResidentSign: () => boolean;
  onCreateService: (title: string, details: string) => boolean;
  onReply: (text: string) => boolean;
};

const leaseStatus = [
  "Manager review",
  "Resident signature pending",
  "Manager signature pending",
  "Signed",
] as const;
const serviceDetails = "The water is collecting under the cabinet.";
const cardIcons: Record<PhoneIcon, React.ReactNode> = {
  file: <FileText aria-hidden />,
  calendar: <CalendarDays aria-hidden />,
  wrench: <Wrench aria-hidden />,
  card: <CreditCard aria-hidden />,
};
const stageOrder: Stage[] = ["message", "tour", "application", "lease", "home"];

export function ResidentLifecyclePhone({
  stage,
  tourAccepted,
  applicationApproved,
  leaseStep,
  serviceCreated,
  messages,
  guideTarget,
  guideInstruction,
  busy,
  script,
  onAcceptTour,
  onOpenLease,
  onResidentSign,
  onCreateService,
  onReply,
}: Props) {
  const [reply, setReply] = useState("");
  const [signingOpen, setSigningOpen] = useState(
    () => leaseStep === 1 && guideTarget === "resident-sign",
  );
  const [localReplies, setLocalReplies] = useState<string[]>([]);
  const stageIndex = stageOrder.indexOf(stage);
  const earlierMessages = messages.filter(
    (message) => stageOrder.indexOf(message.stage) < stageIndex,
  );
  const chapterMessages = messages.filter((message) => message.stage === stage);
  const renderMessages = (items: typeof messages) =>
    items.map((message, index) => (
      <div
        key={`${message.stage}-${index}-${message.text}`}
        className={`rl-phone-message ${message.from === "resident" ? "rl-phone-outgoing" : "rl-phone-incoming"}`}
      >
        <span>{message.text}</span>
      </div>
    ));

  function sendReply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = reply.trim();
    if (!text) return;
    if (script) {
      setLocalReplies((items) => [...items, text]);
      setReply("");
      return;
    }
    if (onReply(text)) setReply("");
  }

  return (
    <section
      className="rl-phone-wrap"
      aria-label={`${script?.caption ?? "Jordan’s phone"} Messages conversation`}
    >
      <div className="rl-phone-caption">
        <span className="rl-phone-caption-dot" />
        {script?.caption ?? "Jordan’s phone"}
      </div>
      <div className="rl-phone-device">
        <div className="rl-phone-screen">
          <div className="rl-phone-status">
            <strong>9:41</strong>
            <div className="rl-phone-island" aria-hidden="true" />
            <span className="rl-phone-status-icons">
              <Signal aria-hidden />
              <Wifi aria-hidden />
              <BatteryFull aria-hidden />
            </span>
          </div>
          <header className="rl-phone-header">
            <button
              type="button"
              className="rl-phone-header-back"
              aria-label="Back to conversations"
            >
              <ArrowLeft aria-hidden />
              <span>2</span>
            </button>
            <div className="rl-phone-contact">
              <span className="rl-phone-contact-avatar">{script?.initials ?? "AM"}</span>
              <strong>{script?.name ?? "Avery Morgan"}</strong>
              <small>{script?.sub ?? "Willow Court"}</small>
            </div>
            <button
              type="button"
              className="rl-phone-video"
              aria-label="Video call"
            >
              <Video aria-hidden />
            </button>
          </header>
          <div
            className="rl-phone-thread"
            aria-label={`Conversation with ${script?.name ?? "Avery Morgan"}`}
          >
            {script ? (
              <>
                {script.items.map((item, index) =>
                  item.kind === "time" ? (
                    <div key={index} className="rl-phone-time">{item.text}</div>
                  ) : item.kind === "card" ? (
                    <div key={index} className="rl-phone-rich-card">
                      <div className="rl-phone-rich-icon">{cardIcons[item.icon]}</div>
                      <div>
                        <small>{item.eyebrow}</small>
                        <strong>{item.title}</strong>
                        <span>{item.sub}</span>
                      </div>
                    </div>
                  ) : (
                    <div
                      key={index}
                      className={`rl-phone-message ${item.kind === "out" ? "rl-phone-outgoing" : "rl-phone-incoming"}`}
                    >
                      <span>{item.text}</span>
                    </div>
                  ),
                )}
                {localReplies.map((text, index) => (
                  <div key={`local-${index}`} className="rl-phone-message rl-phone-outgoing">
                    <span>{text}</span>
                  </div>
                ))}
              </>
            ) : null}
            {!script ? <div className="rl-phone-time">Today&nbsp; 10:12 AM</div> : null}
            {!script ? renderMessages(earlierMessages) : null}
            {!script && stage === "tour" ? (
              <>
                <div className="rl-phone-time">Tour invitation</div>
                <div className="rl-phone-message rl-phone-incoming">
                  <span>
                    Thursday at 5:30 PM Pacific is offered for Room 3. Reply YES
                    to confirm that exact time.
                  </span>
                </div>
                <div className="rl-phone-rich-card">
                  <div className="rl-phone-rich-icon">
                    <CalendarDays aria-hidden />
                  </div>
                  <div>
                    <small>TOUR · 61 WILLOW COURT</small>
                    <strong>Thursday, 5:30 PM Pacific</strong>
                    <span>Room 3 · Oakland, CA</span>
                  </div>
                </div>
                {!tourAccepted ? (
                  <button
                    type="button"
                    className="rl-phone-inline-action"
                    data-guide-target="accept-tour"
                    data-guide-active={guideTarget === "accept-tour" ? "true" : undefined}
                    data-guide-label={guideTarget === "accept-tour" ? guideInstruction : undefined}
                    disabled={busy}
                    onClick={onAcceptTour}
                  >
                    Reply YES to accept <ChevronRight aria-hidden />
                  </button>
                ) : null}
              </>
            ) : null}
            {!script && stage === "application" ? (
              <>
                <div className="rl-phone-time">Application</div>
                <div className="rl-phone-message rl-phone-incoming">
                  <span>
                    {applicationApproved
                      ? "Avery approved your application for Room 3 at 61 Willow Court."
                      : "Your application for Room 3 at 61 Willow Court is in review."}
                  </span>
                </div>
                <button
                  type="button"
                  className="rl-phone-rich-card rl-phone-rich-button"
                  aria-label="Application details"
                >
                  <div className="rl-phone-rich-icon">
                    <FileText aria-hidden />
                  </div>
                  <div>
                    <small>61 WILLOW COURT · ROOM 3</small>
                    <strong>Rental application</strong>
                    <span>
                      {applicationApproved
                        ? "Approved"
                        : "Submitted · In review"}
                    </span>
                  </div>
                  <ChevronRight aria-hidden />
                </button>
              </>
            ) : null}
            {!script && stage === "lease" ? (
              <>
                <div className="rl-phone-time">Lease</div>
                <div className="rl-phone-message rl-phone-incoming">
                  <span>
                    {leaseStep === 0
                      ? "Your lease is with Avery for review."
                      : leaseStep === 1
                        ? "Your lease is ready to review in your resident portal."
                        : leaseStep === 2
                          ? "Your signature is recorded. Avery’s signature is next."
                          : "Your lease has been signed by both parties."}
                  </span>
                </div>
                <button
                  type="button"
                  className="rl-phone-rich-card rl-phone-rich-button"
                  aria-label="Open lease details"
                  data-guide-target="open-lease"
                  data-guide-active={guideTarget === "open-lease" ? "true" : undefined}
                  data-guide-label={guideTarget === "open-lease" ? guideInstruction : undefined}
                  disabled={busy}
                  onClick={() => {
                    if (onOpenLease()) setSigningOpen(true);
                  }}
                >
                  <div className="rl-phone-rich-icon">
                    <FileText aria-hidden />
                  </div>
                  <div>
                    <small>RESIDENT PORTAL · 61 WILLOW COURT</small>
                    <strong>Residential lease</strong>
                    <span>{leaseStatus[leaseStep]}</span>
                  </div>
                  <ChevronRight aria-hidden />
                </button>
                {signingOpen && leaseStep === 1 ? (
                  <div className="rl-phone-signing-preview">
                    <small>RESIDENT PORTAL · LEASE REVIEW</small>
                    <strong>61 Willow Court · Room 3</strong>
                    <span>Oct 1 – Sep 30 · $1,080 / month</span>
                    <button type="button"
                      data-guide-target="resident-sign"
                      data-guide-active={guideTarget === "resident-sign" ? "true" : undefined}
                      data-guide-label={guideTarget === "resident-sign" ? guideInstruction : undefined}
                      disabled={busy}
                      onClick={() => { if (onResidentSign()) setSigningOpen(false); }}>
                      Sign sample lease <Check aria-hidden />
                    </button>
                  </div>
                ) : null}
              </>
            ) : null}
            {!script && stage === "home" ? (
              <>
                <div className="rl-phone-time">After move-in</div>
                <div className="rl-phone-message rl-phone-incoming">
                  <span>
                    Welcome home, Jordan. Your signed lease and October rent of
                    $1,080 are in your resident portal.
                  </span>
                </div>
                <div className="rl-phone-message rl-phone-outgoing">
                  <span>
                    The kitchen faucet is dripping. Water is collecting under
                    the cabinet.
                  </span>
                </div>
                {serviceCreated ? (
                  <div className="rl-phone-message rl-phone-incoming">
                    <span>
                      Your kitchen faucet service request is in the manager’s
                      queue.
                    </span>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="rl-phone-service-action"
                    data-guide-target="service"
                    data-guide-active={guideTarget === "service" ? "true" : undefined}
                    data-guide-label={guideTarget === "service" ? guideInstruction : undefined}
                    disabled={busy}
                    onClick={() =>
                      onCreateService("Kitchen faucet", serviceDetails)
                    }
                  >
                    <Wrench aria-hidden />
                    <span>Send service request</span>
                    <ChevronRight aria-hidden />
                  </button>
                )}
              </>
            ) : null}
            {!script ? renderMessages(chapterMessages) : null}
            {!script && stage === "tour" && tourAccepted ? (
              <div className="rl-phone-confirmed">
                <Check aria-hidden />
                Tour confirmed
              </div>
            ) : null}
          </div>
          <form className="rl-phone-composer" onSubmit={sendReply}>
            <button
              type="button"
              className="rl-phone-add"
              aria-label="Add attachment"
            >
              <Plus aria-hidden />
            </button>
            <input
              aria-label="Write a reply"
              placeholder="Text Message"
              value={reply}
              onChange={(event) => setReply(event.target.value)}
            />
            <button
              type="submit"
              className="rl-phone-send"
              aria-label="Send sample reply"
              disabled={!reply.trim()}
            >
              <Send aria-hidden />
            </button>
          </form>
          <div className="rl-phone-bottom" aria-hidden="true">
            <span />
          </div>
        </div>
      </div>
    </section>
  );
}
