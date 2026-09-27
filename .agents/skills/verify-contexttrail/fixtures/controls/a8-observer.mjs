/**
 * Offline observer control for the V39 consumer corrections — it drives the
 * REAL consumer bodies end to end against a real DOM (jsdom), not handcrafted
 * verdict copies:
 *
 *   - A8_*_PROBE_FN: the probe strings are evaluated by jsdom against the
 *     actual markup (each consumer invokes its probe exactly once);
 *   - observeExpectedRecords: the real per-view dispatcher — record bucketing,
 *     click-dependent placement/divergence dispatch, opened-identity
 *     collection, and the exact-cardinality verdicts (V39-2/V39-8);
 *   - readOpenedEvidenceId + openedOccurrenceId: the scoped Technical-details
 *     identity reader every opener flows through (V39-7) — whole-dialog text,
 *     counterfeit fields, duplicates and missing fields all refuse;
 *   - three real map cases (claim-mode with gates/placement, the zero-selected
 *     empty case, and the connectors+divergence trace case), each run
 *     positive → opposing negative → restored under the SAME predicates.
 *
 * jsdom has no layout engine: geometry-dependent probes (contrast/clipping)
 * are covered by the wrapVerdict record-shape checks in v39-contracts.mjs.
 * This file proves the OBSERVATION path: probe → consumer → identity → verdict.
 *
 *   node fixtures/controls/a8-observer.mjs
 */
import { JSDOM } from "jsdom";
import {
  observeExpectedRecords,
  expectedCaseFor,
  expectedRecordKind,
  fixtureResult,
  A8_OVERVIEW_PROBE_FN,
  A8_TIMELINE_PROBE_FN,
  A8_ANALYSIS_PROBE_FN,
} from "../../cli/control-contexttrail.mjs";

