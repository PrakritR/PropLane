/**
 * PropLane Lavish plan template.
 *
 * Produces the review surface the captain iterates on BEFORE any product code
 * is written. Contract (docs/agents/lavish-plan-standard.md):
 *
 *   - shows the UI, it does not describe it (mock panes in PropLane tokens)
 *   - semi-interactive: tabs, desktop/mobile, before/after, decision forms
 *   - editable: every section is contenteditable and can be queued back to the
 *     agent with one click, so the captain edits the plan in place
 *   - exact: the Build tab is the file-by-file spec the implementation follows
 *
 * All feedback paths go through `window.lavish.queuePrompt(...)`; the agent
 * drains them with `npm run lavish:poll`.
 */

const SLOT = (text) => `<span class="slot">${text}</span>`;

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function buildPlanHtml({ id, title, summary, imageFiles = [], sandboxUrl } = {}) {
  const planId = escapeHtml(id ?? "PLAN");
  const planTitle = escapeHtml(title ?? "Implementation plan");
  const planSummary = escapeHtml(summary ?? "One paragraph: what the captain asked for, in his words.");
  const sandbox = escapeHtml(sandboxUrl ?? "http://localhost:3002");

  const references = imageFiles.length
    ? `<section class="card" id="references">
      <h2>Captain references</h2>
      ${imageFiles
        .map(
          (name) =>
            `<figure><img src="assets/${escapeHtml(name)}" alt="Captain reference ${escapeHtml(name)}" /><figcaption>${escapeHtml(name)}</figcaption></figure>`,
        )
        .join("\n      ")}
    </section>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${planId} — ${planTitle}</title>
<style>
  :root {
    --pl-blue: #2863f0;
    --pl-blue-soft: #5a8cff;
    --pl-blue-deep: #1e4fd6;
    --pl-ink: #17181a;
    --pl-muted: #4a4e56;
    --pl-surface: #fcfcfd;
    --pl-raised: #ffffff;
    --pl-muted-surface: #f4f5f8;
    --pl-line: rgba(8, 9, 11, 0.09);
    --pl-line-strong: rgba(8, 9, 11, 0.14);
    --pl-accent-soft: rgba(40, 99, 240, 0.08);
    --ok-fg: #15803d; --ok-bg: #dcfce7;
    --warn-fg: #a34a06; --warn-bg: #fdf0d5;
    --bad-fg: #dc2626; --bad-bg: #fde4e2;
    --shadow-card: 0 1px 2px rgba(8,9,11,.04), 0 1px 3px rgba(8,9,11,.06);
    --radius: 14px;
  }
  * { box-sizing: border-box; min-width: 0; }
  body {
    margin: 0;
    background: var(--pl-surface);
    color: var(--pl-ink);
    font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 28px 20px 96px; }

  header.plan-head { display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-start; justify-content: space-between; }
  .eyebrow { display: inline-flex; align-items: center; gap: 8px; font-size: 12px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--pl-blue); background: var(--pl-accent-soft); border-radius: 999px; padding: 5px 11px; }
  h1 { font-size: 30px; line-height: 1.2; margin: 12px 0 6px; letter-spacing: -.02em; }
  .lede { color: var(--pl-muted); margin: 0; max-width: 62ch; }

  .listening { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--pl-muted); background: var(--pl-raised); border: 1px solid var(--pl-line); border-radius: 999px; padding: 7px 13px; box-shadow: var(--shadow-card); }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ok-fg); box-shadow: 0 0 0 3px rgba(21,128,61,.16); }

  nav.tabs { position: sticky; top: 0; z-index: 20; display: flex; gap: 4px; margin: 26px 0 22px; padding: 6px; background: rgba(252,252,253,.86); backdrop-filter: blur(8px); border: 1px solid var(--pl-line); border-radius: 999px; overflow-x: auto; }
  nav.tabs button { flex: 0 0 auto; border: 0; background: transparent; color: var(--pl-muted); font: inherit; font-weight: 600; font-size: 14px; padding: 8px 15px; border-radius: 999px; cursor: pointer; }
  nav.tabs button[aria-selected="true"] { background: var(--pl-blue); color: #fff; }

  .panel[hidden] { display: none; }
  .card { background: var(--pl-raised); border: 1px solid var(--pl-line); border-radius: var(--radius); padding: 20px 22px; box-shadow: var(--shadow-card); margin-bottom: 18px; }
  .card > h2 { font-size: 17px; margin: 0 0 4px; letter-spacing: -.01em; }
  .card > .hint { margin: 0 0 14px; font-size: 13px; color: var(--pl-muted); }
  .grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr)); gap: 18px; }

  .editable { border: 1px dashed transparent; border-radius: 10px; padding: 8px 10px; margin: -8px -10px; transition: border-color .12s, background .12s; }
  .editable:hover { border-color: var(--pl-line-strong); }
  .editable:focus { outline: none; border-color: var(--pl-blue); background: var(--pl-accent-soft); }
  .slot { color: var(--pl-blue-deep); background: var(--pl-accent-soft); border-radius: 6px; padding: 0 5px; }

  .row-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
  button.btn { font: inherit; font-weight: 600; font-size: 13px; border-radius: 10px; padding: 8px 14px; cursor: pointer; border: 1px solid var(--pl-line-strong); background: var(--pl-raised); color: var(--pl-ink); }
  button.btn:hover { border-color: var(--pl-blue); color: var(--pl-blue-deep); }
  button.btn.primary { background: var(--pl-blue); border-color: var(--pl-blue); color: #fff; }
  button.btn.primary:hover { background: var(--pl-blue-deep); color: #fff; }
  button.btn.ghost { border-style: dashed; }

  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--pl-line); vertical-align: top; }
  th { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--pl-muted); }
  code, .mono { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace; font-size: 12.5px; }
  td code { background: var(--pl-muted-surface); border-radius: 5px; padding: 1px 5px; }
  .tbl-scroll { overflow-x: auto; }

  .chip { display: inline-block; font-size: 11.5px; font-weight: 700; border-radius: 999px; padding: 3px 9px; }
  .chip.add { background: var(--ok-bg); color: var(--ok-fg); }
  .chip.edit { background: var(--warn-bg); color: var(--warn-fg); }
  .chip.del { background: var(--bad-bg); color: var(--bad-fg); }

  /* ---- UI mock ---- */
  .mock-toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: space-between; margin-bottom: 14px; }
  .seg { display: inline-flex; padding: 3px; gap: 2px; background: var(--pl-muted-surface); border-radius: 999px; }
  .seg button { border: 0; background: transparent; font: inherit; font-size: 13px; font-weight: 600; color: var(--pl-muted); padding: 6px 13px; border-radius: 999px; cursor: pointer; }
  .seg button[aria-pressed="true"] { background: var(--pl-raised); color: var(--pl-ink); box-shadow: var(--shadow-card); }

  .mock-stage { display: flex; justify-content: center; background: var(--pl-muted-surface); border: 1px solid var(--pl-line); border-radius: var(--radius); padding: 18px; overflow-x: auto; }
  .mock-frame { width: 100%; max-width: 940px; background: var(--pl-raised); border: 1px solid var(--pl-line-strong); border-radius: 12px; box-shadow: var(--shadow-card); overflow: hidden; transition: max-width .18s ease; }
  .mock-stage[data-viewport="mobile"] .mock-frame { max-width: 390px; }
  .mock-chrome { display: flex; align-items: center; gap: 6px; padding: 9px 12px; border-bottom: 1px solid var(--pl-line); background: var(--pl-muted-surface); }
  .mock-chrome i { width: 9px; height: 9px; border-radius: 50%; background: var(--pl-line-strong); display: inline-block; }
  .mock-url { margin-left: 8px; font-family: ui-monospace, Menlo, monospace; font-size: 11.5px; color: var(--pl-muted); }
  .mock-body { padding: 18px; }
  .mock-note { margin: 12px 2px 0; font-size: 13px; color: var(--pl-muted); }

  /* PropLane-ish primitives for building faithful mocks */
  .pl-card { background: var(--pl-raised); border: 1px solid var(--pl-line); border-radius: 12px; box-shadow: var(--shadow-card); }
  .pl-row { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border-bottom: 1px solid var(--pl-line); }
  .pl-row:last-child { border-bottom: 0; }
  .pl-title { font-weight: 600; font-size: 14px; }
  .pl-sub { font-size: 12.5px; color: var(--pl-muted); }
  .pl-btn { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 600; border-radius: 10px; padding: 8px 13px; background: var(--pl-blue); color: #fff; }
  .pl-btn.secondary { background: var(--pl-raised); color: var(--pl-ink); border: 1px solid var(--pl-line-strong); }
  .pl-pill { font-size: 11.5px; font-weight: 700; border-radius: 999px; padding: 3px 9px; background: var(--pl-accent-soft); color: var(--pl-blue-deep); }
  .pl-skeleton { background: var(--pl-muted-surface); border-radius: 8px; height: 12px; }

  fieldset.decision { border: 1px solid var(--pl-line); border-radius: 12px; padding: 14px 16px; margin: 0 0 14px; }
  fieldset.decision legend { font-weight: 700; font-size: 14px; padding: 0 6px; }
  fieldset.decision label { display: flex; gap: 10px; align-items: flex-start; padding: 9px 10px; border: 1px solid var(--pl-line); border-radius: 10px; margin-bottom: 8px; cursor: pointer; }
  fieldset.decision label:hover { border-color: var(--pl-blue-soft); }
  fieldset.decision input { margin-top: 3px; }
  fieldset.decision .opt-why { display: block; font-size: 12.5px; color: var(--pl-muted); }

  figure { margin: 0 0 14px; }
  figure img { width: 100%; border: 1px solid var(--pl-line); border-radius: 10px; }
  figcaption { font-size: 12.5px; color: var(--pl-muted); margin-top: 6px; }

  footer.approve { position: sticky; bottom: 0; margin-top: 26px; display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between; background: var(--pl-raised); border: 1px solid var(--pl-line); border-radius: var(--radius); padding: 14px 18px; box-shadow: 0 -2px 14px rgba(8,9,11,.06); }
  footer.approve p { margin: 0; font-size: 13.5px; color: var(--pl-muted); }
  .toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%) translateY(12px); background: var(--pl-ink); color: #fff; font-size: 13px; font-weight: 600; padding: 10px 16px; border-radius: 999px; opacity: 0; pointer-events: none; transition: opacity .18s, transform .18s; z-index: 60; }
  .toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
</style>
</head>
<body>
<div class="wrap">

  <header class="plan-head">
    <div>
      <span class="eyebrow">${planId} · plan, not code yet</span>
      <h1 contenteditable="true" class="editable" data-plan-field="title">${planTitle}</h1>
      <p class="lede editable" contenteditable="true" data-plan-field="summary">${planSummary}</p>
    </div>
    <div class="listening"><span class="dot"></span> Agent is listening — edit any text, then queue it back</div>
  </header>

  <nav class="tabs" role="tablist">
    <button role="tab" aria-selected="true" data-tab="overview">Overview</button>
    <button role="tab" aria-selected="false" data-tab="ui">UI</button>
    <button role="tab" aria-selected="false" data-tab="build">Build</button>
    <button role="tab" aria-selected="false" data-tab="decide">Decide</button>
    <button role="tab" aria-selected="false" data-tab="risks">Risks &amp; tests</button>
  </nav>

  <!-- ───────────────── Overview ───────────────── -->
  <div class="panel" data-panel="overview">
    <div class="grid-2">
      <section class="card">
        <h2>Today</h2>
        <p class="hint">What the captain hits right now.</p>
        <div class="editable" contenteditable="true" data-plan-field="current">${SLOT("Current behaviour, verified in the running app — not assumed.")}</div>
      </section>
      <section class="card">
        <h2>After this change</h2>
        <p class="hint">The outcome in his words.</p>
        <div class="editable" contenteditable="true" data-plan-field="target">${SLOT("Desired behaviour, concretely.")}</div>
      </section>
    </div>

    <section class="card">
      <h2>Scope</h2>
      <div class="grid-2">
        <div>
          <strong>In</strong>
          <ul class="editable" contenteditable="true" data-plan-field="in-scope"><li>${SLOT("…")}</li></ul>
        </div>
        <div>
          <strong>Out</strong>
          <ul class="editable" contenteditable="true" data-plan-field="out-scope"><li>${SLOT("…")}</li></ul>
        </div>
      </div>
      <div class="row-actions">
        <button class="btn" data-lavish-action data-queue-section="scope">Queue my scope edits</button>
      </div>
    </section>

    ${references}
  </div>

  <!-- ───────────────── UI ───────────────── -->
  <div class="panel" data-panel="ui" hidden>
    <section class="card">
      <h2>The screen</h2>
      <p class="hint">This is the build target. What is drawn here is what gets built.</p>

      <div class="mock-toolbar">
        <div class="seg" data-seg="state">
          <button aria-pressed="true" data-state="after">After</button>
          <button aria-pressed="false" data-state="before">Before</button>
        </div>
        <div class="seg" data-seg="viewport">
          <button aria-pressed="true" data-viewport="desktop">Desktop</button>
          <button aria-pressed="false" data-viewport="mobile">Mobile</button>
        </div>
      </div>

      <div class="mock-stage" data-viewport="desktop">
        <div class="mock-frame">
          <div class="mock-chrome"><i></i><i></i><i></i><span class="mock-url">${sandbox}/${SLOT("route")}</span></div>

          <div class="mock-body" data-mock="after">
            <!-- AGENT: replace with a faithful mock of the PROPOSED screen,
                 built from .pl-card / .pl-row / .pl-btn / .pl-pill primitives. -->
            <div class="pl-card">
              <div class="pl-row">
                <div style="flex:1">
                  <div class="pl-title">${SLOT("Proposed screen")}</div>
                  <div class="pl-sub">${SLOT("Draw the real rows, real copy, real states.")}</div>
                </div>
                <span class="pl-btn">${SLOT("Primary action")}</span>
              </div>
            </div>
          </div>

          <div class="mock-body" data-mock="before" hidden>
            <!-- AGENT: screenshot of the real current screen, or a mock of it. -->
            <div class="pl-card">
              <div class="pl-row">
                <div style="flex:1">
                  <div class="pl-title">${SLOT("Current screen")}</div>
                  <div class="pl-sub">${SLOT("Embed a real screenshot when the screen exists.")}</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <p class="mock-note editable" contenteditable="true" data-plan-field="ui-note">${SLOT("Interaction notes: empty state, loading, error, mobile differences.")}</p>
      <div class="row-actions">
        <button class="btn" data-lavish-action data-queue-section="ui">Queue my UI notes</button>
        <button class="btn ghost" data-lavish-action data-queue-text="Redraw this screen — the mock is not what I want.">Redraw this screen</button>
      </div>
    </section>
  </div>

  <!-- ───────────────── Build ───────────────── -->
  <div class="panel" data-panel="build" hidden>
    <section class="card">
      <h2>Files</h2>
      <p class="hint">Exactly what the implementation touches. No file appears in the build that is not on this list.</p>
      <div class="tbl-scroll">
        <table data-plan-field="files">
          <thead><tr><th>File</th><th>Change</th><th>Why</th></tr></thead>
          <tbody class="editable" contenteditable="true">
            <tr><td><code>src/…</code></td><td><span class="chip edit">edit</span></td><td>${SLOT("…")}</td></tr>
            <tr><td><code>tests/unit/…</code></td><td><span class="chip add">new</span></td><td>${SLOT("…")}</td></tr>
          </tbody>
        </table>
      </div>
      <div class="row-actions">
        <button class="btn" data-lavish-action data-queue-section="build">Queue my build edits</button>
      </div>
    </section>

    <section class="card">
      <h2>Data &amp; contracts</h2>
      <p class="hint">Schema, tool layer, RLS, analytics. Say "none" when there are none.</p>
      <div class="editable" contenteditable="true" data-plan-field="data">${SLOT("Migrations, typed tools, permissions, PostHog events, Langfuse traces.")}</div>
    </section>

    <section class="card">
      <h2>Order of work</h2>
      <ol class="editable" contenteditable="true" data-plan-field="steps">
        <li>${SLOT("Step — what lands, what proves it")}</li>
      </ol>
    </section>
  </div>

  <!-- ───────────────── Decide ───────────────── -->
  <div class="panel" data-panel="decide" hidden>
    <section class="card">
      <h2>Open decisions</h2>
      <p class="hint">Pick one per question, then queue the answer. Nothing is sent until you press the button.</p>

      <form class="decision-form" data-lavish-question="decision-1">
        <fieldset class="decision">
          <legend>${SLOT("Decision 1 — the actual question")}</legend>
          <label><input type="radio" name="decision-1" value="Option A" /><span><strong>Option A</strong><span class="opt-why">${SLOT("What it costs, what it buys.")}</span></span></label>
          <label><input type="radio" name="decision-1" value="Option B" /><span><strong>Option B</strong><span class="opt-why">${SLOT("What it costs, what it buys.")}</span></span></label>
          <button class="btn primary" type="submit">Queue this answer</button>
        </fieldset>
      </form>
    </section>
  </div>

  <!-- ───────────────── Risks ───────────────── -->
  <div class="panel" data-panel="risks" hidden>
    <section class="card">
      <h2>Risks</h2>
      <ul class="editable" contenteditable="true" data-plan-field="risks"><li>${SLOT("What could break, and the guard against it.")}</li></ul>
    </section>
    <section class="card">
      <h2>How it gets proved</h2>
      <p class="hint">Real data, real browser, stated edges — never <code>/demo</code> as proof.</p>
      <ul class="editable" contenteditable="true" data-plan-field="tests">
        <li>Seed: <code>npm run test:seed</code></li>
        <li>Drive <code>${sandbox}/${SLOT("route")}</code> — edges: ${SLOT("…")}</li>
        <li><code>npm run test:unit</code> — ${SLOT("targeted specs")}</li>
      </ul>
      <div class="row-actions">
        <button class="btn" data-lavish-action data-queue-section="risks">Queue my edits</button>
      </div>
    </section>
  </div>

  <footer class="approve">
    <p>Edits are queued, not sent, until you press <strong>Send to Agent</strong> in Lavish.</p>
    <div class="row-actions" style="margin:0">
      <button class="btn ghost" data-lavish-action data-queue-text="Rework this plan — see my annotations.">Rework the plan</button>
      <button class="btn primary" data-lavish-action data-queue-text="approved — build">approved — build</button>
    </div>
  </footer>
</div>

<div class="toast" id="toast"></div>

<script>
(function () {
  var toastEl = document.getElementById("toast");
  var toastTimer;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove("show"); }, 2200);
  }

  function queue(text, opts) {
    var lav = window.lavish;
    if (!lav || typeof lav.queuePrompt !== "function") {
      toast("Open this plan through Lavish to send feedback");
      return;
    }
    lav.queuePrompt(text, opts || {});
    toast("Queued — press Send to Agent in Lavish");
  }

  /* Tabs */
  var tabs = Array.prototype.slice.call(document.querySelectorAll("nav.tabs button"));
  var panels = Array.prototype.slice.call(document.querySelectorAll(".panel"));
  tabs.forEach(function (tab) {
    tab.addEventListener("click", function () {
      tabs.forEach(function (t) { t.setAttribute("aria-selected", String(t === tab)); });
      panels.forEach(function (p) { p.hidden = p.dataset.panel !== tab.dataset.tab; });
    });
  });

  /* Before / after + desktop / mobile */
  var stage = document.querySelector(".mock-stage");
  document.querySelectorAll('.seg[data-seg="state"] button').forEach(function (btn) {
    btn.addEventListener("click", function () {
      document.querySelectorAll('.seg[data-seg="state"] button').forEach(function (b) {
        b.setAttribute("aria-pressed", String(b === btn));
      });
      document.querySelectorAll("[data-mock]").forEach(function (m) {
        m.hidden = m.dataset.mock !== btn.dataset.state;
      });
    });
  });
  document.querySelectorAll('.seg[data-seg="viewport"] button').forEach(function (btn) {
    btn.addEventListener("click", function () {
      document.querySelectorAll('.seg[data-seg="viewport"] button').forEach(function (b) {
        b.setAttribute("aria-pressed", String(b === btn));
      });
      if (stage) stage.dataset.viewport = btn.dataset.viewport;
    });
  });

  /* Queue edited sections back to the agent */
  function sectionText(el) {
    return (el.innerText || "").replace(/\\s+\\n/g, "\\n").trim().slice(0, 4000);
  }
  document.querySelectorAll("[data-queue-section]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var card = btn.closest(".card") || document;
      var parts = [];
      card.querySelectorAll("[data-plan-field]").forEach(function (field) {
        parts.push("[" + field.dataset.planField + "]\\n" + sectionText(field));
      });
      if (!parts.length) parts.push(sectionText(card));
      queue(
        "I edited the plan. Apply these edits verbatim and re-open the plan:\\n\\n" + parts.join("\\n\\n"),
        { tag: "plan-edit", queueKey: "edit:" + btn.dataset.queueSection, element: card,
          data: { section: btn.dataset.queueSection } }
      );
    });
  });

  document.querySelectorAll("[data-queue-text]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      queue(btn.dataset.queueText, { tag: "plan", element: btn });
    });
  });

  /* Decision forms — one prompt on submit, never on change */
  document.querySelectorAll("form.decision-form").forEach(function (form) {
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      var data = new FormData(form);
      var question = form.dataset.lavishQuestion || "decision";
      var answer = data.get(question);
      if (!answer) { toast("Pick an option first"); return; }
      queue("Decision — " + question + ": " + answer, {
        tag: "choice", text: question + ": " + answer, element: form,
        queueKey: "decision:" + question, data: { question: question, answer: answer }
      });
    });
  });
})();
</script>
</body>
</html>`;
}
