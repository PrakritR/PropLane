// PropLane portal DOM audit probe — the single source of the mechanical checks.
//
// Loaded three ways, all reading THIS file so a rule can never drift between them:
//   qa-portal-dom-sweep.mjs : context.addInitScript({ content }) then page.evaluate(() => __tmProbe())
//   Playwright MCP          : browser_evaluate with this file's contents, then __tmProbe()
//   browser-use             : evaluate(open("scripts/qa-portal-dom-probe.js").read()) then evaluate("__tmProbe()")
//
// It reports MEASUREMENTS, never opinions: every finding names the element and the
// numbers behind it so the ticket can carry evidence instead of a hunch. Checks that
// cannot be measured reliably are marked `suspected` and must be confirmed by hand
// before they are filed (see SKILL.md, "A finding you cannot demonstrate").
//
// Every check is individually try/caught: one throw on one page must not cost the
// whole route's audit, which is the difference between an overnight sweep that
// reports 22 routes and one that reports 3.
(() => {
  const SELECTOR_MAX = 120;

  function describe(el) {
    if (!el || el === document.documentElement) return "html";
    if (el === document.body) return "body";
    const id = el.id ? `#${el.id}` : "";
    const cls = typeof el.className === "string" && el.className.trim()
      ? "." + el.className.trim().split(/\s+/).slice(0, 3).join(".")
      : "";
    const data = el.getAttribute?.("data-attr") ? `[data-attr="${el.getAttribute("data-attr")}"]` : "";
    return `${el.tagName.toLowerCase()}${id}${cls}${data}`.slice(0, SELECTOR_MAX);
  }

  function path(el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 4 && node !== document.body) {
      parts.unshift(describe(node));
      node = node.parentElement;
    }
    return parts.join(" > ");
  }

  function text(el) {
    return (el?.innerText || el?.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80);
  }

  // The Next dev overlay (`nextjs-portal`, its error toasts and route indicator)
  // is not the product. It re-mounts on every navigation, so dismissing it once
  // before a sweep does not hold, and left in it reports itself as the thing
  // covering every control on the page.
  function isDevChrome(el) {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const tag = n.tagName.toLowerCase();
      if (tag === "nextjs-portal" || tag.startsWith("nextjs-")) return true;
      if (n.id && /^(nextjs|__next-build-watcher|__next-dev)/.test(n.id)) return true;
    }
    return false;
  }

  function visible(el) {
    if (isDevChrome(el)) return false;
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  // Accessible name, close enough for duplicate detection: aria-label, then
  // aria-labelledby, then trimmed text, then title/alt.
  function accName(el) {
    const aria = el.getAttribute("aria-label");
    if (aria) return aria.trim();
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const target = document.getElementById(by.split(/\s+/)[0]);
      if (target) return text(target);
    }
    const t = text(el);
    if (t) return t;
    return (el.getAttribute("title") || el.querySelector?.("img")?.getAttribute("alt") || "").trim();
  }

  const INTERACTIVE = 'a[href], button, [role="button"], [role="tab"], [role="link"], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])';

  function scrolls(el) {
    const s = getComputedStyle(el);
    return /(auto|scroll|overlay)/.test(s.overflowY) || /(auto|scroll|overlay)/.test(s.overflowX);
  }

  function clips(el) {
    const s = getComputedStyle(el);
    return /(hidden|clip)/.test(s.overflowY) || /(hidden|clip)/.test(s.overflowX);
  }

  function run(name, fn) {
    try {
      return fn() || [];
    } catch (err) {
      return [{
        check: name,
        severity: "info",
        suspected: true,
        summary: `probe check "${name}" threw: ${String(err && err.message ? err.message : err)}`,
      }];
    }
  }

  globalThis.__tmProbe = function __tmProbe() {
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const findings = [];
    const all = Array.from(document.querySelectorAll("body *")).filter((el) => {
      try { return visible(el); } catch { return false; }
    });

    // 1. The page itself scrolls sideways. AGENTS.md: "the page body must never
    //    scroll horizontally" — wide content scrolls inside its own container.
    findings.push(...run("page-overflow-x", () => {
      const doc = document.documentElement;
      const over = doc.scrollWidth - doc.clientWidth;
      if (over <= 2) return [];
      const culprits = all
        .filter((el) => {
          const s = getComputedStyle(el);
          if (s.position === "fixed") return false;
          const r = el.getBoundingClientRect();
          return r.width > 8 && r.right > doc.clientWidth + 2;
        })
        .sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)
        .slice(0, 5)
        .map((el) => ({ el: path(el), right: Math.round(el.getBoundingClientRect().right), text: text(el) }));
      return [{
        check: "page-overflow-x",
        severity: "high",
        summary: `Page scrolls horizontally by ${over}px at ${vw}px wide`,
        detail: { overflowPx: over, viewport: vw, culprits },
      }];
    }));

    // 2. Content clipped with no way to scroll to it. The documented PropLane
    //    failure: a broken flex-1/min-h-0 chain under a clipping surface makes
    //    overflow UNREACHABLE rather than scrollable.
    findings.push(...run("unreachable-overflow", () => {
      const out = [];
      for (const el of all) {
        const hiddenY = el.scrollHeight - el.clientHeight;
        const hiddenX = el.scrollWidth - el.clientWidth;
        if (hiddenY <= 12 && hiddenX <= 12) continue;
        if (!clips(el) || scrolls(el)) continue;
        // An ancestor that scrolls can still reveal it.
        let anc = el.parentElement, reachable = false;
        while (anc && anc !== document.documentElement) {
          if (scrolls(anc) && anc.scrollHeight - anc.clientHeight > 8) { reachable = true; break; }
          anc = anc.parentElement;
        }
        if (reachable) continue;
        const r = el.getBoundingClientRect();
        if (r.height < 40 && r.width < 40) continue; // chips/badges truncate on purpose
        // A single line of text truncated WITH an ellipsis is the intended design
        // (`.truncate`), not content the reader cannot reach. Only a clip that
        // hides content silently counts.
        const st = getComputedStyle(el);
        if (hiddenX > 0 && hiddenY <= 12 && (st.textOverflow === "ellipsis" || st.whiteSpace === "nowrap") && r.height < 40) continue;
        out.push({
          check: "unreachable-overflow",
          severity: hiddenY > 60 || hiddenX > 60 ? "high" : "medium",
          summary: `${Math.max(hiddenY, hiddenX)}px of content is clipped with nothing to scroll it`,
          detail: { el: path(el), hiddenY, hiddenX, rect: { w: Math.round(r.width), h: Math.round(r.height) }, text: text(el) },
        });
      }
      return out.slice(0, 6);
    }));

    // 3. A fixed/sticky layer sits on top of something you are meant to click.
    //    This is how the floating bulk bar and the phone tab bar collide.
    findings.push(...run("obscured-control", () => {
      const out = [];
      for (const el of Array.from(document.querySelectorAll(INTERACTIVE))) {
        if (!visible(el)) continue;
        const r = el.getBoundingClientRect();
        // A visually-hidden input (the sr-only file/checkbox behind a styled label)
        // is SUPPOSED to sit under its own chrome — the label is what you click.
        // Reporting it says every well-built custom control is broken.
        if (r.width <= 4 || r.height <= 4) continue;
        if (el.className && typeof el.className === "string" && /\bsr-only\b|\bvisually-hidden\b/.test(el.className)) continue;
        if (r.top < 0 || r.bottom > vh || r.left < 0 || r.right > vw) continue;
        const cx = Math.round(r.left + r.width / 2);
        const cy = Math.round(r.top + r.height / 2);
        const hit = document.elementFromPoint(cx, cy);
        if (!hit || hit === el || el.contains(hit) || hit.contains(el)) continue;
        if (isDevChrome(hit)) continue;
        const s = getComputedStyle(hit);
        const blockerFixed = (function () {
          let n = hit;
          while (n && n !== document.body) {
            const ps = getComputedStyle(n).position;
            if (ps === "fixed" || ps === "sticky") return n;
            n = n.parentElement;
          }
          return null;
        })();
        if (!blockerFixed && s.pointerEvents === "none") continue;
        // A fixed bar is not "covering" its OWN links. elementFromPoint lands on an
        // inner wrapper of the bar, which neither contains nor is contained by the
        // link, so the naive check missed it and every bottom-nav item reported
        // itself as unreachable — 119 findings that were all one false rule.
        if (blockerFixed && blockerFixed.contains(el)) continue;
        // Same shape one level out: if the control's own nearest fixed/sticky
        // ancestor IS the blocker, they travel together and never collide.
        const elFixedAncestor = (function () {
          let n = el.parentElement;
          while (n && n !== document.body) {
            const ps = getComputedStyle(n).position;
            if (ps === "fixed" || ps === "sticky") return n;
            n = n.parentElement;
          }
          return null;
        })();
        if (blockerFixed && elFixedAncestor === blockerFixed) continue;
        out.push({
          check: "obscured-control",
          severity: blockerFixed ? "high" : "medium",
          suspected: !blockerFixed,
          summary: `"${accName(el) || describe(el)}" is covered by ${describe(blockerFixed || hit)} and cannot be clicked`,
          detail: { el: path(el), blocker: path(blockerFixed || hit), point: { x: cx, y: cy } },
        });
      }
      return out.slice(0, 6);
    }));

    // 4. The same control drawn twice — the shipped "two overlapping Apply to
    //    property buttons" shape from a band+row layout mixing both patterns.
    findings.push(...run("duplicate-control", () => {
      const seen = new Map();
      for (const el of Array.from(document.querySelectorAll('button, a[href], [role="button"]'))) {
        if (!visible(el)) continue;
        // Repeated controls inside repeated rows are the LIST, not a duplicated
        // header action. The row markup here is divs with a `*-row` class rather
        // than <li>/<tr>, so a tag-only exclusion let one list report its own 15
        // rows as 15 duplicate controls.
        if (el.closest('li, tr, [role="row"], [role="listitem"], [data-portal-record-row], [class*="-row"], [class*="-card"], [class*="row-"]')) continue;
        const name = accName(el);
        if (!name || name.length < 3) continue;
        const key = name.toLowerCase();
        if (!seen.has(key)) seen.set(key, []);
        seen.get(key).push(el);
      }
      const out = [];
      for (const [name, els] of seen) {
        if (els.length < 2) continue;
        if (els.some((a, i) => els.some((b, j) => i !== j && (a.contains(b) || b.contains(a))))) continue;
        out.push({
          check: "duplicate-control",
          severity: "medium",
          suspected: true,
          summary: `"${name}" renders ${els.length}× at ${vw}px — confirm it is not the band+row duplicate`,
          detail: { els: els.slice(0, 3).map(path) },
        });
      }
      return out.slice(0, 5);
    }));

    // 5. Identical unlabelled repeated buttons — AGENTS.md: every ADD footer must
    //    carry an ariaLabel or a screen reader hears a page of identical buttons.
    findings.push(...run("ambiguous-repeated-button", () => {
      const bare = Array.from(document.querySelectorAll("button, [role='button']"))
        .filter((el) => visible(el) && !el.getAttribute("aria-label") && /^add$/i.test(text(el)));
      if (bare.length < 2) return [];
      return [{
        check: "ambiguous-repeated-button",
        severity: "low",
        summary: `${bare.length} unlabelled "ADD" buttons on one page — each needs its own ariaLabel`,
        detail: { els: bare.slice(0, 4).map(path) },
      }];
    }));

    // 6. Tap targets too small to hit on a phone.
    findings.push(...run("tiny-tap-target", () => {
      if (vw > 500) return [];
      const out = [];
      for (const el of Array.from(document.querySelectorAll(INTERACTIVE))) {
        if (!visible(el)) continue;
        const r = el.getBoundingClientRect();
        // BOTH dimensions must be short. A 57×23 chart tick is not a mis-sized tap
        // target, and reporting every one of them buries the genuine 12×12 icon
        // button. A 1px box is the visually-hidden skip link, which is the correct
        // pattern rather than a defect.
        if (r.width >= 24 || r.height >= 24) continue;
        if (r.width <= 2 || r.height <= 2) continue;
        if (r.bottom < 0 || r.top > vh) continue;
        out.push({
          check: "tiny-tap-target",
          severity: "low",
          summary: `"${accName(el) || describe(el)}" is ${Math.round(r.width)}×${Math.round(r.height)}px — under the 24px minimum`,
          detail: { el: path(el) },
        });
      }
      return out.slice(0, 5);
    }));

    // 7. Content pushed off the left edge (a negative-margin or RTL slip).
    findings.push(...run("offscreen-left", () => {
      const out = [];
      for (const el of all) {
        const s = getComputedStyle(el);
        if (s.position === "fixed" || s.position === "absolute") continue;
        const r = el.getBoundingClientRect();
        if (r.left >= -4 || r.width < 40) continue;
        out.push({
          check: "offscreen-left",
          severity: "medium",
          summary: `${describe(el)} starts ${Math.round(-r.left)}px off the left edge`,
          detail: { el: path(el), text: text(el) },
        });
      }
      return out.slice(0, 4);
    }));

    // 8. Broken images. A listing card with a dead src is indistinguishable to a
    //    manager from the deliberate no-photo placeholder.
    findings.push(...run("broken-image", () => {
      return Array.from(document.images)
        .filter((img) => img.complete && img.naturalWidth === 0 && (img.currentSrc || img.src))
        .slice(0, 5)
        .map((img) => ({
          check: "broken-image",
          severity: "medium",
          summary: `Image failed to load: ${(img.currentSrc || img.src).slice(0, 140)}`,
          detail: { el: path(img), alt: img.alt || null },
        }));
    }));

    // 9. Text truncated by a clip with no ellipsis — reads as a typo, not a cut.
    findings.push(...run("clipped-text", () => {
      const out = [];
      for (const el of all) {
        if (el.children.length > 0) continue;
        const over = el.scrollWidth - el.clientWidth;
        if (over <= 4 || el.clientWidth < 30) continue;
        const s = getComputedStyle(el);
        if (!/(hidden|clip)/.test(s.overflowX)) continue;
        if (s.textOverflow === "ellipsis") continue;
        const t = text(el);
        if (!t) continue;
        out.push({
          check: "clipped-text",
          severity: "low",
          suspected: true,
          summary: `"${t}" is cut off by ${over}px with no ellipsis`,
          detail: { el: path(el) },
        });
      }
      return out.slice(0, 5);
    }));

    // 10. The shell itself failed to render a heading — the page is blank or errored.
    findings.push(...run("no-heading", () => {
      const heads = Array.from(document.querySelectorAll("h1, h2, [role='heading']")).filter(visible);
      if (heads.length) return [];
      const body = text(document.body);
      return [{
        check: "no-heading",
        severity: "high",
        summary: "Page renders no visible heading — shell may have failed to load",
        detail: { bodyStart: body.slice(0, 160) },
      }];
    }));

    // 11. Next.js / React error surfaces rendered into the page.
    findings.push(...run("error-surface", () => {
      const body = text(document.body);
      const patterns = [
        /Application error: a client-side exception/i,
        /Unhandled Runtime Error/i,
        /This page could not be found/i,
        /Something went wrong/i,
        /Internal Server Error/i,
      ];
      const hit = patterns.find((p) => p.test(body));
      if (!hit) return [];
      return [{
        check: "error-surface",
        severity: "high",
        summary: `Page renders an error surface: ${body.match(hit)[0]}`,
        detail: { bodyStart: body.slice(0, 200) },
      }];
    }));

    return {
      url: location.href,
      viewport: { w: vw, h: vh },
      theme: document.documentElement.getAttribute("data-theme"),
      scrollHeight: document.documentElement.scrollHeight,
      findings,
    };
  };
})();
