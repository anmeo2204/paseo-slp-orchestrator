import { afterEach, describe, expect, it } from "vitest";
import { getUnattendedModeId } from "@getpaseo/protocol/provider-manifest";
import { DEFAULT_ORCHESTRATION_SETTINGS } from "../shared/orchestration";
import type { ProviderChoices } from "../shared/state";
import {
  baseProviderId,
  resolveAgentSettings,
  resolvePeerModelForBasePeerProvider,
  unattendedModeForProvider,
  validateProjectAgentSettings,
} from "../server/project-prompts/agent-settings";
import { defaultProjectPrompts } from "../server/project-prompts/defaults";
import { ForkRegistry, type SessionForker } from "../server/fork/session-forker";
import { AgentGateway } from "../server/runtime/agent-gateway";
import {
  defaultFeatureValuesForProvider,
  isKiroProvider,
  permissionModeFor,
} from "../server/runtime/agent-gateway-helpers";
import type { PaseoHolder } from "../server/runtime/paseo-holder";
import { RunStore } from "../server/store/run-store";
import { buildRun } from "./helpers/run-factory";

const CODEX_UNATTENDED = getUnattendedModeId("codex");
const sandboxDefaults = { provider: "codex-slp/gpt-5.4" };

describe("codex-slp provider identity", () => {
  it("maps only the exact codex-slp ID to the codex base", () => {
    expect(CODEX_UNATTENDED).toBe("full-access");
    expect(baseProviderId("codex-slp")).toBe("codex");
    expect(unattendedModeForProvider("codex-slp")).toBe(CODEX_UNATTENDED);
    expect(permissionModeFor("codex-slp/gpt-5.4")).toBe(CODEX_UNATTENDED);
  });

  it.each(["codex-slp2", "codex-slp-extra", "codex-other", "CODEX-SLP", "codex-slp ", "slp", "constructor", "__proto__"])(
    "does not treat look-alike provider '%s' as Codex",
    (providerId) => {
      expect(baseProviderId(providerId)).toBe(providerId);
      expect(unattendedModeForProvider(providerId)).toBeUndefined();
      expect(resolvePeerModelForBasePeerProvider("gpt-5.4", providerId)).toBeNull();
    },
  );

  it("leaves built-in providers unchanged", () => {
    for (const providerId of ["codex", "claude", "antigravity", "copilot", "opencode"]) {
      expect(baseProviderId(providerId)).toBe(providerId);
    }
    expect(unattendedModeForProvider("codex")).toBe("full-access");
    expect(unattendedModeForProvider("claude")).toBe(getUnattendedModeId("claude"));
    expect(unattendedModeForProvider("antigravity")).toBe("full-access");
  });

  it("keeps codex-slp out of the ACP and Kiro permission paths, like codex", () => {
    expect(defaultFeatureValuesForProvider("codex-slp/gpt-5.4")).toBeUndefined();
    expect(defaultFeatureValuesForProvider("codex/gpt-5.4")).toBeUndefined();
    expect(isKiroProvider("codex-slp/gpt-5.4")).toBe(false);
  });
});

describe("codex-slp model and permission resolution", () => {
  it("gives every role Codex's unattended mode when the run uses codex-slp without a saved mode", () => {
    const configuration = defaultProjectPrompts();
    for (const role of ["supervisor", "master_lead", "qa_lead", "peer"] as const) {
      expect(resolveAgentSettings(configuration, role, undefined, sandboxDefaults)).toMatchObject({
        provider: "codex-slp/gpt-5.4",
        permissionModeId: CODEX_UNATTENDED,
      });
    }
  });

  it("accepts short Codex-family peer models under a codex-slp Lead and keeps the Lead's provider", () => {
    expect(resolvePeerModelForBasePeerProvider("gpt-5.4-mini", "codex-slp")).toBe("codex-slp/gpt-5.4-mini");
    expect(resolvePeerModelForBasePeerProvider("codex-slp/gpt-5.4-mini", "codex-slp")).toBe("codex-slp/gpt-5.4-mini");
    const configuration = defaultProjectPrompts();
    configuration.peers[0].model = "gpt-5.4-mini";
    expect(resolveAgentSettings(configuration, "peer", configuration.peers[0].role, sandboxDefaults)).toMatchObject({
      provider: "codex-slp/gpt-5.4-mini",
      permissionModeId: CODEX_UNATTENDED,
    });
  });

  it("rejects other families' models and the unsandboxed codex provider for a codex-slp peer", () => {
    expect(resolvePeerModelForBasePeerProvider("claude-sonnet-4.5", "codex-slp")).toBeNull();
    expect(resolvePeerModelForBasePeerProvider("gemini-3-pro", "codex-slp")).toBeNull();
    // Same family, but a different provider ID is a different process launch path.
    expect(resolvePeerModelForBasePeerProvider("codex/gpt-5.4", "codex-slp")).toBeNull();
    const configuration = defaultProjectPrompts();
    configuration.peers[0].model = "codex/gpt-5.4";
    // A rejected peer model falls back to the run's peer tier, never to the named provider.
    expect(resolveAgentSettings(configuration, "peer", configuration.peers[0].role, sandboxDefaults).provider)
      .toBe("codex-slp/gpt-5.4");
  });

  it("checks a codex-slp catalog by its own provider ID", () => {
    const catalog = [
      { id: "gpt-5.4", provider: "codex-slp" },
      { id: "gpt-5.5", provider: "codex" },
    ];
    expect(resolvePeerModelForBasePeerProvider("gpt-5.4", "codex-slp", catalog)).toBe("codex-slp/gpt-5.4");
    expect(resolvePeerModelForBasePeerProvider("gpt-5.5", "codex-slp", catalog)).toBeNull();
  });

  it("keeps a selected Codex mode when LEAD.md switches between codex and codex-slp", () => {
    const configuration = defaultProjectPrompts();
    configuration.lead.model = "codex-slp/gpt-5.4";
    expect(resolveAgentSettings(configuration, "master_lead", undefined, {
      provider: "codex/gpt-5.4",
      permissionModeId: "auto-review",
    })).toMatchObject({ provider: "codex-slp/gpt-5.4", permissionModeId: "auto-review" });
  });

  it("still refuses to carry one family's mode into another family", () => {
    const configuration = defaultProjectPrompts();
    configuration.lead.model = "claude/sonnet";
    expect(() => resolveAgentSettings(configuration, "master_lead", undefined, {
      provider: "codex-slp/gpt-5.4",
      permissionModeId: "auto-review",
    })).toThrow(/permission mode 'auto-review' belongs to 'codex-slp'/);
  });

  it("passes run-start validation with codex-slp everywhere and the allowlist set", () => {
    const providers: ProviderChoices = {
      supervisor: "codex-slp/gpt-5.4", lead: "codex-slp/gpt-5.4", peer: "codex-slp/gpt-5.4",
      supervisorThinkingOptionId: null, leadThinkingOptionId: null, peerThinkingOptionId: null,
      supervisorPermissionModeId: null, leadPermissionModeId: null, peerPermissionModeId: null,
    };
    const configuration = defaultProjectPrompts();
    configuration.peers[0].model = "gpt-5.4-mini";
    expect(() => validateProjectAgentSettings(configuration, providers, ["codex-slp"])).not.toThrow();
  });
});

