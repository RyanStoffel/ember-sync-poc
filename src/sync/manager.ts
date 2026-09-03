import { type BoardColumns, type WorkspaceRecord, workspaceStore, WorkspaceStore } from "../workspaces.js";
import { SyncEngine, type WorkspaceTarget } from "./engine.js";
import { ensureWebhook, removeWebhook } from "./webhook.js";

function targetFor(record: WorkspaceRecord): WorkspaceTarget {
  const [owner = "", repo = ""] = record.githubRepo.split("/");
  return { githubOwner: owner, githubRepo: repo, jiraProjectKey: record.jiraProjectKey };
}

/**
 * Owns one SyncEngine per workspace. All workspaces share the same GitHub and
 * Jira OAuth connections (account-level); what varies per workspace is the
 * repository, the Jira project, and each workspace's own poll loop, caches,
 * and activity log.
 */
export class WorkspaceManager {
  private readonly engines = new Map<string, SyncEngine>();

  constructor(private readonly store: WorkspaceStore) {
    for (const record of store.list()) {
      this.engines.set(record.id, new SyncEngine(record.id, targetFor(record), store.dataDirFor(record.id)));
    }
  }

  list(): readonly WorkspaceRecord[] {
    return this.store.list();
  }

  get(id: string): WorkspaceRecord | undefined {
    return this.store.get(id);
  }

  engineFor(id: string): SyncEngine | undefined {
    return this.engines.get(id);
  }

  async startAll(): Promise<void> {
    for (const [id, engine] of this.engines) {
      await engine.start();
      const record = this.store.get(id);
      if (record) await ensureWebhook(record).catch((error) => this.logWebhookIssue(record, error));
    }
  }

  async create(input: { name: string; githubRepo: string; jiraProjectKey: string; columns?: Partial<BoardColumns> }): Promise<WorkspaceRecord> {
    const record = this.store.create(input);
    const engine = new SyncEngine(record.id, targetFor(record), this.store.dataDirFor(record.id));
    this.engines.set(record.id, engine);
    await engine.start();
    await ensureWebhook(record).catch((error) => this.logWebhookIssue(record, error));
    return record;
  }

  async update(
    id: string,
    patch: { name?: string; githubRepo?: string; jiraProjectKey?: string; columns?: Partial<BoardColumns> },
  ): Promise<WorkspaceRecord> {
    const previous = this.store.get(id);
    const previousProjectKey = previous?.jiraProjectKey;
    const { record, targetChanged } = this.store.update(id, patch);
    const engine = this.engines.get(id);
    if (engine && targetChanged) await engine.retarget(targetFor(record));
    if (previous && previousProjectKey !== record.jiraProjectKey) {
      await removeWebhook(previous);
      await ensureWebhook(record).catch((error) => this.logWebhookIssue(record, error));
    }
    return record;
  }

  async remove(id: string): Promise<void> {
    const record = this.store.get(id);
    this.engines.get(id)?.stop();
    this.engines.delete(id);
    this.store.remove(id);
    if (record) await removeWebhook(record);
  }

  private logWebhookIssue(record: WorkspaceRecord, error: unknown): void {
    console.error(
      `[ember] could not maintain the Jira webhook for "${record.name}": ${(error as Error).message}. ` +
        `If this persists, confirm the Atlassian OAuth app has the manage:jira-webhook scope and reconnect Jira.`,
    );
  }

  /** Finds the workspace to route a Jira webhook to, by the project key on its payload. */
  findByJiraProjectKey(projectKey: string): SyncEngine | undefined {
    const record = this.store.list().find((workspace) => workspace.jiraProjectKey === projectKey);
    return record ? this.engines.get(record.id) : undefined;
  }
}

export const workspaceManager = new WorkspaceManager(workspaceStore);
