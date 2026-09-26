/**
 * Jev question sets (spec §15.3, §16, §20.1).
 *
 * Instructions and option descriptions are copied verbatim from the frozen
 * spec; question keys are wire labels only — the model never sees them as
 * semantic input beyond the instruction text.
 */

import type { EvidenceCandidate } from "../investigation/contracts/evidence";

export type JevQuestionType = "noul" | "choice" | "score";

export interface JevQuestion {
  type: JevQuestionType;
  instructions: string;
  criteria?: Record<string, string | null>;
}

/** §16.1 — Relevance (Noul). */
export const RELEVANCE_QUESTION: JevQuestion = {
  type: "noul",
  instructions:
    "Based only on the supplied evidence, is this result materially relevant to the image or event under investigation?",
  criteria: {
    true: "The result contains meaningful evidence concerning the same media, the same underlying event, or directly related context.",
    false: "The relationship is incidental, generic, or off-topic.",
  },
};

/** §16.2 — Context relationship (Choice, claim-check mode only). */
export const CONTEXT_QUESTION: JevQuestion = {
  type: "choice",
  instructions:
    "How does the context described by this result relate to the context asserted in the user's claim?",
  criteria: {
    SAME_CONTEXT:
      "The result appears to describe the same underlying event or situation asserted by the claim.",
    DIFFERENT_CONTEXT:
      "The result associates the media with a different event, place, time, or situation.",
    HISTORICAL_REFERENCE:
      "The result discusses the same or related media historically or retrospectively rather than presenting it as the claimed current event.",
    UNCLEAR:
      "The evidence does not contain enough information to determine the relationship.",
  },
};

/** §16.3 — Page role (Choice). */
export const PAGE_ROLE_QUESTION: JevQuestion = {
  type: "choice",
  instructions:
    "What role does this page appear to play based only on the supplied evidence?",
  criteria: {
    REPORTING: null,
    FACT_CHECK: null,
    SOCIAL_REPOST: null,
    AGGREGATOR: null,
    COMMENTARY: null,
    OTHER: null,
  },
};

/** §16.4 — Claim relationship (Choice, claim-check mode only). */
export const CLAIM_QUESTION: JevQuestion = {
  type: "choice",
  instructions:
    "Based only on the supplied evidence, how does this source relate to the user's claim about what the media depicts?",
  criteria: {
    SUPPORTS: null,
    CONTRADICTS: null,
    NEUTRAL: null,
    INSUFFICIENT: null,
  },
};

/** §16.5 — Location relationship (Choice, only when the claim states one). */
export const LOCATION_QUESTION: JevQuestion = {
  type: "choice",
  instructions:
    "Based only on explicit location information in the claim and evidence, how do the locations relate?",
  criteria: {
    SAME_LOCATION: null,
    DIFFERENT_LOCATION: null,
    LOCATION_NOT_STATED: null,
    UNCLEAR: null,
  },
};

/** §20.1 — Pairwise context comparison (Choice). */
export const PAIRWISE_QUESTION: JevQuestion = {
  type: "choice",
  instructions:
    "Do these two occurrences present the media as belonging to the same underlying event or context?",
  criteria: {
    SAME_CONTEXT: null,
    DIFFERENT_CONTEXT: null,
    UNCLEAR: null,
  },
};

/** §15.3 — one candidate per Jev state; never the whole pool. */
export function candidateState(
  c: EvidenceCandidate,
  claim: string | null,
  excerpt: string | null,
): Record<string, unknown> {
  return {
    claim,
    media_relationship: c.mediaRelationship,
    result: {
      title: c.title,
      snippet: c.snippet,
      domain: c.registrableDomain,
      published_at: c.publishedAt,
      retrieval_kind: c.retrievalKind,
      page_excerpt: excerpt,
    },
  };
}

