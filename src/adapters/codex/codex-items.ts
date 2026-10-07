import { normalizeSafeWorkspacePath } from "./codex-paths.js";

export interface CodexFileChangeInfo {
  readonly path: string;
  readonly change: "created" | "modified" | "deleted";
}

export interface CodexItemContext {
  tool: string;
  input: unknown;
  description: string;
  command: string | null;
  filePath: string | null;
  fileChanges?: readonly CodexFileChangeInfo[];
  rejectedFilePaths?: readonly { rawPath: string; error: string }[];
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

export function readErrorMessage(value: unknown): string {
  const record = asRecord(value);
  if (record !== null && typeof record.message === "string") {
    return record.message;
  }
  if (typeof value === "string" && value.length > 0) return value;
  return "Codex turn failed";
}

export function readItemStatus(item: Record<string, unknown>): boolean {
  if (item.status === "failed") return true;
  if (typeof item.error === "string" && item.error.length > 0) return true;
  return asRecord(item.error)?.message !== undefined;
}

export function readExitCode(item: Record<string, unknown>): number | null {
  const direct = [item.exit_code, item.exitCode];
  for (const candidate of direct) {
    if (typeof candidate === "number" && Number.isInteger(candidate)) {
      return candidate;
    }
  }
  const result = asRecord(item.result);
  const nested = result === null ? [] : [result.exit_code, result.exitCode];
  for (const candidate of nested) {
    if (typeof candidate === "number" && Number.isInteger(candidate)) {
      return candidate;
    }
  }
  return null;
}

function parseChangeKind(rawKind: unknown): "created" | "modified" | "deleted" {
  if (typeof rawKind !== "string") return "modified";
  const lower = rawKind.toLowerCase();
  if (lower === "add" || lower === "create" || lower === "new")
    return "created";
  if (lower === "delete" || lower === "remove") return "deleted";
  return "modified";
}

export function extractCodexFileChanges(
  item: Record<string, unknown>,
  cwd: string,
): {
  valid: CodexFileChangeInfo[];
  invalid: { rawPath: string; error: string }[];
} {
  const candidates: { rawPath: string; kind: unknown }[] = [];

  // 1. Check item.changes array (standard in Codex CLI 0.160.0)
  if (Array.isArray(item.changes)) {
    for (const change of item.changes) {
      if (typeof change === "string") {
        candidates.push({ rawPath: change, kind: "modified" });
      } else if (typeof change === "object" && change !== null) {
        const rec = change as Record<string, unknown>;
        const p =
          rec.path ??
          rec.file_path ??
          rec.file ??
          rec.filename ??
          rec.target_file ??
          rec.move_path;
        if (typeof p === "string") {
          const k = rec.kind ?? rec.action ?? rec.type ?? rec.change;
          candidates.push({ rawPath: p, kind: k });
        }
      }
    }
  }

  // 2. Check direct properties on item
  const directPath =
    item.path ??
    item.file_path ??
    item.file ??
    item.filename ??
    item.target_file ??
    item.move_path;
  if (typeof directPath === "string") {
    const directKind = item.kind ?? item.action ?? item.type ?? item.change;
    candidates.push({ rawPath: directPath, kind: directKind });
  }

  const valid: CodexFileChangeInfo[] = [];
  const invalid: { rawPath: string; error: string }[] = [];

  for (const candidate of candidates) {
    const normalized = normalizeSafeWorkspacePath(candidate.rawPath, cwd);
    if (normalized.ok) {
      valid.push({
        path: normalized.path,
        change: parseChangeKind(candidate.kind),
      });
    } else {
      invalid.push({ rawPath: candidate.rawPath, error: normalized.error });
    }
  }

  return { valid, invalid };
}

export function describeItem(
  item: Record<string, unknown>,
  cwd = process.cwd(),
): CodexItemContext | null {
  const type = typeof item.type === "string" ? item.type : "unknown";
  const id = typeof item.id === "string" ? item.id : type;

  if (type === "command_execution") {
    const raw = typeof item.command === "string" ? item.command : "";
    const first = (raw.split("\n")[0] ?? "").trim();
    return {
      tool: "Bash",
      input: { command: raw },
      description: `Bash: ${first.length > 0 ? first : "command"}`,
      command: raw.trim().length > 0 ? raw : null,
      filePath: null,
    };
  }

  if (type === "file_change") {
    const { valid, invalid } = extractCodexFileChanges(item, cwd);
    if (valid.length > 0) {
      const primary = valid[0]!;
      const paths = valid.map((v) => v.path);
      const input =
        paths.length === 1
          ? { file_path: primary.path, path: primary.path }
          : { file_path: primary.path, path: primary.path, files: paths };
      const description =
        paths.length === 1
          ? `Edit: ${primary.path}`
          : `Edit: ${paths.join(", ")}`;
      return {
        tool: "Edit",
        input,
        description,
        command: null,
        filePath: primary.path,
        fileChanges: valid,
        rejectedFilePaths: invalid,
      };
    }

    const description =
      invalid.length > 0
        ? `Edit: rejected path (${invalid[0]!.rawPath})`
        : "Edit: unknown file";
    const input = {
      error:
        invalid.length > 0
          ? invalid[0]!.error
          : "No valid file path in event payload",
    };
    return {
      tool: "Edit",
      input,
      description,
      command: null,
      filePath: null,
      fileChanges: [],
      rejectedFilePaths: invalid,
    };
  }

  if (type === "mcp_tool_call") {
    const tool =
      typeof item.tool === "string" && item.tool.length > 0 ? item.tool : "mcp";
    return {
      tool,
      input: { server: item.server, tool, arguments: item.arguments },
      description: `${tool}: ${id}`,
      command: null,
      filePath: null,
    };
  }

  if (type === "web_search" || type === "todo_list") {
    return {
      tool: type === "web_search" ? "WebSearch" : "Todo",
      input:
        type === "web_search" ? { query: item.query } : { items: item.items },
      description: type === "web_search" ? "WebSearch" : "Todo",
      command: null,
      filePath: null,
    };
  }

  if (type === "agent_message" || type === "reasoning" || type === "error") {
    return null;
  }

  return {
    tool: type,
    input: item,
    description: `${type}: ${id}`,
    command: null,
    filePath: null,
  };
}

export function renderItemOutput(
  item: Record<string, unknown>,
  context: CodexItemContext,
): string {
  const result = asRecord(item.result);
  const output =
    result?.output ?? item.output ?? item.aggregated_output ?? item.text;
  if (typeof output === "string" && output.length > 0) return output;
  if (output !== null && output !== undefined && typeof output !== "string") {
    const rendered = JSON.stringify(output);
    if (typeof rendered === "string" && rendered.length > 0) return rendered;
  }
  const errorRecord = asRecord(item.error);
  if (typeof errorRecord?.message === "string") return errorRecord.message;
  if (typeof item.error === "string" && item.error.length > 0)
    return item.error;
  if (context.filePath !== null) return `${context.tool}: ${context.filePath}`;
  return `${context.tool} completed`;
}
