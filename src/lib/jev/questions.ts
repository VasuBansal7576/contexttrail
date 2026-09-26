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
 * contains a usable location. §16.5 also forbids inferring an unstated location,
 * so eligibility is decided from **positive evidence that the span names a
 * place**, never from the shape of the words.
 *
 * Capitalization is explicitly *not* evidence of geographic meaning. A
 * capitalized token after a locative word may equally be a person ("from
 * Alice"), a publisher ("from Reuters"), a tool ("in Photoshop"), a language
 * ("in French") or a platform ("on Bluesky"), and treating it as a place is what
 * made the earlier gate ask about non-places. This gate therefore recognises a
 * place only through one of three positive signals:
 *
 *   1. a frozen gazetteer entry (§15 — London first, then world places, regions
 *      and compound names), matched accent- and case-insensitively;
 *   2. a place-type head noun ("the river", "the airport", "the stadium");
 *   3. address morphology (a street number followed by a street-type name,
 *      "10 Downing Street").
 *
 * A locative frame whose object matches none of those is reported as
 * `unknown`, which is a distinct outcome from "not a place": it is a place this
 * gate could not recognise, and it is recorded rather than asserted either way.
 * Both `not_eligible` and `unknown` decline to ask the question, so an
 * unrecognised name can never produce a location question about a person.
 *
 * `claimLocationEligibility` returns the full, inspectable record: the claim
 * verbatim, the complete claim-bound spans, and the reason. `claimMayStateLocation`
 * is the boolean view of the same decision and is kept for existing callers.
 */

/** Frozen lowercase gazetteer. Matched accent- and case-insensitively. */
const PLACE_NAMES = new Set([
  // The §16.5 canonical case, first.
  "london",
  // Compound names whose head token alone is ambiguous or a non-place word.
  "white house", "wall street", "times square", "trafalgar square", "red square",
  "greenwich", "new delhi", "old delhi", "new york city", "abu dhabi",
  "north korea", "south korea", "united kingdom", "el salvador", "ivory coast",
  "czech republic", "dar es salaam", "sharm el sheikh", "ho chi minh city",
  "crimea", "kosovo", "macau", "west bank", "golan heights", "bucharest",
  // India / South Asia
  "delhi", "mumbai", "kolkata", "chennai", "bengaluru", "bangalore", "hyderabad",
  "ahmedabad", "jaipur", "lucknow", "pune", "karachi", "lahore", "islamabad",
  "dhaka", "kathmandu", "colombo", "kabul", "dharan", "gaza city",
  // Europe
  "paris", "marseille", "lyon", "toulouse", "bordeaux", "nice", "lille",
  "strasbourg", "montpellier", "milan", "naples", "turin", "florence", "venice",
  "bologna", "munich", "hamburg", "frankfurt", "cologne", "dusseldorf",
  "stuttgart", "dresden", "leipzig", "bremen", "hannover", "nuremberg", "berlin",
  "madrid", "barcelona", "valencia", "seville", "zaragoza", "bilbao", "lisbon",
  "porto", "amsterdam", "rotterdam", "the hague", "utrecht", "antwerp",
  "brussels", "ghent", "bruges", "luxembourg", "zurich", "geneva", "basel",
  "bern", "vienna", "salzburg", "innsbruck", "copenhagen", "stockholm", "oslo",
  "helsinki", "reykjavik", "dublin", "cork", "galway", "sheffield", "manchester",
  "birmingham", "glasgow", "edinburgh", "cardiff", "belfast", "leeds",
  "bristol", "liverpool", "nottingham", "brighton", "oxford", "cambridge",
  "rome", "madonna", "venice", "athens", "thessaloniki", "sofia", "belgrade",
  "zagreb", "kyiv", "kiev", "kharkiv", "odessa", "minsk", "warsaw", "krakow",
  "budapest", "bucharest", "chisinau", "tallinn", "riga", "vilnius", "reykjavik",
  "moscow", "st petersburg", "novosibirsk", "yekaterinburg", "kazan",
  "lisbon", "belgrade", "helsinki", "tirana", "skopje", "sarajevo", "ljubljana",
  // Americas
  "new york", "washington", "boston", "chicago", "houston", "miami", "seattle",
  "san francisco", "los angeles", "san diego", "portland", "atlanta", "detroit",
  "phoenix", "dallas", "houston", "denver", "austin", "nashville", "toronto",
  "vancouver", "montreal", "ottawa", "mexico city", "guadalajara", "monterrey",
  "cancun", "bogota", "medellin", "lima", "la paz", "santiago", "valparaiso",
  "buenos aires", "cordoba", "rio de janeiro", "sao paulo", "brasilia",
  "caracas", "havana", "kingston", "san jose", "guatemala city", "managua",
  "panama city", "havana", "santo domingo", "san salvador", "port-au-prince",
  // Middle East / Africa / Asia
  "tokyo", "osaka", "kyoto", "seoul", "pyongyang", "beijing", "shanghai",
  "shenzhen", "guangzhou", "chengdu", "hong kong", "taipei", "singapore",
  "bangkok", "hanoi", "jakarta", "manila", "kuala lumpur", "yangon",
  "phnom penh", "vientiane", "ulaanbaatar", "kabul", "tehran", "isfahan",
  "baghdad", "basra", "mosul", "damascus", "aleppo", "beirut", "amman",
  "jerusalem", "gaza", "rafah", "ramallah", "hebron", "cairo", "alexandria",
  "giza", "khartoum", "addis ababa", "mogadishu", "nairobi", "kampala",
  "kinshasa", "lagos", "abuja", "accra", "ibadan", "kano", "pretoria",
  "johannesburg", "cape town", "durban", "tunis", "algiers", "tripoli",
  "benghazi", "rabat", "sanaa", "riyadh", "jeddah", "dubai", "doha", "manama",
  "kuwait city", "muscat", "ankara", "istanbul", "izmir", "antalya", "baku",
  "tbilisi", "yerevan", "taskhiran", "uzbekistan", "tashkent", "almaty",
  "astana", "panipat", "ayodhya", "varanasi", "kathmandu", "thimphu",
  // Countries / regions
  "canada", "america", "united states", "usa", "uk", "britain", "england",
  "scotland", "wales", "ireland", "france", "germany", "spain", "portugal",
  "italy", "greece", "turkey", "poland", "ukraine", "russia", "belarus",
  "romania", "bulgaria", "serbia", "croatia", "netherlands", "belgium",
  "switzerland", "austria", "denmark", "sweden", "norway", "finland", "iceland",
  "estonia", "latvia", "lithuania", "hungary", "slovakia", "slovenia",
  "moldova", "georgia", "armenia", "azerbaijan", "kazakhstan", "india",
  "pakistan", "bangladesh", "sri lanka", "nepal", "china", "japan", "korea",
  "taiwan", "mongolia", "vietnam", "thailand", "philippines", "indonesia",
  "malaysia", "myanmar", "cambodia", "laos", "australia", "new zealand",
  "egypt", "sudan", "ethiopia", "somalia", "eritrea", "kenya", "nigeria",
  "ghana", "senegal", "mali", "libya", "algeria", "morocco", "tunisia",
  "israel", "palestine", "jordan", "lebanon", "syria", "iraq", "iran",
  "saudi arabia", "yemen", "afghanistan", "qatar", "kuwait", "oman",
  "united arab emirates", "south africa", "zimbabwe", "zambia", "uganda",
  "rwanda", "tanzania", "mozambique", "angola", "ghana", "cameroon",
  "ivory coast", "burkina faso", "niger", "chad", "sudan", "somalia",
  "mexico", "brazil", "argentina", "chile", "peru", "colombia", "venezuela",
  "cuba", "bolivia", "ecuador", "uruguay", "paraguay", "guatemala", "honduras",
  "nicaragua", "panama", "costa rica", "belize", "jamaica", "haiti",
  "dominican republic", "trinidad and tobago", "barbados", "bahamas",
  // Seas, rivers, regions, features
  "red sea", "mediterranean", "black sea", "caspian sea", "baltic", "arctic",
  "pacific", "atlantic", "indian ocean", "caribbean", "gulf", "strait",
  "himalayas", "sahara", "gobi", "amazon", "danube", "rhine", "thames", "nile",
  "ganges", "euphrates", "tigris", "volga", "danube", "seine", "elbe", "rhone",
  "europe", "asia", "africa", "oceania", "middle east", "south asia",
  "southeast asia", "east asia", "central asia", "east africa", "west africa",
  "north africa", "southern africa", "latin america", "north america",
  "south america", "european union", "eastern europe", "western europe",
  "scandinavia", "the balkans", "levant", "arctic circle",
  // US landmarks / named sites commonly claimed
  "oval office", "capitol hill", "wall street", "times square", "fifth avenue",
  "broadway", "manhattan", "brooklyn", "queens", "the bronx", "harlem",
  "silicon valley", "hollywood", "wall street", "pentagon", "white house",
  "capitol", "lincoln memorial", "golden gate", "central park", "grand canyon",
  "mount rushmore", "statue of liberty", "washington dc", "new orleans",
  "las vegas", "miami beach", "los alamos", "silicon valley",
  // keys are accent-folded, so these match "São Paulo", "Bogotá", "Dakar"
  "sao paulo", "bogota", "dakar", "sao tome", "malmo", "turku", "geneve",
  "zurich", "koebenhavn", "milano", "napoli", "roma", "tirana", "asuncion",
  "paramaribo", "reykjavik", "jamestown", "conakry", "bamako", "niamey",
]);

/** Unambiguously geographic head nouns — eligible in any locative frame. */
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
  "village", "volcano", "warehouse", "waterfront", "yard", "rooftop", "roofs",
  "campus", "arena", "hangar", "pier", "quay", "canal", "aqueduct", "lagoon",
  "reef", "glacier", "delta", "estuary", "plateau", "summit", "foothills",
  "meadow", "orchard", "nursery", "cemetery", "courthouse", "capitol",
  "skyway", "overpass", "underpass", "roundabout", "highstreet", "esplanade",
  "boardwalk", "plaza", "courtyard", "alcove", "cellar", "attic", "loft",
  "corridor", "stairwell", "walkway", "path", "lane", "avenue", "boulevard",
]);