let failures = 0;
const results = [];
const expect = (name, cond, detail) => {
  results.push({ name, ok: cond === true, detail: detail ?? null });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const kind = (r, fixture) => expectedRecordKind(r, fixture);

/* ------------------------- DOM builders (from the map) --------------------- */

function overviewHtml(c) {
  const rec = (k) => c.visibleExpectations.find((r) => kind(r, c.fixture) === k);
  const seg = rec("analysis-segments");
  const support = rec("overview-support");
  const caveat = rec("caveat-visible");
  return `<section aria-label="Investigation result"><div>
    <h1>${esc(c.expectedOverviewHeadline)}</h1>
    ${support ? `<p>${esc(support.expect)}</p>` : ""}
    ${caveat ? `<p>⚠ ${esc(caveat.expect)}</p>` : ""}
    </div>
    <dl>
      <div><dt>Source domains</dt><dd>1</dd></div>
      <div><dt>Observed contexts</dt><dd>${seg ? (seg.expect === null ? "Unresolved" : String(seg.expect)) : "0"}</dd></div>
      <div><dt>Earliest observed</dt><dd>2024</dd></div>
    </dl></section>`;
}

function timelineHtml(c) {
  const rec = (k) => c.visibleExpectations.find((r) => kind(r, c.fixture) === k);
  const ids = c.expectedIds?.timeline ?? [];
  const undatedIds = c.expectedIds?.undated ?? [];
  const placement = rec("placement");
  const divergence = rec("divergence");
  const edges = c.expectedIds?.connectorEdges ?? [];
  const items = ids
    .map((id) => {
      const edge = edges.find((e) => e.toOccurrenceId === id);
      return `<li><h3>Card ${id}</h3>${
        edge ? `<p>${esc(edge.expectConnectorLabel)}</p>` : ""
      }<button aria-label="Inspect evidence for ${id}" data-open-id="${id}">inspect</button></li>`;
    })
    .join("");
  const emptyP =
    ids.length === 0
      ? `<p>${undatedIds.length > 0 ? "No dated core occurrences were found." : "No occurrences were returned in this investigation."}</p>`
      : "";
  const undatedSec = placement
    ? `<section aria-label="${esc(placement.expectSectionAriaLabel ?? "Evidence with unknown dates")}"><h3>${esc(
        placement.expectSectionHeading,
      )}</h3><ul>${undatedIds
        .map(
          (id) =>
            `<li><h3>Undated ${id}</h3><p>${esc(placement.expectItemBadge ?? "")} · ${esc(
              placement.expectNoUsableDateText ?? "",
            )}${
              (placement.expectDateNoteById ?? {})[id] ? ` ${esc(placement.expectDateNoteById[id])}` : ""
            }</p><button aria-label="Inspect evidence for ${id}" data-open-id="${id}">inspect</button></li>`,
        )
        .join("")}</ul></section>`
    : "";
  const divNote = divergence
    ? `<div role="note" aria-label="First observed context divergence"><p>earlier · later</p><button data-open-id="${esc(
        divergence.expect.from,
      )}">earlier</button><button data-open-id="${esc(divergence.expect.to)}">later</button></div>`
    : "";
  return `<div id="ct-panel-timeline"><ol>${items}</ol>${emptyP}${undatedSec}${divNote}</div>`;
}

function analysisHtml(c) {
  const rec = (k) => c.visibleExpectations.find((r) => kind(r, c.fixture) === k);
  const cov = rec("analysis-coverage")?.expect ?? {};
  const pairs = cov.comparedPairIds ?? [];
  const covP =
    (cov.eligible ?? 0) === 0 && (cov.selected ?? 0) === 0
      ? "No occurrences were selected for context comparison."
      : `${cov.comparedPairs} pair${cov.comparedPairs === 1 ? "" : "s"} compared across ${cov.selected} selected of ${cov.eligible} eligible occurrences.`;
  const performed = pairs
    .map((pair) => {
      const [a, b] = pair.split("|");
      return `<li><p>${esc(a)} ↔ ${esc(b)}</p><button data-open-id="${esc(a)}">a</button><button data-open-id="${esc(b)}">b</button></li>`;
    })
    .join("");
  const gatesR = rec("gates");
  const why = gatesR
    ? `<p>${esc(gatesR.expect.statusBasisRendered)}</p><ul>${gatesR.expect.gates
        .map(
          (g) =>
            `<li><p><span aria-hidden="true">${g.passed ? "✓" : "✗"} </span>${esc(g.expectText)}</p><p>${esc(
              g.detail,
            )}</p>${(g.expectSupportLinkIds ?? [])
              .map((id) => `<button data-open-id="${esc(id)}">support</button>`)
              .join("")}</li>`,
        )
        .join("")}</ul>`
    : `<p>Deterministic policy reasons were not included in this result.</p>`;
  const ox = rec("analysis-origins")?.expect ?? {};
  const groups = ox.groups ?? [];
  const groupLis = groups
    .map(
      (g) =>
        `<li><p>Reporting group of ${g.memberIds.length} occurrences · ${(g.renderedReasons ?? [])
          .map(esc)
          .join(" · ")}</p>${(g.memberIds ?? [])
          .map((id) => `<button data-open-id="${esc(id)}">member</button>`)
          .join("")}</li>`,
    )
    .join("");
  const groupsBlock = groups.length ? `<ul>${groupLis}</ul>` : `<p>No resolved reporting groups were reported.</p>`;
  const unresolved = ox.unresolvedCandidateIds ?? [];
  const unresP = unresolved.length
    ? `<p>${unresolved.length} unresolved candidates: ${unresolved
        .map((id) => `<button data-open-id="${esc(id)}">u</button>`)
        .join("")}</p>`
    : "";
  return `<div id="ct-panel-analysis"><section aria-label="Analysis">
    <h3>Comparison coverage</h3><p>${covP}</p>
    <h3>Comparisons performed</h3>${performed ? `<ul>${performed}</ul>` : `<p>No context comparison was performed.</p>`}
    <h3>Why this result</h3>${why}
    <h3>Reporting origins</h3><p>${ox.reportingGroupCount ?? 0} resolved reporting groups · ${ox.unresolvedOriginCount ?? 0} unresolved candidates</p>
    <h3>Reporting groups</h3>${groupsBlock}${unresP}
    </section></div>`;
}

/* ------------------------- fake page over a real DOM ------------------------ */

/** A page stub whose evaluate() runs the REAL probe strings inside jsdom and
 *  whose locators wrap real DOM elements. Opener buttons carry data-open-id —
 *  clicking one makes the fake dialog's Technical-details field report that
 *  identity, so readOpenedEvidenceId runs its real scoped reader. */
function makeHarness(html) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
    runScripts: "outside-only",
  });
  const w = dom.window;
  const doc = w.document;
  // jsdom does not implement innerText; the probes read it for human-visible
  // text. textContent is the honest offline stand-in (whitespace-insensitive
  // verdicts normalize it anyway).
  Object.defineProperty(w.HTMLElement.prototype, "innerText", {
    get() {
      return this.textContent ?? "";
    },
    configurable: true,
  });
  const dialogEl = doc.createElement("div");
  dialogEl.setAttribute("role", "dialog");
  doc.body.appendChild(dialogEl);
  const evalCalls = [];

  const matchText = (el, t) =>
    typeof t === "string" ? (el.textContent ?? "").includes(t) : t.test(el.textContent ?? "");
  const subQuery = (els, sel) => {
    if (typeof sel === "string" && sel.startsWith("xpath=")) {
      const m = /^xpath=following-sibling::([a-z]+)\[(\d+)\]$/.exec(sel);
      if (!m) throw new Error(`stub cannot express ${sel}`);
      const [, tag, nth] = m;
      return els
        .map((e) => {
          let n = e.nextElementSibling;
          let seen = 0;
          while (n) {
            if (n.tagName === tag.toUpperCase() && ++seen === +nth) return n;
            n = n.nextElementSibling;
          }
          return null;
        })
        .filter(Boolean);
    }
    const scoped = sel.replace(/^\s*>\s*/, ":scope > ");
    return els.flatMap((e) => [...e.querySelectorAll(scoped)]);
  };
  const loc = (els) => ({
    count: async () => els.length,
    first: () => loc(els.slice(0, 1)),
    nth: (i) => loc(els[i] ? [els[i]] : []),
    filter: ({ hasText }) => loc(els.filter((e) => matchText(e, hasText))),
    locator: (sel) => loc(subQuery(els, sel)),
    click: async () => {
      const el = els[0];
      if (!el) return;
      const id = el.getAttribute("data-open-id");
      dialogEl.innerHTML = `<details><summary>Technical details</summary><p>Occurrence ID: ${id}</p></details>`;
    },
    evaluate: async (fn) => fn(els[0] ?? null),
    waitFor: async () => {},
    getByRole: (role, opts) =>
      loc(
        [...(els[0] ?? doc).querySelectorAll(role === "button" ? "button" : role)].filter((e) =>
          opts?.name ? matchText(e, opts.name) || opts.name.test(e.getAttribute("aria-label") ?? "") : true,
        ),
      ),
    innerText: async () => els[0]?.textContent ?? "",
    textContent: async () => els[0]?.textContent ?? "",
    isEnabled: async () => els.length > 0,
    isVisible: async () => els.length > 0,
    boundingBox: async () => (els.length ? { width: 100, height: 48 } : null),
    getAttribute: async (a) => els[0]?.getAttribute(a) ?? null,
  });
  const page = {
    evaluate: async (src, arg) => {
      evalCalls.push(src);
      return typeof src === "string" ? w.eval(src) : src(arg);
    },
    locator: (sel, opts) => {
      let els = [...doc.querySelectorAll(sel)];
      if (opts?.hasText) els = els.filter((e) => matchText(e, opts.hasText));
      return loc(els);
    },
    keyboard: { press: async () => {} },
    getByRole: (role, opts) => loc([...doc.querySelectorAll("button")].filter((e) => matchText(e, opts?.name ?? ""))),
  };
  return { page, dom, doc, dialogEl, evalCalls };
}

