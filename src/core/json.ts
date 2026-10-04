import canonicalize from "canonicalize";
import { parseTree, type Node as JsonNode, type ParseError } from "jsonc-parser";

export class StrictJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StrictJsonError";
  }
}

function rejectDuplicateKeys(node: JsonNode): void {
  if (node.type === "object") {
    const keys = new Set<string>();
    for (const property of node.children ?? []) {
      const key = property.children?.[0]?.value;
      if (typeof key !== "string") throw new StrictJsonError("Object property name is not a string");
      if (keys.has(key)) throw new StrictJsonError(`Duplicate JSON object key: ${key}`);
      keys.add(key);
      const value = property.children?.[1];
      if (value) rejectDuplicateKeys(value);
    }
  } else if (node.type === "array") {
    for (const child of node.children ?? []) rejectDuplicateKeys(child);
  } else if (node.type === "number") {
    const numericValue = Number(node.value);
    if (!Number.isFinite(numericValue) || (Number.isInteger(numericValue) && !Number.isSafeInteger(numericValue))) {
      throw new StrictJsonError("JSON numbers must be finite; integers outside the safe range must be encoded as strings");
    }
  }
}

export function parseStrictJson(text: string): unknown {
  const errors: ParseError[] = [];
  const tree = parseTree(text, errors, { allowTrailingComma: false, disallowComments: true, allowEmptyContent: false });
  if (errors.length > 0 || !tree) throw new StrictJsonError("Input is not strict JSON");
  rejectDuplicateKeys(tree);
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new StrictJsonError(error instanceof Error ? error.message : "Input is not valid JSON");
  }
}

export function canonicalJson(value: unknown): string {
  const output = canonicalize(value);
  if (typeof output !== "string") throw new StrictJsonError("Value cannot be represented as canonical JSON");
  return output;
}