/**
 * Street-type suffixes used by the address rule. A number followed by a name
 * ending in one of these is a street address, which is positive place evidence
 * without needing the name itself to be in the gazetteer.
 */
const ADDRESS_SUFFIXES = new Set([
  "street", "road", "avenue", "lane", "drive", "way", "place", "square",
  "crescent", "row", "close", "court", "gardens", "park", "circle", "terrace",
  "highway", "boulevard", "parade", "walk", "green", "mews", "rise", "vale",
]);

/**
 * Directional and size modifiers that may sit in front of a place name and are
 * part of it ("northern France", "Greater Manchester"). They extend a matched
 * span to the left; they are never place evidence on their own.
 */
const PLACE_MODIFIERS = new Set([
  "northern", "southern", "eastern", "western", "central", "greater", "upper",
  "lower", "inner", "outer", "new", "old", "north", "south", "east", "west",
  "far", "little", "big", "large", "great", "port", "st", "saint", "san",
  "santa", "de", "del", "la", "le", "el", "al", "bin", "abu",
]);

/**
 * Words that are never a place: media, platforms, cognition, position, weather.
 * Checked before the gazetteer so "on Twitter" cannot resolve through a
 * platform that happens to share a name with a place.
 */
const NON_PLACE = new Set([
  // media / platform
  "news", "picture", "pictures", "photo", "photos", "photograph", "image",
  "images", "video", "videos", "clip", "clips", "footage", "stream", "screenshot",
  "screen", "television", "tv", "radio", "newspaper", "magazine", "broadsheet",
  "article", "articles", "post", "posts", "tweet", "thread", "story", "report",
  "website", "web", "internet", "online", "print", "press", "media", "caption",
  "headline", "document", "file", "folder", "album", "gallery", "book", "novel",
  "wikipedia", "blog", "channel", "page", "site", "app", "device", "phone",
  "camera", "lens", "resolution", "quality", "colour", "color", "black",
  "white", "grayscale", "greyscale", "monochrome", "sepia", "reuters",
  "associated press", "ap", "afp", "bloomberg", "bbc", "cnn", "guardian",
  "times", "post", "herald", "tribune", "journal", "gazette", "times of india",
  // platforms
  "twitter", "facebook", "instagram", "youtube", "tiktok", "reddit", "telegram",
  "snapchat", "whatsapp", "linkedin", "mastodon", "substack", "medium",
  "wordpress", "bluesky", "threads", "pinterest", "tumblr", "discord", "slack",
  "dropbox", "gdrive", "icloud", "wechat", "line", "kakao", "viber",
  // software / tools
  "photoshop", "illustrator", "lightroom", "gimp", "canva", "figma", "sketch",
  "paint", "paint.net", "microsoft", "word", "excel", "powerpoint", "outlook",
  "notepad", "vscode", "intellij", "eclipse", "netbeans", "xcode", "android",
  "ios", "windows", "linux", "macos", "chrome", "firefox", "safari", "edge",
  "camera", "lens", "instagram", "tiktok", "snapchat", "premiere", "final cut",
  "imovie", "handbrake", "premiere pro", "after effects", "cinema 4d",
  // languages
  "english", "hindi", "arabic", "french", "german", "spanish", "italian",
  "portuguese", "russian", "chinese", "japanese", "korean", "urdu", "bengali",
  "punjabi", "tamil", "telugu", "marathi", "gujarati", "persian", "turkish",
  "dutch", "swedish", "polish", "greek", "hebrew", "dutch", "farsi", "pashto",
  // cognition / discourse
  "fact", "facts", "fact-check", "detail", "details", "context", "reverse",
  "search", "memory", "remembrance", "mind", "doubt", "question", "questions",
  "answer", "answers", "conclusion", "purpose", "general", "particular",
  "case", "cases", "example", "addition", "summary", "verdict", "truth",
  "lie", "hoax", "fake", "real", "reality", "public", "attention", "focus",
  "name", "names", "word", "words", "language", "opinion", "views", "people",
  "everyone", "nobody", "someone", "anyone", "anything", "something", "nothing",
  "everything", "it", "him", "her", "them", "they", "he", "she", "we", "you",
  "i", "my", "our", "your", "their", "his", "hers", "theirs", "its", "this",
  "that", "these", "those", "this photo", "the image", "the picture",
  // position / geometry
  "front", "back", "top", "bottom", "left", "right", "middle", "centre",
  "center", "half", "part", "parts", "end", "beginning", "total", "sum",
  "addition", "distance", "depth", "height", "length", "width", "order",
  "reverse", "circles", "fashion", "focus", "foreground", "background", "edge",
  "corner", "side", "angle", "zoom", "close-up", "frame", "shot",
  // weather / natural non-locative
  "rain", "snow", "sun", "sunshine", "wind", "fog", "storm", "smoke", "fire",
  "air", "water", "dust", "mud", "sand", "dark", "light", "shadow", "cloud",
  "clouds", "sky", "sunset", "sunrise", "lightning", "thunder",
]);

