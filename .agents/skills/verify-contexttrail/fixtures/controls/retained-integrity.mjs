/**
 * Offline derivative of the seal-time retained-stream integrity assertion.
 *
 * The drive writes the exact buffer each request was served from as a durable
 * per-request file, and checks at seal time that the file on disk is still those
 * bytes. A check that can only pass proves nothing, so this exercises the SAME
 * predicate against a lost file and a corrupted file and must report both as
 * failures. It needs no browser and no run.
 *
 *   node fixtures/controls/retained-integrity.mjs <drive-dir>
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: node retained-integrity.mjs <drive-dir>");
  process.exit(2);
}
const manifest = JSON.parse(fs.readFileSync(path.join(dir, "retained-streams.json"), "utf8"));

// The same predicate the drive uses.
const verify = (rows) =>
  rows.map((r) => {
    const p = path.join(dir, r.file);
    if (!fs.existsSync(p)) return { file: r.file, matches: false, why: "retained file is missing" };
    const actual = fs.readFileSync(p);
    const sha = crypto.createHash("sha256").update(actual).digest("hex");
    return {
      file: r.file,
      matches: sha === r.sha256 && actual.length === r.bytes,
      why: sha === r.sha256 && actual.length === r.bytes ? "byte-identical" : "retained bytes differ from the captured buffer",
    };
  });

const baseline = verify(manifest.streams);
console.log("as sealed:", baseline.map((r) => `${r.file} ${r.matches ? "OK" : "FAIL"} (${r.why})`).join("; "));

// LOST file: a name that genuinely does not exist. An earlier version of this
// derivative WROTE the file before verifying it, so "lost" was never actually lost
// and the case reported green — the control proving nothing.
const lostRows = verify([{ ...manifest.streams[0], file: "stream-request-0-never-written.ndjson" }]);
console.log("file lost:", lostRows[0].matches ? "PASS (BAD - should be red)" : `RED (${lostRows[0].why})`);
const backup = fs.readFileSync(path.join(dir, manifest.streams[0].file));

// corrupted file: same length, one byte changed
const corrupt = path.join(dir, "stream-request-0-corrupt.ndjson");
const flipped = Buffer.from(backup);
flipped[10] = flipped[10] === 0x61 ? 0x62 : 0x61;
fs.writeFileSync(corrupt, flipped);
const corruptRows = verify([{ ...manifest.streams[0], file: "stream-request-0-corrupt.ndjson" }]);
console.log("file corrupted:", corruptRows[0].matches ? "PASS (BAD - should be red)" : `RED (${corruptRows[0].why})`);

fs.unlinkSync(corrupt);
const allRed = baseline.every((r) => r.matches) && !lostRows[0].matches && !corruptRows[0].matches;
console.log(allRed ? "PASS: the integrity predicate discriminates" : "FAIL: the predicate does not discriminate");
process.exit(allRed ? 0 : 1);
