import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import { LandingDashboardChatDemo } from "@/components/marketing/landing-dashboard-chat-demo";
import { LandingInboxApproveDemo } from "@/components/marketing/landing-inbox-approve-demo";
import { BOOK_DEMO_HREF, GET_STARTED_HREF } from "@/lib/marketing/public-contact";
import "./landing-proplane.css";

const GET_STARTED = GET_STARTED_HREF;

/** Dashboard+assistant demo, learn guides, ops banner, FAQ board, closing CTAs. */
export function LandingHomeSections() {
  return (
    <>
      {/* One element paints the blueprint grid for the whole flow band, so the
          square pitch never resets phase at a section boundary. */}
      <div className="lp-flow-band lp-blueprint">
        <LandingDashboardChatDemo />
        <LandingInboxApproveDemo />
        <LearnSection />
      </div>
      <OpsSkySection />
      <FaqSection />
      <section className="lp-end lp-end-cta-only" aria-label="Get started">
        <CtaPair
          primaryAttr="home-closing-get-started"
          secondaryAttr="home-closing-book-demo"
          primaryClass="lp-btn lp-btn-blue lp-lg"
          secondaryClass="lp-btn lp-btn-ghost lp-lg"
        />
      </section>
    </>
  );
}

function CtaPair({
  primaryAttr,
  secondaryAttr,
  primaryClass = "lp-btn lp-btn-blue",
  secondaryClass = "lp-btn lp-btn-ghost",
}: {
  primaryAttr: string;
  secondaryAttr: string;
  primaryClass?: string;
  secondaryClass?: string;
}) {
  return (
    <div className="lp-cta-row">
      <Link href={GET_STARTED} data-attr={primaryAttr} className={primaryClass}>
        Get started
      </Link>
      <Link href={BOOK_DEMO_HREF} data-attr={secondaryAttr} className={secondaryClass}>
        Book a demo
      </Link>
    </div>
  );
}

