// Computer use (desktop mouse/keyboard control, screenshot-driven UI driving) is blocked for every SLP agent.
// Verification goes through CLI tests, API checks and headless browser automation run from the shell instead.

// Tool names as each provider surfaces them: Codex `cua_repl.js` / `mcp__cua_repl`, Claude `computer`,
// `mcp__computer-use__*` and `mcp__claude-in-chrome__*`.
const COMPUTER_USE_TOOL_NAME = /(?:^|[.:/]|__)(?:cua_repl|computer[-_]?use|claude-in-chrome|computer)(?:$|[.:/]|__)/i;
// Codex can also reach the computer-use runtime from its generic JavaScript REPL.
const REPL_TOOL_NAME = /(?:^|[.:/]|__)node_repl(?:$|[.:/]|__)/i;
const COMPUTER_USE_REPL_CODE = /\bcua\s*\.\s*\w+|@oai\/sky|\bsky\s*\.\s*\w+/;

// Claude Agent SDK rules: a bare `mcp__<server>` entry disallows every tool of that server.
export const CLAUDE_COMPUTER_USE_DISALLOWED_TOOLS = ["computer", "mcp__computer-use", "mcp__claude-in-chrome"] as const;

// Codex merges a session's mcp_servers over the servers its bundled computer-use plugins register, and a server
// whose command exits at once contributes no tools; the session itself still starts. Codex has no per-session
// deny list, so this replacement is the only way to remove these servers without editing ~/.codex/config.toml.
export const CODEX_COMPUTER_USE_MCP_SERVERS = ["cua_repl", "node_repl"] as const;
export const CODEX_COMPUTER_USE_MCP_OVERRIDES: Readonly<Record<string, { type: "stdio"; command: string; args: string[] }>> =
  Object.fromEntries(CODEX_COMPUTER_USE_MCP_SERVERS.map((name) => [name, { type: "stdio" as const, command: "/usr/bin/false", args: [] }]));

export const COMPUTER_USE_BLOCKED_MESSAGE =
  "Computer use is blocked in SLP: do not control the desktop, the mouse/keyboard or a visible browser through computer-use tools. "
  + "Verify with CLI tests, API checks or headless browser automation run from the shell (for example Playwright locators). "
  + "Grade a criterion that cannot be checked that way as blocked with the reason; never mark it passed.";

function serializedInput(input: unknown): string {
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input) ?? "";
  } catch {
    return "";
  }
}

export function isComputerUseTool(toolName: string, input?: unknown): boolean {
  if (COMPUTER_USE_TOOL_NAME.test(toolName)) return true;
  return REPL_TOOL_NAME.test(toolName) && COMPUTER_USE_REPL_CODE.test(serializedInput(input));
}