/** §20.1 — two occurrences per pairwise state. */
export function pairwiseState(
  a: EvidenceCandidate,
  b: EvidenceCandidate,
  excerptA: string | null,
  excerptB: string | null,
): Record<string, unknown> {
  const summarize = (c: EvidenceCandidate, excerpt: string | null) => ({
    title: c.title,
    snippet: c.snippet,
    domain: c.registrableDomain,
    published_at: c.publishedAt,
    media_relationship: c.mediaRelationship,
    page_excerpt: excerpt,
  });
  return { occurrence_a: summarize(a, excerptA), occurrence_b: summarize(b, excerptB) };
}

/**
 * §16.5 — the location question is asked only when the claim *explicitly*
 * contains a usable location. §16.5 also forbids inferring an unstated
 * location, so eligibility is decided by an explicit locative construction
 * (or a frozen place name) and never by named-entity capitalization alone.
 *
 * `claimLocationEligibility` returns the full, inspectable record: the claim
 * verbatim, the matched spans, and the reason. `claimMayStateLocation` is the
 * boolean view of the same decision and is kept for existing callers.
 */

/** Frozen lowercase place names. Any case form matches; casing is not evidence. */
const PLACE_NAMES = new Set([
  // The §16.5 canonical case, first.
  "london",
  "delhi", "mumbai", "kolkata", "chennai", "bengaluru", "bangalore", "hyderabad",
  "karachi", "lahore", "islamabad", "dhaka", "kathmandu", "colombo",
  "kyiv", "kiev", "moscow", "st petersburg", "minsk", "warsaw", "budapest",
  "bucharest", "sofia", "belgrade", "zagreb", "athens", "ankara", "istanbul",
  "tehran", "baghdad", "damascus", "beirut", "amman", "jerusalem", "gaza",
  "ramallah", "cairo", "alexandria", "khartoum", "addis ababa", "mogadishu",
  "nairobi", "kampala", "kinshasa", "lagos", "abuja", "accra", "pretoria",
  "johannesburg", "cape town", "tunis", "algiers", "tripoli", "rabat",
  "sanaa", "riyadh", "dubai", "doha", "kuwait city", "manama", "muscat",
  "tokyo", "osaka", "kyoto", "seoul", "pyongyang", "beijing", "shanghai",
  "shenzhen", "hong kong", "taipei", "singapore", "bangkok", "hanoi", "jakarta",
  "manila", "kuala lumpur", "yangon", "phnom penh", "vientiane", "delhi",
  "new york", "washington", "boston", "chicago", "houston", "miami", "seattle",
  "san francisco", "los angeles", "portland", "atlanta", "detroit", "phoenix",
  "toronto", "vancouver", "montreal", "ottawa", "mexico city", "guadalajara",
  "bogota", "lima", "santiago", "buenos aires", "rio de janeiro", "sao paulo",
  "brasilia", "caracas", "havana", "kingston", "san jose", "guatemala city",
  "managua", "panama city", "london", "manchester", "birmingham", "glasgow",
  "edinburgh", "cardiff", "belfast", "dublin", "paris", "marseille", "lyon",
  "toulouse", "bordeaux", "nice", "lille", "strasbourg", "montpellier",
  "berlin", "munich", "hamburg", "frankfurt", "cologne", "dusseldorf",
  "stuttgart", "dresden", "leipzig", "bremen", "hannover", "nuremberg",
  "rome", "milan", "naples", "turin", "florence", "venice", "bologna",
  "madrid", "barcelona", "valencia", "seville", "zaragoza", "bilbao",
  "lisbon", "porto", "amsterdam", "rotterdam", "the hague", "utrecht",
  "antwerp", "brussels", "ghent", "bruges", "luxembourg", "zurich", "geneva",
  "basel", "bern", "vienna", "salzburg", "innsbruck", "copenhagen",
  "stockholm", "oslo", "helsinki", "reykjavik", "dublin", "cork", "galway",
  "canada", "america", "united states", "usa", "uk", "britain", "england",
  "scotland", "wales", "ireland", "france", "germany", "spain", "portugal",
  "italy", "greece", "turkey", "poland", "ukraine", "russia", "belarus",
  "romania", "bulgaria", "serbia", "croatia", "netherlands", "belgium",
  "switzerland", "austria", "denmark", "sweden", "norway", "finland",
  "iceland", "estonia", "latvia", "lithuania", "india", "pakistan", "bangladesh",
  "sri lanka", "nepal", "china", "japan", "korea", "taiwan", "mongolia",
  "vietnam", "thailand", "philippines", "indonesia", "malaysia", "myanmar",
  "cambodia", "laos", "australia", "new zealand", "egypt", "sudan", "ethiopia",
  "somalia", "kenya", "nigeria", "ghana", "senegal", "mali", "libya",
  "algeria", "morocco", "israel", "palestine", "jordan", "lebanon", "syria",
  "iraq", "iran", "saudi arabia", "yemen", "afghanistan", "qatar", "kuwait",
  "oman", "united arab emirates", "uzbekistan", "kazakhstan", "georgia",
  "armenia", "azerbaijan", "mexico", "brazil", "argentina", "chile", "peru",
  "colombia", "venezuela", "cuba", "bolivia", "ecuador", "uruguay",
  "paraguay", "guatemala", "honduras", "nicaragua", "panama", "costa rica",
  "europe", "asia", "africa", "america north", "america south", "middle east",
  "the middle east", "south asia", "southeast asia", "east asia",
  "central asia", "east africa", "west africa", "north africa", "latin america",
  "north america", "south america", "european union", "red sea", "mediterranean",
  "black sea", "gulf", "pacific", "atlantic", "indian ocean",
  "baltic", "caribbean", "himalayas", "sahara", "ganges", "nile", "amazon",
  "danube", "rhine", "thames",
  // compound names whose head token alone is ambiguous or a non-place word
  "white house", "wall street", "times square", "trafalgar square", "red square",
  "greenwich", "new delhi", "old delhi", "new york city", "abu dhabi",
  "north korea", "south korea", "united kingdom", "el salvador", "ivory coast",
  "czech republic", "dar es salaam", "sharm el sheikh", "ho chi minh city",
  "bucharest", "crimea", "kosovo", "macau", "west bank", "golan heights",
]);

