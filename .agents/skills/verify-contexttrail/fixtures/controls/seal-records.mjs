/**
 * Structural drive-record seal classification (F38-5), exercised through the
 * REAL `evidence` command — `node cli/control-contexttrail.mjs evidence
 * --run-id <id> --checkout <tmp>` — on synthetic run directories. No browser,
 * no server, no product code: just drive.json + assertions.jsonl fixtures and
 * the maintained seal.
 *
 * The contract: a structurally invalid record is a seal ERROR at exit 2 no
 * matter which outcome it claims (unknown "GREEN", malformed PASS, malformed
 * FAIL, malformed INCOMPLETE), while a legitimate complete FAIL and an honest
 * INCOMPLETE recording are well-formed records that seal at exit 0 as
 * inspectable failed/incomplete tests — recorded assertions that disagree
 * with the durable counts are also a seal error.
 *
 *   node fixtures/controls/seal-records.mjs
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, "../../cli/control-contexttrail.mjs");

let failures = 0;
const results = [];
const expect = (name, cond, detail) => {
  results.push({ name, ok: cond === true, detail: detail ?? null });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

let n = 0;
/** Build a synthetic run dir under a private temp checkout and return
 *  {checkout, runId, evidenceDir}. Each drive entry: {id, record, assertions}. */
function makeRun(drives) {
  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), "ct-seal-"));
  const runId = `ctl-seal-${process.pid}-${n++}`;
  const runDir = path.join(checkout, ".verify", runId);
  const evDir = path.join(runDir, "evidence");
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, "manifest.json"),
    JSON.stringify({ revision: "control", buildId: "control", live: false }) + "\n",
  );
  for (const d of drives) {
    const dd = path.join(evDir, "drives", d.id);
    fs.mkdirSync(dd, { recursive: true });
    fs.writeFileSync(path.join(dd, "drive.json"), JSON.stringify(d.record, null, 2) + "\n");
    fs.writeFileSync(
      path.join(dd, "assertions.jsonl"),
      d.assertions.map((a) => JSON.stringify(a)).join("\n") + "\n",
    );
  }
  return { checkout, runId, evDir };
}

const driveRecord = (id, over = {}) => ({
  driveId: id,
  feature: "result",
  outcome: "PASS",
  complete: true,
  assertions: { pass: 2, fail: 0, info: 1 },
  failure: null,
  ...over,
});
const lines = (pass = 0, fail = 0, info = 0) => [
  ...Array.from({ length: pass }, (_, i) => ({ id: `p${i}`, status: "PASS", detail: "x" })),
  ...Array.from({ length: fail }, (_, i) => ({ id: `f${i}`, status: "FAIL", detail: "x" })),
  ...Array.from({ length: info }, (_, i) => ({ id: `i${i}`, status: "INFO", detail: "x" })),
];

/** Run the real seal and return {code, manifest}. */
function seal(checkout, runId) {
  const r = spawnSync(process.execPath, [CLI, "evidence", "--run-id", runId, "--checkout", checkout], {
    encoding: "utf8",
  });
  const manifestPath = path.join(checkout, ".verify", runId, "evidence", "evidence-manifest.json");
  return {
    code: r.status,
    stderr: (r.stderr ?? "").trim().slice(0, 300),
    manifest: fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : null,
  };
}

/* ----- positive: a well-formed run seals at exit 0, whatever the verdicts - */
{
  const { checkout, runId } = makeRun([
    { id: "001-pass", record: driveRecord("001-pass"), assertions: lines(2, 0, 1) },
    {
      id: "002-fail",
      record: driveRecord("002-fail", {
        outcome: "FAIL",
        assertions: { pass: 2, fail: 1, info: 0 },
        failure: "viewer.focus-restored-after-close: settled on body",
      }),
      assertions: lines(2, 1, 0),
    },
    {
      id: "003-incomplete",
      record: driveRecord("003-incomplete", {
        outcome: "INCOMPLETE",
        complete: false,
        assertions: { pass: 1, fail: 0, info: 0 },
      }),
      assertions: lines(1, 0, 0),
    },
  ]);
  const r = seal(checkout, runId);
  expect("a valid PASS + valid FAIL + valid INCOMPLETE run seals at exit 0", r.code === 0, `exit=${r.code} ${r.stderr}`);
  expect("legitimate FAIL/INCOMPLETE records stay inspectable, not integrity failures",
    r.manifest !== null && (r.manifest.malformedRecords ?? []).length === 0 &&
    r.manifest.drives.find((d) => d.driveId === "002-fail")?.recordVerdict?.ok === true &&
    r.manifest.drives.find((d) => d.driveId === "003-incomplete")?.recordVerdict?.ok === true);
  fs.rmSync(checkout, { recursive: true, force: true });
}

