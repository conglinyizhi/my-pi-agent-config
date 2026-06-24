import assert from "node:assert";
import { describe, it } from "node:test";
import { normalizeBaseUrl } from "./detector.ts";

describe("detector", () => {
  it("generates baseUrl candidates", () => {
    const candidates = normalizeBaseUrl("https://api.example.com");
    assert(candidates.includes("https://api.example.com"));
    assert(candidates.includes("https://api.example.com/v1"));
    assert(candidates.includes("https://api.example.com/v1/chat/completions"));
    assert(candidates.includes("https://api.example.com/v1/responses"));
  });

  it("strips trailing slashes", () => {
    const candidates = normalizeBaseUrl("https://api.example.com/");
    assert(candidates.includes("https://api.example.com"));
    assert(!candidates.some((c) => c.endsWith("//")));
  });

  it("handles existing /v1 suffix", () => {
    const candidates = normalizeBaseUrl("https://api.example.com/v1");
    assert(candidates.includes("https://api.example.com"));
    assert(candidates.includes("https://api.example.com/v1"));
  });
});
