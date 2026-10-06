/**
 * Best-effort credential redaction for provider event text before
 * it enters session storage. Heuristic only: Spider never claims
 * this catches every secret (see SECURITY.md). Patterns cover the
 * explicit never-store list: API keys, bearer tokens, OAuth
 * access/refresh tokens, cookies, and authorization headers.
 */
const SECRET_PATTERNS: readonly {
  readonly re: RegExp;
  readonly via: string;
}[] = [
  // OpenAI-style keys: sk-..., sk-proj-..., svc_..., hex 20+ chars.
  { re: /\bsk-[A-Za-z0-9_-]{16,}/g, via: "sk-" },
  { re: /\bsvc_[A-Za-z0-9]{16,}/g, via: "svc_" },
  // OPENAI_API_KEY / generic *_TOKEN assignments and JSON pairs.
  {
    re: /\b([A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD))\s*[=:]\s*["']?[^\s"',;]{8,}/gi,
    via: "assignment",
  },
  // Authorization: Bearer <jwt-or-opaque>
  {
    re: /\b(authorization\s*:\s*bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
    via: "bearer",
  },
  // JWTs anywhere (three base64url segments).
  {
    re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g,
    via: "jwt",
  },
  // Cookie: session=... style pairs.
  {
    re: /\b(cookie\s*:\s*)[^\r\n]{6,}/gi,
    via: "cookie",
  },
];

export function redactSecrets(text: string): string {
  let output = text;
  for (const { re, via } of SECRET_PATTERNS) {
    output = output.replace(re, (match, prefix: string | undefined) => {
      if (via === "assignment") {
        return `${prefix ?? match.split(/[=:]/)[0]}=[REDACTED]`;
      }
      if (via === "bearer") return `${prefix as string}[REDACTED]`;
      if (via === "cookie") return `${prefix as string}[REDACTED]`;
      return "[REDACTED]";
    });
  }
  return output;
}

/** Redact secrets inside an arbitrary tool payload, preserving shape. */
export function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) {
      out[key] =
        /key|token|secret|password|cookie|authorization/i.test(key) &&
        typeof entry === "string"
          ? "[REDACTED]"
          : redactValue(entry);
    }
    return out;
  }
  return value;
}