/** Unambiguously geographic common nouns — eligible in any locative frame. */
const PLACE_NOUNS = new Set([
  "airport", "altar", "arena", "airstrip", "aqueduct", "atrium", "barracks",
  "basement", "bathroom", "bedroom", "beach", "belfry", "bridge", "building",
  "campus", "canal", "canyon", "chapel", "church", "cinema", "city", "cliff",
  "coast", "courtyard", "dam", "desert", "dock", "downtown", "dungeon",
  "embassy", "factory", "farm", "field", "forest", "fortress", "foundry",
  "garden", "glacier", "gym", "hall", "harbour", "harbor", "highway", "hill",
  "hospital", "hotel", "house", "intersection", "island", "junction", "lake",
  "library", "lighthouse", "mall", "market", "mine", "monastery", "mosque",
  "mountain", "museum", "office", "orchard", "palace", "park", "parking",
  "pier", "port", "prison", "railway", "reservoir", "restaurant", "river",
  "road", "rooftop", "room", "runway", "school", "sea", "shore", "skyline",
  "square", "stadium", "station", "street", "studio", "suburb", "subway",
  "temple", "terminal", "theatre", "theater", "town", "tunnel", "university",
  "village", "volcano", "warehouse", "waterfront", "yard",
]);

/**
 * Tokens that are commonly capitalized or prepositional objects but are never
 * a location. Checked before the place tests, so "on Twitter", "in the news"
 * and "in the picture" cannot qualify.
 */
