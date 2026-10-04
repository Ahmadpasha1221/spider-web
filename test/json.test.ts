import { describe, expect, it } from "vitest";
import { canonicalJson, parseStrictJson } from "../src/core/json.js";

describe("strict JSON and canonical JSON", () => {
  it("rejects comments, trailing commas, duplicate decoded keys, and unsafe integers", () => {
    for (const text of [
      '{"a":1,}',
      '{/*x*/"a":1}',
      '{"a":1,"\\u0061":2}',
      '{"a":9007199254740992}',
    ]) {
      expect(() => parseStrictJson(text)).toThrow();
    }
  });
  it("uses stable property ordering", () => {
    expect(canonicalJson({ z: 1, a: "ok" })).toBe('{"a":"ok","z":1}');
  });
});
