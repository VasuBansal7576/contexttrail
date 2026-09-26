import { describe, expect, it, vi } from "vitest";
import { ProviderError } from "../providers/http";
import {
  JevClient,
  JEV_ENDPOINT,
  JEV_MODEL,
  JEV_PROBABILITY_RETAINED_DECIMALS,
  JEV_WINNER_TIE_TOLERANCE,
  jevProbabilitySumTolerance,
  judgmentFromAnswers,
  pairwiseFromAnswers,
  resolveModelIdentity,
  verifiedPinnedModel,
  type JevModelIdentity,
} from "./client";
import {
  claimLocationEligibility,
  type LocationRejection,
  claimMayStateLocation,
  evidenceQuestions,
  evidenceQuestionsWithProvenance,
  PAIRWISE_QUESTION,
  RELEVANCE_QUESTION,
} from "./questions";

const noul = (n: number) => ({ type: "noul", noul: n });
const choice = (c: string, probs: Record<string, number>) => ({
  type: "choice",
  choice: c,
  probabilities: probs,
});
/** A Choice answer with no declared winner — malformed under the answer contract. */
const choiceNoWinner = (probs: Record<string, number>) => ({
  type: "choice",
  probabilities: probs,
});

const PAGE_ROLE_KEYS = ["REPORTING", "FACT_CHECK", "SOCIAL_REPOST", "AGGREGATOR", "COMMENTARY", "OTHER"];
const CONTEXT_KEYS = ["SAME_CONTEXT", "DIFFERENT_CONTEXT", "HISTORICAL_REFERENCE", "UNCLEAR"];
const CLAIM_KEYS = ["SUPPORTS", "CONTRADICTS", "NEUTRAL", "INSUFFICIENT"];
const PAIRWISE_KEYS = ["SAME_CONTEXT", "DIFFERENT_CONTEXT", "UNCLEAR"];
const LOCATION_KEYS = ["SAME_LOCATION", "DIFFERENT_LOCATION", "LOCATION_NOT_STATED", "UNCLEAR"];

/** A normalized distribution with `winner` on top and the rest split evenly. */
const probs = (keys: string[], winner: string, p = 0.8) =>
  Object.fromEntries(keys.map((k) => [k, k === winner ? p : (1 - p) / (keys.length - 1)]));

const sumsToOne = (values: number[]): Record<string, number> =>
  Object.fromEntries(PAGE_ROLE_KEYS.map((k, i) => [k, values[i]]));

const jsonResponse = (body: unknown) =>
  vi.fn().mockImplementation(async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );

const verified = resolveModelIdentity(JEV_MODEL, JEV_MODEL);
const unexpected = resolveModelIdentity(JEV_MODEL, "unexpected-model-v9");
const missing = resolveModelIdentity(JEV_MODEL, undefined);

const traceAnswers = {
  relevance: noul(0.9),
  page_role: choice("REPORTING", probs(PAGE_ROLE_KEYS, "REPORTING")),
};

const claimAnswers = {
  ...traceAnswers,
  context_relation: choice("DIFFERENT_CONTEXT", probs(CONTEXT_KEYS, "DIFFERENT_CONTEXT")),
  claim_relation: choice("CONTRADICTS", probs(CLAIM_KEYS, "CONTRADICTS")),
  location_relation: choice("SAME_LOCATION", probs(LOCATION_KEYS, "SAME_LOCATION", 0.7)),
};

const pairwiseAnswers = {
  pairwise_context: choice("SAME_CONTEXT", probs(PAIRWISE_KEYS, "SAME_CONTEXT")),
};

describe("evidenceQuestions", () => {
  it("trace mode asks relevance + page_role only", () => {
    expect(Object.keys(evidenceQuestions({ claimMode: false, claimHasLocation: false }))).toEqual([
      "relevance",
      "page_role",
    ]);
  });

  it("claim mode adds context/claim relations; location only when the claim states one", () => {
    expect(
      Object.keys(evidenceQuestions({ claimMode: true, claimHasLocation: false })),
    ).toEqual(["relevance", "page_role", "context_relation", "claim_relation"]);
    expect(
      Object.keys(evidenceQuestions({ claimMode: true, claimHasLocation: true })),
    ).toContain("location_relation");
  });

  it("location question is never asked in trace mode even when a location exists", () => {
    expect(
      Object.keys(evidenceQuestions({ claimMode: false, claimHasLocation: true })),
    ).not.toContain("location_relation");
  });
});

/* --------------------- §16.5 explicit-location gating --------------------- */

describe("claimLocationEligibility — the originally reproduced cases", () => {
  const cases: Array<[string, boolean]> = [
    ["London is where this image was taken.", true],
    ["This image was taken in london.", true],
    ["This image shows Alice smiling.", false],
    ["This image was taken in London.", true],
  ];

  it.each(cases)("%s => %s", (claim, expected) => {
    expect(claimMayStateLocation(claim)).toBe(expected);
  });
});

