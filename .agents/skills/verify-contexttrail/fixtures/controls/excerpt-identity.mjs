/**
 * Offline derivative of the exact rendered source-bound excerpt predicate
 * (F38-4). The maintained verifier projects the SAME span the product
 * derives at the accepted pin — evidence-display.ts at 7b18c16: composite
 * "Title: / Snippet:" splitting, first-paragraph body selection,
 * word-boundary truncation at the viewer's real 600-char budget — and then
 * requires the rendered <blockquote> to EQUAL that span.
 *
 * This exercises the REAL exported projection and verdict functions —
 * splitCompositeExcerpt, truncateExcerptWords, expectedAttributableSpan,
 * expectedExcerptAttribution, renderedExcerptVerdict — on the record shapes
 * the fixture rows actually carry.
 *
 *   node fixtures/controls/excerpt-identity.mjs
 */
import {
  splitCompositeExcerpt,
  truncateExcerptWords,
  expectedAttributableSpan,
  expectedExcerptAttribution,
  renderedExcerptVerdict,
} from "../../cli/control-contexttrail.mjs";

let failures = 0;
const results = [];
const expect = (name, cond, detail) => {
  results.push({ name, ok: cond === true, detail: detail ?? null });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

/* ---------- the composite split port ---------- */
{
  const c = splitCompositeExcerpt("Title: A Page\n\nSnippet: a snippet\n\nBody one.\n\nBody two.");
  expect("composite: title, snippet and body all split", c.title === "A Page" && c.snippet === "a snippet" && c.body === "Body one.\n\nBody two.");
}
expect("a bare Title: wrapper splits to no body and no snippet", (() => {
  const c = splitCompositeExcerpt("Title: Just a title");
  return c.title === "Just a title" && c.body === null && c.snippet === null;
})());
expect("a plain string is all body, no title/snippet", (() => {
  const c = splitCompositeExcerpt("just some page text");
  return c.title === null && c.snippet === null && c.body === "just some page text";
})());
expect("a trailing-only Snippet: block leaves no body", (() => {
  const c = splitCompositeExcerpt("Title: T\n\nSnippet: s only");
  return c.title === "T" && c.snippet === "s only" && c.body === null;
})());

/* ---------- word-boundary truncation ---------- */
{
  const long = "word ".repeat(200).trim(); // ~999 chars > 600
  const t = truncateExcerptWords(long, 600);
  expect("a >600-char text truncates at a word boundary with an ellipsis",
    t.truncated === true && t.text.endsWith("…") && t.text.length <= 601 && !t.text.slice(0, -1).endsWith(" "));
  expect("a <=600-char text is untruncated", truncateExcerptWords("short text", 600).truncated === false);
  expect("truncation never cuts mid-word", (() => {
    const { text } = truncateExcerptWords("alpha beta gamma delta epsilon", 12);
    return text === "alpha beta…";
  })());
}

/* ---------- the projected span ---------- */
const plainRow = { excerpt: "The cat sat on the mat.", excerptSource: "snippet" };
const spanPlain = expectedAttributableSpan(plainRow);
expect("a plain excerpt projects verbatim with Search snippet attribution",
  spanPlain !== null && spanPlain.text === "The cat sat on the mat." && spanPlain.attribution === "Search snippet" && spanPlain.truncated === false);

const compositeRow = {
  excerpt: "Title: The Real Story\n\nSnippet: a search blurb\n\nThe body paragraph that is quoted.\n\nA second paragraph that stays out.",
  excerptSource: "page_text",
};
const spanComposite = expectedAttributableSpan(compositeRow);
expect("a page_text composite quotes the first body paragraph",
  spanComposite !== null && spanComposite.text === "The body paragraph that is quoted." && spanComposite.attribution === "Extracted page excerpt");
expect("a composite with further body marks the span truncated",
  spanComposite.truncated === true);

const snippetOnlyComposite = {
  excerpt: "Title: No Body Here\n\nSnippet: only the snippet survives",
  excerptSource: "page_text",
};
const spanSnippet = expectedAttributableSpan(snippetOnlyComposite);
expect("a page_text composite with no body quotes the embedded snippet as a snippet",
  spanSnippet !== null && spanSnippet.text === "only the snippet survives" && spanSnippet.attribution === "Search snippet");

const bareTitleRow = { excerpt: "Title: Wrapper Only", excerptSource: "page_text" };
expect("a bare Title: wrapper projects NO quotable span", expectedAttributableSpan(bareTitleRow) === null);
expect("a row with no excerpt projects NO quotable span", expectedAttributableSpan({ title: "t" }) === null);
expect("a null row projects NO quotable span", expectedAttributableSpan(null) === null);

const longRow = { excerpt: "word ".repeat(200).trim(), excerptSource: "page_text" };
const spanLong = expectedAttributableSpan(longRow);
expect("a long page body truncates at the viewer's 600-char budget",
  spanLong !== null && spanLong.truncated === true && spanLong.text.endsWith("…") && spanLong.text.length <= 601);

/* ---------- the rendered verdict ---------- */
// Positive: the blockquote's own text equals the projected span — the
// typographic quote wrap is stripped, internal whitespace normalized.
expect(
  "the exact rendered span passes",
  renderedExcerptVerdict("“The body paragraph that is quoted.”", spanComposite).ok === true,
);
expect(
  "the rendered contract-truncated span passes",
  renderedExcerptVerdict(`“${spanLong.text}”`, spanLong).ok === true,
);

// Negatives: every weaker shape is RED.
expect(
  "a one-character prefix is RED, not a match",
  renderedExcerptVerdict("“T”", spanComposite).ok === false,
);
expect(
  "a 48-char prefix is still RED — only exact equality counts",
  renderedExcerptVerdict(`“${spanLong.text.slice(0, 48)}”`, spanLong).ok === false,
);
expect(
  "a substituted quote is RED even though authentic text exists elsewhere",
  renderedExcerptVerdict("“A second paragraph that stays out.”", spanComposite).ok === false,
);
expect(
  "the composite TITLE quoted instead of the body is RED",
  renderedExcerptVerdict("“The Real Story”", spanComposite).ok === false,
);
expect(
  "the composite title+snippet wrapper is RED — it is not the body span",
  renderedExcerptVerdict("“Title: The Real Story a search blurb”", spanComposite).ok === false,
);
expect(
  "the SNIPPET quoted instead of the body is RED",
  renderedExcerptVerdict("“a search blurb”", spanComposite).ok === false,
);
expect(
  "the span plus leaked second paragraph is RED — wrapper/body-remainder leaked",
  renderedExcerptVerdict("“The body paragraph that is quoted. A second paragraph that stays out.”", spanComposite).ok === false,
);
expect(
  "no blockquote at all is RED when the contract has a quotable span",
  renderedExcerptVerdict(null, spanComposite).ok === false,
);
expect(
  "no projected span is a honest non-pass, never a match",
  renderedExcerptVerdict("“anything”", null).ok === false,
);

// Attribution: a backend displayAttribution wins over the span's own label.
expect(
  "backend displayAttribution wins over the span label",
  expectedExcerptAttribution({ displayAttribution: "Retrieved media caption" }, spanComposite) === "Retrieved media caption",
);
expect(
  "no displayAttribution falls back to the span's own label",
  expectedExcerptAttribution({}, spanComposite) === "Extracted page excerpt",
);

console.log(
  JSON.stringify({ control: "excerpt-identity", checks: results.length, failures, ok: failures === 0 }),
);
console.log(failures === 0 ? "PASS: excerpt identity predicates discriminate" : `FAIL: ${failures} expectation(s) failed`);
process.exit(failures === 0 ? 0 : 1);