const rec = () => {
  const checks = [];
  return {
    checks,
    check: (name, ok, detail) => checks.push({ name, ok: ok === true, detail }),
    note: () => {},
    red: () => checks.filter((c) => !c.ok),
  };
};

/* --------------------------- the three map cases --------------------------- */

const CASES = {
  claim: expectedCaseFor("controlled-claim"),
  insufficient: expectedCaseFor("controlled-insufficient"),
  uncertain: expectedCaseFor("controlled-trace-uncertain-transition"),
};
expect("the three control cases resolve through the real roster gate", Object.values(CASES).every((c) => c !== null));

const htmlFor = (c) => overviewHtml(c) + timelineHtml(c) + analysisHtml(c);
const terminalFor = (c) => fixtureResult(c.fixture);

async function runView(c, view, mutate) {
  const h = makeHarness(htmlFor(c));
  if (mutate) mutate(h.doc);
  const r = rec();
  await observeExpectedRecords(h.page, r, c, view, { terminal: terminalFor(c) });
  return { ...r, evalCalls: h.evalCalls };
}
const a8Checks = (r) => r.checks.filter((c) => c.name.startsWith("a8.expect."));
const findCheck = (r, suffix) => r.checks.find((c) => c.name.endsWith(suffix));

/* ============================ POSITIVE: all green ========================== */

