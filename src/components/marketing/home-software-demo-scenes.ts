export const SOFTWARE_DEMO_SCENES = [
  { id: "text", label: "Text arrives", title: "It starts with a text." },
  { id: "inbox", label: "Manager inbox", title: "Right into your inbox." },
  { id: "draft", label: "Draft reply", title: "PropLane drafts the reply." },
  { id: "approve", label: "Approve reply", title: "You give the go-ahead." },
  { id: "tour", label: "Tour booked", title: "The tour is on the calendar." },
  { id: "paid", label: "Rent paid", title: "Later, the rent arrives." },
] as const;
export type SoftwareDemoScene = (typeof SOFTWARE_DEMO_SCENES)[number]["id"];
export const SOFTWARE_DEMO_SCENE_MS = 5000;
