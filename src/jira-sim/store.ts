import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { AdfDoc } from "../adf.js";
import { config } from "../config.js";

/**
 * In-memory Jira issue store with JSON persistence, shaped to match the
 * subset of Jira Cloud REST v3 the sync engine actually touches.
 */

export type JiraUser = { accountId: string; displayName: string; emailAddress: string };

export type JiraStatus = { id: string; name: JiraStatusName };
export type JiraStatusName = "To Do" | "In Progress" | "In Review" | "Done";

export type JiraComment = {
  id: string;
  body: AdfDoc;
  author: JiraUser;
  created: string;
  updated: string;
};

export type JiraIssue = {
  id: string;
  key: string;
  fields: {
    summary: string;
    description: AdfDoc | null;
    status: JiraStatus;
    labels: string[];
    issuetype: { name: string };
    project: { key: string };
    reporter: JiraUser;
    created: string;
    updated: string;
  };
  comments: JiraComment[];
};

export const STATUSES: readonly JiraStatus[] = [
  { id: "10001", name: "To Do" },
  { id: "10002", name: "In Progress" },
  { id: "10004", name: "In Review" },
  { id: "10003", name: "Done" },
];

/** Jira models status changes as transitions, not as a writable field. */
export const TRANSITIONS: readonly { id: string; name: string; to: JiraStatus }[] = [
  { id: "11", name: "To Do", to: STATUSES[0]! },
  { id: "21", name: "In Progress", to: STATUSES[1]! },
  { id: "24", name: "In Review", to: STATUSES[2]! },
  { id: "31", name: "Done", to: STATUSES[3]! },
];

type Persisted = { nextId: number; nextCommentId: number; issues: JiraIssue[] };

export class JiraStore {
  private nextId = 1;
  private nextCommentId = 1;
  private issues: JiraIssue[] = [];
  private readonly file = `${config.dataDir}jira.json`;

  constructor() {
    mkdirSync(config.dataDir, { recursive: true });
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Persisted;
      this.nextId = parsed.nextId;
      this.nextCommentId = parsed.nextCommentId;
      this.issues = parsed.issues;
    } catch {
      // Fresh store.
    }
  }

  private flush(): void {
    const payload: Persisted = {
      nextId: this.nextId,
      nextCommentId: this.nextCommentId,
      issues: this.issues,
    };
    writeFileSync(this.file, JSON.stringify(payload, null, 2));
  }

  all(): readonly JiraIssue[] {
    return this.issues;
  }

  find(key: string): JiraIssue | undefined {
    return this.issues.find((issue) => issue.key === key);
  }

  create(input: {
    summary: string;
    description: AdfDoc | null;
    labels: string[];
    reporter: JiraUser;
  }): JiraIssue {
    const id = String(10000 + this.nextId);
    const key = `${config.jira.projectKey}-${this.nextId}`;
    this.nextId++;
    const now = new Date().toISOString();
    const issue: JiraIssue = {
      id,
      key,
      fields: {
        summary: input.summary,
        description: input.description,
        status: STATUSES[0]!,
        labels: input.labels,
        issuetype: { name: "Task" },
        project: { key: config.jira.projectKey },
        reporter: input.reporter,
        created: now,
        updated: now,
      },
      comments: [],
    };
    this.issues.push(issue);
    this.flush();
    return issue;
  }

  /**
   * Applies a field patch and returns Jira-style changelog items for whatever
   * actually changed, so no-op writes produce no event.
   */
  update(
    key: string,
    patch: { summary?: string; description?: AdfDoc | null; labels?: string[] },
  ): { issue: JiraIssue; items: ChangelogItem[] } | undefined {
    const issue = this.find(key);
    if (!issue) return undefined;
    const items: ChangelogItem[] = [];

    if (patch.summary !== undefined && patch.summary !== issue.fields.summary) {
      items.push({
        field: "summary",
        fieldtype: "jira",
        fromString: issue.fields.summary,
        toString: patch.summary,
      });
      issue.fields.summary = patch.summary;
    }
    if (patch.description !== undefined) {
      const before = JSON.stringify(issue.fields.description);
      const after = JSON.stringify(patch.description);
      if (before !== after) {
        items.push({ field: "description", fieldtype: "jira", fromString: before, toString: after });
        issue.fields.description = patch.description;
      }
    }
    if (patch.labels !== undefined) {
      const before = [...issue.fields.labels].sort().join(" ");
      const after = [...patch.labels].sort().join(" ");
      if (before !== after) {
        items.push({ field: "labels", fieldtype: "jira", fromString: before, toString: after });
        issue.fields.labels = patch.labels;
      }
    }

    if (items.length > 0) {
      issue.fields.updated = new Date().toISOString();
      this.flush();
    }
    return { issue, items };
  }

  transition(key: string, transitionId: string): { issue: JiraIssue; items: ChangelogItem[] } | undefined {
    const issue = this.find(key);
    if (!issue) return undefined;
    const target = TRANSITIONS.find((transition) => transition.id === transitionId);
    if (!target) return undefined;
    if (issue.fields.status.name === target.to.name) return { issue, items: [] };
    const items: ChangelogItem[] = [
      {
        field: "status",
        fieldtype: "jira",
        fromString: issue.fields.status.name,
        toString: target.to.name,
      },
    ];
    issue.fields.status = target.to;
    issue.fields.updated = new Date().toISOString();
    this.flush();
    return { issue, items };
  }

  addComment(key: string, body: AdfDoc, author: JiraUser): { issue: JiraIssue; comment: JiraComment } | undefined {
    const issue = this.find(key);
    if (!issue) return undefined;
    const now = new Date().toISOString();
    const comment: JiraComment = { id: String(this.nextCommentId++), body, author, created: now, updated: now };
    issue.comments.push(comment);
    issue.fields.updated = now;
    this.flush();
    return { issue, comment };
  }
}

export type ChangelogItem = {
  field: string;
  fieldtype: string;
  fromString: string | null;
  toString: string | null;
};
