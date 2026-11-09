import { afterEach, describe, expect, it } from "vitest";
import { CLAUDE_COMPUTER_USE_DISALLOWED_TOOLS, isComputerUseTool } from "../server/hooks/computer-use";
import { decidePermission } from "../server/hooks/permissions";
import { AgentGateway } from "../server/runtime/agent-gateway";
import type { PaseoHolder } from "../server/runtime/paseo-holder";
import { RunStore } from "../server/store/run-store";
import { permissionRequest, shellRequest } from "./helpers/permission-request";
import { buildRun } from "./helpers/run-factory";

describe("computer-use detection", () => {
  it.each([
    "cua_repl.js",
    "mcp__cua_repl",
    "mcp__cua_repl__js",
    "computer",
    "mcp__computer-use__left_click",
    "computer_use",
    "mcp__claude-in-chrome__navigate",
  ])("treats %s as computer use", (toolName) => {
    expect(isComputerUseTool(toolName)).toBe(true);
  });

  it.each(["Bash", "exec", "mcp__playwright__browser_click", "computer_vision_check", "mcp__slp-bus__slp_stage_report", "node_repl.js"])(
    "leaves %s alone",
    (toolName) => {
      expect(isComputerUseTool(toolName, { code: "console.log(1)" })).toBe(false);
    },
  );

  it("catches the computer-use runtime reached through the Codex JavaScript REPL", () => {
    expect(isComputerUseTool("node_repl.js", { code: 'await cua.createBrowserTab("iab", "http://127.0.0.1:8000")' })).toBe(true);
  });

  it("denies computer-use permission requests for every role, including writers", () => {
    for (const role of ["supervisor", "master_lead", "qa_lead", "peer"] as const) {
      const decision = decidePermission(permissionRequest({ name: "mcp__computer-use__screenshot" }), {
        role, agentCwd: "/work", writableScope: [], pipelineId: "p", stageId: "s", stageActive: true, archived: false, peerKind: "developer",
      });
      expect(decision).toMatchObject({ behavior: "deny", message: expect.stringContaining("Computer use is blocked") });
    }
    const shellDecision = decidePermission(shellRequest("npx playwright test"), {
      role: "peer", agentCwd: "/work", writableScope: [], pipelineId: "p", stageId: "s", stageActive: true, archived: false, peerKind: "qa",
    });
    expect(shellDecision.behavior).toBe("allow");
  });
});

describe("computer-use tools at the Paseo creation boundary", () => {
  const openedStores: RunStore[] = [];
  afterEach(() => { for (const store of openedStores.splice(0)) store.close(); });

  type Creation = { config: Record<string, unknown> & { provider: string; options?: Record<string, unknown> } };

  function gateway() {
    const store = new RunStore(":memory:");
    openedStores.push(store);
    store.insert(buildRun());
    const creations: Creation[] = [];
    const workspace = { refresh: async () => undefined, agents: { create: async (creation: Creation) => { creations.push(creation); } } };
    const holder = { get: async () => ({ workspaces: { ref: () => workspace } }) } as unknown as PaseoHolder;
    return { creations, gateway: new AgentGateway(holder, store, async () => 1234) };
  }

  it("disallows computer-use tools on Claude sessions while keeping fork flags", async () => {
    const { creations, gateway: claudeGateway } = gateway();
    const forkOptions = { extraArgs: { resume: "source-session", "fork-session": null } };
    await claudeGateway.createAgent({
      runId: "run-1", role: "peer", projectRole: "qa-engineer", taskId: null, provider: "claude/opus", workspaceId: "ws", title: "QA", awaitTool: null,
      extraOptions: forkOptions,
    });
    expect(creations[0].config.options).toEqual({ ...forkOptions, disallowedTools: [...CLAUDE_COMPUTER_USE_DISALLOWED_TOOLS] });
  });

  it("sends no provider options Codex would reject", async () => {
    const { creations, gateway: codexGateway } = gateway();
    await codexGateway.createAgent({
      runId: "run-1", role: "peer", projectRole: "qa-engineer", taskId: null, provider: "codex/gpt-5.4", workspaceId: "ws", title: "QA", awaitTool: null,
    });
    expect(creations[0].config.options).toBeUndefined();
  });
});