describe("codex-slp session forking", () => {
  const nativeCodexForker: SessionForker = {
    family: "codex",
    bind: async () => ({ mode: "native", providerOptions: { resumed: true } }),
  };

  it("never resumes a codex-slp agent from a session in another provider's Codex home", async () => {
    const registry = new ForkRegistry([nativeCodexForker]);
    expect(await registry.resolve({ provider: "codex/gpt-5.4", providerSessionId: "s1" }, "codex-slp/gpt-5.4"))
      .toMatchObject({ mode: "stored-spec" });
    expect(await registry.resolve({ provider: "codex-slp/gpt-5.4", providerSessionId: "s1" }, "codex/gpt-5.4"))
      .toMatchObject({ mode: "stored-spec" });
    // Even same-provider forks degrade until a codex-slp adapter is written for its own Codex home.
    expect(await registry.resolve({ provider: "codex-slp/gpt-5.4", providerSessionId: "s1" }, "codex-slp/gpt-5.4"))
      .toMatchObject({ mode: "stored-spec" });
  });
});

describe("codex-slp at the Paseo creation boundary", () => {
  const openedStores: RunStore[] = [];
  afterEach(() => { for (const store of openedStores.splice(0)) store.close(); });

  type Creation = { config: Record<string, unknown> & { provider: string } };

  function gatewayWith(allowedAgentProviders: string[] | null) {
    const store = new RunStore(":memory:");
    openedStores.push(store);
    store.insert(buildRun({ orchestration: { ...DEFAULT_ORCHESTRATION_SETTINGS, allowedAgentProviders } }));
    const creations: Creation[] = [];
    const workspace = {
      refresh: async () => undefined,
      agents: { create: async (creation: Creation) => { creations.push(creation); } },
    };
    const holder = { get: async () => ({ workspaces: { ref: () => workspace } }) } as unknown as PaseoHolder;
    return { creations, gateway: new AgentGateway(holder, store, async () => 1234) };
  }

  it.each(["supervisor", "master_lead", "qa_lead"] as const)(
    "opens a %s on codex-slp in Codex's unattended mode with the same tool policy as codex",
    async (role) => {
      const sandboxed = gatewayWith(["codex-slp"]);
      await sandboxed.gateway.createAgent({
        runId: "run-1", role, taskId: null, provider: "codex-slp/gpt-5.4",
        workspaceId: "ws", title: role, awaitTool: null,
      });
      const plain = gatewayWith(null);
      await plain.gateway.createAgent({
        runId: "run-1", role, taskId: null, provider: "codex/gpt-5.4",
        workspaceId: "ws", title: role, awaitTool: null,
      });
      const [sandboxedConfig] = sandboxed.creations.map((creation) => creation.config);
      const [plainConfig] = plain.creations.map((creation) => creation.config);
      expect(sandboxedConfig).toMatchObject({ provider: "codex-slp/gpt-5.4", modeId: CODEX_UNATTENDED });
      expect(sandboxedConfig.featureValues).toBeUndefined();
      expect(sandboxedConfig.toolPolicy).toBeDefined();
      expect(sandboxedConfig.toolPolicy).toEqual(plainConfig.toolPolicy);
    },
  );

  it("keeps an explicitly chosen Codex mode instead of forcing full access", async () => {
    const { creations, gateway } = gatewayWith(["codex-slp"]);
    await gateway.createAgent({
      runId: "run-1", role: "supervisor", taskId: null, provider: "codex-slp/gpt-5.4",
      permissionModeId: "auto-review", workspaceId: "ws", title: "Supervisor", awaitTool: null,
    });
    expect(creations[0].config.modeId).toBe("auto-review");
  });

  it("sends no inherited unattended mode for an unknown custom provider", async () => {
    const { creations, gateway } = gatewayWith(null);
    await gateway.createAgent({
      runId: "run-1", role: "supervisor", taskId: null, provider: "codex-other/gpt-5.4",
      workspaceId: "ws", title: "Supervisor", awaitTool: null,
    });
    expect(creations[0].config.modeId).toBeUndefined();
  });
});