describe("claimLocationEligibility — positive place evidence only", () => {
  /**
   * A place is recognised only through a gazetteer entry, a place-type head
   * noun, or street-address morphology. Capitalization is never consulted, so
   * every case below turns on what the span *names*.
   */
  const mustAsk: Array<[string, string]> = [
    ["This image was taken in London.", "gazetteer"],
    ["This image was taken in london.", "gazetteer"],
    ["London is where this image was taken.", "gazetteer"],
    ["this photo is from Delhi today", "gazetteer"],
    ["This photo shows flooding in Delhi today", "gazetteer"],
    ["This image was taken in Bogota last night.", "gazetteer"],
    ["The protest happened in Paris.", "gazetteer"],
    ["This image is located in Gaza.", "gazetteer"],
    ["This photograph was taken near the Ganges.", "gazetteer"],
    ["This image was taken in front of the White House.", "gazetteer"],
    ["This image was taken in Hong Kong.", "gazetteer"],
    ["This image was taken in New Delhi.", "gazetteer"],
    ["This image was taken in sheffield.", "gazetteer"],
    ["This image was taken in são paulo.", "gazetteer"],
    ["This image is located in northern France.", "gazetteer"],
    ["This photo shows a protest in Tbilisi.", "gazetteer"],
    ["Paris, France: this image shows the flooding.", "gazetteer"],
    ["in Las Vegas", "gazetteer"],
    ["This image was taken at the airport.", "place_type_noun"],
    ["This image was taken at 10 Downing Street.", "street_address"],
    ["This image was taken next to the river.", "place_type_noun"],
    ["This image was filmed in the street.", "place_type_noun"],
    ["The fire started in a warehouse.", "place_type_noun"],
    ["This image was taken inside a subway station.", "place_type_noun"],
    ["The President spoke in the Oval Office about the economy.", "gazetteer"],
  ];

  it.each(mustAsk)("asks for %s", (claim, evidence) => {
    const r = claimLocationEligibility(claim);
    expect(r.eligible, claim).toBe(true);
    expect(r.outcome).toBe("eligible");
    expect(r.evidence).toContain(evidence);
  });

  /**
   * Beyond-frozen-list names that are nonetheless places, and the
   * person / platform / software / language / authorship objects that are not.
   */
  const mustNotAsk: Array<[string, string]> = [
    // person references, including names outside every list
    ["This photograph is from Alice.", "unrecognised_name"],
    ["This image was posted by Alice.", "no_locative_construction"],
    ["This image was taken by photographer John Smith.", "no_locative_construction"],
    ["We are looking at Alice.", "unrecognised_name"],
    ['A photo focusing "on Jordan smiling".', "topic_or_source_reference"],
    ["A photo focusing on Sarah laughing.", "topic_or_source_reference"],
    ["An image from Bob Dylan.", "unrecognised_name"],
    ["A portrait of Marie Curie.", "no_locative_construction"],
    ["This image shows a man in a suit.", "unrecognised_name"],
    ["This image shows a woman holding a phone.", "no_locative_construction"],
    ["This image shows a man named Mr President.", "no_locative_construction"],
    ["This image was taken at the reporter's desk.", "person_reference"],
    ["This image was taken from Mr Smith.", "person_reference"],
    ["This quote is from the minister.", "person_reference"],
    // publishers and authorship, not geography
    ["This photograph is from Reuters.", "non_place_reference"],
    ["This photograph is from the Guardian.", "non_place_reference"],
    ["This photograph is from the BBC.", "non_place_reference"],
    // software and tools
    ["This image was made in Photoshop.", "non_place_reference"],
    ["This image was made in Gimp.", "non_place_reference"],
    ["This image was made in Figma.", "non_place_reference"],
    ["This image was edited in Lightroom.", "non_place_reference"],
    // languages
    ["The caption is written in French.", "non_place_reference"],
    ["The caption is written in Tamil.", "non_place_reference"],
    ["The text is in Arabic.", "non_place_reference"],
    ["The sign is in Hebrew.", "non_place_reference"],
    // platforms
    ["This was posted on Bluesky.", "non_place_reference"],
    ["This was posted on Mastodon.", "non_place_reference"],
    ["This was posted on Pinterest.", "non_place_reference"],
    ["This image was posted on Discord.", "non_place_reference"],
    ["This image was shared on Twitter.", "non_place_reference"],
    // media, time, position, weather
    ["This image was published in the news.", "non_place_reference"],
    ["The photo is in the picture.", "non_place_reference"],
    ["This picture is in the album.", "non_place_reference"],
    ["This image is from a website.", "non_place_reference"],
    ["This happened in 2019.", "no_locative_construction"],
    ["This happened on Tuesday.", "temporal_reference"],
    ["This image shows the sky at night.", "temporal_reference"],
    ["This image was taken in reverse.", "non_place_reference"],
    ["This image was taken in black and white.", "non_place_reference"],
    ["This image was taken in focus.", "non_place_reference"],
    ["This image is in general detail.", "non_place_reference"],
    ["This image shows a flood today.", "no_locative_construction"],
    ["This image shows smoke in the distance.", "non_place_reference"],
    ["This image shows a child in the crowd.", "unrecognised_name"],
    ["This image was taken at the conference.", "unrecognised_name"],
    ["The President addressed the crowd.", "no_locative_construction"],
  ];

  it.each(mustNotAsk)("does not ask for %s", (claim, rejection) => {
    const r = claimLocationEligibility(claim);
    expect(r.eligible, claim).toBe(false);
    expect(r.rejectedBy, claim).toBe(rejection);
  });

  it("declines the question for an object in no script it can read, as unknown", () => {
    const r = claimLocationEligibility("This image was taken in 東京.");
    expect(r.eligible).toBe(false);
    // unknown, not a claim that the object is not a place
    expect(r.outcome).toBe("unknown");
    expect(r.rejectedBy).toBe("unrecognised_name");
    // and the name is still reported, rather than erased by the renderer
    expect(r.unresolved).toEqual(["東京"]);
  });

  it("keeps complete claim-bound spans instead of truncating at the first token", () => {
    expect(claimLocationEligibility("in Las Vegas").spans).toEqual(["Las Vegas"]);
    expect(claimLocationEligibility("in northern France").spans).toEqual(["northern France"]);
    // a sentence-final place noun is part of the span, not a new phrase
    expect(claimLocationEligibility("This image was taken in the Old Delhi neighbourhood").spans).toEqual([
      "Old Delhi",
    ]);
    expect(claimLocationEligibility("A hurricane neared the Gulf Coast.").spans).toEqual([
      "Gulf Coast",
    ]);
    expect(claimLocationEligibility("This image was taken at 10 Downing Street.").spans).toEqual([
      "10 Downing Street",
    ]);
  });

  it("matches gazetteer names accent- and case-insensitively", () => {
    for (const claim of [
      "This image was taken in são paulo.",
      "This image was taken in SAO PAULO.",
      "This image was taken in Bogotá.",
    ]) {
      expect(claimMayStateLocation(claim), claim).toBe(true);
    }
  });

  it("keeps the original claim verbatim and never rewrites it", () => {
    const claim = "  London   is where THIS image was taken.  ";
    const r = claimLocationEligibility(claim);
    expect(r.claim).toBe(claim);
    expect(r.eligible).toBe(true);
  });

  it("derives no product verdict — the record carries no status/verdict field", () => {
    const r = claimLocationEligibility("This image was taken in London.");
    expect(Object.keys(r).sort()).toEqual([
      "claim",
      "eligible",
      "evidence",
      "outcome",
      "reasons",
      "rejectedBy",
      "spans",
      "unresolved",
    ]);
    for (const k of Object.keys(r)) {
      expect(k).not.toMatch(/verdict|status|result|outcome_?final|confidence|decision/i);
    }
  });

  it("boolean view agrees with the record across a mixed corpus", () => {
    const corpus = [
      "London is where this image was taken.",
      "This image was taken in london.",
      "This image shows Alice smiling.",
      "this photo is from Delhi today",
      "this photo shows a flood today",
      "This image was shared on Twitter.",
      "The protest happened in Paris.",
      "This happened in 2019.",
      "This photograph is from Alice.",
      "This image was taken at 10 Downing Street.",
      "",
      "   ",
    ];
    for (const claim of corpus) {
      expect(claimMayStateLocation(claim)).toBe(claimLocationEligibility(claim).eligible);
    }
  });
});

describe("claimLocationEligibility — authorship and topic binding", () => {
  /**
   * A proper name can belong to a person, an account or a subject as easily as
   * to a place. These claims state where the picture *came from* or what it is
   * *about*, so the location question must not be authorised even though the
   * name is in the gazetteer.
   */
  it.each([
    ["The photograph is from Jordan Smith\u2019s collection.", "Jordan"],
    ["This photograph was taken from Jordan\u2019s Instagram account.", "Jordan\u2019s"],
    ["The photo was taken yesterday and focuses on Jordan smiling.", "Jordan"],
    ["This image is about a speech on London politics.", "London"],
  ])("declines %s", (claim, span) => {
    const r = claimLocationEligibility(claim);
    expect(r.eligible, claim).toBe(false);
    expect(r.rejectedBy, claim).toBe("topic_or_source_reference");
    // the name it refused is still reported, verbatim
    expect(r.unresolved).toContain(span);
  });

  it("does not let a capture verb in another clause cancel the check", () => {
    // "taken" is in the first clause; the span sits in the second
    const split = claimLocationEligibility(
      "The photo was taken yesterday and focuses on Jordan smiling.",
    );
    expect(split.eligible).toBe(false);
    // with no capture verb anywhere, the same frame is a topic
    const single = claimLocationEligibility("A photo focusing on Jordan smiling.");
    expect(single.eligible).toBe(false);
  });

  it("keeps genuine place readings of the same names", () => {
    const kept: Array<[string, boolean]> = [
      ["This image was taken in Jordan.", true],
      ["This image was taken at 10 Downing Street.", true],
      ["A protest in Amman.", true],
      ["This image was taken in Jerusalem.", true],
      ["This image is about the economy in London.", true],
      ["Damage at the airport.", true],
      ["Fire at the hospital this morning.", true],
      ["This image was taken in Bogota last night.", true],
      ["This image was taken in São Tomé yesterday.", true],
      ["This photograph is from Alice's collection.", false],
    ];
    for (const [claim, expected] of kept) {
      expect(claimMayStateLocation(claim), claim).toBe(expected);
    }
  });

  it("exempts address evidence from the topic and ownership guards", () => {
    // an address is positive evidence in its own right and is not a name that
    // can be read as a person
    expect(claimLocationEligibility("This image was taken at 10 Downing Street.").eligible).toBe(true);
    expect(claimLocationEligibility("Report filed at 221B Baker Street.").eligible).toBe(true);
  });
});