/* ----- unknown outcome: "GREEN" must NOT seal ----- */
{
  const { checkout, runId } = makeRun([
    { id: "001-green", record: driveRecord("001-green", { outcome: "GREEN" }), assertions: lines(2, 0, 1) },
  ]);
  const r = seal(checkout, runId);
  expect("an unknown outcome (GREEN) is a non-zero seal", r.code === 2, `exit=${r.code}`);
  expect("the seal names the malformed record", r.manifest?.malformedRecords?.[0]?.driveId === "001-green",
    JSON.stringify(r.manifest?.malformedRecords ?? null));
  fs.rmSync(checkout, { recursive: true, force: true });
}

/* ----- malformed PASS: missing assertions block ----- */
{
  const { checkout, runId } = makeRun([
    { id: "001-bad", record: driveRecord("001-bad", { assertions: undefined }), assertions: lines(2, 0, 1) },
  ]);
  const r = seal(checkout, runId);
  expect("a malformed PASS record is a non-zero seal", r.code === 2, `exit=${r.code}`);
  expect("the malformed PASS is named", r.manifest?.malformedRecords?.[0]?.driveId === "001-bad");
  fs.rmSync(checkout, { recursive: true, force: true });
}

/* ----- malformed FAIL: no failed assertion and no failure record ----- */
{
  const { checkout, runId } = makeRun([
    { id: "001-bad", record: driveRecord("001-bad", { outcome: "FAIL", assertions: { pass: 2, fail: 0, info: 0 } }), assertions: lines(2, 0, 0) },
  ]);
  const r = seal(checkout, runId);
  expect("a FAIL with no failure evidence is a non-zero seal", r.code === 2, `exit=${r.code}`);
  fs.rmSync(checkout, { recursive: true, force: true });
}

/* ----- malformed INCOMPLETE: complete=true cannot record INCOMPLETE ----- */
{
  const { checkout, runId } = makeRun([
    { id: "001-bad", record: driveRecord("001-bad", { outcome: "INCOMPLETE", complete: true }), assertions: lines(2, 0, 1) },
  ]);
  const r = seal(checkout, runId);
  expect("a complete drive recording INCOMPLETE is a non-zero seal", r.code === 2, `exit=${r.code}`);
  fs.rmSync(checkout, { recursive: true, force: true });
}

/* ----- PASS claiming failures: inconsistent verdict ----- */
{
  const { checkout, runId } = makeRun([
    { id: "001-bad", record: driveRecord("001-bad", { assertions: { pass: 2, fail: 1, info: 0 } }), assertions: lines(2, 1, 0) },
  ]);
  const r = seal(checkout, runId);
  expect("a PASS claiming a failed assertion is a non-zero seal", r.code === 2, `exit=${r.code}`);
  fs.rmSync(checkout, { recursive: true, force: true });
}

/* ----- durable-vs-recorded divergence: recorded totals the file lacks ----- */
{
  const { checkout, runId } = makeRun([
    { id: "001-divergent", record: driveRecord("001-divergent"), assertions: lines(1, 0, 1) },
  ]);
  const r = seal(checkout, runId);
  expect("a durable-vs-recorded count divergence is a non-zero seal", r.code === 2, `exit=${r.code}`);
  expect("the divergence is named per drive", (r.manifest?.assertionDivergence ?? []).some((d) => d.driveId === "001-divergent"),
    JSON.stringify(r.manifest?.assertionDivergence ?? null));
  fs.rmSync(checkout, { recursive: true, force: true });
}

/* ----- restored: the same run without the malformed drive seals clean ----- */
{
  const { checkout, runId } = makeRun([
    { id: "001-green", record: driveRecord("001-green", { outcome: "GREEN" }), assertions: lines(2, 0, 1) },
    { id: "002-good", record: driveRecord("002-good"), assertions: lines(2, 0, 1) },
  ]);
  const bad = seal(checkout, runId);
  fs.rmSync(path.join(checkout, ".verify", runId, "evidence", "drives", "001-green"), { recursive: true, force: true });
  fs.rmSync(path.join(checkout, ".verify", runId, "evidence", "evidence-manifest.json"), { force: true });
  const good = seal(checkout, runId);
  expect("a run with the malformed drive removed seals clean at exit 0", bad.code === 2 && good.code === 0,
    `before=${bad.code} after=${good.code}`);
  fs.rmSync(checkout, { recursive: true, force: true });
}

console.log(
  JSON.stringify({ control: "seal-records", checks: results.length, failures, ok: failures === 0 }),
);
console.log(failures === 0 ? "PASS: the seal rejects malformed records across all outcomes" : `FAIL: ${failures} expectation(s) failed`);
process.exit(failures === 0 ? 0 : 1);
