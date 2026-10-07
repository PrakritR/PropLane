/**
 * The home hero is scroll-driven (portal redesign, captain 2026-10-07): a sticky frame pins the headline while the
 * window grows with a transform, the track is always frame + run (no layout jump), and a phone or reduced motion
 * gets the static, full-size window. These are source guards on the three pieces that must keep agreeing.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");
const css = read("src/components/marketing/resident-lifecycle-hero.css");
const tsx = read("src/components/marketing/resident-lifecycle-prototypes.tsx");

describe("home hero grows on scroll", () => {
  it("pins the headline and window in a sticky frame inside a track that also holds the run", () => {
    expect(tsx).toMatch(/className="rlp-grow"/);
    expect(tsx).toMatch(/className="rlp-grow-frame"/);
    expect(tsx).toMatch(/className="rlp-grow-run"/);
    expect(css).toMatch(/\.rlp-grow-frame\s*\{[^}]*position:\s*sticky;[^}]*top:\s*var\(--rlp-hdr\)/);
    expect(css).toMatch(/\.rlp-grow-run\s*\{[^}]*height:/);
  });

  it("grows by transform only, from a smaller scale to 1, so nothing in the layout moves", () => {
    expect(tsx).toMatch(/GROW_FROM\s*=\s*0\.\d+/);
    expect(tsx).toMatch(/setProperty\("--rlp-grow"/);
    expect(css).toMatch(/\.rlp-hero-stage\s*\{[^}]*transform:\s*scale\(var\(--rlp-grow/);
    const stage = css.slice(css.indexOf(".rlp-story .rlp-hero-stage"), css.indexOf("}", css.indexOf(".rlp-story .rlp-hero-stage")));
    expect(stage).not.toMatch(/\b(width|height|margin|top|left):\s*calc\(var\(--rlp-grow/);
  });

  it("is static below md and under prefers-reduced-motion", () => {
    expect(css).toMatch(/@media \(max-width: 767px\)[\s\S]*\.rlp-grow-run\s*\{\s*display:\s*none/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.rlp-grow-frame\s*\{\s*position:\s*static/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.rlp-hero-stage\s*\{\s*transform:\s*none/);
    expect(tsx).toMatch(/STATIC_BELOW\s*=\s*768/);
    expect(tsx).toMatch(/reduced \|\| window\.innerWidth < STATIC_BELOW/);
  });

  it("keeps the phone beside the window while pinned, then lets it glide up to its resting top", () => {
    expect(tsx).toMatch(/setProperty\("--rlp-phone-top"/);
    expect(css).toMatch(/\.rlp-story-phone-slot\s*\{\s*top:\s*var\(--rlp-phone-top/);
  });
});
