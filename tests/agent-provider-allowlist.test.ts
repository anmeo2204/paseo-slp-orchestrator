import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_ORCHESTRATION_SETTINGS,
  OrchestrationSettingsSchema,
  disallowedAgentProvider,
  parseAllowedAgentProviders,
  runOrchestration,
} from "../shared/orchestration";
import type { ProviderChoices } from "../shared/state";
import { validateProjectAgentSettings } from "../server/project-prompts/agent-settings";
import { defaultProjectPrompts } from "../server/project-prompts/defaults";
import { parseRoleMarkdown } from "../server/project-prompts/markdown";
import { startRun } from "../server/pipeline/run-lifecycle";
import { AgentGateway } from "../server/runtime/agent-gateway";
import type { PaseoHolder } from "../server/runtime/paseo-holder";
import { RunStore } from "../server/store/run-store";
import { useFlowFixture } from "./helpers/flow-fixture";
import { buildRun } from "./helpers/run-factory";

const SANDBOX_ONLY = ["codex-slp"];
const sandboxProviders: ProviderChoices = {
  supervisor: "codex-slp/gpt-5",
  lead: "codex-slp/gpt-5",
  peer: "codex-slp/gpt-5",
  supervisorThinkingOptionId: null,
  leadThinkingOptionId: null,
  peerThinkingOptionId: null,
  supervisorPermissionModeId: null,
  leadPermissionModeId: null,
  peerPermissionModeId: null,
};

describe("agent provider allowlist matching", () => {
  it("allows any provider only when no allowlist is set", () => {
    expect(disallowedAgentProvider(null, "codex/gpt-5")).toBeNull();
    expect(DEFAULT_ORCHESTRATION_SETTINGS.allowedAgentProviders).toBeNull();
    // Runs stored before the setting existed keep their unrestricted behaviour instead of failing to load.
    expect(runOrchestration({ orchestration: null }).allowedAgentProviders).toBeNull();
    expect(OrchestrationSettingsSchema.parse({ forkPeers: true }).allowedAgentProviders).toBeNull();
  });

  it("matches the provider ID exactly and fails closed on everything else", () => {
    expect(disallowedAgentProvider(SANDBOX_ONLY, "codex-slp/gpt-5")).toBeNull();
    expect(disallowedAgentProvider(SANDBOX_ONLY, "codex-slp")).toBeNull();
    // The unsandboxed family and look-alike IDs are different providers, not prefixes of an allowed one.
    expect(disallowedAgentProvider(SANDBOX_ONLY, "codex/gpt-5")).toBe("codex");
    expect(disallowedAgentProvider(SANDBOX_ONLY, "codex-slp-extra/gpt-5")).toBe("codex-slp-extra");
    expect(disallowedAgentProvider(SANDBOX_ONLY, "CODEX-SLP/gpt-5")).toBe("CODEX-SLP");
    expect(disallowedAgentProvider(SANDBOX_ONLY, "")).toBe("(empty)");
    expect(disallowedAgentProvider(SANDBOX_ONLY, "/gpt-5")).toBe("(empty)");
    // A switched-on policy with no entries allows nothing.
    expect(disallowedAgentProvider([], "codex-slp/gpt-5")).toBe("codex-slp");
  });

  it("parses the settings text without widening a partial entry to 'any provider'", () => {
    expect(parseAllowedAgentProviders("")).toBeNull();
    expect(parseAllowedAgentProviders("   ")).toBeNull();
    expect(parseAllowedAgentProviders("codex-slp,")).toEqual(["codex-slp"]);
    expect(parseAllowedAgentProviders(" codex-slp , codex-slp, claude-slp ")).toEqual(["codex-slp", "claude-slp"]);
    expect(parseAllowedAgentProviders(" , ")).toEqual([]);
  });
});

describe("run-start validation of .slp models against the allowlist", () => {
  it("accepts a catalog whose roles all stay on allowed providers, including short model IDs", () => {
    const configuration = defaultProjectPrompts();
    configuration.supervisor.model = "gpt-5-high";
    expect(() => validateProjectAgentSettings(configuration, sandboxProviders, SANDBOX_ONLY)).not.toThrow();
  });

  it.each([
    ["SUPERVISOR.md", "Supervisor"],
    ["LEAD.md", "Lead"],
    ["QA_LEAD.md", "QA Lead"],
  ] as const)("rejects a full provider/model in %s that switches to an unlisted provider", (fileName, label) => {
    const configuration = defaultProjectPrompts();
    const roleMarkdown = parseRoleMarkdown(
      `---\nrole: Role\ndescription: Role under test\nmodel: codex/gpt-5\n---\nWorkflow.`,
      `.slp/${fileName}`,
    );
    if (fileName === "SUPERVISOR.md") configuration.supervisor.model = roleMarkdown.model;
    else if (fileName === "LEAD.md") configuration.lead.model = roleMarkdown.model;
    else configuration.qaLead = { ...(configuration.qaLead ?? configuration.lead), model: roleMarkdown.model };
    expect(() => validateProjectAgentSettings(configuration, sandboxProviders, SANDBOX_ONLY))
      .toThrow(new RegExp(`${label} resolves to provider 'codex'`));
  });

  it("keeps the existing provider switch working when no allowlist is set", () => {
    const configuration = defaultProjectPrompts();
    configuration.supervisor.model = "codex/gpt-5";
    expect(() => validateProjectAgentSettings(configuration, sandboxProviders, null)).not.toThrow();
  });

  it("does not let a peer file move a peer off the Lead's allowed provider", () => {
    const configuration = defaultProjectPrompts();
    configuration.peers[0].model = "codex/gpt-5";
    // A peer model on another provider falls back to the peer tier, which is allowed.
    expect(() => validateProjectAgentSettings(configuration, sandboxProviders, SANDBOX_ONLY)).not.toThrow();
  });

  it.each(["supervisor", "lead", "peer"] as const)("rejects an unlisted %s tier provider from the start form", (tier) => {
    const providers = { ...sandboxProviders, [tier]: "claude/sonnet" };
    expect(() => validateProjectAgentSettings(defaultProjectPrompts(), providers, SANDBOX_ONLY)).toThrow(/provider 'claude'/);
  });
});

