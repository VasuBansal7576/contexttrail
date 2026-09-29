/**
 * Offline derivative of the S3 planned-vs-observed request projection.
 *
 * A stream-ownership drive plans two requests. The ledger only ever contains
 * what actually reached the transport, so the projection must keep a
 * planned-but-unsent request UNOBSERVED — with a reason and null observed-only
 * fields — instead of fabricating a row that looks like it happened. A check
 * that can only pass proves nothing, so this exercises the REAL exported
 * predicate against a missing request, an empty ledger and an unplanned extra
 * request, and must report them honestly.
 *
 *   node fixtures/controls/request-projection.mjs
 */
import { projectRequestObservations } from "../../cli/control-contexttrail.mjs";

const planned = [
  { request: 0, fixture: "controlled-pair", investigationId: "inv-a" },
  { request: 1, fixture: "controlled-insufficient", investigationId: "inv-b" },
];
const sha = (c) => c.repeat(64);
const ledgerRow = (index, fixture) => ({
  index,
  fixture,
  sentClaimSha256: sha("a"),
  sentClaimBytes: 52,
  sentMediaName: "investigation-image",
  sentMediaBytes: 560,
  imageEntryMethod: "setInputFiles",
  eventsWritten: 61,
  clientClosed: true,
  endedByServer: false,
  lateAttempts: [{ delivered: false, reason: "client aborted" }],
});

let failures = 0;
const expect = (name, cond, detail) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

// Positive: both planned requests observed, with their real fields carried.
const both = projectRequestObservations(planned, [
  ledgerRow(0, "controlled-pair"),
  ledgerRow(1, "controlled-insufficient"),
]);
expect(
  "both requests OBSERVED",
  both.requests.every((r) => r.observed === true && r.status === "OBSERVED" && r.unobservedReason === null),
);
expect(
  "observed rows carry the real claim/media identity",
  both.requests.every(
    (r) => r.sentClaimSha256 === sha("a") && r.sentMediaName === "investigation-image" && r.fixtureAgrees === true,
  ),
);
expect("no unplanned rows", both.unplanned.length === 0);

// The case the finalizer exists for: B was planned but the drive ended before
// it was sent. It must be UNOBSERVED — never fabricated into an observed row.
const unsent = projectRequestObservations(planned, [ledgerRow(0, "controlled-pair")]);
const b = unsent.requests[1];
expect("request 0 OBSERVED", unsent.requests[0].observed === true);
expect(
  "planned-but-unsent request is UNOBSERVED with a reason",
  b.observed === false && b.status === "UNOBSERVED" && typeof b.unobservedReason === "string" && b.unobservedReason.length > 0,
);
expect(
  "UNOBSERVED row fabricates nothing",
  b.sentClaimSha256 === null && b.sentClaimBytes === null && b.sentMediaBytes === null && b.eventsWritten === null &&
    b.clientClosed === null && b.lateAttempts === null,
);

// Empty ledger: everything planned is unobserved, not absent.
const none = projectRequestObservations(planned, []);
expect("empty ledger -> every planned request UNOBSERVED", none.requests.every((r) => r.status === "UNOBSERVED"));

// A request the plan never named must surface as unplanned, not vanish.
const extra = projectRequestObservations(planned, [
  ledgerRow(0, "controlled-pair"),
  ledgerRow(1, "controlled-insufficient"),
  ledgerRow(2, "controlled-claim"),
]);
expect("unplanned request is surfaced", extra.unplanned.length === 1 && extra.unplanned[0].index === 2);

// An observed request served from a DIFFERENT fixture than planned is a real
// divergence and is reported, not papered over.
const wrongFixture = projectRequestObservations(planned, [
  ledgerRow(0, "controlled-claim"),
  ledgerRow(1, "controlled-insufficient"),
]);
expect(
  "fixture divergence is reported",
  wrongFixture.requests[0].observed === true && wrongFixture.requests[0].fixtureAgrees === false,
);

console.log(failures === 0 ? "PASS: the projection is honest" : `FAIL: ${failures} expectation(s) failed`);
process.exit(failures === 0 ? 0 : 1);