/**
 * Weekdays, months and similar temporal tokens. A date is orderable but it is
 * not geography, so these are refused in every case form.
 */
const TEMPORAL = new Set([
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december",
  "week", "weeks", "weekend", "weekends", "month", "months", "year", "years",
  "day", "days", "today", "tomorrow", "yesterday", "tonight", "decade",
  "decades", "century", "centuries", "season", "seasons", "spring", "summer",
  "autumn", "fall", "winter", "morning", "afternoon", "evening", "night", "noon",
  "midnight", "date", "dates", "time", "times", "era", "moment", "moments",
  "period", "periods", "anniversary", "clock", "o'clock", "today", "recently",
  "now", "then", "later", "earlier", "overnight", "quarter", "semester",
]);

/** Person roles and kinship terms — a person reference, never a place. */
const PERSON_ROLES = new Set([
  "mr", "mrs", "ms", "miss", "dr", "sir", "madam", "prof", "professor",
  "president", "vice-president", "minister", "prime", "chancellor", "governor",
  "mayor", "king", "queen", "prince", "princess", "sheikh", "imam", "bishop",
  "pope", "sultan", "chief", "commander", "colonel", "major",
  "captain", "sergeant", "lieutenant", "officer", "official", "officials",
  "spokesperson", "spokesman", "spokeswoman", "police", "soldier", "soldiers",
  "troops", "army", "navy", "airforce", "nato", "un", "who", "man", "woman",
  "men", "women", "boy", "girl", "child", "children", "kid", "kids", "baby",
  "person", "people", "student", "students", "worker", "workers", "farmer",
  "protester", "protestors", "protester", "refugee", "refugees", "journalist",
  "reporter", "photographer", "witness", "witnesses", "victim", "victims",
  "resident", "residents", "citizen", "citizens", "doctor", "nurse", "teacher",
  "activist", "activists", "crew", "staff", "model", "actor", "actress",
  "singer", "athlete", "player", "driver", "shopkeeper", "monk", "nun",
  "boyfriend", "girlfriend", "husband", "wife", "father", "mother", "son",
  "daughter", "friend", "friends", "stranger", "tourist", "tourists", "who's",
  "author", "authors", "writer", "artist", "painter", "sculptor", "chef",
  "scientist", "researcher", "professor", "student", "pupil", "boss", "ceo",
  "founder", "owner", "employee", "employer", "client", "customer", "guest",
  "speaker", "host", "presenter", "commentator", "columnist", "editor",
  "candidate", "senator", "congressman", "governor", "ambassador", "diplomat",
  "referee", "player", "coach", "manager", "ceo", "entrepreneur", "investor",
  "analyst", "banker", "lawyer", "judge", "magistrate", "clergy", "monk",
]);