const NON_PLACE = new Set([
  // media / platform
  "news", "picture", "pictures", "photo", "photos", "photograph", "image",
  "images", "video", "videos", "clip", "clips", "footage", "stream", "screenshot",
  "screen", "screen", "television", "tv", "radio", "newspaper", "magazine",
  "article", "articles", "post", "posts", "tweet", "thread", "story", "report",
  "website", "web", "internet", "online", "print", "press", "media",
  "twitter", "facebook", "instagram", "youtube", "tiktok", "reddit", "telegram",
  "snapchat", "whatsapp", "linkedin", "mastodon", "substack", "medium",
  "wordpress", "blog", "channel", "page", "site", "app", "device", "phone",
  "camera", "lens", "resolution", "quality", "colour", "color", "black",
  "white", "grayscale", "greyscale", "monochrome", "sepia",
  // cognition / discourse
  "fact", "facts", "fact-check", "detail", "details", "context", "reverse",
  "search", "memory", "remembrance", "mind", "doubt", "question", "questions",
  "answer", "answers", "conclusion", "purpose", "general", "particular",
  "case", "cases", "example", "addition", "summary", "verdict", "truth",
  "lie", "hoax", "fake", "real", "reality", "public", "attention", "focus",
  "name", "names", "word", "words", "language", "english", "hindi", "arabic",
  "opinion", "views", "people", "everyone", "nobody", "someone", "anything",
  "something", "nothing", "everything", "everyone's", "it", "him", "her",
  "them", "they", "he", "she", "we", "you", "i", "my", "our", "your", "their",
  "his", "hers", "theirs", "its",
  // time / season / position
  "time", "times", "day", "days", "week", "weeks", "month", "months", "year",
  "years", "morning", "afternoon", "evening", "night", "noon", "midnight",
  "today", "tomorrow", "yesterday", "tonight", "spring", "summer", "autumn",
  "fall", "winter", "season", "seasons", "century", "decade", "weekend",
  "front", "back", "top", "bottom", "left", "right", "middle", "centre",
  "center", "half", "part", "parts", "end", "beginning", "total", "sum",
  "addition", "purpose", "distance", "depth", "height", "length", "width",
  "order", "reverse", "circles", "fashion", "real", "reverse-image",
  "date", "dates", "moment", "moments", "period", "periods", "era", "anniversary",
  "o'clock", "clock", "hour", "hours", "minute", "minutes", "second", "seconds",
  // weather / natural non-locative
  "rain", "snow", "sun", "wind", "fog", "storm", "smoke", "fire", "air",
  "water", "dust", "mud", "sand", "dark", "light", "colour", "color",
]);

/**
 * Weekdays, months and similar temporal tokens. A date is orderable but it is
 * not geography, so these are refused in every case form — this is what keeps
 * capitalization from standing in for a location.
 */
const TEMPORAL = new Set([
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december",
  "week", "weeks", "weekend", "weekends", "month", "months", "year", "years",
  "day", "days", "today", "tomorrow", "yesterday", "tonight", "decade",
  "decades", "century", "centuries", "season", "seasons", "spring", "summer",
  "autumn", "winter", "morning", "afternoon", "evening", "night", "noon",
  "midnight", "date", "dates", "time", "times", "era", "moment", "moments",
  "period", "periods", "anniversary", "clock", "o'clock",
]);

/** Person roles — a capitalized role or name is not a place. */
const PERSON_ROLES = new Set([
  "mr", "mrs", "ms", "dr", "sir", "madam", "prof", "president", "vice-president",
  "minister", "prime", "chancellor", "governor", "mayor", "minister's", "king",
  "queen", "prince", "princess", "sheikh", "imam", "bishop", "pope", "sultan",
  "chief", "commander", "general", "colonel", "major", "captain", "sergeant",
  "officer", "official", "officials", "spokesperson", "police", "soldier",
  "soldiers", "troops", "army", "nato", "un", "who", "man", "woman", "men",
  "women", "boy", "girl", "child", "children", "kid", "kids", "baby", "person",
  "people", "student", "students", "worker", "workers", "farmer", "protester",
  "protestors", "protester", "refugee", "refugees", "journalist", "reporter",
  "photographer", "witness", "witnesses", "victim", "victims", "resident",
  "residents", "resident's", "citizen", "citizens", "doctor", "nurse",
  "teacher", "activist", "activists", "crew", "staff", "model", "actor",
  "singer", "athlete", "player", "driver", "shopkeeper", "monk", "nun",
  "boyfriend", "girlfriend", "husband", "wife", "father", "mother", "son",
  "daughter", "friend", "friends", "stranger", "tourist", "tourists", "who's",
]);

