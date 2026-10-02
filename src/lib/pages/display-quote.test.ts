import { describe, expect, it } from "vitest";
import { selectDisplayQuote } from "./extract";

describe("verbatim source excerpts", () => {
  it("shows a relevant body paragraph instead of a header-like publication line", () => {
    const body = "The coastal photograph was taken during a surveying mission, several years before the later festival claim.";
    expect(selectDisplayQuote({title:"Coastal photograph",claim:"This photograph depicts a festival.",paragraphs:["1 min readPublisherJul 15, 2019 Image Article",body]})).toBe(body);
  });
  it("never substitutes the submitted claim, title, or a search snippet for page text", () => {
    expect(selectDisplayQuote({title:"A claim",claim:"This definitely happened yesterday",paragraphs:[]})).toBeNull();
  });
  it("uses stable document order when relevance ties and preserves verbatim text", () => {
    expect(selectDisplayQuote({title:null,claim:null,paragraphs:["First paragraph — exact text.","Second paragraph."]})).toBe("First paragraph — exact text.");
  });
});
