/**
 * Offline derivative of the S2 one-buffer invariant, against the REAL code.
 *
 * The drive used to assert the served stream derived from the retained buffer
 * with a line-COUNT and non-empty check — a same-count content change, a wrong
 * investigation id or a wrong sha256 all sailed through green. This control
 * exercises the actual exported pipeline: a real startStreamServer, a real
 * planSequence (ONE filesystem read, counted), then the real
 * verifyStreamBufferProvenance predicate — including the case where a second
 * offered read would return DISSIMILAR bytes, proving the retained state is
 * bound to the buffer that was actually served, not to whatever the fixture
 * file happens to contain later.
 *
 *   node fixtures/controls/stream-buffer-provenance.mjs
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startStreamServer, verifyStreamBufferProvenance } from "../../cli/control-contexttrail.mjs";

let failures = 0;
const expect = (name, cond, detail) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

const CONTROLS_RETAINED = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "retained",
);
const FIXTURE = "ctrl-one-read-provenance";
const fixtureFile = path.join(CONTROLS_RETAINED, `${FIXTURE}.ndjson`);

// A self-describing NDJSON stream: investigation id, a stage lifecycle and a
// terminal event — enough for buildSegments to hold a barrier mid-stream.
const linesV1 = [
  { type: "investigation.started", investigationId: "inv-ctrl-one-read" },
  { type: "stage.started", stage: "harvest" },
  { type: "evidence.discovered", evidence: { title: "Control row one" } },
  { type: "stage.completed", stage: "harvest" },
  { type: "evidence.discovered", evidence: { title: "Control row two" } },
  { type: "stage.started", stage: "synthesize" },
  { type: "stage.completed", stage: "synthesize" },
  { type: "investigation.completed", investigationId: "inv-ctrl-one-read", result: { status: "answered" } },
];
// The second offered read: SAME line count and shape, DIFFERENT content — the
// exact case the old count-only check could not see.
const linesV2 = linesV1.map((l, i) =>
  i === 0 ? { ...l, investigationId: "inv-ctrl-second-read" } : { ...l, mutated: true },
);

const writeFixture = (lines) =>
  fs.writeFileSync(fixtureFile, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

const v2Sha = () => crypto.createHash("sha256").update(fs.readFileSync(fixtureFile)).digest("hex");

fs.mkdirSync(CONTROLS_RETAINED, { recursive: true });
let stream = null;
try {
  writeFixture(linesV1);
  const bytesV1 = fs.readFileSync(fixtureFile);

  stream = await startStreamServer();
  stream.planSequence([{ fixture: FIXTURE, holds: 1 }]);
  const st = stream.state.sequence[0];
  const reads = stream.state.fixtureReads[FIXTURE];

  // The file is now different — a second offered read would be DISSIMILAR.
  writeFixture(linesV2);
  expect("the second offered read really is dissimilar", v2Sha() !== crypto.createHash("sha256").update(bytesV1).digest("hex"));

  // Positive: the retained state is bound to the FIRST buffer, exactly.
  const pos = verifyStreamBufferProvenance(st, reads);
  expect("one-read plan validates against its own retained buffer", pos.ok === true, pos.problems.join("; "));
  expect("the retained buffer IS the bytes that were read", st.buffer.equals(bytesV1));
  expect("the read was counted exactly once", reads === 1, `${reads} read(s)`);
  expect("segments flatten to the buffer's exact normalized lines",
    st.segments.flat().join("\n") === bytesV1.toString("utf8").split("\n").filter((l) => l.trim()).join("\n"));

  // Negative: same line COUNT, one changed line — the old check's false green.
  const segLines = st.segments.flat();
  const tampered = [...segLines];
  tampered[2] = JSON.stringify({ type: "evidence.discovered", evidence: { title: "A different row" } });
  const sameCount = verifyStreamBufferProvenance({ ...st, segments: [tampered] }, reads);
  expect("same-line-count changed segments are RED", sameCount.ok === false,
    sameCount.problems.find((p) => p.includes("line sequence")));

  const wrongId = verifyStreamBufferProvenance({ ...st, id: "inv-forged" }, reads);
  expect("a wrong investigation id is RED", wrongId.ok === false, wrongId.problems.find((p) => p.includes("id")));

  const wrongSha = verifyStreamBufferProvenance({ ...st, sha256: "f".repeat(64) }, reads);
  expect("a wrong sha256 is RED", wrongSha.ok === false, wrongSha.problems.find((p) => p.includes("sha256")));

  const wrongBytes = verifyStreamBufferProvenance({ ...st, bytes: st.bytes + 1 }, reads);
  expect("a wrong byte count is RED", wrongBytes.ok === false, wrongBytes.problems.find((p) => p.includes("byte")));

  const repeatedRead = verifyStreamBufferProvenance(st, 2);
  expect("a fixture read twice is RED", repeatedRead.ok === false, repeatedRead.problems.find((p) => p.includes("read")));

  // And a REAL second planSequence call reads the mutated file: the state it
  // produces is honestly different — proving the first plan is bound to the
  // buffer it served, not to the fixture name.
  await stream.close();
  stream = await startStreamServer();
  stream.planSequence([{ fixture: FIXTURE, holds: 1 }]);
  const st2 = stream.state.sequence[0];
  expect("a second planSequence really reads dissimilar bytes", !st2.buffer.equals(st.buffer));
  expect("and is bound to ITS buffer, honestly", verifyStreamBufferProvenance(st2, stream.state.fixtureReads[FIXTURE]).ok === true);
} finally {
  await stream?.close().catch(() => {});
  fs.rmSync(fixtureFile, { force: true });
}

console.log(failures === 0 ? "PASS: the provenance predicate discriminates" : `FAIL: ${failures} expectation(s) failed`);
process.exit(failures === 0 ? 0 : 1);