describe("claimLocationEligibility — discourse frames take a topic, not a place", () => {
  /**
   * A discourse noun's complement is a subject by definition, so "a speech on
   * Jordan" states no location. §16.5 permits the question only when the claim
   * explicitly contains a usable location, and this construction is decided by
   * its frame rather than by any particular phrase.
   */
  it.each([
    ["This image is about a speech on Jordan.", "topic_or_source_reference"],
    ["A speech on Jordan.", "topic_or_source_reference"],
    ["A speech on London.", "topic_or_source_reference"],
    ["An article on Jordan.", "topic_or_source_reference"],
    ["A report on London.", "topic_or_source_reference"],
    ["This image is about a speech on London politics.", "topic_or_source_reference"],
  ])("declines %s", (claim, rejection) => {
    const r = claimLocationEligibility(claim);
    expect(r.eligible, claim).toBe(false);
    expect(r.rejectedBy, claim).toBe(rejection);
  });

  it("generalises across discourse heads rather than matching one phrase", () => {
    for (const claim of [
      "A talk on Jordan.",
      "An interview about Jordan.",
      "A debate on London.",
      "A documentary about Amman.",
      "An essay on Paris.",
      "A column on Delhi.",
    ]) {
      expect(claimMayStateLocation(claim), claim).toBe(false);
    }
  });

  it("keeps explicit location constructions of the same names", () => {
    const kept: Array<[string, boolean]> = [
      ["This image was taken in Jordan.", true],
      ["A protest in Amman.", true],
      ["A speech given in Paris.", true],
      ["An article published in Delhi.", true],
      ["Flooding on the Thames.", true],
      ["This image was taken on the Thames.", true],
      ["A fire on the bridge.", true],
      ["Damage at the airport.", true],
      ["Fire at the hospital this morning.", true],
      ["this photo is from Delhi today", true],
      ["This image was taken in London today.", true],
      ["This image is about the economy in London.", true],
      ["This image was taken in the Oval Office about the economy.", true],
      ["This image was taken at 10 Downing Street.", true],
    ];
    for (const [claim, expected] of kept) {
      expect(claimMayStateLocation(claim), claim).toBe(expected);
    }
  });

  it("does not let a discourse head in another clause suppress a real location", () => {
    // "speech" heads the first clause; the span sits in the second
    const r = claimLocationEligibility(
      "There was a speech on migration and this image was taken in Berlin.",
    );
    expect(r.eligible).toBe(true);
    expect(r.spans).toContain("Berlin");
  });

  it("leaves a capture verb in the same clause in charge", () => {
    expect(claimMayStateLocation("This image was taken on the Thames.")).toBe(true);
    expect(claimMayStateLocation("This was published on the record.")).toBe(false);
  });
});

describe("claimLocationEligibility — governing-relationship precedence", () => {
  /**
   * A discourse complement governs its own object. Neither a capture verb
   * elsewhere in the clause nor the fact that the object is a genuine
   * geographical thing may override that relationship.
   */
  it.each([
    ["The photograph was taken during a speech on Jordan.", "a capture verb governing a different adjunct"],
    ["The photo was filmed during a lecture on London.", "a capture verb governing a different adjunct"],
    ["This image is about a speech on the river.", "a place-type noun inside the complement"],
    ["This image is about a report on 10 Downing Street.", "a street address inside the complement"],
  ])("does not ask for %s — %s", (claim) => {
    const r = claimLocationEligibility(claim);
    expect(r.eligible, claim).toBe(false);
    expect(r.rejectedBy, claim).toBe("topic_or_source_reference");
  });

  it("asks through production question construction, not just the boolean view", () => {
    for (const claim of [
      "The photograph was taken during a speech on Jordan.",
      "The photo was filmed during a lecture on London.",
      "This image is about a speech on the river.",
      "This image is about a report on 10 Downing Street.",
    ]) {
      const built = evidenceQuestionsWithProvenance({ claimMode: true, claim });
      expect(built.questions.location_relation, claim).toBeUndefined();
      expect(built.locationEligibility!.eligible, claim).toBe(false);
    }
    // and a real location still produces the question
    const real = evidenceQuestionsWithProvenance({
      claimMode: true,
      claim: "This image was taken in London.",
    });
    expect(real.questions.location_relation).toBeDefined();
  });

  it("lets a capture verb establish geography only for its own locative relationship", () => {
    const owns: Array<[string, boolean]> = [
      ["This image was taken on the Thames.", true],
      ["This was published on the record.", false],
      ["The photograph was taken during a speech on Jordan.", false],
      ["Flooding on the Thames.", true],
    ];
    for (const [claim, expected] of owns) {
      expect(claimMayStateLocation(claim), claim).toBe(expected);
    }
  });

  it("keeps genuine place and address positives outside any topic frame", () => {
    const kept: Array<[string, boolean]> = [
      ["A report filed at 10 Downing Street.", true],
      ["Report filed at 221B Baker Street.", true],
      ["A fire in a warehouse.", true],
      ["A fire on the bridge.", true],
      ["Damage at the airport.", true],
      ["A speech given in Paris.", true],
      ["An article published in Delhi.", true],
      ["A protest in Amman.", true],
      ["This image was taken in Jordan.", true],
      ["in Las Vegas", true],
    ];
    for (const [claim, expected] of kept) {
      expect(claimMayStateLocation(claim), claim).toBe(expected);
    }
  });

  it("scopes both the discourse head and the capture verb to their own clause", () => {
    const separate = claimLocationEligibility(
      "There was a speech on migration and this image was taken in Berlin.",
    );
    expect(separate.eligible).toBe(true);
    expect(separate.spans).toContain("Berlin");

    const laterTopic = claimLocationEligibility(
      "The photo was taken yesterday and focuses on Jordan smiling.",
    );
    expect(laterTopic.eligible).toBe(false);
  });
});

describe("claimLocationEligibility — honest unknown state", () => {
  it("reports an unrecognised name as unknown, not as definitely not a place", () => {
    for (const claim of [
      "This image was taken in Brindlewick.",
      "this image was taken in brindlewick.",
    ]) {
      const r = claimLocationEligibility(claim);
      expect(r.eligible, claim).toBe(false);
      expect(r.outcome, claim).toBe("unknown");
      expect(r.rejectedBy, claim).toBe("unrecognised_name");
      expect(r.unresolved.length, claim).toBe(1);
    }
  });

  it("keeps not_eligible for a demonstrated non-place context", () => {
    const demonstrated: Array<[string, LocationRejection]> = [
      ["This happened on Tuesday.", "temporal_reference"],
      ["This image was shared on Twitter.", "non_place_reference"],
      ["This quote is from the minister.", "person_reference"],
      ["This image shows Alice smiling.", "no_locative_construction"],
    ];
    for (const [claim, rejection] of demonstrated) {
      const r = claimLocationEligibility(claim);
      expect(r.eligible, claim).toBe(false);
      expect(r.outcome, claim).toBe("not_eligible");
      expect(r.rejectedBy, claim).toBe(rejection);
    }
  });

  it("gives a positive place signal precedence over unresolved candidates", () => {
    const r = claimLocationEligibility("This image was taken in London and focuses on Jordan smiling.");
    expect(r.eligible).toBe(true);
    expect(r.spans).toEqual(["London"]);
    // the refused candidate is still reported alongside the accepted one
    expect(r.unresolved).toEqual(["Jordan"]);
  });

  it("only eligible ever authorises the question", () => {
    for (const claim of [
      "This image was taken in Brindlewick.",
      "This happened on Tuesday.",
      "This image shows Alice smiling.",
      "This image was taken in 東京.",
    ]) {
      const r = claimLocationEligibility(claim);
      expect(r.eligible, claim).toBe(r.outcome === "eligible");
    }
  });
});

describe("claimLocationEligibility — verbatim span fidelity", () => {
  it("reports an accented name exactly as written", () => {
    const r = claimLocationEligibility("This image was taken in São Tomé.");
    expect(r.eligible).toBe(true);
    expect(r.spans).toEqual(["São Tomé"]);
  });

  it("reports a non-Latin name rather than erasing it", () => {
    const r = claimLocationEligibility("This image was taken in 東京.");
    expect(r.eligible).toBe(false);
    expect(r.outcome).toBe("unknown");
    expect(r.unresolved).toEqual(["東京"]);
  });

  it("includes a sentence-final token instead of dropping it", () => {
    for (const claim of [
      "A photo focusing on Juniper Chen.",
      "This image was taken near Juniper Chen.",
    ]) {
      expect(claimLocationEligibility(claim).unresolved, claim).toEqual(["Juniper Chen"]);
    }
  });

  it("keeps accented and cased gazetteer names matched", () => {
    for (const claim of [
      "This image was taken in são paulo.",
      "This image was taken in SAO PAULO.",
      "This image was taken in Bogotá.",
      "This image was taken in são tomé.",
    ]) {
      expect(claimMayStateLocation(claim), claim).toBe(true);
    }
  });
});