for (const [label, c] of Object.entries(CASES)) {
  for (const view of ["overview", "timeline", "analysis"]) {
    const r = await runView(c, view);
    const bucket = c.visibleExpectations.filter((x) => {
      const k = kind(x, c.fixture);
      return { overview: "overview", timeline: "timeline", analysis: "analysis" }[
        { "overview-headline": "overview", "overview-support": "overview", "caveat-visible": "overview",
          "caveat-serialized": "overview", "analysis-segments": "overview", "timeline-ids": "timeline",
          "timeline-empty-state": "timeline", "undated-section-absent": "timeline", placement: "timeline",
          divergence: "timeline", connectors: "timeline", "analysis-coverage": "analysis",
          "analysis-origins": "analysis", "analysis-policy-not-applicable": "analysis", gates: "analysis" }[k]
      ] === view;
    });
    const reds = a8Checks(r).filter((x) => !x.ok);
    expect(
      `${label}/${view}: every map record discharged green through the real consumer`,
      bucket.length > 0 && a8Checks(r).length >= bucket.length && reds.length === 0,
      reds.length ? reds.map((x) => `${x.name}: ${x.detail}`).join(" | ") : `${a8Checks(r).length} checks`,
    );
    expect(
      `${label}/${view}: the consumer invoked its page probe exactly once`,
      r.evalCalls.length === 1 && r.evalCalls[0] === { overview: A8_OVERVIEW_PROBE_FN, timeline: A8_TIMELINE_PROBE_FN, analysis: A8_ANALYSIS_PROBE_FN }[view],
      `${r.evalCalls.length} evaluate call(s)`,
    );
  }
}

/* ============================== NEGATIVE pairs ============================= */

