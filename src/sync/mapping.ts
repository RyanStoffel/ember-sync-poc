import { config } from "../config.js";
import { fromAdf } from "../adf.js";
import type { GithubIssue } from "../github/client.js";
import type { JiraIssue, JiraStatusName } from "../jira-sim/store.js";

/**
 * Field mapping between a GitHub issue and a Jira issue.
 *
 * The interesting part is the workflow state mapping. GitHub has two issue
 * states, while Jira has To Do, In Progress, In Review, and Done. Control
 * labels on GitHub carry the two intermediate Jira states without changing
 * the GitHub issue state itself.

 */
export type GhSnapshot = {
  title: string;
  body: string;
  state: "open" | "closed";
  labels: string[];
};

export type JiraSnapshot = {
  summary: string;
  description: string;
  status: JiraStatusName;
  labels: string[];
};

/** Fields compared to decide whether anything actually changed. */
export type SyncField = "title" | "body" | "status" | "labels";

export function ghSnapshot(issue: GithubIssue): GhSnapshot {
  return {
    title: issue.title,
    body: issue.body ?? "",
    state: issue.state,
    labels: issue.labels.map((label) => label.name).sort(),
  };
}

export function jiraSnapshot(issue: JiraIssue): JiraSnapshot {
  return {
    summary: issue.fields.summary,
    description: fromAdf(issue.fields.description),
    status: issue.fields.status.name,
    labels: [...issue.fields.labels].sort(),
  };
}

/** Labels that carry meaning on both sides; workflow labels are state, not labels. */
export function portableLabels(labels: readonly string[]): string[] {
  return labels.filter(
    (label) => label !== config.github.inProgressLabel && label !== config.github.inReviewLabel,
  ).sort();
}

/** Jira labels reject whitespace, so multi-word GitHub labels are hyphenated. */
export function toJiraLabels(labels: readonly string[]): string[] {
  return portableLabels(labels).map((label) => label.replace(/\s+/g, "-"));
}

export function jiraStatusFor(snapshot: GhSnapshot): JiraStatusName {
  if (snapshot.state === "closed") return "Done";
  if (snapshot.labels.includes(config.github.inReviewLabel)) return "In Review";
  return snapshot.labels.includes(config.github.inProgressLabel) ? "In Progress" : "To Do";
}

/** Inverse of `jiraStatusFor`: Jira workflow statuses become GitHub state plus control labels. */
export function githubStateFor(
  status: JiraStatusName,
  jiraLabels: readonly string[],
): { state: "open" | "closed"; labels: string[] } {
  const labels = portableLabels(jiraLabels);
  if (status === "Done") return { state: "closed", labels };
  if (status === "In Review") return { state: "open", labels: [...labels, config.github.inReviewLabel].sort() };
  if (status === "In Progress") return { state: "open", labels: [...labels, config.github.inProgressLabel].sort() };
  return { state: "open", labels };
}

/**
 * Prefixes marking a comment as mirrored rather than authored. GitHub issue
 * comments carry no origin metadata and the PoC writes with a single token, so
 * the marker in the body is what stops comments ping-ponging.
 */
export const GH_MIRROR_PREFIX = "via Jira ·";
export const JIRA_MIRROR_PREFIX = "via GitHub ·";

export function isMirroredComment(body: string): boolean {
  const trimmed = body.trimStart();
  return trimmed.startsWith(GH_MIRROR_PREFIX) || trimmed.startsWith(JIRA_MIRROR_PREFIX);
}
