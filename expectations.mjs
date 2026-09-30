/**
 * CORRECTION 037 — typed expectations, case derivation, verdict reducers.
 *
 * Changes from 036 (answering the independent review's PREP36-1A / 3B):
 *
 *   1A  — deriveCaseArtifacts reads the REAL terminal contract: the
 *         `investigation.completed` event carries `result` — mode, status,
 *         timeline[] (per-occurrence fields), supportingEvidence[],
 *         contextualEvidence[], undatedEvidence[],
 *         firstObservedContextDivergence{fromOccurrenceId,toOccurrenceId}.
 *         The 036 defect read the event envelope as the result and looked
 *         for flattened fields, so every fixture derived minOccurrences:0.
 *         The adapter itself is the producer-owned case contract
 *         (ct-jev-proof recorder-contract-037/case-contract.mjs): this module
 *         requires it as an explicit `contract` argument — it verifies the
 *         export shape and calls it. The bound artifact pin is checked by
 *         the run gate; without a bound+called contract the case cannot be
 *         consumed. Submitted-preview availability derives from ENTRY/input
 *         ownership (live upload vs restored cache — the app never persists
 *         image bytes), not an absent terminal field. Declared local media
 *         is a SEPARATELY HASHED artifact whose URL scope must sit inside
 *         the case's actual retrieved imageUrl set — no NDJSON edits.
 *
 *   3B  — evaluateExpectation and the negative-family runners are consumed by
 *         the executor: stream-ledger comparisons with an absent observed
 *         value are INVALID (undefined===undefined is not a pass), every
 *         bound expectation/negative result is persisted on the chapter
 *         record and folded into the chapter/run verdict, page/video errors
 *         and missing observations are non-passing, and request-ledger
 *         failures are classified — an intentionally boundary-blocked or
 *         declared-local-media request is expected evidence, anything else
 *         unexpected.
 *
 * Reducers: ok:false steps, armed-not-observed, failed assertions/holds,
 * failed expectations/negatives, unexpected errors and unobserved required
 * evidence are ALL non-passing. Unknown is non-pass and distinct from fail.
 */

import fs from "node:fs";
import crypto from "node:crypto";

const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");

/* ----------------------------------------------------- typed expectations */

/**
 * The expectation kinds a bound CHAPTER_EXPECTATIONS entry may carry.
 * Every kind maps to a real evaluation path — an unknown kind is malformed,
 * never a pass.
 */
export const EXPECTATION_KINDS = Object.freeze([
  // A step record must exist with action X and an ok status.
  "step-ok",
  // A step record must exist whose observed text matches a regex.
  "step-observed-text",
  // The chapter's request ledger must contain an outcome.
  "ledger-outcome",
  // The chapter's request ledger must NOT contain an outcome.
  "ledger-outcome-absent",
  // The chapter's stream ledger must show a condition on request N.
  "stream-ledger",
  // hold/settle/panel verdicts.
  "hold-pass",
  "settle-ok",
  "panel-identity",
  // Zero provider attempts — computed ONLY from an observed ledger.
  "zero-provider-observed",
  // A negative predicate must reject (the fault actually changes the outcome).
  "negative-rejects",
]);