// Exported for unit coverage of the light/dark guide-art swap.
export function LearnSection() {
  return (
    <section id="learn" className="lp-learn scroll-mt-20">
      <div className="lp-w">
        <h2>Learn how to manage your house</h2>
        <p className="lp-lede">
          Short guides for automating messages and tours, then PropLane turns each step into tasks you
          approve.
        </p>
        <div className="lp-chapters">
          <article className="lp-chapter">
            <div className="lp-cap">
              <div className="lp-lab">Guide 01</div>
              <h3>How to automate messages</h3>
            </div>
            <div className="lp-art lp-art-messages">
              <Image
                src="/marketing/guide-messages.webp"
                alt="PropLane Communication → Schedule tab: automated rent, tour, and renewal messages queued on upcoming send dates"
                fill
                sizes="(max-width: 700px) 100vw, 460px"
                className="lp-art-img lp-art-img-light"
              />
              <Image
                src="/marketing/guide-messages-dark.webp"
                alt=""
                fill
                sizes="(max-width: 700px) 100vw, 460px"
                className="lp-art-img lp-art-img-dark"
              />
            </div>
          </article>
          <article className="lp-chapter">
            <div className="lp-cap">
              <div className="lp-lab">Guide 02</div>
              <h3>How to automate tours</h3>
            </div>
            <div className="lp-art lp-art-tours">
              <Image
                src="/marketing/guide-tours.webp"
                alt="PropLane Calendar availability week: open self-scheduling tour slots alongside tours prospects have already booked"
                fill
                sizes="(max-width: 700px) 100vw, 460px"
                className="lp-art-img lp-art-img-light"
              />
              <Image
                src="/marketing/guide-tours-dark.webp"
                alt=""
                fill
                sizes="(max-width: 700px) 100vw, 460px"
                className="lp-art-img lp-art-img-dark"
              />
            </div>
          </article>
          <div className="lp-frost">
            <div className="lp-bar">
              <Link href="/why-proplane" data-attr="home-learn-guide" className="lp-pill-cta">
                See automation in PropLane <span className="lp-ico">→</span>
              </Link>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function OpsSkySection() {
  return (
    <section className="lp-ops-sky">
      <div className="lp-deco" aria-hidden>
        <div className="lp-pins">
          <span className="lp-p1" />
          <span className="lp-p2" />
          <span className="lp-p3" />
          <span className="lp-p4" />
        </div>
      </div>
      <h2>All the tools your portfolio needs</h2>
      <div className="lp-controls">
        <div className="lp-pt">You approve every outbound action</div>
        <div className="lp-pt lp-on">Rent, leases &amp; work orders run in the background</div>
        <div className="lp-pt">Customize per building and vendor</div>
      </div>
      <div className="lp-task-float">
        <TaskFloatRow status="review" label="Manager review" title="Lease · Cascade 4B" agent="Leases" />
        <TaskFloatRow status="run" label="Running" title="Rent reminder · April overdue" agent="Payments" />
        <TaskFloatRow status="done" label="Completed" title="Service #142 · bids collected" agent="Services" />
      </div>
    </section>
  );
}

function TaskFloatRow({
  status,
  label,
  title,
  agent,
}: {
  status: "review" | "run" | "done";
  label: string;
  title: string;
  agent: string;
}) {
  return (
    <div className="lp-row">
      <span className={`lp-status lp-${status}`}>{label}</span>
      <div className="lp-meta">
        <div className="lp-title">{title}</div>
      </div>
      <span className="lp-agent">{agent}</span>
    </div>
  );
}

/** The questions a prospect actually asks before signing up. Every answer is
 *  grounded in what the product ships — plans + trial (`manager-plan-tiers.ts`,
 *  `manager-signup-trial.ts`), the approval-first assistant (`docs/ai-assistant.md`),
 *  resident setup-link onboarding (`api/auth/resident-setup`), and the iOS shell
 *  (`docs/mobile-app.md`). Keep it that way: an FAQ reads as a promise, so don't
 *  add a claim the code can't back. */
const FAQ_NOTES: { q: string; a: ReactNode }[] = [
  {
    q: "What is PropLane?",
    a: "One place to run your rentals: list a unit, take applications, book tours, sign leases, collect rent, and handle repairs and messages. Managers, residents, and your repair vendors each get their own sign-in.",
  },
  {
    q: "What does the AI actually do?",
    a: "It reads your live numbers and answers questions, and it can draft things like a rent reminder or a message. It never sends a message, charges a card, or signs a lease on its own — it shows you exactly what it wrote, and those actions only go out once you approve.",
  },
  {
    q: "Is there a free plan?",
    a: "Yes. Free is $0 and needs no card. You get one property listing, applications and tour scheduling, and rent collection. Residents, leases, repairs, and the inbox come with a paid plan.",
  },
  {
    q: "How much does it cost?",
    a: "Free is $0. Pro is $20 a month (up to 2 properties, plus residents, leases, and the inbox). Business is $200 a month (up to 20 properties and priority support). Paying for a year saves about 20%.",
  },
  {
    q: "Do I need a credit card to try it?",
    a: "No. Paid plans start with a 14-day trial and no card — you only add payment if you decide to keep it.",
  },
  {
    q: "How do my residents get in?",
    a: "You don't hand out passwords. When someone applies, PropLane emails them a one-time link — tied to the same email they applied with — to set up their own account. Once you approve them, they can pay rent, sign leases, and message you.",
  },
  {
    q: "Can I use it on my phone?",
    a: (
      <>
        Yes. PropLane opens in any web browser on a computer, tablet, or phone — no download needed. There is also a{" "}
        <Link href="/app" className="font-semibold text-[var(--lp-brand)] hover:underline">
          mobile app
        </Link>{" "}
        with the same portals, push notifications, and camera uploads.
      </>
    ),
  },
];

/** FAQ as a board of sticky notes (post-it look), before the closing CTA. */
function FaqSection() {
  return (
    <section className="lp-faq" aria-labelledby="lp-faq-heading">
      <div className="lp-w">
        <h2 id="lp-faq-heading">Questions, answered</h2>
        <p className="lp-lede">
          The things people ask us before signing up — plain answers, no fine print.
        </p>
        <dl className="lp-faq-board">
          {FAQ_NOTES.map((item) => (
            <div className="lp-note" key={item.q}>
              <dt className="lp-note-q">{item.q}</dt>
              <dd className="lp-note-a">{item.a}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
