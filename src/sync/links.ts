import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { GhSnapshot, JiraSnapshot } from "./mapping.js";

/**
 * The link registry: which GitHub issue corresponds to which Jira issue, plus
 * the last snapshot the engine believes each side holds. Diffing live state
 * against these snapshots is what turns "something was updated" into "the
 * title changed", which is the only way to make a poll-driven side behave like
 * an event-driven one.
 */

export type IssueLink = {
  ghNumber: number;
  jiraKey: string;
  /** Where the link came from, for display. */
  origin: "github" | "jira";
  /** Branch automatically created for Jira-origin tickets. */
  branchName?: string;
  /** Latest branch commit seen by workflow polling. */
  lastCommitSha?: string;
  /** Pull request previously observed for this branch. */
  pullRequestNumber?: number;
  gh: GhSnapshot;
  jira: JiraSnapshot;
};

type Persisted = {
  links: IssueLink[];
  /** GitHub comment ids already considered, so repeated polls do not re-mirror. */
  seenGhComments: number[];
  /** Jira comment ids already mirrored to GitHub. */
  seenJiraComments: string[];
};

export class LinkRegistry {
  readonly links: IssueLink[] = [];
  private readonly seenGhComments = new Set<number>();
  private readonly seenJiraComments = new Set<string>();
  private readonly file: string;

  constructor(workspaceDataDir: string) {
    mkdirSync(workspaceDataDir, { recursive: true });
    this.file = `${workspaceDataDir}links.json`;
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Persisted;
      this.links.push(...parsed.links);
      for (const id of parsed.seenGhComments) this.seenGhComments.add(id);
      for (const id of parsed.seenJiraComments) this.seenJiraComments.add(id);
    } catch {
      // Fresh registry.
    }
  }

  save(): void {
    const payload: Persisted = {
      links: this.links,
      seenGhComments: [...this.seenGhComments],
      seenJiraComments: [...this.seenJiraComments],
    };
    writeFileSync(this.file, JSON.stringify(payload, null, 2));
  }

  byGh(number: number): IssueLink | undefined {
    return this.links.find((link) => link.ghNumber === number);
  }

  byJira(key: string): IssueLink | undefined {
    return this.links.find((link) => link.jiraKey === key);
  }

  add(link: IssueLink): IssueLink {
    this.links.push(link);
    this.save();
    return link;
  }

  /** True the first time a comment id is offered, false on every later call. */
  claimGhComment(id: number): boolean {
    if (this.seenGhComments.has(id)) return false;
    this.seenGhComments.add(id);
    this.save();
    return true;
  }


  /** Clears associations when a user switches the configured repository or Jira project. */
  reset(): void {
    this.links.length = 0;
    this.seenGhComments.clear();
    this.seenJiraComments.clear();
    this.save();
  }
  claimJiraComment(id: string): boolean {
    if (this.seenJiraComments.has(id)) return false;
    this.seenJiraComments.add(id);
    this.save();
    return true;
  }
}