describe("claimLocationEligibility — explicit motion-relationship complements (§16.5)", () => {
  /**
   * The exact claim retained from the genuine Floyd/Katrina run. "The Gulf
   * Coast" is the complement of the motion verb "approaching", so the gate must
   * read it as the explicit location the claim states. The place text in the
   * claim is the evidence; nothing is inferred about the storm.
   */
  const RETAINED_CLAIM =
    "This satellite image shows Hurricane Katrina approaching the Gulf Coast in August 2005.";

  it("reads the place the claim explicitly names, as a motion complement", () => {
    const r = claimLocationEligibility(RETAINED_CLAIM);
    expect(r.eligible).toBe(true);
    expect(r.outcome).toBe("eligible");
    // the complete place span, not just its first token
    expect(r.spans).toEqual(["Gulf Coast"]);
    expect(r.reasons).toContain("motion_relationship_complement");
  });

  it("keeps the claim verbatim and the temporal text it also examined", () => {
    const r = claimLocationEligibility(RETAINED_CLAIM);
    expect(r.claim).toBe(RETAINED_CLAIM);
    // the temporal object of "in" is still reported, and is not promoted
    expect(r.unresolved).toContain("August 2005");
    expect(r.spans).not.toContain("August 2005");
  });

  it("asks the location question through production question construction", () => {
    const built = evidenceQuestionsWithProvenance({ claimMode: true, claim: RETAINED_CLAIM });
    expect(built.questions.location_relation).toBeDefined();
    expect(built.locationEligibility!.eligible).toBe(true);
    // never in trace mode
    const trace = evidenceQuestionsWithProvenance({ claimMode: false, claim: RETAINED_CLAIM });
    expect(trace.questions.location_relation).toBeUndefined();
  });

  it("recognises other narrow motion complements, and only with a real place", () => {
    // Every positive uses a name or noun the frozen lexicons already carry:
    // this stage adds no place name and no region of its own.
    const positives = [
      "This image shows a storm approaching the Gulf Coast.",
      "A hurricane neared Miami.",
      "A hurricane neared the Gulf Coast.",
      "The storm struck the Gulf Coast.",
      "Wildfire devastated the Amazon.",
    ];
    for (const claim of positives) {
      expect(claimMayStateLocation(claim), claim).toBe(true);
    }
  });

  it("a motion complement that is not a place never authorises the question", () => {
    const negatives = [
      "This image shows a man approaching Alice.",
      "The storm struck midnight.",
      "The water headed toward the horizon.",
      "The flood approached the horizon.",
      "Floods devastated the economy.",
    ];
    for (const claim of negatives) {
      expect(claimMayStateLocation(claim), claim).toBe(false);
    }
  });

  it("distinguishes an unevaluated complement from an affirmative no-location", () => {
    // "Tomorrowland" is a name this gate does not know: unsupported parsing,
    // reported as unknown rather than as "the claim states no location".
    const unknown = claimLocationEligibility("A storm is approaching Tomorrowland.");
    expect(unknown.eligible).toBe(false);
    expect(unknown.outcome).toBe("unknown");
    expect(unknown.rejectedBy).toBe("unrecognised_name");

    // a motion verb with no complement at all is likewise unevaluated
    const dangling = claimLocationEligibility("The storm is approaching.");
    expect(dangling.eligible).toBe(false);
    expect(dangling.outcome).toBe("unknown");
    expect(dangling.rejectedBy).toBe("unparsed_relationship");
  });

  it("temporal-only claims keep the affirmative no-location reading", () => {
    const temporal: Array<[string, LocationRejection]> = [
      ["This happened on Tuesday.", "temporal_reference"],
      ["The storm struck midnight.", "temporal_reference"],
      ["This happened in August 2005.", "temporal_reference"],
      ["Floods hit the coast in March.", "temporal_reference"],
    ];
    for (const [claim, rejection] of temporal) {
      const r = claimLocationEligibility(claim);
      expect(r.eligible, claim).toBe(false);
      expect(r.outcome, claim).toBe("not_eligible");
      expect(r.rejectedBy, claim).toBe(rejection);
    }
    // A bare numeric year is not a place either. Its recorded reason is weaker
    // than the cases above, because a bare number is skipped as a span head
    // rather than evaluated; both outcomes decline the question.
    expect(claimMayStateLocation("This image was taken in 2019.")).toBe(false);
  });

  it("preserves the prior discourse, source-ownership and topical negatives", () => {
    const preserved: Array<[string, LocationRejection]> = [
      ["A speech on Jordan.", "topic_or_source_reference"],
      ["An article on Jordan.", "topic_or_source_reference"],
      ["This image is about a speech on the river.", "topic_or_source_reference"],
      ["This image is about a report on 10 Downing Street.", "topic_or_source_reference"],
      ["This photograph was taken during a speech on Jordan.", "topic_or_source_reference"],
      ["The photo was taken yesterday and focuses on Jordan smiling.", "topic_or_source_reference"],
      ["The photograph is from Jordan Smith’s collection.", "topic_or_source_reference"],
      ["This photograph was taken from Jordan’s Instagram account.", "topic_or_source_reference"],
      ["This photograph is from Reuters.", "non_place_reference"],
      ["This image shows Alice smiling.", "no_locative_construction"],
    ];
    for (const [claim, rejection] of preserved) {
      const r = claimLocationEligibility(claim);
      expect(r.eligible, claim).toBe(false);
      expect(r.rejectedBy, claim).toBe(rejection);
    }
  });

  /* ---- M1: the motion path must apply the same disambiguation guards ---- */

  it.each([
    ["A man approached Jordan Smith.", "a person named after a place"],
    ["The news devastated Paris Hilton.", "a person named after a place"],
    ["A man approached Jordan smiling.", "a topic description, not a place"],
    ["A reporter approached the Washington Post.", "an organisation named after a place"],
  ])("does not ask for %s — %s", (claim) => {
    const built = evidenceQuestionsWithProvenance({ claimMode: true, claim });
    expect(built.questions.location_relation, claim).toBeUndefined();
    expect(built.locationEligibility!.eligible, claim).toBe(false);
    expect(built.locationEligibility!.spans, claim).toEqual([]);
  });

  it("records why a place-prefixed person or source phrase was refused", () => {
    const person = claimLocationEligibility("A man approached Jordan Smith.");
    expect(person.rejectedBy).toBe("person_reference");
    const org = claimLocationEligibility("A reporter approached the Washington Post.");
    expect(org.rejectedBy).toBe("non_place_reference");
    const topic = claimLocationEligibility("A man approached Jordan smiling.");
    expect(topic.rejectedBy).toBe("topic_or_source_reference");
  });

  /* ---- M2: the relation must not borrow a complement across a sentence ---- */

  it("does not take a complement from the next sentence", () => {
    const r = claimLocationEligibility("A man approached. Jordan smiled.");
    expect(r.eligible).toBe(false);
    expect(r.spans).toEqual([]);
    // the relation is present but unevaluated, not "the claim states no location"
    expect(r.outcome).toBe("unknown");
    expect(r.rejectedBy).toBe("unparsed_relationship");
  });

  it("opposing control: a sentence-final place keeps its full span and stops there", () => {
    const r = claimLocationEligibility("A storm neared the Gulf Coast. Alice waved.");
    expect(r.eligible).toBe(true);
    // exactly the place, never extended into the following sentence
    expect(r.spans).toEqual(["Gulf Coast"]);
  });

  it("an unevaluated complement does not absorb the following sentence either", () => {
    const r = claimLocationEligibility("The storm neared Tomorrowland. Alice waved.");
    expect(r.eligible).toBe(false);
    expect(r.unresolved).toEqual(["Tomorrowland"]);
  });

  /* ---- M3: an unresolved complement must not swallow the next clause ---- */

  it.each([
    "A storm approached Tomorrowland in August 2005.",
    "The storm neared Tomorrowland in August 2005.",
  ])("keeps %s unevaluated, without reading a surname across the temporal clause", (claim) => {
    const r = claimLocationEligibility(claim);
    expect(r.eligible, claim).toBe(false);
    expect(r.outcome, claim).toBe("unknown");
    expect(r.rejectedBy, claim).toBe("unrecognised_name");
    // the unrecognised name and the temporal clause are both reported, and the
    // stop preposition is not absorbed into either span
    expect(r.unresolved, claim).toEqual(["Tomorrowland", "August 2005"]);
    const built = evidenceQuestionsWithProvenance({ claimMode: true, claim });
    expect(built.questions.location_relation, claim).toBeUndefined();
  });

  it("applies the same stop-token rule on the preposition path", () => {
    const r = claimLocationEligibility("This image was taken in Brindlewick in August 2005.");
    expect(r.eligible).toBe(false);
    expect(r.outcome).toBe("unknown");
    expect(r.unresolved).toEqual(["Brindlewick", "August 2005"]);
  });

  it("still records a genuine multi-word unresolved name whole", () => {
    // "Chen" and "today" are neither stop tokens nor sentence ends, so the span
    // covers the whole phrase; only a stop token or a sentence end truncates it.
    const r = claimLocationEligibility("A man approached Juniper Chen today.");
    expect(r.unresolved).toEqual(["Juniper Chen today"]);
  });

  it("keeps the M1 fixes from costing a genuine place, address or modifier", () => {
    const kept: Array<[string, boolean]> = [
      // the confirmed positives
      ["This image shows a storm approaching the Gulf Coast.", true],
      ["A hurricane neared Miami.", true],
      ["A hurricane neared the Gulf Coast.", true],
      ["The storm struck the Gulf Coast.", true],
      ["Wildfire devastated the Amazon.", true],
      ["A storm neared the Gulf Coast. Alice waved.", true],
      // a modifier before the name
      ["Wildfire devastated the northern forest.", true],
      // a place that legitimately continues with a place noun
      ["A storm neared the Gulf Coast coast.", true],
    ];
    for (const [claim, expected] of kept) {
      expect(claimMayStateLocation(claim), claim).toBe(expected);
    }
  });

  it("keeps the ownership and topic exclusions on the motion path", () => {
    const excluded: Array<[string, string]> = [
      ["A photographer approached Jordan's account.", "topic_or_source_reference"],
      ["A crawler approached Jordan's collection.", "topic_or_source_reference"],
    ];
    for (const [claim] of excluded) {
      expect(claimMayStateLocation(claim), claim).toBe(false);
    }
  });

  it("documents the residual: a bare place name as a motion complement stays ambiguous", () => {
    // "A man approached Jordan." is genuinely ambiguous - the country or a person
    // - and the frozen lexicons cannot separate them. The existing policy admits
    // a recognised gazetteer name, so this remains a false-positive direction.
    // It is pinned here so the risk stays visible rather than implied.
    const r = claimLocationEligibility("A man approached Jordan.");
    expect(r.eligible).toBe(true);
    expect(r.spans).toEqual(["Jordan"]);
  });

  it("documents a known limit: a directional preposition is not in the locative set", () => {
    // "toward"/"towards" are not locative prepositions for this gate, so
    // "headed toward the river" is not read through that frame. Adding them is a
    // preposition-coverage change, deliberately outside this stage.
    expect(claimMayStateLocation("The water headed toward the river.")).toBe(false);
  });

  it("documents a known limit: a demonym modifier is not a place name", () => {
    // "Japanese coastline" names a place, but recognising a demonym would mean
    // growing a nationality lexicon, which is explicitly out of scope. The
    // outcome is a safe decline - the question is not asked - so this costs a
    // missed question, never a wrong one. The recorded reason is imprecise: the
    // gate classifies "Japanese" from its language entry rather than recognising
    // it as a modifier, so the rationale is weaker than the decision.
    const r = claimLocationEligibility("A hurricane neared the Japanese coastline.");
    expect(r.eligible).toBe(false);
    expect(r.spans).toEqual([]);
  });

  it("keeps the override controls: real places outside any motion or topic frame", () => {
    const overrides: Array<[string, boolean]> = [
      ["A speech given in Paris.", true],
      ["A report filed at 10 Downing Street.", true],
      ["This image was taken in Jordan.", true],
      ["A fire on the bridge.", true],
      ["Damage at the airport.", true],
      ["Flooding on the Thames.", true],
      // the discourse guard is keyed on a preposition; a place named as a motion
      // complement is still a place the claim states
      ["An article about a hurricane approaching the Gulf Coast.", true],
    ];
    for (const [claim, expected] of overrides) {
      expect(claimMayStateLocation(claim), claim).toBe(expected);
    }
  });
});

