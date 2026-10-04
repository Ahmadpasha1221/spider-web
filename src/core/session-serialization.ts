import { canonicalJson, parseStrictJson } from "./json.js";
import { validateSession, type SpiderSession } from "./session.js";

export function serializeSession(session: SpiderSession): string {
  validateSession(session);
  return canonicalJson(session);
}

export function parseSessionJson(text: string): SpiderSession {
  const value = parseStrictJson(text);
  validateSession(value);
  return value;
}
