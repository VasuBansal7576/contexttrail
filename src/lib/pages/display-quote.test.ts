import { describe, expect, it } from "vitest";
import { selectDisplayQuote } from "./extract";

describe("verbatim source excerpts", () => {
  it("shows a relevant body paragraph instead of a header-like publication line", () => {
    const body = "The coastal photograph was taken during a surveying mission, several years before the later festival claim.";
    expect(selectDisplayQuote({title:"Coastal photograph",claim:"This photograph depicts a festival.",paragraphs:["1 min readPublisherJul 15, 2019 Image Article",body]})).toBe(body);
  });
  it("rejects the saved-run unrelated paragraph despite a matching page title", () => {
    expect(selectDisplayQuote({ title: 'Fashion Nova blocking negative reviews', claim: 'What does evidence establish about Fashion Nova suppressing customer reviews versus fabricating them?', paragraphs: ['Unrelated newsletter subscription and general editorial material.'] })).toBeNull();
  });
  it("does not let title-only overlap qualify text for a supplied question", () => {
    expect(selectDisplayQuote({ title: 'Newsletter subscription', claim: 'Fashion Nova customer reviews', paragraphs: ['Newsletter subscription and general editorial material.'] })).toBeNull();
  });
  it("selects by question overlap before title overlap without establishing semantic relevance", () => {
    const topic = 'Fashion Nova customer reviews were discussed by the agency.';
    expect(selectDisplayQuote({ title: 'Newsletter subscription editorial material', claim: 'Fashion Nova customer reviews', paragraphs: ['Newsletter subscription editorial material for our members.', topic] })).toBe(topic);
  });
  it("does not qualify an unrelated retained prefix using words outside the excerpt cap", () => {
    expect(selectDisplayQuote({ title: null, claim: 'Fashion Nova', paragraphs: ['Unrelated editorial text. '.repeat(1000) + 'Fashion Nova'] })).toBeNull();
  });
  it("never substitutes the submitted claim, title, or a search snippet for page text", () => {
    expect(selectDisplayQuote({title:"A claim",claim:"This definitely happened yesterday",paragraphs:[]})).toBeNull();
  });
  it("uses stable document order when relevance ties and preserves verbatim text", () => {
    expect(selectDisplayQuote({title:null,claim:null,paragraphs:["First paragraph — exact text.","Second paragraph."]})).toBe("First paragraph — exact text.");
  });
});