export function validateExpectation(exp) {
  const problems = [];
  if (!exp || typeof exp !== "object" || Array.isArray(exp)) return { ok: false, problems: ["expectation is not an object"] };
  if (!EXPECTATION_KINDS.includes(exp.kind)) {
    return { ok: false, problems: [`unknown expectation kind ${JSON.stringify(exp.kind)}`] };
  }
  switch (exp.kind) {
    case "step-ok":
    case "step-observed-text":
      if (typeof exp.action !== "string" || !exp.action) problems.push(`${exp.kind} requires an action id`);
      if (exp.kind === "step-observed-text" && typeof exp.match !== "string") problems.push("step-observed-text requires a match regex string");
      break;
    case "ledger-outcome":
    case "ledger-outcome-absent":
      if (typeof exp.outcome !== "string" || !exp.outcome) problems.push(`${exp.kind} requires an outcome string`);
      break;
    case "stream-ledger":
      if (typeof exp.field !== "string" || !exp.field) problems.push("stream-ledger requires a field name");
      break;
    case "negative-rejects":
      if (typeof exp.family !== "string" || !exp.family) problems.push("negative-rejects requires a family");
      break;
    default:
      break; // hold-pass / settle-ok / panel-identity / zero-provider-observed need no fields
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Execute ONE expectation against a finished chapter record.
 * Returns { ok: true|false|null, detail } — null means the evidence needed
 * to decide was never observed: the expectation is UNKNOWN, not satisfied.
 * A comparison whose observed value is UNDEFINED is invalid, not a pass.
 */
export function evaluateExpectation(exp, chapterRec) {
  const v = validateExpectation(exp);
  if (!v.ok) return { ok: false, detail: { malformed: v.problems } };
  const steps = chapterRec?.steps ?? [];
  // Step-instance association: prefer the exact instance when `stepIndex` is
  // supplied, else the LAST record of that action (a waiter carries both its
  // "armed" placeholder and its consumed record — the consumed one is the
  // observable result).
  const step = exp.action
    ? (exp.stepIndex !== undefined
        ? steps.find((s) => s.i === exp.stepIndex && s.action === exp.action)
        : [...steps].reverse().find((s) => s.action === exp.action && s.status !== "armed"))
    : null;
  switch (exp.kind) {
    case "step-ok":
      if (!step) return { ok: null, detail: { reason: "step-not-run-or-gated-off" } };
      return { ok: step.ok === true, detail: { status: step.status } };
    case "step-observed-text": {
      if (!step) return { ok: null, detail: { reason: "step-not-run" } };
      const observed = step.detail?.observed ?? "";
      const re = new RegExp(exp.match, "i");
      return { ok: re.test(observed), detail: { observed: observed.slice(0, 160) } };
    }
    case "ledger-outcome": {
      const ledger = chapterRec?.requestLedger;
      if (!Array.isArray(ledger)) return { ok: null, detail: { reason: "ledger-unobserved" } };
      return { ok: ledger.some((e) => e.outcome === exp.outcome), detail: { outcomes: ledger.map((e) => e.outcome) } };
    }
    case "ledger-outcome-absent": {
      const ledger = chapterRec?.requestLedger;
      if (!Array.isArray(ledger)) return { ok: null, detail: { reason: "ledger-unobserved" } };
      return { ok: !ledger.some((e) => e.outcome === exp.outcome), detail: {} };
    }
    case "stream-ledger": {
      const entries = chapterRec?.streamLedger;
      if (!Array.isArray(entries) || entries.length === 0) {
        return { ok: null, detail: { reason: "stream-ledger-unobserved" } };
      }
      const entry = entries[exp.requestIndex ?? 0];
      if (!entry) return { ok: null, detail: { reason: "stream-request-unobserved" } };
      const actual = entry[exp.field];
      // undefined === undefined is NOT a pass: the field must be observed.
      if (actual === undefined) {
        return { ok: false, detail: { reason: "stream-field-absent", field: exp.field } };
      }
      if (exp.equals === undefined) {
        return { ok: Boolean(actual), detail: { actual } };
      }
      return { ok: actual === exp.equals, detail: { actual } };
    }
    case "hold-pass":
      if (!chapterRec?.hold) return { ok: null, detail: { reason: "hold-unobserved" } };
      return { ok: chapterRec.hold.verdict === "pass", detail: chapterRec.hold };
    case "settle-ok":
      if (!chapterRec?.settle) return { ok: null, detail: { reason: "settle-unobserved" } };
      return { ok: chapterRec.settle.ok === true, detail: { reason: chapterRec.settle?.reason } };
    case "panel-identity":
      if (!chapterRec?.panelIdentity) return { ok: null, detail: { reason: "panel-identity-unread" } };
      return { ok: chapterRec.panelIdentity.match === true, detail: chapterRec.panelIdentity };
    case "zero-provider-observed": {
      const ledger = chapterRec?.requestLedger;
      if (!Array.isArray(ledger)) return { ok: null, detail: { reason: "ledger-unobserved" } };
      const externalish = ledger.filter(
        (e) => e.outcome === "blocked-unexpected-external" || e.outcome === "failed-external-request",
      );
      return { ok: externalish.length === 0, detail: { externals: externalish.length } };
    }
    case "negative-rejects": {
      const neg = chapterRec?.negativeResults?.[exp.family];
      if (!neg) return { ok: null, detail: { reason: "negative-family-not-run" } };
      return { ok: neg.rejected === true, detail: neg };
    }
    default:
      return { ok: false, detail: { reason: "unreachable" } };
  }
}

/* --------------------------------------------------- negative predicates */

/**
 * The negative-family contract: each family is a predicate that MUST reject
 * the mutated artifact/step for the negative to be real. A family whose
 * predicate cannot discriminate is itself non-passing. The runners below are
 * the CONSUMING paths — the predicate is exercised through the same exported
 * consumers the run uses (deriveCaseArtifacts / buildRunManifest), so a hash
 * difference alone is never the proof: the consumer must actually refuse.
 */
export const NEGATIVE_PREDICATES = Object.freeze({
  // An altered case body must fail the authoritative-buffer digest check.
  "case-bytes-mutated": {
    family: "F-integrity",
    evaluate: ({ artifact, mutatedBytes }) => {
      const altered = sha256(mutatedBytes) !== artifact.sha256;
      return { rejected: altered, detail: { altered } };
    },
  },
  // A manifest whose cut claims a different parent must be refused.
  "wrong-film-parent": {
    family: "F-lineage",
    evaluate: ({ manifestResult }) => ({
      rejected: manifestResult.ok === false,
      detail: { problems: manifestResult.problems },
    }),
  },
});

/**
 * Consumer-level negative runners: each family mutates REAL chapter evidence
 * and pushes it through the ACTUAL consuming function. `runNegative` is what
 * runChapter invokes for each bound family — the result proves the consumer
 * rejected, not merely that bytes differed.
 *   contract — the pinned case-contract module (may be a controls double).
 *   buildManifest — film.mjs's buildRunManifest (injectable for order safety).
 */
export async function runNegativeFamily(family, ctx) {
  const pred = NEGATIVE_PREDICATES[family];
  if (!pred) return { rejected: false, detail: { reason: "unknown-negative-family", family } };
  if (family === "case-bytes-mutated") {
    const artifact = ctx.caseBinding?.artifact;
    const buffer = ctx.caseBinding?.buffer;
    if (!artifact || !buffer) {
      return { rejected: false, detail: { reason: "no-bound-case-to-mutate" } };
    }
    // Mutate the authoritative buffer, then run the SAME consumer path.
    const mutated = Buffer.from(buffer);
    mutated[0] ^= 0xff;
    let rejected = false;
    let detail = {};
    try {
      deriveCaseArtifacts({ path: artifact.path, sha256: artifact.sha256 }, { caseId: ctx.caseBinding.caseId, contract: ctx.caseContract, readFile: () => mutated });
      rejected = false; // the consumer accepted corrupted bytes — a real defect
    } catch (e) {
      rejected = true;
      detail = { consumerError: String(e?.message ?? e).slice(0, 200), consumer: "deriveCaseArtifacts" };
    }
    return { rejected, detail: { ...detail, digestDiffers: pred.evaluate({ artifact, mutatedBytes: mutated }).detail.altered } };
  }
  if (family === "wrong-film-parent") {
    // Mutate the REAL artifacts list: point the cut at a raw chapter instead
    // of the registered full uncut film, then run buildRunManifest itself.
    const arts = ctx.filmArtifacts;
    const fn = ctx.buildManifest;
    if (!Array.isArray(arts) || !arts.length || typeof fn !== "function") {
      return { rejected: false, detail: { reason: "no-film-artifacts-to-mutate" } };
    }
    const cut = arts.find((a) => a.stage === "concise-cut");
    const raw = arts.find((a) => a.stage === "raw-uncut");
    if (!cut || !raw) return { rejected: false, detail: { reason: "lineage-incomplete" } };
    const mutatedArts = arts.map((a) => (a === cut ? { ...a, derivedFrom: raw.path, derivedFromSha256: raw.sha256 } : a));
    const res = fn({ ...ctx.manifestArgs, artifacts: mutatedArts });
    return pred.evaluate({ manifestResult: res });
  }
  return { rejected: false, detail: { reason: "no-runner", family } };
}

/* ------------------------------------------------------ error classification
 * A page error or video/record error is non-passing. A request failure is
 * classified against the observed boundary ledger: a blocked external or a
 * denied undeclared write is EXPECTED controlled evidence, not a defect. */
export function classifyChapterErrors(errors = [], ledger = []) {
  const expectedOutcomes = new Set([
    "blocked-external-request",
    "denied-undeclared-post",
    "denied-undeclared-same-origin-write",
    "denied-stream-server-unavailable",
  ]);
  const ledgerBlockedUrls = new Set(
    (ledger ?? [])
      .filter((e) => expectedOutcomes.has(e.outcome))
      .map((e) => e.path ?? e.url ?? null)
      .filter(Boolean),
  );
  const unexpected = [];
  const expected = [];
  for (const e of errors) {
    if (!e || typeof e !== "object") { unexpected.push(e); continue; }
    if (
      e.kind === "requestfailed" &&
      (e.url?.path ? ledgerBlockedUrls.has(e.url.path) : true) &&
      e.blockedByBoundary === true
    ) {
      expected.push(e);
      continue;
    }
    if (e.kind === "http-error" && e.status === 404 && e.boundaryExpected === true) {
      expected.push(e);
      continue;
    }
    unexpected.push(e);
  }
  return { unexpected, expected };
}

/* ---------------------------------------------------------- the reducers */

const NONPASS_STEP_STATUSES = new Set([
  "dispatch-failed", "precondition-unmet", "unknown-action",
  "armed-not-observed", "assertion-failed",
]);

/**
 * Chapter verdict — the honest aggregation:
 *   pass:    every executed step ok, no armed-not-observed, settle ok, hold
 *            pass, panel identity matching when read, every bound
 *            expectation true, every bound negative rejected, no unexpected
 *            page/video/request errors.
 *   unknown: something needed for a verdict was never observed.
 *   fail:    any failed step/assertion/hold/expectation/negative or any
 *            unexpected error.
 * Skipped-profile / skipped-case-prerequisite steps are NEUTRAL; a chapter
 * in which NO step ran is unknown, not pass.
 */
export function reduceChapterVerdict(rec) {
  const steps = rec?.steps ?? [];
  const failures = [];
  const unknowns = [];
  let ran = 0;
  for (const s of steps) {
    if (s.ok === false) failures.push(`${s.action}:${s.status}`);
    if (s.status === "skipped-profile" || s.status === "skipped-case-prerequisite") continue;
    if (s.ok === true) ran++;
    if (s.status === "case-prerequisite-unbound") unknowns.push(`${s.action}:unbound`);
  }
  if (rec?.settle && rec.settle.ok === false) failures.push(`settle:${rec.settle.reason}`);
  if (rec?.hold && rec.hold.verdict === "fail") failures.push(`hold:${rec.hold.reason}`);
  if (rec?.hold && rec.hold.verdict === "skipped") unknowns.push("hold-skipped");
  if (
    rec?.panelIdentity &&
    rec.panelIdentity.match === false &&
    (rec.panelIdentity.selectedTabId || rec.panelIdentity.panelId)
  ) failures.push("panel-identity-mismatch");

  // Bound expectations and negative families — actually evaluated, not gate data.
  for (const [i, r] of (rec?.expectationResults ?? []).entries()) {
    if (r.ok === false) failures.push(`expectation[${i}]:${r.expectation?.kind ?? "?"}-false`);
    if (r.ok === null) unknowns.push(`expectation[${i}]:${r.expectation?.kind ?? "?"}-unobserved`);
  }
  for (const [fam, r] of Object.entries(rec?.negativeResults ?? {})) {
    if (r.rejected !== true) failures.push(`negative:${fam}-not-rejected`);
  }
  const boundNegatives = rec?.negativesBound ?? [];
  for (const fam of boundNegatives) {
    if (!(fam in (rec?.negativeResults ?? {}))) unknowns.push(`negative:${fam}-not-run`);
  }

  // Unexpected page/video/request errors are non-passing; intentionally
  // boundary-blocked entries are classified expected, not blanket-failed.
  const errs = classifyChapterErrors(rec?.errors ?? [], rec?.requestLedger ?? []);
  for (const e of errs.unexpected) {
    failures.push(`error:${e.kind ?? "unknown"}:${String(e.message ?? e.failure ?? e.status ?? "").slice(0, 80)}`);
  }
  if (rec?.video && rec.video.error) failures.push(`video:${rec.video.error}`);
  if (rec?.status === "interrupted") failures.push("chapter-interrupted");

  if (failures.length) return { verdict: "fail", failures, unknowns, stepsRun: ran };
  if (unknowns.length || ran === 0) return { verdict: "unknown", failures, unknowns, stepsRun: ran };
  return { verdict: "pass", failures, unknowns, stepsRun: ran };
}

/**
 * Run verdict over chapter records + lifecycle/film outcomes.
 * A run PASSES only when every chapter passes, nothing interrupted, cleanup
 * succeeded overall (including the driver-owned stream server), and — when a
 * film stage was requested — the film manifest is ok. Unknown/unfinished
 * parts make the run unknown; a failed film or cleanup is non-passing.
 */
export function reduceRunVerdict(chapters = [], { interrupted = null, cleanup = null, film = null, negatives = null } = {}) {
  const chapterVerdicts = chapters.map((c) => ({ chapter: c.chapterId, profile: c.profile, verdict: c.verdict?.verdict ?? "unknown" }));
  const failed = chapterVerdicts.filter((c) => c.verdict === "fail");
  const unknown = chapterVerdicts.filter((c) => c.verdict === "unknown");
  const parts = { chapters: chapterVerdicts };
  if (interrupted) parts.interrupted = interrupted;
  if (film && film.stage !== "not-started" && film.stage !== "complete") parts.film = film.stage;
  if (failed.length || interrupted) {
    return { verdict: "fail", ...parts, reason: "one or more chapters failed or the run was interrupted" };
  }
  if (unknown.length || chapters.length === 0) {
    return { verdict: "unknown", ...parts, reason: "unobserved or unrun chapters" };
  }
  if (cleanup) {
    if (cleanup.overall === "failure") {
      return { verdict: "fail", ...parts, reason: "cleanup failure" };
    }
    if (cleanup.overall !== "success") {
      return { verdict: "unknown", ...parts, reason: `cleanup overall is ${cleanup.overall}` };
    }
    // A driver-owned stream server that failed to close is non-passing even
    // when every other handle closed — no absent-handle green.
    if (typeof cleanup.streamServer === "string" && cleanup.streamServer !== "closed") {
      return { verdict: "fail", ...parts, reason: `streamServer ${cleanup.streamServer}` };
    }
    if (cleanup.streamServer === undefined || cleanup.streamServer === null) {
      // Not recorded at all is UNKNOWN — never implied closed.
      return { verdict: "unknown", ...parts, reason: "streamServer cleanup unrecorded" };
    }
  }
  if (film) {
    if (film.stage === "failed" || film.ok === false) {
      return { verdict: "fail", ...parts, reason: "film stage failed or manifest rejected" };
    }
    if (film.stage !== "complete" && film.stage !== "not-started" && film.stage !== "disabled") {
      return { verdict: "unknown", ...parts, reason: `film stage unfinished: ${film.stage}` };
    }
  }
  // Bound run-scope negative families: a bound family that ran and did not
  // reject is a failure; one that never ran is unknown. Both are non-passing.
  if (negatives) {
    const bound = negatives.bound ?? Object.keys(negatives.results ?? {});
    for (const fam of bound) {
      if (!(fam in (negatives.results ?? {}))) {
        return { verdict: "unknown", ...parts, reason: `negative family ${fam} was bound but never ran` };
      }
      if (negatives.results[fam]?.rejected !== true) {
        return { verdict: "fail", ...parts, reason: `negative family ${fam} was not rejected` };
      }
    }
  }
  return { verdict: "pass", ...parts };
}

/* ---------------------------------------------------- case derivation ==== */

/**
 * The consumer-side case-contract interface — the PRODUCER-owned module
 * (ct-jev-proof recorder-contract: case-contract.mjs, sha256 a7ac0278…,
 * integrated byte-exact into this stage). A bound contract MUST export the
 * producer surface:
 *   deriveCaseArtifacts(artifact, {caseId, input, localMedia, streamPlanOpts})
 *     -> { caseId, sha256, buffer, result, cacheSeedObject, cacheSeedJson,
 *          events, attributes, divergence {fromId,toId,…},
 *          occurrences {all,byId,bySection,count}, declaredMedia,
 *          inlineMedia, unresolvedImageUrls, inputOwnership, streamPlan? }
 *   deriveAttributes(events, result, {input})
 *   occurrenceIndex(result)
 *   resolveInputOwnership(input, result, {caseId})
 *   loadLocalMediaDeclaration(decl, {readFile})
 *
 * Presence of a function is never authority — the module is pinned by
 * digest at the run gate, CALLED here, and its honest typing guard is
 * probed (the terminal EVENT envelope must throw when passed as the
 * result). A throwing or shape-lying contract is a refusal.
 */
export function assertCaseContract(contract) {
  if (!contract || typeof contract !== "object") {
    throw new Error("case contract is UNBOUND — deriveCaseArtifacts requires the pinned case-contract module");
  }
  for (const fn of ["deriveCaseArtifacts", "deriveAttributes", "occurrenceIndex", "resolveInputOwnership", "loadLocalMediaDeclaration"]) {
    if (typeof contract[fn] !== "function") {
      throw new Error(`case contract is missing required export ${fn}`);
    }
  }
  // Probe the honest typing guard — passing the EVENT ENVELOPE where the
  // RESULT belongs was the 036 defect class; a real contract refuses it.
  let guarded = false;
  try {
    contract.deriveAttributes([], { type: "investigation.completed", result: {} });
  } catch {
    guarded = true;
  }
  if (!guarded) {
    throw new Error("case contract accepted the event envelope as the result — refusing unverified authority");
  }
  // Probe the index builder: an unusable shape is a refusal, not a pass.
  const probe = contract.occurrenceIndex({ timeline: [{ occurrenceId: "__probe__", title: "t" }] });
  if (probe?.count !== 1 || probe?.byId?.__probe__?.occurrenceId !== "__probe__") {
    throw new Error("case contract occurrenceIndex returned an unusable index — refused");
  }
  return contract;
}

/**
 * Consumer-side derivation through the PINNED producer contract. The
 * artifact {path, sha256} is digest-checked HERE as well as inside the
 * contract (a consumer never forwards unverified bytes). The separately-
 * hashed local-media declaration is loaded through the contract's own
 * loader — every declared asset's bytes are re-hashed, and `assetReadFile`
 * may remap declared asset paths to the stage-local verified copies.
 * Afterwards EVERY declared urlBinding is scope-checked against THIS
 * case's retrieved imageUrl set: an out-of-scope URL refuses the binding,
 * never silently narrows.
 *
 * `input` is the declared input/entry ownership descriptor the contract
 * normalizes: {entry:"controlled-post"|"cache-restore", submittedMedia,
 * claimText} — the ONLY source of submitted-preview availability.
 */
export function deriveCaseArtifacts(artifact, {
  caseId, contract,
  readFile = fs.readFileSync,
  assetReadFile = null,
  mediaArtifact = null,       // separately-hashed LOCAL_MEDIA_ARTIFACT {path, sha256}
  input = null,               // declared entry/input ownership descriptor
  streamPlanOpts = null,      // {holds,paceMs,faultAtSegment,faultKind}
} = {}) {
  if (!artifact || typeof artifact.path !== "string" || !/^[0-9a-f]{64}$/.test(artifact.sha256 ?? "")) {
    throw new Error(`case ${caseId ?? "?"}: artifact must carry {path, sha256(64-hex)}`);
  }
  const buffer = readFile(artifact.path);
  const actual = sha256(buffer);
  if (actual !== artifact.sha256) {
    throw new Error(`case ${caseId ?? "?"}: byte digest ${actual.slice(0, 16)}… != declared ${artifact.sha256.slice(0, 16)}… — refused, never substituted`);
  }

  assertCaseContract(contract);

  let localMedia = null;
  if (mediaArtifact) {
    const mediaBytes = readFile(mediaArtifact.path);
    const mediaActual = sha256(mediaBytes);
    if (mediaArtifact.sha256 && mediaActual !== mediaArtifact.sha256) {
      throw new Error(`LOCAL_MEDIA_ARTIFACT digest ${mediaActual.slice(0, 16)}… != declared — refused`);
    }
    let declared;
    try {
      declared = JSON.parse(mediaBytes.toString("utf8"));
    } catch {
      throw new Error("LOCAL_MEDIA_ARTIFACT is not parseable JSON — refused");
    }
    localMedia = contract.loadLocalMediaDeclaration(declared, {
      readFile: assetReadFile ?? readFile,
    });
  }

  // The pinned contract derives EVERYTHING from exactly these bytes.
  const artifacts = contract.deriveCaseArtifacts(
    { path: artifact.path, sha256: artifact.sha256 },
    { caseId, input, localMedia, streamPlanOpts },
  );
  if (!artifacts?.result || typeof artifacts.result !== "object") {
    throw new Error(`case ${caseId}: contract returned no result object — refused`);
  }

  // Scope check (consumer responsibility): every declared urlBinding must
  // name a retrieved imageUrl of THIS case — a foreign declaration refuses.
  if (localMedia) {
    const urls = new Set((artifacts.occurrences?.all ?? []).map((o) => o.imageUrl).filter(Boolean));
    const outside = Object.keys(localMedia.declaredMedia ?? {}).filter((u) => !urls.has(u));
    if (outside.length) {
      throw new Error(`LOCAL_MEDIA_ARTIFACT declares URLs outside the case's retrieved-image scope: ${outside.join(", ")}`);
    }
  }
  return artifacts;
}
