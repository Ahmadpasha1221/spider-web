export interface CodexItemContext {
  tool: string;
  input: unknown;
  description: string;
  command: string | null;
  filePath: string | null;
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

export function describeItem(
  item: Record<string, unknown>,
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
    const path =
      typeof item.path === "string"
        ? item.path
        : typeof item.file === "string"
          ? item.file
          : "file";
    return {
      tool: "Edit",
      input: { file_path: path },
      description: `Edit: ${path}`,
      command: null,
      filePath: path,
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
  const output = result?.output ?? item.output ?? item.text;
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
