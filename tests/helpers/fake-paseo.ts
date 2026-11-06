// Stub of the Paseo SDK surface used by the pipeline (workspaces + agent timeline) and of the
// holder that hands it out. Worktrees are REAL `git worktree add` directories so the scope gate
// can run `git diff` against them.
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import type { PaseoApi } from "../../server/runtime/paseo-holder";
import { runGitSync } from "./git-fixture";

export interface WorkspaceCreateRequest {
  source: { kind: string; cwd: string; action: string; refName: string; branchName: string };
  title: string;
}

export interface TimelineAppendCall {
  agentId: string;
  item: { id: string; kind: string; data: { taskId: string; phase: string } };
}

export class FakePaseo {
  readonly openedRepositories: string[] = [];
  readonly createdWorkspaces: Array<{ request: WorkspaceCreateRequest; workspaceId: string; directory: string }> = [];
  readonly archivedWorkspaceIds: string[] = [];
  readonly timelineAppends: TimelineAppendCall[] = [];
  private workspaceCounter = 0;
  private openedWorkspaceCounter = 0;
  // Keyed by canonical path: Paseo identifies a workspace by the checkout it owns, and the pipeline resolves
  // every path with realpath before opening one (validateCheckout), so the key has to be resolved too.
  private readonly workspaceIdByDirectory = new Map<string, string>();

  constructor(private readonly worktreeRootDirectory: string) {}

  asApi(): PaseoApi {
    // Aliased because the object literal below needs the instance while its arrows must not rebind `this`.
    const fakePaseo = this;
    return {
      workspaces: {
        open: async (repoPath: string) => {
          fakePaseo.openedRepositories.push(repoPath);
          return fakePaseo.openWorkspaceForDirectory(repoPath);
        },
        create: async (request: WorkspaceCreateRequest) => fakePaseo.createWorktreeWorkspace(request),
        ref: (workspaceId: string) => fakePaseo.buildHandle(workspaceId, null),
        archive: async (workspaceId: string) => {
          fakePaseo.archivedWorkspaceIds.push(workspaceId);
        },
      },
      agents: {
        ref: (agentId: string) => ({
          timeline: {
            append: async (item: TimelineAppendCall["item"]) => {
              fakePaseo.timelineAppends.push({ agentId, item });
            },
          },
        }),
      },
    // Only the surface the pipeline touches is faked, so the cast is the honest way to satisfy the full SDK type.
    } as unknown as PaseoApi;
  }

  cardsForTask(taskId: string): TimelineAppendCall["item"]["data"][] {
    return this.timelineAppends.filter((append) => append.item.id === `task-${taskId}`).map((append) => append.item.data);
  }

  // A temp directory can be reached by more than one path (macOS resolves /var to /private/var), so a workspace
  // registered under the path used to create it must still be found under the resolved path the pipeline opens.
  private static canonicalDirectory(directory: string): string {
    try {
      return realpathSync(directory);
    } catch {
      // An archived or not-yet-created checkout cannot be resolved; its lexical path is the best key available.
      return resolve(directory);
    }
  }

  // Paseo returns the workspace that owns the given checkout, creating one for a checkout it does not track yet.
  // An unknown directory must therefore get its own identity: handing back the Supervisor's workspace instead
  // would let a feature worktree silently inherit the Supervisor's workspace id.
  private openWorkspaceForDirectory(directory: string) {
    const canonicalDirectory = FakePaseo.canonicalDirectory(directory);
    const knownWorkspaceId = this.workspaceIdByDirectory.get(canonicalDirectory);
    if (knownWorkspaceId) return this.buildHandle(knownWorkspaceId, directory);
    this.openedWorkspaceCounter += 1;
    const openedWorkspaceId = `ws-open-${this.openedWorkspaceCounter}`;
    this.workspaceIdByDirectory.set(canonicalDirectory, openedWorkspaceId);
    return this.buildHandle(openedWorkspaceId, directory);
  }

  private buildHandle(workspaceId: string, directory: string | null) {
    // Matches the real handle: `directory` can be null until refresh, which is why the pipeline always refreshes first.
    return { id: workspaceId, directory, refresh: async () => undefined };
  }

  private createWorktreeWorkspace(request: WorkspaceCreateRequest) {
    this.workspaceCounter += 1;
    const workspaceId = `ws-${this.workspaceCounter}`;
    const directory = join(this.worktreeRootDirectory, `worktree-${this.workspaceCounter}`);
    // same call Paseo makes for action "branch-off": a new branch cut from refName
    runGitSync(request.source.cwd, ["worktree", "add", "-b", request.source.branchName, directory, request.source.refName]);
    // Registered under the canonical path so the later open() of this same checkout resolves to this workspace.
    this.workspaceIdByDirectory.set(FakePaseo.canonicalDirectory(directory), workspaceId);
    this.createdWorkspaces.push({ request, workspaceId, directory });
    return this.buildHandle(workspaceId, directory);
  }
}

// Same public surface as PaseoHolder, without the 30 s wait for a first hook event.
export class FakePaseoHolder {
  readonly captures: unknown[] = [];
  // flips to false to emulate a plugin restart where no hook has delivered the SDK handle yet
  ready = true;

  constructor(private readonly paseo: PaseoApi) {}

  capture(capturedPaseo: unknown): void {
    this.captures.push(capturedPaseo);
  }

  async get(): Promise<PaseoApi> {
    return this.paseo;
  }

  isReady(): boolean {
    return this.ready;
  }
}