describe("startRun enforcement", () => {
  const createFlow = useFlowFixture();

  it("refuses to start before creating any workspace or agent when a role resolves outside the allowlist", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO", orchestration: { allowedAgentProviders: SANDBOX_ONLY } });
    // The flow fixture starts every tier on claude/sonnet.
    await expect(flow.startRun()).rejects.toThrow(/not in the SLP agent provider allowlist/);
    expect(flow.store.list()).toHaveLength(0);
    expect(flow.gateway.createdAgents).toHaveLength(0);
    expect(flow.paseo.createdWorkspaces).toHaveLength(0);
  });

  it("snapshots the allowlist into the run when every role is allowed", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO", orchestration: { allowedAgentProviders: ["claude"] } });
    const runId = await flow.startRun();
    expect(flow.run(runId).orchestration?.allowedAgentProviders).toEqual(["claude"]);
  });

  it("refuses to start when the host settings cannot be read, instead of assuming no allowlist", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    flow.ctx.getSettings = () => { throw new Error("settings store unavailable"); };
    await expect(startRun(flow.ctx, {
      repoPath: flow.repoPath,
      name: "Unreadable settings",
      mode: "FULL_AUTO",
      providers: { supervisor: "claude/sonnet", lead: "claude/sonnet", peer: "claude/sonnet" },
    })).rejects.toThrow(/agent provider allowlist cannot be checked/);
    expect(flow.store.list()).toHaveLength(0);
    expect(flow.gateway.createdAgents).toHaveLength(0);
  });
});

describe("gateway enforcement at the Paseo creation boundary", () => {
  const openedStores: RunStore[] = [];
  afterEach(() => { for (const store of openedStores.splice(0)) store.close(); });

  function gatewayFor(promptConfig: ReturnType<typeof defaultProjectPrompts>, create: (provider: string) => void) {
    const store = new RunStore(":memory:");
    openedStores.push(store);
    store.insert(buildRun({
      promptConfig,
      orchestration: { ...DEFAULT_ORCHESTRATION_SETTINGS, allowedAgentProviders: SANDBOX_ONLY },
    }));
    const createdProviders: string[] = [];
    const workspace = {
      refresh: async () => undefined,
      agents: { create: async (creation: { config: { provider: string } }) => {
        createdProviders.push(creation.config.provider);
        create(creation.config.provider);
      } },
    };
    const holder = { get: async () => ({ workspaces: { ref: () => workspace } }) } as unknown as PaseoHolder;
    return { store, createdProviders, gateway: new AgentGateway(holder, store, async () => 1234) };
  }

  it("never asks Paseo for an unlisted provider and leaves no agent token behind", async () => {
    // A run stored with a provider switch (for example one restored from before the allowlist was set).
    const configuration = defaultProjectPrompts();
    configuration.supervisor.model = "codex/gpt-5";
    const { store, createdProviders, gateway } = gatewayFor(configuration, () => undefined);
    await expect(gateway.createAgent({
      runId: "run-1", role: "supervisor", taskId: null, provider: "codex-slp/gpt-5",
      workspaceId: "ws-sup", title: "Supervisor", awaitTool: null,
    })).rejects.toThrow(/provider 'codex'/);
    expect(createdProviders).toEqual([]);
    expect(Object.keys(store.require("run-1").agents)).toEqual([]);
  });

  it("checks the peer-model fallback provider too, not only the first attempt", async () => {
    const configuration = defaultProjectPrompts();
    configuration.lead.model = "codex-slp/lead-model";
    configuration.peers[0].model = "codex-slp/missing-model";
    const { store, createdProviders, gateway } = gatewayFor(configuration, (provider) => {
      if (provider === "codex-slp/missing-model") throw new Error("model missing-model not found");
    });
    // The peer tier provider is the fallback target; here it is the unsandboxed family.
    await expect(gateway.createAgent({
      runId: "run-1", role: "peer", projectRole: configuration.peers[0].role, taskId: null,
      provider: "codex/gpt-5", workspaceId: "ws-peer", title: "Peer", awaitTool: null,
    })).rejects.toThrow(/provider 'codex'/);
    expect(createdProviders).toEqual(["codex-slp/missing-model"]);
    expect(Object.keys(store.require("run-1").agents)).toEqual([]);
  });

  it("creates the agent when the resolved provider is allowed", async () => {
    const { createdProviders, gateway } = gatewayFor(defaultProjectPrompts(), () => undefined);
    await gateway.createAgent({
      runId: "run-1", role: "supervisor", taskId: null, provider: "codex-slp/gpt-5",
      workspaceId: "ws-sup", title: "Supervisor", awaitTool: null,
    });
    expect(createdProviders).toEqual(["codex-slp/gpt-5"]);
  });
});
