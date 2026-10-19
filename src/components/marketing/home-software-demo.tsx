import { HomeSoftwareDemoPlayer } from "./home-software-demo-player";
import { DRAFT_REPLY, STORIES, type PhoneItem } from "./resident-lifecycle-script";
import { homeRentPaid } from "./home-dashboard-data";

/** Fixture derivation stays on the server; the player receives only its six small phone frames. */
export function HomeSoftwareDemo() {
  const tour = STORIES.resident.find((beat) => beat.id === "tour")!;
  const request = tour.messages[0].text;
  const initial: PhoneItem[] = [{ kind: "out", text: request }];
  const booked: PhoneItem[] = tour.messages.flatMap((message): PhoneItem[] => [
    { kind: message.kind, text: message.text },
    ...(message.card ? [{ kind: "card" as const, ...message.card }] : []),
  ]);
  const paid = homeRentPaid();
  const receipt: PhoneItem[] = [
    { kind: "out", text: "Paid!" },
    { kind: "card", icon: "card", eyebrow: "Payment received", title: paid.amount, sub: `${paid.chargeTitle} · Paid` },
  ];
  return <HomeSoftwareDemoPlayer request={request} draft={DRAFT_REPLY} phoneScenes={[initial, initial, initial, initial, booked, receipt]} />;
}
