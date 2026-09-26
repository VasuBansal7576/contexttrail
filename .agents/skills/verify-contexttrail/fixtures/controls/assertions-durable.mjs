/**
 * Offline derivative of the recorder-durability invariant.
 *
 * A drive used to close its assertions.jsonl stream inside the finally and
 * then push `fault.sabotage-reported` (and possibly `drive.videos-collected`)
 * AFTER the close: the entries landed in the in-memory count the terminal and
 * drive.json reported, but never reached the durable file — drive.json claimed
 * 18 PASS while assertions.jsonl held 17 and the seal counted 44, not 45.
 *
 * This exercises the REAL exported Recorder: every push made before close must
 * be on disk after `await rec.close()` returns, the totals derived from the
 * durable file must equal the reported counts, and a push after close must be
 * a loud throw rather than a silently lost assertion.
 *
 *   node fixtures/controls/assertions-durable.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Recorder } from "../../cli/control-contexttrail.mjs";

let failures = 0;
const expect = (name, cond, detail) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-recorder-"));
try {
  const rec = new Recorder(dir);
  rec.push("a.first", "PASS", "one");
  rec.push("a.second", "INFO", "two");
  // The regression shape: the LAST pushes are the bookkeeping ones.
  rec.push("fault.sabotage-reported", "PASS", "1 mutation(s)");
  rec.push("drive.completed", "PASS", "done");
  await rec.close();

  const durable = fs
    .readFileSync(path.join(dir, "assertions.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const durableCounts = {
    pass: durable.filter((e) => e.status === "PASS").length,
    fail: durable.filter((e) => e.status === "FAIL").length,
    info: durable.filter((e) => e.status === "INFO").length,
  };
  const reported = rec.counts();

  expect("every pushed entry reached the durable file", durable.length === 4, `${durable.length} lines`);
  expect("the late final control is on disk", durable.some((e) => e.id === "fault.sabotage-reported"));
  expect(
    "durable totals equal reported totals",
    durableCounts.pass === reported.pass && durableCounts.fail === reported.fail && durableCounts.info === reported.info,
    `durable ${durableCounts.pass}P/${durableCounts.fail}F/${durableCounts.info}I vs reported ${reported.pass}P/${reported.fail}F/${reported.info}I`,
  );

  let threw = false;
  try {
    rec.push("a.late", "PASS", "after close");
  } catch {
    threw = true;
  }
  expect("a push after close throws rather than vanishing", threw);

  const after = fs.readFileSync(path.join(dir, "assertions.jsonl"), "utf8").split("\n").filter(Boolean);
  expect("the thrown push left the durable file unchanged", after.length === 4);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? "PASS: recorded totals and durable totals cannot diverge" : `FAIL: ${failures} expectation(s) failed`);
process.exit(failures === 0 ? 0 : 1);