describe("evidenceQuestionsWithProvenance — additive, backward compatible", () => {
  it("returns the same question map evidenceQuestions would build", () => {
    const claim = "This image was taken in London.";
    const r = evidenceQuestionsWithProvenance({ claimMode: true, claim });
    expect(Object.keys(r.questions)).toEqual(
      Object.keys(
        evidenceQuestions({ claimMode: true, claimHasLocation: claimMayStateLocation(claim) }),
      ),
    );
    expect(r.questions.location_relation).toBeDefined();
    expect(r.locationEligibility!.claim).toBe(claim);
    expect(r.locationEligibility!.outcome).toBe("eligible");
  });

  it("omits the location question and keeps the refusal rationale for no-location claims", () => {
    const claim = "This image shows Alice smiling.";
    const r = evidenceQuestionsWithProvenance({ claimMode: true, claim });
    expect(r.questions.location_relation).toBeUndefined();
    expect(r.locationEligibility!.eligible).toBe(false);
    expect(r.locationEligibility!.rejectedBy).toBe("no_locative_construction");
  });

  it("treats an unknown object the same as a refusal when building the question map", () => {
    const r = evidenceQuestionsWithProvenance({
      claimMode: true,
      claim: "This image was taken in 東京.",
    });
    expect(r.questions.location_relation).toBeUndefined();
    expect(r.locationEligibility!.outcome).toBe("unknown");
  });

  it("has no location record in trace mode", () => {
    const r = evidenceQuestionsWithProvenance({
      claimMode: false,
      claim: "This image was taken in London.",
    });
    expect(r.locationEligibility).toBeNull();
    expect(Object.keys(r.questions)).toEqual(
      Object.keys(evidenceQuestions({ claimMode: false, claimHasLocation: false })),
    );
  });

  it("tolerates a null claim in claim mode", () => {
    const r = evidenceQuestionsWithProvenance({ claimMode: true, claim: null });
    expect(r.locationEligibility).toBeNull();
    expect(Object.keys(r.questions)).toEqual([
      "relevance",
      "page_role",
      "context_relation",
      "claim_relation",
    ]);
  });
});

/* --------------------------- answer validation --------------------------- */

