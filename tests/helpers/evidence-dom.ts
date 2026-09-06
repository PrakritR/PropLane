import { mkdirSync, writeFileSync } from "node:fs";

/**
 * Serialize the rendered jsdom body for a reviewer screenshot.
 *
 * `innerHTML` alone loses live form state: a controlled checkbox keeps its
 * checked-ness as a DOM *property*, and a textarea's typed text never reaches
 * the markup — so a screenshot of the raw markup would show empty inputs the
 * person plainly filled in. The values are mirrored onto a CLONE so the live
 * React tree is left untouched and the test can keep interacting with it.
 */
export function renderedBodyHtml(): string {
  const clone = document.body.cloneNode(true) as HTMLElement;
  const liveInputs = Array.from(document.body.querySelectorAll("input"));
  const cloneInputs = Array.from(clone.querySelectorAll("input"));
  liveInputs.forEach((live, index) => {
    const copy = cloneInputs[index];
    if (!copy) return;
    if (live.type === "checkbox" || live.type === "radio") {
      if (live.checked) copy.setAttribute("checked", "");
      else copy.removeAttribute("checked");
    } else copy.setAttribute("value", live.value);
  });
  const liveAreas = Array.from(document.body.querySelectorAll("textarea"));
  const cloneAreas = Array.from(clone.querySelectorAll("textarea"));
  liveAreas.forEach((live, index) => {
    const copy = cloneAreas[index];
    if (copy) copy.textContent = live.value;
  });
  const liveSelects = Array.from(document.body.querySelectorAll("select"));
  const cloneSelects = Array.from(clone.querySelectorAll("select"));
  liveSelects.forEach((live, index) => {
    const copy = cloneSelects[index];
    if (!copy) return;
    Array.from(copy.querySelectorAll("option")).forEach(option => {
      if (option.value === live.value) option.setAttribute("selected", "");
      else option.removeAttribute("selected");
    });
  });
  return clone.innerHTML;
}

/** Write one screenshot-ready page. No-op unless EVIDENCE_DIR asks for it. */
export function writeEvidenceSurface(name: string, caption: string, bottomPadding = 60) {
  const out = process.env.EVIDENCE_DIR ?? "";
  if (!out) return;
  mkdirSync(out, { recursive: true });
  writeFileSync(
    `${out}/${name}.html`,
    `<!doctype html><html lang="en" class="h-full antialiased" data-theme="light"><head><meta charset="utf-8"><link rel="stylesheet" href="./app.css"></head>
<body class="min-h-full overflow-x-clip bg-background text-foreground">
<div style="max-width:960px;margin:0 auto;padding:20px 16px ${bottomPadding}px">
  <p style="font:600 13px/1.4 system-ui;color:#64748b;margin:0 0 12px">${caption}</p>
  ${renderedBodyHtml()}
</div></body></html>`,
    "utf8",
  );
}