/**
 * Locative prepositions that assert a place. `by`, `about`, `for`, `with` and
 * `of` are deliberately absent: they mark authorship, topic, benefit and
 * possession, none of which is a location.
 */
const LOCATIVE_PREPOSITIONS = new Set([
  "in", "at", "on", "near", "inside", "within", "outside", "across", "around",
  "throughout", "beside", "along", "into", "onto", "upon", "amid", "amidst",
  "next", "close", "opposite", "adjacent", "beneath", "underneath", "above",
  "below", "behind", "under", "over", "topside", "from",
]);

/** Connectors that may join a locative word to its object ("next to", "in front of"). */
const PREPOSITION_CONNECTORS = new Set(["to", "of"]);

/**
 * Filler inside a compound preposition ("in front of the White House", "next
 * to the river"). The real object follows the whole phrase. Every entry is
 * itself a spatial word, so none can silently stand in as the location.
 */
const COMPOUND_PREPOSITION_FILLER = new Set([
  "front", "top", "next", "close", "nearest", "opposite", "adjacent", "back",
  "behind", "above", "below", "under", "underneath", "over", "beneath",
  "outside", "out", "inside", "beside", "beyond", "around", "across", "along",
  "throughout", "of", "to", "the", "a", "an", "side", "way", "part",
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
 * Prepositions that as often mark a topic or object of attention as a place
 * ("a photo focusing on Jordan", "an article about the minister").
 */
const TOPIC_PREPOSITIONS = new Set([
  "on", "at", "about", "of", "for", "regarding", "concerning", "featuring",
  "showing", "depicting", "portraying", "titled", "named",
]);

/**
 * Head nouns of a discourse or abstract frame. Their complement is a *topic* by
 * definition - a speech is on something, an article is about something - so a
 * name governed by one of these is the subject of the discourse rather than a
 * place the image was taken in. This is a property of the construction, not of
 * any particular phrase, so it generalises to "a talk on X", "an interview
 * about X" and "a report on X" alike.
 */
const DISCOURSE_HEADS = new Set([
  "speech", "speeches", "talk", "talks", "address", "addresses", "speech(es)",
  "statement", "statements", "interview", "interviews", "article", "articles",
  "report", "reports", "essay", "essays", "analysis", "analyses", "debate",
  "debates", "discussion", "commentary", "column", "editorial", "opinion",
  "opinions", "documentary", "podcast", "presentation", "lecture", "seminar",
  "briefing", "press", "coverage", "segment", "episode", "feature", "profile",
  "book", "books", "chapter", "paper", "study", "survey", "poll", "review",
  "reflection", "remark", "remarks", "quote", "quotation", "testimony",
  "headline", "caption", "title", "post", "story", "piece", "series", "panel",
  "conference", "convention", "forum", "summit", "rally", "campaign",
  "politics", "policy", "economy", "history", "war", "peace", "rights",
  "reform", "crisis", "election", "law", "rights", "future", "past", "issue",
  "issues", "matter", "matters", "question", "questions", "debate",
]);

/**
 * Verbs that assert a capture or occurrence site. A claim containing one is
 * describing where something was captured or happened, so a following
 * preposition is read as locative rather than topical.
 */
const CAPTURE_VERBS = new Set([
  "taken", "shot", "filmed", "captured", "recorded", "photographed", "snapped",
  "grabbed", "occurred", "happened", "located", "situated", "created",
  "produced", "published", "posted", "shared", "uploaded", "generated",
  "filmed", "shot", "taken", "photographed", "recorded", "made", "seen",
  "spotted", "caught", "filmed", "obtained", "acquired", "sourced", "found",
]);

/** Punctuation that marks a dateline boundary. */
const DATELINE_MARK = /[,:-]$/;

/** Words that terminate a claim-bound span. */
const SPAN_STOP = new Set([
  "in", "at", "on", "from", "near", "of", "and", "or", "but", "is", "was",
  "were", "are", "be", "been", "being", "to", "for", "with", "as", "by",
  "that", "which", "who", "while", "after", "before", "during", "since",
  "until", "where", "when", "what", "why", "how", "this", "that", "these",
  "those", "a", "an", "the", "not", "no", "so", "then", "than", "there",
  "has", "have", "had", "was", "were", "been", "will", "would", "can", "could",
  "should", "may", "might", "must", "do", "does", "did", "made", "makes",
]);

/**
 * Tokens that open a new phrase rather than continuing the current noun
 * phrase. A token after a place name that is *not* one of these is modifying
 * it ("London politics", "Jordan smiling"), which makes the name a topic
 * rather than a stated location.
 */
const PHRASE_BREAK = new Set([
  ...LOCATIVE_PREPOSITIONS,
  ...TOPIC_PREPOSITIONS,
  ...DETERMINERS,
  ...SPAN_STOP,
  "and", "or", "but", "also", "plus", "while", "whereas", "though", "although",
]);

/** Conjunctions and clause boundaries that separate one clause from the next. */
const CLAUSE_BREAK = new Set([
  "and", "but", "or", "also", "plus", "while", "whereas", "though", "although",
  "however", "meanwhile", "then", "yet", "so",
]);

/**
 * Head nouns that name a container of someone else's material. A possessive
 * landing on one of these is a source or account reference ("Jordan's
 * Instagram account", "from Jordan Smith's collection"), never a place.
 */
const OWNERSHIP_HEADS = new Set([
  "collection", "collections", "account", "accounts", "profile", "profiles",
  "channel", "channels", "feed", "inbox", "handle", "username", "portfolio",
  "album", "archive", "dataset", "gallery", "library", "page", "pages",
  "website", "site", "post", "posts", "thread", "article", "report",
  "newsletter", "drive", "folder", "book", "books", "publication", "press",
]);

/**
 * Rejections that positively establish the object is *not* a place. Anything
 * else — notably an unrecognised name — is reported as `unknown`, because the
 * gate does not know, rather than asserting that no location is stated.
 */
const DEMONSTRATED_NON_PLACE = new Set<LocationRejection>([
  "person_reference",
  "temporal_reference",
  "non_place_reference",
  "topic_or_source_reference",
  "no_locative_construction",
]);


/** Words that end a sentence, so a span never crosses one. */
const SENTENCE_END = new Set([".", "!", "?", ":", ";", "—", "–"]);

/**
 * §16.5 eligibility outcome.
 *
 * `eligible`    — positive place evidence found; the question may be asked.
 * `not_eligible`— positively identified as not a location, or no locative
 *                 construction was present at all.
 * `unknown`     — a locative construction was present but its object matched no
 *                 place signal this gate knows. The question is declined,
 *                 because asking about an unrecognised name risks asking about
 *                 a person, and the gap is recorded rather than guessed.
 *
 * Only `eligible` authorises the §16.5 question, so `unknown` and
 * `not_eligible` behave identically for the question and differ only in what
 * the record claims about itself.
 */
export type LocationOutcome = "eligible" | "not_eligible" | "unknown";

/** Typed reason for a non-eligible outcome. */
export type LocationRejection =
  | "no_locative_construction"
  | "person_reference"
  | "temporal_reference"
  | "non_place_reference"
  | "topic_or_source_reference"
  | "unrecognised_name";

/** Positive evidence that a span names a place. */
export type PlaceEvidence = "gazetteer" | "place_type_noun" | "street_address";

/**
 * Typed, inspectable §16.5 eligibility record. Carries the claim verbatim, the
 * complete claim-bound spans, and the reason; never a product status or verdict
 * (§15.2 — Jev may not decide the final product status, and neither may this
 * heuristic).
 */
export interface LocationEligibility {
  /** the claim exactly as supplied — never normalized, trimmed or rewritten */
  readonly claim: string;
  readonly outcome: LocationOutcome;
  /** true only for `outcome === "eligible"`; the sole question-authorising flag */
  readonly eligible: boolean;
  /** machine-readable positive reasons, most specific first */
  readonly reasons: readonly string[];
  /** positive evidence that made the span a place, when eligible */
  readonly evidence: readonly PlaceEvidence[];
  /** complete claim-bound spans, verbatim, that justify `eligible` */
  readonly spans: readonly string[];
  /** the rejection that decided a non-eligible outcome, else null */
  readonly rejectedBy: LocationRejection | null;
  /** verbatim candidate spans that were examined and did not resolve */
  readonly unresolved: readonly string[];
}

/** A token of the claim, pre-parsed once. */
interface Token {
  /** the token exactly as it appears */
  raw: string;
  /** accent-folded, lowercased, edge-punctuation-stripped form */
  lower: string;
  /** true when the token is a sentence-ending mark or ends a clause */
  terminal: boolean;
}

function fold(w: string): string {
  return (
    w
      // Unicode-aware: an ASCII \\w would delete "é" from "São Tomé" and the
      // whole of "東京", corrupting the evidence this module reports.
      .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      // a possessive is dropped so "the reporter's desk" resolves to the role
      .replace(/['\u2019]s$/, "")
  );
}

function isNumeric(w: string): boolean {
  return /^[\d.,/'’-]+$/.test(w);
}

/**
 * A street-address house number, including the alphanumeric UK form ("221B",
 * "12A"). It must begin with a digit, so an ordinary word is never read as a
 * number.
 */
function isHouseNumber(w: string): boolean {
  return /^\d+[A-Za-z]?(?:[-/][\dA-Za-z]+)*$/.test(w);
}

function tokenize(claim: string): Token[] {
  return claim
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((raw) => {
      const bare = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
      const terminal = /[.!?;:,—–)\]]$/.test(raw) || SENTENCE_END.has(bare);
      return { raw, lower: fold(raw), terminal };
    });
}

/**
 * The verbatim span `tokens[from..to]`, rejoined with single spaces. Trimming is
 * Unicode-aware so a name is reported as it was written: "São Tomé", not
 * "São Tom", and "東京" rather than an empty string.
 */
function spanText(tokens: Token[], from: number, to: number): string {
  return tokens
    .slice(from, to + 1)
    .map((t) => t.raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((s) => s.length > 0)
    .join(" ");
}

/**
 * Word-level stop test. A trailing period ends the *sentence*, not the word, so
 * "London." is still a usable head; `terminal` is consulted separately when
 * deciding whether a span may be extended further.
 */
function isStop(t: Token): boolean {
  return SPAN_STOP.has(t.lower) || t.lower.length === 0;
}

/**
 * Longest gazetteer match beginning at `i`, in whole tokens.
 * Returns the token count consumed, or 0 when nothing matches.
 */
function matchGazetteer(tokens: Token[], i: number): number {
  for (let len = Math.min(4, tokens.length - i); len >= 1; len--) {
    const slice = tokens.slice(i, i + len);
    // A stop word or sentence end *inside* the phrase rules out this length;
    // a shorter length may still be a valid name, so shorten rather than abort.
    if (slice.some((t, k) => k > 0 && (isStop(t) || (k < len - 1 && t.terminal)))) {
      continue;
    }
    const phrase = slice.map((t) => t.lower).join(" ");
    if (PLACE_NAMES.has(phrase)) return len;
  }
  return 0;
}

/** Longest place-type head noun match at `i`, in whole tokens. */
function matchPlaceNoun(tokens: Token[], i: number): number {
  const t = tokens[i];
  if (t === undefined || isStop(t)) return 0;
  return PLACE_NOUNS.has(t.lower) ? 1 : 0;
}

/** Street-address match: a number followed by a name ending in a street type. */
function matchAddress(tokens: Token[], i: number): number {
  const num = tokens[i];
  if (num === undefined || !isHouseNumber(num.raw)) return 0;
  let j = i + 1;
  const words: string[] = [];
  while (j < tokens.length && !isStop(tokens[j]) && !isNumeric(tokens[j].raw)) {
    words.push(tokens[j].lower);
    if (ADDRESS_SUFFIXES.has(tokens[j].lower)) return j - i + 1;
    j += 1;
  }
  return 0;
}

/** The positive place signal matching at `i`, or null when none does. */
function placeSignalAt(tokens: Token[], i: number): PlaceEvidence | null {
  if (matchGazetteer(tokens, i) > 0) return "gazetteer";
  if (matchAddress(tokens, i) > 0) return "street_address";
  if (matchPlaceNoun(tokens, i) > 0) return "place_type_noun";
  return null;
}

interface Candidate {
  /** index of the first token of the candidate span */
  from: number;
  /** index of the last token of the candidate span */
  to: number;
  /**
   * The positive place signal that admitted this candidate, or null when none
   * did. Carried rather than re-derived: a span may start at a modifier
   * ("northern France"), so the signal sits at an offset from `from`.
   */
  evidence: PlaceEvidence | null;
  /** true when a place signal was withdrawn because the frame is topical */
  topic: boolean;
}

/**
 * Collect the spans that could name a place: `in <name>`, compound locatives
 * ("next to the river", "in front of the White House"), the London-first
 * subject frame `<Name> is where`, a dateline ("Paris, France: ..."), and a
 * street address.
 */
function collectCandidates(claim: string): { tokens: Token[]; candidates: Candidate[] } {
  const tokens = tokenize(claim);
  const candidates: Candidate[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.lower.length === 0) continue;

    // Dateline: "<Place>, <Place>:" at the very start of the claim. The span
    // must itself be comma/colon-marked, so a claim that merely opens with a
    // place word is not treated as a dateline.
    if (i === 0) {
      for (let j = Math.min(4, tokens.length - 1); j >= 0; j--) {
        const joined = tokens
          .slice(0, j + 1)
          .map((x) => x.lower)
          .join(" ");
        if (!PLACE_NAMES.has(joined)) continue;
        const marked =
          DATELINE_MARK.test(tokens[j].raw) ||
          (tokens[j + 1] !== undefined && DATELINE_MARK.test(tokens[j + 1].raw));
        if (!marked) continue;
        candidates.push({ from: 0, to: j, evidence: "gazetteer", topic: false });
        break;
      }
    }

    // London-first subject frame: "<Name> is where".
    if (
      (tokens[i + 1]?.lower === "is" || tokens[i + 1]?.lower === "was") &&
      (tokens[i + 2]?.lower === "where" || tokens[i + 2]?.lower === "when")
    ) {
      const signal = placeSignalAt(tokens, i);
      if (signal !== null) {
        const n = matchGazetteer(tokens, i) || matchPlaceNoun(tokens, i);
        candidates.push({ from: i, to: i + n - 1, evidence: signal, topic: false });
      }
    }

    if (!LOCATIVE_PREPOSITIONS.has(t.lower)) continue;

    // Skip the compound-preposition filler and determiners to reach the object.
    let j = i + 1;
    while (
      j < tokens.length &&
      (PREPOSITION_CONNECTORS.has(tokens[j].lower) ||
        COMPOUND_PREPOSITION_FILLER.has(tokens[j].lower) ||
        DETERMINERS.has(tokens[j].lower))
    ) {
      j += 1;
    }
    const obj = tokens[j];
    if (j >= tokens.length || isStop(obj)) {
      // a street address may begin with the number itself
      const addr = matchAddress(tokens, j);
      if (addr > 0) {
        const to = j + addr - 1;
        candidates.push({
          from: j,
          to,
          evidence: "street_address",
          topic: isTopicFrame(tokens, i, to, "street_address"),
        });
        continue;
      }
      // A locative word with an object this gate cannot even read (a non-Latin
      // script) is an unresolved location, not the absence of one.
      if (
        obj !== undefined &&
        obj.lower.length === 0 &&
        obj.raw.replace(/[^\p{L}\p{N}]/gu, "").length > 0
      ) {
        candidates.push({ from: j, to: j, evidence: null, topic: false });
      }
      continue;
    }
    if (isNumeric(obj.raw) || isHouseNumber(obj.raw)) {
      // a street address begins with the house number
      const addr = matchAddress(tokens, j);
      if (addr > 0) {
        const to = j + addr - 1;
        candidates.push({
          from: j,
          to,
          evidence: "street_address",
          topic: isTopicFrame(tokens, i, to, "street_address"),
        });
      }
      continue;
    }

    // A directional or size modifier in front of the name is part of it
    // ("northern France"), so the match is retried past the modifier and the
    // span is then extended back over it.
    let from = j;
    let signal = placeSignalAt(tokens, j);
    while (signal === null && from + 1 < tokens.length && PLACE_MODIFIERS.has(tokens[from].lower)) {
      from += 1;
      signal = placeSignalAt(tokens, from);
    }
    if (signal !== null) {
      const n = matchGazetteer(tokens, from) || matchAddress(tokens, from) || matchPlaceNoun(tokens, from);
      let to = from + n - 1;
      // Extend over a following place-type head noun so the whole noun phrase
      // is kept ("Delhi neighbourhood", "Downtown street").
      while (to + 1 < tokens.length && !isStop(tokens[to + 1]) && !tokens[to + 1].terminal) {
        if (PLACE_NOUNS.has(tokens[to + 1].lower) && !PLACE_NAMES.has(tokens[to + 1].lower)) {
          to += 1;
          continue;
        }
        break;
      }
      // Extend left over any further modifier that is part of the name.
      while (from - 1 >= 0 && !isStop(tokens[from - 1]) && PLACE_MODIFIERS.has(tokens[from - 1].lower)) {
        from -= 1;
      }
      // A topic frame — "a photo focusing on Jordan smiling" — is about a
      // person or subject even when the object shares a name with a place, so
      // the place signal is withdrawn. Both conditions are required: a
      // following participle/possessive marks an object-of-attention, and a
      // claim with no capture verb is describing a topic rather than a capture
      // site. "on the Thames" keeps its place reading.
      // Source ownership and topic frames are rejected *before* a gazetteer
      // name is allowed to stand as place evidence, because a proper name can
      // belong to a person, an account or a subject as easily as to a place.
      // An address is exempt: it is positive address evidence on its own.
      const topic = isTopicFrame(tokens, i, to, signal);
      const owned =
        signal === "street_address" ? false : isSourceOwnershipFrame(tokens, from, to);
      candidates.push({ from, to, evidence: signal, topic: topic || owned });
    } else {
      // Unresolvable object inside a locative frame: recorded, never guessed.
      // Extend over the rest of the noun phrase. A sentence-ending mark stops
      // the extension only after the token carrying it has been taken in, so
      // "Juniper Chen." is recorded whole.
      let to = j;
      while (to + 1 < tokens.length && !isStop(tokens[to + 1])) {
        to += 1;
        if (tokens[to].terminal) break;
      }
      candidates.push({
        from: j,
        to,
        evidence: null,
        topic:
          isTopicFrame(tokens, i, j, null) || isSourceOwnershipFrame(tokens, j, j),
      });
    }
  }
  return { tokens, candidates };
}

/** True when the token carries a possessive marker. */
function isPossessive(t: Token): boolean {
  return t.raw.includes("\u2019") || /['\u2019]s$/i.test(t.raw);
}

/**
 * True when a capture verb *directly governs* the preposition at `index` — the
 * nearest content word to its left is a capture verb. A capture verb establishes
 * geography only for its own locative relationship: in "was taken during a
 * speech on Jordan" the verb governs "during", not "on", so it says nothing
 * about Jordan. Scoped to the clause, and to the first content word, so an
 * unrelated verb elsewhere cannot reach across.
 */
function governingCaptureVerb(tokens: Token[], index: number): boolean {
  const from = clauseStart(tokens, index);
  for (let i = index - 1; i >= from; i--) {
    const w = tokens[i].lower;
    if (w.length === 0 || DETERMINERS.has(w)) continue;
    return CAPTURE_VERBS.has(w);
  }
  return false;
}

/** Index of the first token of the clause containing `index`. */
function clauseStart(tokens: Token[], index: number): number {
  for (let i = index; i > 0; i--) {
    if (tokens[i].terminal || CLAUSE_BREAK.has(tokens[i - 1].lower)) return i;
  }
  return 0;
}

/** True when a capture verb occurs in the clause containing `index`. */
function clauseHasCaptureVerb(tokens: Token[], index: number): boolean {
  const from = clauseStart(tokens, index);
  for (let i = from; i < tokens.length; i++) {
    if (i > index && (tokens[i].terminal || CLAUSE_BREAK.has(tokens[i].lower))) break;
    if (CAPTURE_VERBS.has(tokens[i].lower)) return true;
  }
  return false;
}

/**
 * True when the token after the span continues the noun phrase as a bare
 * modifier. A preposition, determiner or clause break after the span means a
 * new phrase began instead, which leaves the place reading intact.
 */
function nextIsBareModifier(tokens: Token[], spanTo: number): boolean {
  const next = tokens[spanTo + 1];
  if (next === undefined || isStop(next)) return false;
  // A trailing period is punctuation, not a phrase boundary: in "a speech on
  // London politics." the name still modifies the word before the sentence ends.
  if (PHRASE_BREAK.has(next.lower)) return false;
  if (TEMPORAL.has(next.lower)) return false;
  if (PLACE_NOUNS.has(next.lower) || PLACE_NAMES.has(next.lower)) return false;
  const bare = next.raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
  return bare.length > 0;
}

/**
 * True when a discourse or abstract head noun governs the topical preposition
 * within its own clause - "a speech on Jordan", "an article about London".
 * Scanning is leftwards from the preposition and stays inside the clause, so a
 * discourse noun in a different clause does not suppress a real location.
 */
function hasDiscourseHead(tokens: Token[], prepositionIndex: number): boolean {
  const from = clauseStart(tokens, prepositionIndex);
  for (let i = prepositionIndex - 1; i >= from && i >= prepositionIndex - 3; i--) {
    const w = tokens[i].lower;
    if (w.length === 0) continue;
    if (DETERMINERS.has(w)) continue;
    if (PHRASE_BREAK.has(w)) return false;
    if (DISCOURSE_HEADS.has(w)) return true;
    // only a determiner or an adjective may sit between the head and the
    // preposition; any other noun means this is a different phrase
    return false;
  }
  return false;
}

/**
 * True when the span is the object of a topic frame rather than a place.
 *
 * The test is bound to the span's own clause: a capture verb in a *different*
 * clause says nothing about this one, which is what let "The photo was taken
 * yesterday and focuses on Jordan smiling" through.
 *
 * Three independent signals, any of which withholds a proper name's place
 * reading: a discourse head governing the preposition; a possessive or
 * participle right after the span; or the span continuing into a bare modifier.
 * A capture verb in the same clause, a preposition after the span, and a
 * place-type noun or street address as the evidence all keep the place reading.
 */
function isTopicFrame(
  tokens: Token[],
  prepositionIndex: number,
  spanTo: number,
  evidence: PlaceEvidence | null,
): boolean {
  if (!TOPIC_PREPOSITIONS.has(tokens[prepositionIndex].lower)) return false;

  // 1. A discourse complement governs, and nothing below may override it. The
  //    complement of "a speech on X" is a subject, so a gazetteer name, a
  //    place-type noun and a street address are all topics there, and a capture
  //    verb elsewhere in the clause is irrelevant to this relationship.
  if (hasDiscourseHead(tokens, prepositionIndex)) return true;

  // 2. Outside a discourse frame, a place-type noun and a street address are
  //    self-sufficient positive evidence. A gazetteer name — and an object
  //    that matched nothing at all, whose local signals are still worth
  //    reporting — do go through the rest of this test.
  if (evidence === "place_type_noun" || evidence === "street_address") return false;

  // 3. A capture verb governing this preposition keeps the place reading.
  if (governingCaptureVerb(tokens, prepositionIndex)) return false;

  // 4. Local topic signals on the span itself.
  const next = tokens[spanTo + 1];
  if (next !== undefined) {
    if (isPossessive(next)) return true;
    if (next.lower.length > 4 && next.lower.endsWith("ing")) return true;
  }
  return nextIsBareModifier(tokens, spanTo);
}

/**
 * True when a possessive near the span lands on a container of someone else's
 * material, which makes the name a source or account rather than a place.
 */
function isSourceOwnershipFrame(tokens: Token[], from: number, to: number): boolean {
  const window = [tokens[from], tokens[to], tokens[to + 1], tokens[to + 2]].filter(
    (t): t is Token => t !== undefined,
  );
  if (!window.some(isPossessive)) return false;
  return [tokens[to + 1], tokens[to + 2], tokens[to + 3]].some(
    (t) => t !== undefined && OWNERSHIP_HEADS.has(t.lower),
  );
}

function classifyUnresolved(tokens: Token[], c: Candidate): LocationRejection {
  if (c.topic) return "topic_or_source_reference";
  for (let i = c.from; i <= c.to; i++) {
    const w = tokens[i]?.lower ?? "";
    if (TEMPORAL.has(w)) return "temporal_reference";
    if (PERSON_ROLES.has(w)) return "person_reference";
    if (NON_PLACE.has(w)) return "non_place_reference";
  }
  return "unrecognised_name";
}

/**
 * §16.5 eligibility with a full, inspectable rationale. The claim is returned
 * verbatim and no product verdict is derived here.
 */
export function claimLocationEligibility(claim: string): LocationEligibility {
  const { tokens, candidates } = collectCandidates(claim);
  const spans: string[] = [];
  const evidence: PlaceEvidence[] = [];
  const unresolved: string[] = [];
  const reasons: string[] = [];
  const addReason = (r: string) => {
    if (!reasons.includes(r)) reasons.push(r);
  };
  const addEvidence = (e: PlaceEvidence) => {
    if (!evidence.includes(e)) evidence.push(e);
  };

  if (candidates.length === 0) {
    return {
      claim,
      outcome: "not_eligible",
      eligible: false,
      reasons: [],
      evidence: [],
      spans: [],
      rejectedBy: "no_locative_construction",
      unresolved: [],
    };
  }

  let firstRejection: LocationRejection | null = null;
  for (const c of candidates) {
    const text = spanText(tokens, c.from, c.to);
    if (text.length === 0) continue;
    if (c.evidence !== null && !c.topic) {
      if (!spans.includes(text)) spans.push(text);
      addEvidence(c.evidence);
      continue;
    }
    if (!unresolved.includes(text)) unresolved.push(text);
    if (firstRejection === null) firstRejection = classifyUnresolved(tokens, c);
  }

  if (spans.length > 0) {
    addReason("explicit_locative_construction");
    if (evidence.includes("gazetteer")) addReason("named_place");
    if (evidence.includes("place_type_noun")) addReason("geographic_noun");
    if (evidence.includes("street_address")) addReason("street_address");
    return {
      claim,
      outcome: "eligible",
      eligible: true,
      reasons,
      evidence,
      spans,
      rejectedBy: null,
      unresolved,
    };
  }
  // Mixed-candidate precedence: a positive place signal anywhere in the claim
  // wins outright. Otherwise a *demonstrated* non-place context yields
  // not_eligible, and an object this gate simply does not recognise yields
  // unknown - which declines the question just the same but claims nothing
  // about the name.
  const demonstrated =
    firstRejection !== null && DEMONSTRATED_NON_PLACE.has(firstRejection);
  return {
    claim,
    outcome: demonstrated ? "not_eligible" : "unknown",
    eligible: false,
    reasons: [],
    evidence: [],
    spans: [],
    rejectedBy: firstRejection,
    unresolved,
  };
}

/**
 * Boolean view of {@link claimLocationEligibility}. Retained so existing
 * callers keep working unchanged. Only `eligible` answers true, so an
 * `unknown` object declines the question exactly as `not_eligible` does.
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
