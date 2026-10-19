import type { Metadata } from "next";
import { HomeDemoEmbed } from "@/components/demo/home-demo-embed";

/**
 * The homepage Software demo's iframe: the REAL manager portal shell over fixture data
 * (`buildHomeDemoSnapshot`), no marketing chrome, never indexed. Reached only from the homepage
 * (same origin); every other `/demo` URL still redirects home. See docs/agents/demo-sandbox.md.
 */
export const metadata: Metadata = {
  title: "PropLane sample portal",
  robots: { index: false, follow: false },
};

export default function HomeEmbedPage() {
  return <HomeDemoEmbed />;
}