describe("judgmentFromAnswers — typed answer validation at the boundary", () => {
  const prov = { provenance: verified };

  it("parses a valid trace-mode answer set", () => {
    const j = judgmentFromAnswers(traceAnswers, { claimMode: false, ...prov });
    expect(j).not.toBeNull();
    expect(j!.relevance).toBeCloseTo(0.9);
    expect(j!.pageRole.reporting).toBeCloseTo(0.8);
    expect(j!.contextRelation).toBeNull();
    expect(j!.model).toBe(JEV_MODEL);
  });

  it("parses claim-mode relations", () => {
    const j = judgmentFromAnswers(claimAnswers, { claimMode: true, ...prov });
    expect(j!.contextRelation!.differentContext).toBeCloseTo(0.8);
    expect(j!.claimRelation!.contradicts).toBeCloseTo(0.8);
    expect(j!.locationRelation!.sameLocation).toBeCloseTo(0.7);
  });

  it("degrades absent optional claim surfaces to null without rejecting the judgment", () => {
    const noOptional = {
      relevance: noul(0.9),
      page_role: choice("REPORTING", probs(PAGE_ROLE_KEYS, "REPORTING")),
    };
    const j = judgmentFromAnswers(noOptional, { claimMode: true, ...prov });
    expect(j).not.toBeNull();
    expect(j!.claimRelation).toBeNull();
    expect(j!.locationRelation).toBeNull();
  });

  it("returns null on malformed required surfaces — no heuristic fallback", () => {
    expect(judgmentFromAnswers({}, { claimMode: false, ...prov })).toBeNull();
    expect(judgmentFromAnswers({ relevance: noul(2) }, { claimMode: false, ...prov })).toBeNull();
    expect(
      judgmentFromAnswers({ ...traceAnswers, page_role: { type: "choice" } }, { claimMode: false, ...prov }),
    ).toBeNull();
  });

  it("rejects a noul relevance that is not a finite 0..1 probability", () => {
    for (const bad of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -0.01,
      1.01,
      "0.9",
      null,
      undefined,
    ]) {
      expect(
        judgmentFromAnswers({ ...traceAnswers, relevance: noul(bad as number) }, { claimMode: false, ...prov }),
      ).toBeNull();
    }
  });

  it("rejects a distribution that misses 1 by more than the option-count tolerance", () => {
    for (const bad of [
      even6(0.9), // 5.4
      sumsToOne([0.2, 0.2, 0.2, 0.2, 0.2, 0.2]), // 1.2
      even6(0.25), // 1.5
      even6(0.1), // 0.6
    ]) {
      expect(
        judgmentFromAnswers({ ...traceAnswers, page_role: choiceNoWinner(bad) }, { claimMode: false, ...prov }),
        JSON.stringify(bad),
      ).toBeNull();
    }
    expect(judgmentFromAnswers({}, { claimMode: false, ...prov })).toBeNull();
  });

  it("accepts a distribution within the option-count tolerance, including per-option rounding", () => {
    // six options at .167 sum to 1.002 — a three-decimal rounding artefact that
    // a fixed 1e-3 tolerance would reject
    expect(even6(0.167)).toBeDefined();
    const j = judgmentFromAnswers(
      {
        ...traceAnswers,
        page_role: choice("REPORTING", even6(0.167)),
      },
      { claimMode: false, ...prov },
    );
    expect(j).not.toBeNull();
    expect(j!.pageRole.reporting).toBe(0.167);
    // pairwise with three options: 0.333 x 3 = 0.999
    const r = pairwiseFromAnswers(
      {
        pairwise_context: choice("SAME_CONTEXT", {
          SAME_CONTEXT: 0.333,
          DIFFERENT_CONTEXT: 0.333,
          UNCLEAR: 0.333,
        }),
      },
      verified,
    );
    expect(r).not.toBeNull();
    expect(r!.sameContext).toBe(0.333);
  });

  it("scales the tolerance with the option count and states its assumption", () => {
    expect(JEV_PROBABILITY_RETAINED_DECIMALS).toBe(3);
    // N options, each rounded to 3 decimals, can miss 1 by up to N * 0.0005
    expect(jevProbabilitySumTolerance(3)).toBeCloseTo(0.0015);
    expect(jevProbabilitySumTolerance(6)).toBeCloseTo(0.003);
    expect(jevProbabilitySumTolerance(4)).toBeCloseTo(0.002);
    expect(jevProbabilitySumTolerance(6)).toBeGreaterThan(jevProbabilitySumTolerance(3));
    // still refuses a materially non-distributional map
    expect(Math.abs(even6(0.9).REPORTING * 6 - 1)).toBeGreaterThan(jevProbabilitySumTolerance(6));
  });

  it("rejects a missing declared option", () => {
    const partial: Record<string, number> = { ...probs(PAGE_ROLE_KEYS, "REPORTING") };
    delete partial.OTHER;
    expect(
      judgmentFromAnswers({ ...traceAnswers, page_role: choice("REPORTING", partial) }, { claimMode: false, ...prov }),
    ).toBeNull();
    const nulled: Record<string, number> = {
      ...probs(PAGE_ROLE_KEYS, "REPORTING"),
      OTHER: null as never,
    };
    expect(
      judgmentFromAnswers({ ...traceAnswers, page_role: choice("REPORTING", nulled) }, { claimMode: false, ...prov }),
    ).toBeNull();
  });

  it("rejects an undeclared option key rather than dropping it", () => {
    const smuggled = { ...probs(PAGE_ROLE_KEYS, "REPORTING"), SMUGGLED_OPTION: 0 };
    expect(
      judgmentFromAnswers({ ...traceAnswers, page_role: choice("REPORTING", smuggled) }, { claimMode: false, ...prov }),
    ).toBeNull();
    // the declared option replaced by a differently-cased alias
    const aliased: Record<string, number> = { ...probs(PAGE_ROLE_KEYS, "REPORTING") };
    aliased.reporting = aliased.REPORTING;
    delete aliased.REPORTING;
    expect(
      judgmentFromAnswers({ ...traceAnswers, page_role: choice("REPORTING", aliased) }, { claimMode: false, ...prov }),
    ).toBeNull();
  });

  it("rejects out-of-range and non-finite option probabilities", () => {
    for (const bad of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -0.1,
      1.5,
      "0.05",
      null,
      undefined,
    ]) {
      const p: Record<string, number> = {
        REPORTING: 0.8,
        FACT_CHECK: bad as number,
        SOCIAL_REPOST: 0.1,
        AGGREGATOR: 0.05,
        COMMENTARY: 0.025,
        OTHER: 0.025,
      };
      expect(
        judgmentFromAnswers({ ...traceAnswers, page_role: choice("REPORTING", p) }, { claimMode: false, ...prov }),
        String(bad),
      ).toBeNull();
    }
  });

  it("rejects a Choice slot filled with the wrong answer type", () => {
    for (const bad of [noul(0.9), 0.9, null, [1, 2], "REPORTING"]) {
      expect(
        judgmentFromAnswers({ ...traceAnswers, page_role: bad }, { claimMode: false, ...prov }),
      ).toBeNull();
    }
  });

  it("never produces a judgment from a partially valid answer set", () => {
    expect(
      judgmentFromAnswers(
        { relevance: noul(0.9), page_role: choice("REPORTING", { REPORTING: 0.5 }) },
        { claimMode: false, ...prov },
      ),
    ).toBeNull();
  });

  it("validates optional claim surfaces with the same rules, degrading to null", () => {
    // Documented policy: a malformed *optional* surface degrades to a null
    // sub-judgment (§29 — never synthetic probabilities), while the required
    // relevance/page-role surfaces reject the whole judgment. No fabricated
    // value is ever substituted.
    const badContext = {
      ...claimAnswers,
      context_relation: choice("DIFFERENT_CONTEXT", Object.fromEntries(CONTEXT_KEYS.map((k) => [k, 0.4]))),
    };
    const degraded = judgmentFromAnswers(badContext, { claimMode: true, ...prov });
    expect(degraded).not.toBeNull();
    expect(degraded!.contextRelation).toBeNull();
    expect(degraded!.claimRelation!.contradicts).toBeCloseTo(0.8);

    const badLocation = {
      ...claimAnswers,
      location_relation: choice("SAME_LOCATION", {
        ...probs(LOCATION_KEYS, "SAME_LOCATION", 0.7),
        EXTRA: 0.5,
      }),
    };
    const noLocation = judgmentFromAnswers(badLocation, { claimMode: true, ...prov });
    expect(noLocation).not.toBeNull();
    expect(noLocation!.locationRelation).toBeNull();
    expect(noLocation!.contextRelation!.differentContext).toBeCloseTo(0.8);
  });

  it("a required-surface distribution violation rejects the whole judgment", () => {
    expect(
      judgmentFromAnswers(
        { relevance: noul(0.9), page_role: choice("REPORTING", even6(0.4)) },
        { claimMode: false, ...prov },
      ),
    ).toBeNull();
  });
});

/** Six equal option values — used to exercise the sum tolerance directly. */
function even6(p: number): Record<string, number> {
  return Object.fromEntries(PAGE_ROLE_KEYS.map((k) => [k, p]));
}

