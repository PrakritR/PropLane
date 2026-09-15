import {
  MockButton,
  MockChip,
  MockFrame,
  MockRow,
  SiteCtaPair,
  SiteEyebrow,
  SiteIntro,
  SiteSection,
} from "@/components/marketing/site/primitives";
import { cn } from "@/lib/utils";

type SwitchStep = { eyebrow: string; title: string; body: string };

const STEPS: SwitchStep[] = [
  {
    eyebrow: "Step 1",
    title: "Import your portfolio",
    body: "Upload a spreadsheet or an export from AppFolio or Buildium. Properties, units and residents come in together, in the right order.",
  },
  {
    eyebrow: "Step 2",
    title: "Invite your residents",
    body: "Residents get their own portal for paying rent, submitting requests and asking the property assistant questions.",
  },
  {
    eyebrow: "Step 3",
    title: "Collect rent in PropLane",
    body: "Payments land in your dashboard as they come in, and anything paid outside PropLane can be recorded too.",
  },
];

const WIZARD_STEPS = ["1 Upload", "2 Match columns", "3 Review", "4 Import", "5 Invite"];
const CURRENT_WIZARD_STEP = "3 Review";

const SUMMARY = [
  { value: "2", label: "properties" },
  { value: "7", label: "units" },
  { value: "6", label: "residents" },
];

/** How switching to PropLane works: import, invite, collect — told as three steps beside the import screen itself. */
export function SiteSwitchSteps() {
  return (
    <SiteSection tone="muted" ariaLabelledBy="site-switch-heading">
      <SiteIntro
        eyebrow="Switching"
        id="site-switch-heading"
        title="Up and running without starting over."
        lede="Your properties, units and residents come with you. Here's what switching to PropLane looks like."
      />
      <div className="grid grid-cols-[minmax(0,1fr)] gap-10 lg:grid-cols-2 lg:items-start">
        <div className="min-w-0">
          <div className="space-y-8">
            {STEPS.map((step) => (
              <div key={step.title} className="border-t border-border pt-5">
                <SiteEyebrow className="mb-2">{step.eyebrow}</SiteEyebrow>
                <h3 className="text-[19px] font-bold leading-snug tracking-tight text-foreground">{step.title}</h3>
                <p className="mt-2 text-[14.5px] leading-relaxed text-muted">{step.body}</p>
              </div>
            ))}
          </div>
          <SiteCtaPair primaryAttr="home-switch-get-started" secondaryAttr="home-switch-book-demo" className="mt-8" />
        </div>
        <div className="mx-auto w-full min-w-0 max-w-[540px] lg:mr-0">
          <MockFrame title="Manager · Import your portfolio">
            <div className="flex flex-wrap gap-1.5">
              {WIZARD_STEPS.map((step) => {
                const current = step === CURRENT_WIZARD_STEP;
                return (
                  <span
                    key={step}
                    className={cn(
                      "inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-bold",
                      current ? "border-primary bg-primary/10 text-primary" : "border-border text-muted",
                    )}
                  >
                    {step}
                  </span>
                );
              })}
            </div>
            <div className="mt-4 grid grid-cols-3 gap-2">
              {SUMMARY.map((cell) => (
                <div key={cell.label} className="rounded-xl border border-border px-3 py-2.5 text-center">
                  <span className="block text-[20px] font-bold leading-none text-foreground">{cell.value}</span>
                  <span className="block text-[11px] text-muted">{cell.label}</span>
                </div>
              ))}
            </div>
            <div className="mt-4 divide-y divide-border/60">
              <MockRow
                name="Maple Court"
                title="Maple Court"
                sub="220 Maple Ave · 4 units · 3 occupied"
                right={<MockChip tone="good">Ready</MockChip>}
              />
              <MockRow
                name="1412 Pine St"
                title="1412 Pine St"
                sub="3 rooms · 2 occupied"
                right={<MockChip tone="good">Ready</MockChip>}
              />
              <MockRow
                name="Luis Ortega"
                title="Luis Ortega · Room 3"
                sub="No email — add one to invite"
                right={<MockChip tone="warn">Check</MockChip>}
              />
            </div>
            <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
              <MockButton primary>Import 2 properties, 6 residents</MockButton>
              <span className="text-[12px] text-muted">Nothing is emailed until you say so</span>
            </div>
          </MockFrame>
        </div>
      </div>
    </SiteSection>
  );
}