// Timeline: one dated opener reports the wrong identity (V39-7 reader feeds
// the V39-8 exact-sequence verdict — position 1 must go red).
{
  const c = CASES.claim;
  const r = await runView(c, "timeline", (doc) => {
    const b = [...doc.querySelectorAll('#ct-panel-timeline ol > li button[aria-label^="Inspect evidence"]')][1];
    b.setAttribute("data-open-id", "ev-counterfeit-00");
  });
  const chk = findCheck(r, `${c.fixture}-timeline-ids`);
  expect("timeline: wrong opened identity is RED on the same record", chk?.ok === false, chk?.detail);
}
// Timeline: a dated item removed — cardinality shortfall is RED.
{
  const c = CASES.claim;
  const r = await runView(c, "timeline", (doc) => {
    doc.querySelector('#ct-panel-timeline ol > li:last-of-type')?.remove();
  });
  const chk = findCheck(r, `${c.fixture}-timeline-ids`);
  expect("timeline: a removed dated item is RED (exact cardinality)", chk?.ok === false, chk?.detail);
}
// Placement: dropping an undated item and moving NO id into dated is still RED.
{
  const c = CASES.claim;
  const r = await runView(c, "timeline", (doc) => {
    doc.querySelector('#ct-panel-timeline section[aria-label="Evidence with unknown dates"] ul > li:last-of-type')?.remove();
  });
  const chk = findCheck(r, `${c.fixture}-placement`);
  expect("timeline: a missing undated item fails the placement record", chk?.ok === false, chk?.detail);
}
// Divergence: the note's "later" endpoint opens the wrong occurrence.
{
  const c = CASES.uncertain;
  const r = await runView(c, "timeline", (doc) => {
    const btns = doc.querySelectorAll('[role="note"][aria-label="First observed context divergence"] button');
    btns[1]?.setAttribute("data-open-id", "ev-muiw5ak5-111");
  });
  const chk = findCheck(r, `${c.fixture}-divergence`);
  expect("timeline: wrong divergence endpoint identity is RED", chk?.ok === false, chk?.detail);
}
// Connectors: a wrong connector label on the edge's own item is RED.
{
  const c = CASES.uncertain;
  const r = await runView(c, "timeline", (doc) => {
    const li = doc.querySelectorAll("#ct-panel-timeline ol > li")[2];
    const p = li?.querySelector("p");
    if (p) p.textContent = "Same context as previous · compared";
  });
  const chk = findCheck(r, `${c.fixture}-connectors`);
  expect("timeline: a wrong connector label is RED", chk?.ok === false, chk?.detail);
}
// Undated-absence on an unmeasured surface is NON-PASS, not a pass (V39-8).
{
  const c = CASES.insufficient;
  const r = await runView(c, "timeline", (doc) => {
    doc.getElementById("ct-panel-timeline")?.remove();
  });
  const absent = findCheck(r, `${c.fixture}-undated-section-absent`);
  expect(
    "timeline: null surface cannot prove undated absence (non-pass)",
    absent?.ok === false,
    absent?.detail,
  );
}
// Zero-selected coverage rejects a phantom performed row (V39-8).
{
  const c = CASES.insufficient;
  const r = await runView(c, "analysis", (doc) => {
    const sec = doc.querySelector('#ct-panel-analysis section[aria-label="Analysis"]');
    const perfH = [...sec.querySelectorAll("h3")].find((x) => x.textContent.trim() === "Comparisons performed");
    const ul = doc.createElement("ul");
    ul.innerHTML = `<li><p>phantom</p><button data-open-id="ev-a">a</button><button data-open-id="ev-b">b</button></li>`;
    perfH.parentElement.insertBefore(ul, perfH.nextElementSibling);
  });
  const chk = findCheck(r, `${c.fixture}-analysis-coverage`);
  expect("analysis: a phantom performed row under zero-selected coverage is RED", chk?.ok === false, chk?.detail);
}
// Origins: an extra member button (phantom member) is RED (V39-8).
{
  const c = CASES.claim;
  const r = await runView(c, "analysis", (doc) => {
    const li = doc.querySelector('#ct-panel-analysis section[aria-label="Analysis"] ul li');
    // The first ul inside Reporting groups — find via its own h3.
    const grpH = [...doc.querySelectorAll("#ct-panel-analysis h3")].find((x) => x.textContent.trim() === "Reporting groups");
    const ul = grpH.nextElementSibling;
    const first = ul.querySelector("li");
    const extra = doc.createElement("button");
    extra.setAttribute("data-open-id", "ev-muiw5afg-99");
    first.appendChild(extra);
    void li;
  });
  const chk = findCheck(r, `${c.fixture}-analysis-origins`);
  expect("analysis: an extra member button fails exact cardinality", chk?.ok === false, chk?.detail);
}
// Gates: a support link opening the wrong occurrence is RED.
{
  const c = CASES.claim;
  const r = await runView(c, "analysis", (doc) => {
    const whyH = [...doc.querySelectorAll("#ct-panel-analysis h3")].find((x) => x.textContent.trim() === "Why this result");
    const ul = [...whyH.parentElement.children].find((e, i) => i > [...whyH.parentElement.children].indexOf(whyH) && e.tagName === "UL");
    const btn = ul.querySelector("li button");
    btn.setAttribute("data-open-id", "ev-support-wrong");
  });
  const chk = findCheck(r, `${c.fixture}-gates`);
  expect("analysis: a gate support link opened to the wrong id is RED", chk?.ok === false, chk?.detail);
}
// Overview: a foreign headline is RED on the same record.
{
  const c = CASES.claim;
  const r = await runView(c, "overview", (doc) => {
    doc.querySelector('section[aria-label="Investigation result"] h1').textContent = "Fabricated headline";
  });
  const chk = findCheck(r, `${c.fixture}-overview-headline`);
  expect("overview: a wrong status headline is RED", chk?.ok === false, chk?.detail);
}
// Overview: wrong Observed-contexts metric fails analysis-segments.
{
  const c = CASES.claim;
  const r = await runView(c, "overview", (doc) => {
    const dd = [...doc.querySelectorAll("dl > div")].find((d) => /Observed contexts/.test(d.querySelector("dt")?.textContent ?? ""))?.querySelector("dd");
    if (dd) dd.textContent = "7";
  });
  const chk = findCheck(r, `${c.fixture}-analysis-segments`);
  expect("overview: a wrong segments metric is RED", chk?.ok === false, chk?.detail);
}

/* ============================== RESTORED =================================== */

for (const [label, c] of Object.entries(CASES)) {
  for (const view of ["overview", "timeline", "analysis"]) {
    const r = await runView(c, view);
    const reds = a8Checks(r).filter((x) => !x.ok);
    expect(`${label}/${view}: restored DOM is green again on the same predicates`, reds.length === 0, reds.map((x) => x.name).join(",") || undefined);
  }
}

console.log(`\n${results.length} checks, ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