describe("choiceAnswer — the documented winner contract", () => {
  const prov = { provenance: verified };
  const pageRole = (v: unknown) =>
    judgmentFromAnswers({ ...traceAnswers, page_role: v }, { claimMode: false, ...prov });

  it("requires a declared winner", () => {
    // absent
    expect(pageRole(choiceNoWinner(probs(PAGE_ROLE_KEYS, "REPORTING")))).toBeNull();
    // explicit null is malformed too — no consistent reading of "no winner"
    expect(
      pageRole({ type: "choice", choice: null, probabilities: probs(PAGE_ROLE_KEYS, "REPORTING") }),
    ).toBeNull();
  });

  it("rejects a declared winner that is not among the tied maxima", () => {
    // normalized, but the declared winner is not the highest-probability option
    const notMax = {
      REPORTING: 0.8,
      FACT_CHECK: 0.025,
      SOCIAL_REPOST: 0.05,
      AGGREGATOR: 0.05,
      COMMENTARY: 0.05,
      OTHER: 0.025,
    };
    expect(pageRole(choice("OTHER", notMax))).toBeNull();
    expect(pageRole(choice("FACT_CHECK", notMax))).toBeNull();
    // the actual maximum is accepted
    expect(pageRole(choice("REPORTING", notMax))).not.toBeNull();
  });

  it("accepts either of two tied maxima", () => {
    const tied = {
      REPORTING: 0.4,
      FACT_CHECK: 0.4,
      SOCIAL_REPOST: 0.05,
      AGGREGATOR: 0.05,
      COMMENTARY: 0.05,
      OTHER: 0.05,
    };
    expect(pageRole(choice("REPORTING", tied))).not.toBeNull();
    expect(pageRole(choice("FACT_CHECK", tied))).not.toBeNull();
  });

  it("treats maxima within one rounding unit as tied", () => {
    expect(JEV_WINNER_TIE_TOLERANCE).toBe(10 ** -JEV_PROBABILITY_RETAINED_DECIMALS);
    const nearTie = {
      REPORTING: 0.4,
      FACT_CHECK: 0.4 - JEV_WINNER_TIE_TOLERANCE / 2,
      SOCIAL_REPOST: 0.05,
      AGGREGATOR: 0.05,
      COMMENTARY: 0.05,
      OTHER: 0.05,
    };
    expect(pageRole(choice("FACT_CHECK", nearTie))).not.toBeNull();
    // a full unit clear of the maximum is not a tie
    const clearLoser = {
      REPORTING: 0.4,
      FACT_CHECK: 0.4 - JEV_WINNER_TIE_TOLERANCE * 2,
      SOCIAL_REPOST: 0.05,
      AGGREGATOR: 0.05,
      COMMENTARY: 0.05,
      OTHER: 0.05,
    };
    expect(pageRole(choice("FACT_CHECK", clearLoser))).toBeNull();
  });

  it("rejects a winner naming an option that was not offered, or a non-string winner", () => {
    expect(pageRole(choice("TOTALLY_MADE_UP_ROLE", probs(PAGE_ROLE_KEYS, "REPORTING")))).toBeNull();
    for (const bad of [7, true, [], {}]) {
      expect(
        pageRole({ type: "choice", choice: bad, probabilities: probs(PAGE_ROLE_KEYS, "REPORTING") }),
      ).toBeNull();
    }
  });

  it("applies the same winner contract to the pairwise surface", () => {
    const p = (winner: unknown, probs_: Record<string, number>) => ({
      pairwise_context: { type: "choice", choice: winner, probabilities: probs_ },
    });
    expect(pairwiseFromAnswers(p(undefined, probs(PAIRWISE_KEYS, "SAME_CONTEXT")), verified)).toBeNull();
    expect(
      pairwiseFromAnswers(
        p("UNCLEAR", { SAME_CONTEXT: 0.8, DIFFERENT_CONTEXT: 0.15, UNCLEAR: 0.05 }),
        verified,
      ),
    ).toBeNull();
    expect(pairwiseFromAnswers(p("SAME_CONTEXT", probs(PAIRWISE_KEYS, "SAME_CONTEXT")), verified)).not.toBeNull();
  });
});

describe("pairwiseFromAnswers", () => {
  it("parses pairwise context choice", () => {
    const r = pairwiseFromAnswers(pairwiseAnswers, verified);
    expect(r!.sameContext).toBeCloseTo(0.8);
    expect(r!.differentContext).toBeLessThan(0.8);
  });

  it("returns null on malformed pairwise answers", () => {
    expect(pairwiseFromAnswers({}, verified)).toBeNull();
    expect(pairwiseFromAnswers({ pairwise_context: { type: "noul", noul: 1 } }, verified)).toBeNull();
  });

  it("returns null on an unnormalized or incomplete pairwise distribution", () => {
    expect(
      pairwiseFromAnswers(
        { pairwise_context: choice("SAME_CONTEXT", Object.fromEntries(PAIRWISE_KEYS.map((k) => [k, 0.5]))) },
        verified,
      ),
    ).toBeNull();
    expect(
      pairwiseFromAnswers(
        {
          pairwise_context: choice("SAME_CONTEXT", {
            SAME_CONTEXT: 0.7,
            DIFFERENT_CONTEXT: 0.3,
          }),
        },
        verified,
      ),
    ).toBeNull();
  });
});

/* --------------------------- model provenance --------------------------- */

describe("resolveModelIdentity", () => {
  it("verified only when the provider reported the configured model exactly", () => {
    expect(resolveModelIdentity(JEV_MODEL, JEV_MODEL)).toEqual({
      requested: JEV_MODEL,
      reported: JEV_MODEL,
      status: "verified",
      pinned: true,
    });
  });

  it("unexpected when a different non-empty identity is reported", () => {
    expect(resolveModelIdentity(JEV_MODEL, "unexpected-model-v9")).toEqual({
      requested: JEV_MODEL,
      reported: "unexpected-model-v9",
      status: "unexpected",
      pinned: true,
    });
  });

  it("missing — never guessed — for absent, blank, non-string or array identities", () => {
    for (const reported of [undefined, null, "", "   ", 7, true, {}, [], ["jev-1.13.0"]]) {
      const id = resolveModelIdentity(JEV_MODEL, reported);
      expect(id.status, String(reported)).toBe("missing");
      expect(id.reported, String(reported)).toBeNull();
    }
  });

  it("keeps an explicit override inspectable instead of rewriting it", () => {
    expect(resolveModelIdentity("jev-1.14.0", "jev-1.14.0")).toEqual({
      requested: "jev-1.14.0",
      reported: "jev-1.14.0",
      status: "verified",
      pinned: false,
    });
  });

  it("a case-different identity is unexpected, not verified", () => {
    expect(resolveModelIdentity(JEV_MODEL, "JEV-1.13.0").status).toBe("unexpected");
    expect(resolveModelIdentity(JEV_MODEL, "jev-1.13.0 ").status).toBe("unexpected");
  });
});

describe("verifiedPinnedModel — rechecked against the identifiers, not the flags", () => {
  it("yields the pinned model only for a verified pinned identity", () => {
    expect(verifiedPinnedModel(verified)).toBe(JEV_MODEL);
  });

  it("yields null for unexpected, missing, unpinned and absent identities", () => {
    expect(verifiedPinnedModel(unexpected)).toBeNull();
    expect(verifiedPinnedModel(missing)).toBeNull();
    expect(verifiedPinnedModel(resolveModelIdentity("jev-1.14.0", "jev-1.14.0"))).toBeNull();
    expect(verifiedPinnedModel(null)).toBeNull();
    expect(verifiedPinnedModel(undefined)).toBeNull();
    expect(verifiedPinnedModel({} as unknown as JevModelIdentity)).toBeNull();
    expect(verifiedPinnedModel("jev-1.13.0" as unknown as JevModelIdentity)).toBeNull();
  });

  it("ignores forged status/pinned flags and re-derives them from the identifiers", () => {
    const forgedVerified = {
      requested: "other",
      reported: "other",
      status: "verified",
      pinned: true,
    } as unknown as JevModelIdentity;
    expect(verifiedPinnedModel(forgedVerified)).toBeNull();

    const forgedPinned = {
      requested: JEV_MODEL,
      reported: "jev-1.14.0",
      status: "verified",
      pinned: true,
    } as unknown as JevModelIdentity;
    expect(verifiedPinnedModel(forgedPinned)).toBeNull();

    // flags that disagree with truthful identifiers do not revoke a real match
    const understated = {
      requested: JEV_MODEL,
      reported: JEV_MODEL,
      status: "missing",
      pinned: false,
    } as unknown as JevModelIdentity;
    expect(verifiedPinnedModel(understated)).toBe(JEV_MODEL);
  });
});