/** Locative prepositions that can introduce an explicit location. */
const LOCATIVE_PREPOSITIONS = new Set([
  "in", "at", "on", "from", "near", "inside", "within", "outside", "across",
  "around", "throughout", "beside", "along", "into", "onto", "upon",
]);

/**
 * Function words that may sit between the preposition and the name. Only pure
 * function words belong here: an adjective such as "new" or "old" is part of a
 * place name ("New York", "Old Delhi"), so treating it as skippable would
 * truncate the name.
 */
const DETERMINERS = new Set([
  "the", "a", "an", "this", "that", "these", "those", "its", "their", "his",
  "her", "our", "your", "my", "of",
]);

/**
 * Filler inside a compound preposition ("in front of the White House", "next
 * to the river"). The real object follows the whole phrase, so these tokens are
 * skipped on the way to it. They are all spatial words in their own right, so
 * none of them can silently stand in as the location.
 */
const COMPOUND_PREPOSITION_FILLER = new Set([
  "front", "top", "next", "close", "nearest", "opposite", "adjacent", "back",
  "behind", "above", "below", "under", "underneath", "over", "beneath",
  "outside", "out", "inside", "beside", "beyond", "around", "across", "along",
  "throughout", "of", "to",
]);

/** Words that may not end a candidate span. */
const SPAN_STOP = new Set([
  "in", "at", "on", "from", "near", "of", "and", "or", "but", "is", "was",
  "were", "are", "be", "been", "being", "to", "for", "with", "as", "by",
  "that", "which", "who", "while", "after", "before", "during", "since",
  "until", "where", "when", "what", "why", "how", "this", "that", "these",
  "those", "a", "an", "the", "not", "no", "so", "then", "than", "there",
]);

export type LocationRejection =
  | "no_locative_construction"
  | "candidate_not_a_place"
  | "candidate_is_a_person"
  | "candidate_is_non_place";

/**
 * Typed, inspectable §16.5 eligibility record. Carries the claim verbatim,
 * the matched spans, and the reason; never a product status or verdict
 * (§15.2 — Jev may not decide the final product status, and neither may this
 * heuristic).
 */
export interface LocationEligibility {
  /** the claim exactly as supplied — never normalized, trimmed or rewritten */
  readonly claim: string;
  readonly eligible: boolean;
  /** machine-readable positive reasons, most specific first */
  readonly reasons: readonly string[];
  /** verbatim spans that justify `eligible` */
  readonly evidence: readonly string[];
  /** the rejection that decided `eligible: false`, else null */
  readonly rejectedBy: LocationRejection | null;
  /** verbatim candidate spans that were examined and refused */
  readonly rejected: readonly string[];
}

/** One candidate name-span, tried verbatim against the place tests. */
interface Attempt {
  /** the span exactly as it appears in the claim, trimmed of edge punctuation */
  raw: string;
  /** punctuation-stripped, lowercased form used for every lookup */
  lower: string;
  /** true when the span's head word is capitalized in the original claim */
  capitalized: boolean;
  /** every word, lowercased, so a phrase can be refused as a whole */
  words: string[];
}

interface Candidate {
  /** attempts in widening order: the head token, then head + next token */
  attempts: Attempt[];
  kind: "preposition" | "copula";
}

/** Why an attempt qualified, for the inspectable rationale. */
type PlaceReason = "named_place" | "geographic_noun" | "proper_noun_in_locative_frame";

function stripPunctuation(w: string): string {
  return w.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
}

function isNumeric(w: string): boolean {
  return /^[\d.,/-]+$/.test(w);
}

function isCapitalized(w: string): boolean {
  return /^[A-Z][a-z]/.test(w);
}

