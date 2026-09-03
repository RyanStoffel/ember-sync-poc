import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { config } from "./config.js";

export type BoardColumns = {
  todo: string;
  inProgress: string;
  inReview: string;
  done: string;
};

export type WorkspaceRecord = {
  id: string;
  name: string;
  /** "owner/repo" */
  githubRepo: string;
  jiraProjectKey: string;
  columns: BoardColumns;
  createdAt: string;
  /** Id of the dynamic Jira webhook (registered over OAuth) scoped to this workspace's project. */
  jiraWebhookId?: number;
};

const defaultColumns: BoardColumns = {
  todo: "To Do",
  inProgress: "In Progress",
  inReview: "In Review",
  done: "Done",
};

type Persisted = { workspaces: WorkspaceRecord[] };
type LegacySettings = {
  workspaceName?: string;
  githubRepo?: string;
  jiraProjectKey?: string;
  columns?: Partial<BoardColumns>;
};

/**
 * Every workspace is one GitHub repository paired with one Jira project.
 * All workspaces share the same GitHub and Jira OAuth connections (those are
 * account-level), so creating a workspace only ever asks for the repo and
 * project, never a second sign-in.
 */
export class WorkspaceStore {
  private workspaces: WorkspaceRecord[];
  private readonly file = `${config.dataDir}workspaces.json`;

  constructor() {
    mkdirSync(config.dataDir, { recursive: true });
    this.workspaces = this.load();
  }

  private load(): WorkspaceRecord[] {
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Persisted;
      return parsed.workspaces;
    } catch {
      return this.migrateLegacySettings();
    }
  }

  /**
   * The prototype used to support exactly one global workspace, persisted at
   * `data/settings.json`. Converting it into the first workspace record (and
   * moving its link registry into the new per-workspace directory) means an
   * existing deployment does not lose its sync history on upgrade.
   */
  private migrateLegacySettings(): WorkspaceRecord[] {
    const legacyFile = `${config.dataDir}settings.json`;
    if (!existsSync(legacyFile)) return [];
    try {
      const legacy = JSON.parse(readFileSync(legacyFile, "utf8")) as LegacySettings;
      if (!legacy.githubRepo || !legacy.jiraProjectKey) return [];
      const record: WorkspaceRecord = {
        id: randomBytes(8).toString("hex"),
        name: legacy.workspaceName ?? legacy.githubRepo,
        githubRepo: legacy.githubRepo,
        jiraProjectKey: legacy.jiraProjectKey.toUpperCase(),
        columns: { ...defaultColumns, ...legacy.columns },
        createdAt: new Date().toISOString(),
      };
      mkdirSync(this.dataDirFor(record.id), { recursive: true });
      const legacyLinks = `${config.dataDir}links.json`;
      if (existsSync(legacyLinks)) renameSync(legacyLinks, `${this.dataDirFor(record.id)}links.json`);
      this.workspaces = [record];
      this.save();
      return this.workspaces;
    } catch {
      return [];
    }
  }

  private save(): void {
    writeFileSync(this.file, JSON.stringify({ workspaces: this.workspaces } satisfies Persisted, null, 2));
  }

  dataDirFor(id: string): string {
    return `${config.dataDir}workspaces/${id}/`;
  }

  list(): readonly WorkspaceRecord[] {
    return this.workspaces;
  }

  get(id: string): WorkspaceRecord | undefined {
    return this.workspaces.find((workspace) => workspace.id === id);
  }

  private validateRepo(githubRepo: string): void {
    const parts = githubRepo.split("/");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new Error("GitHub repository must look like owner/repo");
    }
  }

  /**
   * Two workspaces pointed at the same repository and the same Jira project
   * would each run their own reconcile against their own link registry, so
   * every issue looks "unlinked" to one of them and both sides get mirrored
   * twice, forever, on every restart. This is what a duplicate submit of the
   * "create workspace" form produces, so it is rejected outright rather than
   * just discouraged in the UI.
   */
  private validateUnique(githubRepo: string, jiraProjectKey: string, excludeId?: string): void {
    const collision = this.workspaces.find(
      (workspace) =>
        workspace.id !== excludeId &&
        workspace.githubRepo.toLowerCase() === githubRepo.toLowerCase() &&
        workspace.jiraProjectKey === jiraProjectKey,
    );
    if (collision) {
      throw new Error(`"${collision.name}" already syncs ${githubRepo} with ${jiraProjectKey}`);
    }
  }

  create(input: { name: string; githubRepo: string; jiraProjectKey: string; columns?: Partial<BoardColumns> }): WorkspaceRecord {
    this.validateRepo(input.githubRepo);
    if (!input.jiraProjectKey.trim()) throw new Error("Jira project key is required");
    const jiraProjectKey = input.jiraProjectKey.trim().toUpperCase();
    this.validateUnique(input.githubRepo, jiraProjectKey);
    const record: WorkspaceRecord = {
      id: randomBytes(8).toString("hex"),
      name: input.name.trim() || input.githubRepo,
      githubRepo: input.githubRepo,
      jiraProjectKey,
      columns: { ...defaultColumns, ...input.columns },
      createdAt: new Date().toISOString(),
    };
    mkdirSync(this.dataDirFor(record.id), { recursive: true });
    this.workspaces.push(record);
    this.save();
    return record;
  }

  /** Returns the updated record and whether the sync target (repo or project) actually changed. */
  update(
    id: string,
    patch: { name?: string; githubRepo?: string; jiraProjectKey?: string; columns?: Partial<BoardColumns> },
  ): { record: WorkspaceRecord; targetChanged: boolean } {
    const record = this.get(id);
    if (!record) throw new Error("Workspace not found");
    if (patch.githubRepo !== undefined) this.validateRepo(patch.githubRepo);
    const nextGithubRepo = patch.githubRepo ?? record.githubRepo;
    const nextJiraProjectKey = patch.jiraProjectKey ? patch.jiraProjectKey.trim().toUpperCase() : record.jiraProjectKey;
    this.validateUnique(nextGithubRepo, nextJiraProjectKey, id);
    const targetChanged = nextGithubRepo !== record.githubRepo || nextJiraProjectKey !== record.jiraProjectKey;
    record.name = patch.name?.trim() || record.name;
    record.githubRepo = nextGithubRepo;
    record.jiraProjectKey = nextJiraProjectKey;
    if (patch.columns) record.columns = { ...record.columns, ...patch.columns };
    this.save();
    return { record, targetChanged };
  }

  /** Records which dynamic Jira webhook (if any) is currently registered for this workspace. */
  setWebhookId(id: string, webhookId: number): void {
    const record = this.get(id);
    if (!record) return;
    record.jiraWebhookId = webhookId;
    this.save();
  }

  remove(id: string): void {
    this.workspaces = this.workspaces.filter((workspace) => workspace.id !== id);
    this.save();
  }
}

export const workspaceStore = new WorkspaceStore();