describe("JevClient.ask — provider-boundary model validation", () => {
  it("posts the pinned model + questions map with bearer auth", async () => {
    const fetchImpl = jsonResponse({
      model: JEV_MODEL,
      answers: { relevance: { type: "noul", noul: 1 } },
    });
    const client = new JevClient({ apiKey: "k", fetchImpl: fetchImpl as never });
    const res = await client.ask({ x: 1 }, { pairwise_context: PAIRWISE_QUESTION });
    expect(res.model).toBe(JEV_MODEL);
    expect(res.identity.status).toBe("verified");
    expect(res.identity.pinned).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(JEV_ENDPOINT);
    expect(String((init.headers as Record<string, string>)["authorization"])).toBe("Bearer k");
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe(JEV_MODEL);
    expect(body.questions.pairwise_context.type).toBe("choice");
  });

  it("REFUSES an unexpected model identity and never relabels it as jev-1.13.0", async () => {
    const client = new JevClient({
      apiKey: "k",
      fetchImpl: jsonResponse({ model: "unexpected-model-v9", answers: traceAnswers }) as never,
    });
    const err = await client
      .ask({ x: 1 }, { relevance: RELEVANCE_QUESTION })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe("malformed");
    expect((err as ProviderError).message).toBe("jev model identity unexpected");
  });

  it("REFUSES a response with no model identity at all", async () => {
    for (const body of [
      { answers: traceAnswers },
      { model: null, answers: traceAnswers },
      { model: "", answers: traceAnswers },
      { model: 7, answers: traceAnswers },
      { model: ["jev-1.13.0"], answers: traceAnswers },
    ]) {
      const client = new JevClient({ apiKey: "k", fetchImpl: jsonResponse(body) as never });
      const err = await client
        .ask({ x: 1 }, { relevance: RELEVANCE_QUESTION })
        .catch((e: unknown) => e);
      expect((err as ProviderError).message, JSON.stringify(body)).toBe("jev model identity missing");
    }
  });

  it("REFUSES a verified but unpinned override rather than labelling it jev-1.13.0", async () => {
    const fetchImpl = jsonResponse({ model: "jev-1.14.0", answers: traceAnswers });
    const client = new JevClient({
      apiKey: "k",
      model: "jev-1.14.0",
      fetchImpl: fetchImpl as never,
    });
    expect(client.model).toBe("jev-1.14.0");
    const err = await client
      .ask({ x: 1 }, { relevance: RELEVANCE_QUESTION })
      .catch((e: unknown) => e);
    expect((err as ProviderError).message).toBe("jev model is not the pinned model");
    // the override is really sent on the wire, unmodified
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body)).model).toBe("jev-1.14.0");
    expect(verifiedPinnedModel(resolveModelIdentity("jev-1.14.0", "jev-1.14.0"))).toBeNull();
  });

  it("rejects a non-object response body", async () => {
    for (const body of [null, 7, "ok", [1, 2]]) {
      const client = new JevClient({ apiKey: "k", fetchImpl: jsonResponse(body) as never });
      const err = await client
        .ask({ x: 1 }, { relevance: RELEVANCE_QUESTION })
        .catch((e: unknown) => e);
      expect((err as ProviderError).message).toBe("jev response was not a JSON object");
    }
  });

  it("returns empty answers — not a throw — when a verified response omits `answers`", async () => {
    const client = new JevClient({
      apiKey: "k",
      fetchImpl: jsonResponse({ model: JEV_MODEL }) as never,
    });
    const res = await client.ask({ x: 1 }, { relevance: RELEVANCE_QUESTION });
    expect(res.answers).toEqual({});
    expect(res.identity.status).toBe("verified");
    expect(judgmentFromAnswers(res.answers, { claimMode: false, provenance: res.identity })).toBeNull();
  });

  it("yields a usable judgment end to end for a valid pinned-model response", async () => {
    const client = new JevClient({
      apiKey: "k",
      fetchImpl: jsonResponse({ model: JEV_MODEL, answers: traceAnswers }) as never,
    });
    const res = await client.ask({}, { relevance: RELEVANCE_QUESTION });
    const j = judgmentFromAnswers(res.answers, { claimMode: false, provenance: res.identity });
    expect(j).not.toBeNull();
    expect(j!.model).toBe(JEV_MODEL);
    expect(j!.relevance).toBeCloseTo(0.9);
  });

  it("an unexpected model can reach no judgment through the real client path", async () => {
    const client = new JevClient({
      apiKey: "k",
      fetchImpl: jsonResponse({ model: "unexpected-model-v9", answers: traceAnswers }) as never,
    });
    await expect(client.ask({}, { relevance: RELEVANCE_QUESTION })).rejects.toBeInstanceOf(ProviderError);
  });
});

describe("refusal errors cannot echo provider or configured content", () => {
  const ask = (body: unknown) => {
    const client = new JevClient({
      apiKey: "super-secret-token",
      model: "SYNTHETIC_REQUESTED\nSENTINEL",
      fetchImpl: jsonResponse(body) as never,
    });
    return client
      .ask({ x: 1 }, { relevance: RELEVANCE_QUESTION })
      .then(
        () => new ProviderError("network", "SYNTHETIC_unexpected_success") as ProviderError,
        (e: unknown) => e as ProviderError,
      );
  };

  it("never reproduces a malicious or oversized model field", async () => {
    const secrets = [
      "SYNTHETIC_ECHOED_SECRET",
      "unexpected-model-v9\nprovider-body-SENTINEL\r\ninjected: log line",
      "x".repeat(10_000),
      `${"y".repeat(9_990)}SENTINEL`,
    ];
    for (const reported of secrets) {
      const err = await ask({ model: reported, answers: traceAnswers, secret: "do-not-log" });
      expect(err).toBeInstanceOf(ProviderError);
      const msg = err.message;
      // one of the fixed, enumerated reasons
      expect(
        [
          "jev model identity unexpected",
          "jev model identity missing",
          "jev model is not the pinned model",
        ],
      ).toContain(msg);
      // nothing from the response body, the override, or the credential
      expect(msg).not.toContain("SYNTHETIC");
      expect(msg).not.toContain("SENTINEL");
      expect(msg).not.toContain("super-secret-token");
      expect(msg).not.toContain("do-not-log");
      expect(msg).not.toContain("https://");
      expect(msg).not.toMatch(/[\r\n]/);
      // bounded: a 10k model must not produce a 10k message
      expect(msg.length).toBeLessThan(64);
    }
  });

  it("uses one static message per reason, independent of content", async () => {
    const a = await ask({ model: "unexpected-model-v9", answers: traceAnswers });
    const b = await ask({ model: "a".repeat(5_000), answers: traceAnswers });
    expect(a.message).toBe(b.message);
  });

  it("only a verified pinned model is ever attached to a successful result", async () => {
    const ok = new JevClient({
      apiKey: "k",
      fetchImpl: jsonResponse({ model: JEV_MODEL, answers: traceAnswers }) as never,
    });
    const res = await ok.ask({}, { relevance: RELEVANCE_QUESTION });
    // the only identifiers a caller can read are the allowlisted pinned model
    expect(res.identity.requested).toBe(JEV_MODEL);
    expect(res.identity.reported).toBe(JEV_MODEL);
  });
});

describe("model provenance is required at both judgment constructors", () => {
  it("rejects a judgment when the supplied identity is unexpected, missing or null", () => {
    expect(judgmentFromAnswers(traceAnswers, { claimMode: false, provenance: unexpected })).toBeNull();
    expect(judgmentFromAnswers(traceAnswers, { claimMode: false, provenance: missing })).toBeNull();
    expect(judgmentFromAnswers(traceAnswers, { claimMode: false, provenance: null })).toBeNull();
  });

  it("rejects an override identity even though it verified on the wire", () => {
    expect(
      judgmentFromAnswers(traceAnswers, {
        claimMode: false,
        provenance: resolveModelIdentity("jev-1.14.0", "jev-1.14.0"),
      }),
    ).toBeNull();
  });

  it("rejects a hand-built identity whose flags contradict its identifiers", () => {
    const forged = {
      requested: "other",
      reported: "other",
      status: "verified",
      pinned: true,
    } as unknown as JevModelIdentity;
    expect(judgmentFromAnswers(traceAnswers, { claimMode: false, provenance: forged })).toBeNull();
  });

  it("accepts and labels the pinned model for a verified identity", () => {
    const j = judgmentFromAnswers(traceAnswers, { claimMode: false, provenance: verified });
    expect(j).not.toBeNull();
    expect(j!.model).toBe(JEV_MODEL);
  });

  it("gates the pairwise judgment on the same required identity", () => {
    expect(pairwiseFromAnswers(pairwiseAnswers, unexpected)).toBeNull();
    expect(pairwiseFromAnswers(pairwiseAnswers, missing)).toBeNull();
    expect(pairwiseFromAnswers(pairwiseAnswers, null)).toBeNull();
    expect(pairwiseFromAnswers(pairwiseAnswers, verified)).not.toBeNull();
  });

  it("the judgment model is always the constant, never a provider-supplied string", () => {
    for (const provenance of [verified, unexpected, missing, null]) {
      const j = judgmentFromAnswers(traceAnswers, { claimMode: false, provenance });
      if (j !== null) expect(j.model).toBe(JEV_MODEL);
    }
  });
});
