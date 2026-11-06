import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Writes a rendered surface to `EVIDENCE_DIR` as a whole HTML page, linked to the app's own
 * compiled stylesheet (`app.css`, built beside it), so a reviewer can open it — or screenshot it —
 * and see the real screen rather than a DOM dump. No-op when `EVIDENCE_DIR` is unset, so the test
 * it lives in stays a plain test everywhere else.
 *
 * `app.css` is the app's stylesheet compiled once beside the pages:
 *
 *   node -e 'import("postcss").then(async ({default:postcss})=>{const t=(await import("@tailwindcss/postcss")).default;const fs=await import("node:fs");\
 *     const entry="src/app/globals.css";const css=fs.readFileSync(entry,"utf8")+["../components/public-site/public-site.css",\
 *     "../components/public-site/journey-forms.css","../components/public-site/browse.css"].map(f=>`\n@import "${f}";`).join("");\
 *     fs.writeFileSync(process.env.EVIDENCE_DIR+"/app.css",(await postcss([t]).process(css,{from:entry})).css)})'
 */
export function writeEvidencePage(
  name: string,
  html: string,
  opts: { title: string; theme?: "light" | "dark"; width?: number; wrapperClass?: string; expandScrollers?: boolean } = { title: name },
): void {
  const dir = process.env.EVIDENCE_DIR ?? "";
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  const page = `<!doctype html>
<html lang="en" data-theme="${opts.theme ?? "light"}">
  <head>
    <meta charset="utf-8" />
    <title>${opts.title}</title>
    <link rel="stylesheet" href="app.css" />
    <style>
      body { margin: 0; background: var(--pl-surface, #fcfcfd); }
      .evidence-shell { width: ${opts.width ?? 960}px; margin: 0 auto; padding: 24px; }
      .evidence-caption { font: 600 13px/1.5 ui-sans-serif, system-ui, sans-serif; color: #475467; padding: 0 0 12px; }
      ${opts.expandScrollers ? ".evidence-shell * { max-height: none !important; overflow: visible !important; }" : ""}
    </style>
  </head>
  <body>
    <div class="evidence-shell ${opts.wrapperClass ?? ""}">
      <p class="evidence-caption">${opts.title}</p>
      ${html}
    </div>
  </body>
</html>
`;
  writeFileSync(join(dir, `${name}.html`), page, "utf8");
}