function attempt(raw: string): Attempt {
  const trimmed = raw.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
  const words = trimmed.split(/\s+/).filter((w) => w.length > 0);
  // the head of a proper-noun phrase is its last word: "northern France",
  // "Old Delhi", "the White House"
  const headWord = words.length > 0 ? words[words.length - 1] : "";
  return {
    raw: trimmed,
    // a possessive is dropped so "the reporter's desk" resolves to the role
    lower: trimmed.toLowerCase().replace(/['\u2019]s$/, ""),
    capitalized: isCapitalized(headWord),
    words: words.map((w) => w.toLowerCase().replace(/['\u2019]s$/, "")),
  };
}

/**
 * Collect locative candidate spans: `in <name>` and `<Name> is where`.
 *
 * Each preposition yields at most two attempts — the head token alone, then
 * the head plus one following token — which is enough for compound place
 * names without greedily swallowing the rest of the clause.
 */
function collectCandidates(claim: string): Candidate[] {
  const words = claim.split(/\s+/).filter((t) => t.length > 0);
  const lower = words.map((w) => stripPunctuation(w).toLowerCase());
  const out: Candidate[] = [];

  for (let i = 0; i < words.length; i++) {
    const w = lower[i];
    // P1 — "<Name> is where ..." (the London-first subject frame).
    if (
      w.length > 0 &&
      (lower[i + 1] === "is" || lower[i + 1] === "was") &&
      (lower[i + 2] === "where" || lower[i + 2] === "when")
    ) {
      out.push({ attempts: [attempt(words[i])], kind: "copula" });
    }
    if (!LOCATIVE_PREPOSITIONS.has(w)) continue;
    // P2 — "<preposition> <compound filler|determiner>* <name>".
    let j = i + 1;
    while (
      j < words.length &&
      (DETERMINERS.has(lower[j]) || COMPOUND_PREPOSITION_FILLER.has(lower[j]))
    ) {
      j += 1;
    }
    if (j >= words.length) continue;
    const head = lower[j];
    if (head.length === 0 || isNumeric(head) || SPAN_STOP.has(head)) continue;
    const attempts = [attempt(words[j])];
    const next = lower[j + 1];
    if (j + 1 < words.length && next.length > 0 && !isNumeric(next) && !SPAN_STOP.has(next)) {
      attempts.push(attempt(`${words[j]} ${words[j + 1]}`));
    }
    out.push({ attempts, kind: "preposition" });
  }
  return out;
}

/**
 * Conservative place test for one attempt. Casing is corroboration only, never
 * sufficient on its own: a temporal token is refused in any case form, a person
 * role and a known non-place are refused outright, and a proper-noun-shaped
 * token qualifies only inside an explicit locative frame. A lowercase unknown
 * single word is a place we cannot name, so §16.5's "do not infer an unstated
 * location" applies and it is refused rather than guessed.
 */
function attemptVerdict(a: Attempt): LocationRejection | PlaceReason {
  if (a.lower.length === 0) return "candidate_not_a_place";
  // A whole compound place name is checked first, so "White House" resolves
  // even though "white" alone is a non-place word.
  if (PLACE_NAMES.has(a.lower)) return "named_place";
  if (a.words.length === 1) {
    if (TEMPORAL.has(a.lower)) return "candidate_not_a_place";
    if (NON_PLACE.has(a.lower)) return "candidate_is_non_place";
    if (PERSON_ROLES.has(a.lower)) return "candidate_is_a_person";
    if (PLACE_NOUNS.has(a.lower)) return "geographic_noun";
    if (a.capitalized) return "proper_noun_in_locative_frame";
    return "candidate_not_a_place";
  }
  // A phrase is refused outright when any of its words is a person role, a
  // temporal token or a non-place: "Mr Smith", "in front of the news".
  for (const w of a.words) {
    if (TEMPORAL.has(w)) return "candidate_not_a_place";
    if (PERSON_ROLES.has(w)) return "candidate_is_a_person";
    if (NON_PLACE.has(w)) return "candidate_is_non_place";
  }
  const head = a.words[a.words.length - 1];
  if (PLACE_NOUNS.has(head)) return "geographic_noun";
  if (a.capitalized) return "proper_noun_in_locative_frame";
  return "candidate_not_a_place";
}

function isRejection(v: LocationRejection | PlaceReason): v is LocationRejection {
  return v !== "named_place" && v !== "geographic_noun" && v !== "proper_noun_in_locative_frame";
}

/**
 * §16.5 eligibility with a full, inspectable rationale. The claim is returned
 * verbatim and no product verdict is derived here.
 */
export function claimLocationEligibility(claim: string): LocationEligibility {
  const rejected: string[] = [];
  const evidence: string[] = [];
  const reasons: string[] = [];
  const addReason = (r: string) => {
    if (!reasons.includes(r)) reasons.push(r);
  };
  const candidates = collectCandidates(claim);
  if (candidates.length === 0) {
    return {
      claim,
      eligible: false,
      reasons: [],
      evidence: [],
      rejectedBy: "no_locative_construction",
      rejected: [],
    };
  }
  let rejectedBy: LocationRejection | null = null;
  for (const c of candidates) {
    let matched: Attempt | null = null;
    let matchedReason: PlaceReason | null = null;
    let firstRejection: LocationRejection | null = null;
    for (const a of c.attempts) {
      const v = attemptVerdict(a);
      if (isRejection(v)) {
        if (firstRejection === null) firstRejection = v;
        continue;
      }
      matched = a;
      matchedReason = v;
      break;
    }
    if (matched !== null && matchedReason !== null) {
      evidence.push(matched.raw);
      if (c.kind === "copula") addReason("subject_locative_copula");
      addReason(matchedReason);
      addReason("explicit_locative_construction");
    } else {
      rejected.push(c.attempts[0].raw);
      if (rejectedBy === null) rejectedBy = firstRejection ?? "candidate_not_a_place";
    }
  }
  const eligible = evidence.length > 0;
  return {
    claim,
    eligible,
    reasons: eligible ? reasons : [],
    evidence: eligible ? evidence : [],
    rejectedBy: eligible ? null : (rejectedBy ?? "candidate_not_a_place"),
    rejected,
  };
}

/**
 * Boolean view of {@link claimLocationEligibility}. Retained so existing
 * callers keep working unchanged.
 */
export function claimMayStateLocation(claim: string): boolean {
  return claimLocationEligibility(claim).eligible;
}

/** Build the §16 question map for one candidate. */
export function evidenceQuestions(opts: {
  claimMode: boolean;
  claimHasLocation: boolean;
}): Record<string, JevQuestion> {
  const q: Record<string, JevQuestion> = {
    relevance: RELEVANCE_QUESTION,
    page_role: PAGE_ROLE_QUESTION,
  };
  if (opts.claimMode) {
    q.context_relation = CONTEXT_QUESTION;
    q.claim_relation = CLAIM_QUESTION;
    if (opts.claimHasLocation) q.location_relation = LOCATION_QUESTION;
  }
  return q;
}

/**
 * Additive companion to {@link evidenceQuestions}: the same question map plus
 * the §16.5 eligibility record that decided whether the location question is
 * present, so a caller can log the verbatim claim and the rationale without
 * re-deriving them. `locationEligibility` is null in Trace mode, where the
 * location question is never asked.
 */
export function evidenceQuestionsWithProvenance(opts: {
  claimMode: boolean;
  claim: string | null;
}): {
  questions: Record<string, JevQuestion>;
  locationEligibility: LocationEligibility | null;
} {
  const locationEligibility =
    opts.claimMode && opts.claim !== null
      ? claimLocationEligibility(opts.claim)
      : null;
  return {
    questions: evidenceQuestions({
      claimMode: opts.claimMode,
      claimHasLocation: locationEligibility?.eligible === true,
    }),
    locationEligibility,
  };
}
