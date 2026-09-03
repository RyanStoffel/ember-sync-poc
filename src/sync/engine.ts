import { type AdfDoc, fromAdf, toAdf } from "../adf.js";
import { config } from "../config.js";
import { authStatus } from "../oauth.js";
import { eventLog } from "../events.js";
import { type GithubComment, GithubClient, type GithubIssue, NOT_MODIFIED } from "../github/client.js";
import { jiraAsSync } from "../jira/client.js";
import type { JiraComment, JiraIssue, JiraStatusName } from "../jira-sim/store.js";
import { EchoGuard } from "./echo.js";
import { type IssueLink, LinkRegistry } from "./links.js";
import {
  GH_MIRROR_PREFIX,
  type GhSnapshot,
  ghSnapshot,
  githubStateFor,
  isMirroredComment,
  JIRA_MIRROR_PREFIX,
  type JiraSnapshot,
  jiraSnapshot,
  jiraStatusFor,
  portableLabels,
  toJiraLabels,
} from "./mapping.js";

/** Branch convention shared by Ember and developers. */
export function branchNameFor(jiraKey: string, summary: string): string {
  const slug = summary.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);
  return `feature/${jiraKey}-${slug || "work"}`;
}
export type EngineStats = {
  paused: boolean;
  polls: number;
  notModified: number;
  lastPollAt: string | null;
  pendingFingerprints: number;
};

/**
 * Bidirectional GitHub <-> Jira sync.
 *
 * Jira is event driven: the stand-in delivers real Jira webhook payloads, and
 * `onJiraWebhook` reacts to the changelog. GitHub is poll driven, because
 * receiving GitHub webhooks would require a publicly reachable URL; the engine
 * diffs each polled issue against the last snapshot in the link registry to
 * recover the same field-level change events a webhook would have given it.
 */
export class SyncEngine {
  readonly links = new LinkRegistry();
  readonly ghCache = new Map<number, GithubIssue>();
  readonly jiraCache = new Map<string, JiraIssue>();
  private readonly pendingJiraCreates = new Set<string>();
  private readonly gh = new GithubClient();
  private readonly echo = new EchoGuard();
  private timer: NodeJS.Timeout | undefined;
  private busy = false;
  private paused = false;
  private polls = 0;
  private notModified = 0;
  private lastPollAt: string | null = null;

  get stats(): EngineStats {
    return {
      paused: this.paused,
      polls: this.polls,
      notModified: this.notModified,
      lastPollAt: this.lastPollAt,
      pendingFingerprints: this.echo.size,
    };
  }

  async start(): Promise<void> {
    if (this.timer) return;
    const auth = authStatus();
    if (!auth.githubConnected || !auth.jiraConnected) {
      eventLog.emit({
        direction: "system",
        disposition: "no-op",
        entity: "engine",
        summary: "waiting for GitHub and Jira OAuth",
      });
      return;
    }
    try {
      await this.reconcile("boot");
    } catch (error) {
      eventLog.emit({
        direction: "system",
        disposition: "error",
        entity: "engine",
        summary: "provider sync unavailable",
        detail: (error as Error).message,
      });
    }
    this.timer = setInterval(() => void this.tick(), config.githubPollMs);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  /**
   * Pausing stops propagation so the two systems can be driven apart on
   * purpose. Resuming runs a full reconcile, which is also how a real
   * deployment recovers from webhook delivery it missed while offline.
   */
  async setPaused(paused: boolean): Promise<void> {
    if (paused === this.paused) return;
    this.paused = paused;
    eventLog.emit({
      direction: "system",
      disposition: "no-op",
      entity: "engine",
      summary: paused ? "sync paused" : "sync resumed",
      ...(paused ? {} : { detail: "running full reconcile to catch up" }),
    });
    if (!paused) await this.reconcile("resume");
  }

  private async tick(): Promise<void> {
    if (this.paused || this.busy) return;
    this.busy = true;
    try {

      // Overlap the window so an issue updated mid-request is not skipped.
      const since = new Date(Date.now() - config.githubPollMs * 3).toISOString();
      this.polls++;
      this.lastPollAt = new Date().toISOString();

      const issues = await this.gh.listIssues({ since, conditional: true });
      if (issues === NOT_MODIFIED) {
        this.notModified++;
      } else {
        for (const issue of issues) await this.ingestGithubIssue(issue);
      }

      const comments = await this.gh.listComments({ since, conditional: true });
      if (comments === NOT_MODIFIED) {
        this.notModified++;
      } else {
        for (const comment of comments) await this.ingestGithubComment(comment);
      }
      await this.pollBranchWorkflows();
    } catch (error) {
      eventLog.emit({
        direction: "gh->jira",
        disposition: "error",
        entity: "poll",
        summary: "GitHub poll failed",
        detail: (error as Error).message,
      });
    } finally {
      this.busy = false;
    }
  }

  async reconfigure(resetAssociations: boolean): Promise<void> {
    if (resetAssociations) {
      this.links.reset();
      this.ghCache.clear();
      this.jiraCache.clear();
      this.gh.resetCache();
    }
    await this.reconcile("settings updated");
  }

  /** Polls each linked work branch and applies the requested Jira workflow transitions. */
  private async pollBranchWorkflows(): Promise<void> {
    for (const link of this.links.links) {
      if (!link.branchName) continue;
      try {
        const head = await this.gh.branchHead(link.branchName);
        if (!head) {
          eventLog.emit({
            direction: "gh->jira",
            disposition: "error",
            entity: `${link.jiraKey} branch`,
            summary: "linked branch is missing",
            detail: link.branchName,
          });
          continue;
        }

        if (link.lastCommitSha === undefined) {
          link.lastCommitSha = head;
          this.links.save();
        } else if (head !== link.lastCommitSha) {
          link.lastCommitSha = head;
          this.links.save();
          if (link.jira.status === "To Do") {
            await this.transitionWorkflow(link, "In Progress", `commit ${head.slice(0, 7)} on ${link.branchName}`);
          }
        }

        const pullRequests = await this.gh.pullRequestsForBranch(link.branchName);
        const pullRequest = pullRequests[0];
        if (!pullRequest) continue;
        if (link.pullRequestNumber !== pullRequest.number) {
          link.pullRequestNumber = pullRequest.number;
          this.links.save();
        }

        if (pullRequest.merged_at !== null) {
          if (link.jira.status !== "Done") {
            await this.transitionWorkflow(link, "Done", `PR #${pullRequest.number} merged`);
          }
        } else if (pullRequest.state === "open" && link.jira.status !== "Done" && link.jira.status !== "In Review") {
          await this.transitionWorkflow(link, "In Review", `PR #${pullRequest.number} opened`);
        }
      } catch (error) {
        eventLog.emit({
          direction: "gh->jira",
          disposition: "error",
          entity: `${link.jiraKey} workflow`,
          summary: "workflow poll failed",
          detail: (error as Error).message,
        });
      }
    }
  }

  /** Transitions Jira and mirrors the workflow state back to the linked GitHub issue. */
  private async transitionWorkflow(link: IssueLink, target: JiraStatusName, reason: string): Promise<void> {
    const changed = await jiraAsSync.transitionTo(link.jiraKey, target);
    if (!changed) throw new Error(`${link.jiraKey} has no transition to "${target}"`);
    const updatedJira = await jiraAsSync.getIssue(link.jiraKey);
    this.jiraCache.set(link.jiraKey, updatedJira);
    link.jira = jiraSnapshot(updatedJira);
    await this.reflectWorkflowOnGithub(link, target);
    this.links.save();
    eventLog.emit({
      direction: "gh->jira",
      disposition: "applied",
      entity: `${link.jiraKey} workflow`,
      summary: reason,
      detail: `Jira -> ${target}`,
    });
  }

  private async reflectWorkflowOnGithub(link: IssueLink, status: JiraStatusName): Promise<void> {
    const current = this.ghCache.get(link.ghNumber);
    if (!current) return;
    const target = githubStateFor(status, current.labels.map((label) => label.name));
    const labels = portableLabels(target.labels).join(" ");
    this.echo.mark(link.ghNumber, "status", status);
    this.echo.mark(link.ghNumber, "labels", labels);
    const updated = await this.gh.updateIssue(link.ghNumber, {
      state: target.state,
      labels: target.labels,
    });
    this.ghCache.set(updated.number, updated);
    link.gh = ghSnapshot(updated);
  }

  /**
   * Full two-way sweep: links anything unlinked, then applies drift on both
   * sides. On conflict GitHub wins, because it is the side holding the code.
   */
  async reconcile(reason: string): Promise<void> {
    const ghIssues = await this.gh.listIssues();
    if (ghIssues === NOT_MODIFIED) return;
    for (const issue of ghIssues) this.ghCache.set(issue.number, issue);
    const jiraIssues = await jiraAsSync.search();
    for (const issue of jiraIssues) this.jiraCache.set(issue.key, issue);
    eventLog.emit({
      direction: "system",
      disposition: "no-op",
      entity: "reconcile",
      summary: `${reason}: ${ghIssues.length} GitHub, ${jiraIssues.length} Jira`,
      detail: `${this.links.links.length} existing links`,
    });

    for (const issue of ghIssues) {
      if (!this.links.byGh(issue.number)) await this.createJiraFromGithub(issue);
    }
    for (const issue of jiraIssues) {
      if (!this.links.byJira(issue.key)) await this.createGithubFromJira(issue);
    }
    for (const link of this.links.links) {
      if (link.origin === "jira" && !link.branchName) await this.ensureBranchForLink(link);
    }

    // One search after the create pass, keyed for the drift loop below.
    const refreshedJiraIssues = await jiraAsSync.search();
    for (const issue of refreshedJiraIssues) this.jiraCache.set(issue.key, issue);
    const jiraByKey = new Map(refreshedJiraIssues.map((issue) => [issue.key, issue]));
    for (const link of this.links.links) {
      const ghIssue = this.ghCache.get(link.ghNumber);
      const jiraIssue = jiraByKey.get(link.jiraKey);
      if (!ghIssue || !jiraIssue) continue;
      const ghNow = ghSnapshot(ghIssue);
      const jiraNow = jiraSnapshot(jiraIssue);
      const ghDrifted = JSON.stringify(ghNow) !== JSON.stringify(link.gh);
      const jiraDrifted = JSON.stringify(jiraNow) !== JSON.stringify(link.jira);

      if (ghDrifted && jiraDrifted) {
        eventLog.emit({
          direction: "gh->jira",
          disposition: "applied",
          entity: `GH#${link.ghNumber} / ${link.jiraKey}`,
          summary: "conflict resolved",
          detail: "both sides changed while paused; GitHub is authoritative",
        });
        await this.applyGithubToJira(link, ghNow);
        link.jira = jiraSnapshot(jiraIssue);
      } else if (ghDrifted) {
        await this.applyGithubToJira(link, ghNow);
      } else if (jiraDrifted) {
        await this.applyJiraToGithub(link, jiraNow, "drift");
      }
    }

    // Comments that already existed are adopted as history rather than replayed.
    const allComments = await this.gh.listComments();
    if (allComments !== NOT_MODIFIED) {
      let adopted = 0;
      for (const comment of allComments) if (this.links.claimGhComment(comment.id)) adopted++;
      if (adopted > 0) {
        eventLog.emit({
          direction: "system",
          disposition: "no-op",
          entity: "reconcile",
          summary: `baselined ${adopted} pre-existing GitHub comments`,
          detail: "history is not replayed across the boundary",
        });
      }
    }
    this.links.save();
  }

  // ---------------------------------------------------------------- GitHub in

  private async ingestGithubIssue(issue: GithubIssue): Promise<void> {
    this.ghCache.set(issue.number, issue);
    const link = this.links.byGh(issue.number);
    if (!link) {
      await this.createJiraFromGithub(issue);
      return;
    }
    await this.applyGithubToJira(link, ghSnapshot(issue));
  }

  private async ingestGithubComment(comment: GithubComment): Promise<void> {
    const number = Number(comment.issue_url.split("/").pop());
    const link = this.links.byGh(number);
    if (!link) return;
    if (!this.links.claimGhComment(comment.id)) return;

    if (isMirroredComment(comment.body)) {
      eventLog.emit({
        direction: "gh->jira",
        disposition: "echo-suppressed",
        entity: `GH#${number} comment`,
        summary: "mirrored comment not sent back",
        detail: "body carries an origin marker",
      });
      return;
    }

    const body = `${JIRA_MIRROR_PREFIX} @${comment.user.login}\n\n${comment.body}`;
    await jiraAsSync.addComment(link.jiraKey, toAdf(body));
    eventLog.emit({
      direction: "gh->jira",
      disposition: "applied",
      entity: `GH#${number} comment`,
      summary: `comment mirrored to ${link.jiraKey}`,
      detail: comment.body.slice(0, 80),
    });
  }

  private async createJiraFromGithub(issue: GithubIssue): Promise<void> {
    const snapshot = ghSnapshot(issue);
    const created = await jiraAsSync.createIssue({
      summary: snapshot.title,
      description: toAdf(snapshot.body),
      labels: toJiraLabels(snapshot.labels),
    });
    this.pendingJiraCreates.add(created.key);
    const status = jiraStatusFor(snapshot);
    if (status !== "To Do") await jiraAsSync.transitionTo(created.key, status);
    const jiraIssue = await jiraAsSync.getIssue(created.key);
    this.jiraCache.set(created.key, jiraIssue);

    this.links.add({
      ghNumber: issue.number,
      jiraKey: created.key,
      origin: "github",
      gh: snapshot,
      jira: {
        summary: snapshot.title,
        description: snapshot.body,
        status,
        labels: toJiraLabels(snapshot.labels),
      },
    });
    eventLog.emit({
      direction: "gh->jira",
      disposition: "created",
      entity: `GH#${issue.number}`,
      summary: `created ${created.key}`,
      detail: snapshot.title,
    });
  }

  /** Applies a GitHub-side change set to Jira, dropping fields that are our own echo. */
  private async applyGithubToJira(link: IssueLink, now: GhSnapshot): Promise<void> {
    const before = link.gh;
    const fields: { summary?: string; description?: AdfDoc; labels?: string[] } = {};
    const changed: string[] = [];

    if (now.title !== before.title) {
      if (this.echo.consume(link.ghNumber, "title", now.title)) {
        this.suppressed(link, "title");
      } else {
        fields.summary = now.title;
        changed.push("summary");
      }
    }
    if (now.body !== before.body) {
      if (this.echo.consume(link.ghNumber, "body", now.body)) {
        this.suppressed(link, "body");
      } else {
        fields.description = toAdf(now.body);
        changed.push("description");
      }
    }

    const beforeLabels = portableLabels(before.labels).join(" ");
    const nowLabels = portableLabels(now.labels).join(" ");
    if (nowLabels !== beforeLabels) {
      if (this.echo.consume(link.ghNumber, "labels", nowLabels)) {
        this.suppressed(link, "labels");
      } else {
        fields.labels = toJiraLabels(now.labels);
        changed.push("labels");
      }
    }

    const nowStatus = jiraStatusFor(now);
    let statusToApply: JiraStatusName | null = null;
    if (nowStatus !== link.jira.status) {
      if (this.echo.consume(link.ghNumber, "status", nowStatus)) {
        this.suppressed(link, "status");
      } else {
        statusToApply = nowStatus;
        changed.push(`status -> ${nowStatus}`);
      }
    }

    link.gh = now;

    if (changed.length === 0) {
      this.links.save();
      return;
    }

    try {
      if (Object.keys(fields).length > 0) await jiraAsSync.updateIssue(link.jiraKey, fields);
      if (statusToApply) await jiraAsSync.transitionTo(link.jiraKey, statusToApply);
      const updatedJira = await jiraAsSync.getIssue(link.jiraKey);
      this.jiraCache.set(link.jiraKey, updatedJira);
      if (fields.summary !== undefined) link.jira.summary = fields.summary;
      if (fields.description !== undefined) link.jira.description = now.body;
      if (fields.labels !== undefined) link.jira.labels = fields.labels;
      if (statusToApply) link.jira.status = statusToApply;
      this.links.save();
      eventLog.emit({
        direction: "gh->jira",
        disposition: "applied",
        entity: `GH#${link.ghNumber} -> ${link.jiraKey}`,
        summary: changed.join(", "),
        detail: fields.summary ?? now.title,
      });
    } catch (error) {
      eventLog.emit({
        direction: "gh->jira",
        disposition: "error",
        entity: `GH#${link.ghNumber} -> ${link.jiraKey}`,
        summary: "write to Jira failed",
        detail: (error as Error).message,
      });
    }
  }

  private suppressed(link: IssueLink, field: string): void {
    eventLog.emit({
      direction: "gh->jira",
      disposition: "echo-suppressed",
      entity: `GH#${link.ghNumber} ${field}`,
      summary: "observed our own write",
      detail: "content fingerprint matched a pending outbound write",
    });
  }

  // ------------------------------------------------------------------ Jira in

  /** Entry point for Jira webhook deliveries. */
  async onJiraWebhook(payload: JiraWebhook): Promise<void> {
    const actor = payload.user?.accountId ?? "unknown";
    const key = payload.issue?.key;
    if (!key) return;
    if (payload.issue) this.jiraCache.set(key, payload.issue);

    const engineCreatedIssue =
      payload.webhookEvent === "jira:issue_created" && this.pendingJiraCreates.delete(key);
    const humanCreatedUnlinked =
      payload.webhookEvent === "jira:issue_created" && !this.links.byJira(key) && !engineCreatedIssue;
    if (actor === config.jira.syncAccountId && !humanCreatedUnlinked) {
      // Our own write coming back. Refresh the snapshot so drift detection stays honest.
      const link = this.links.byJira(key);
      if (link && payload.issue) {
        link.jira = jiraSnapshot(payload.issue);
        this.links.save();
      }
      eventLog.emit({
        direction: "jira->gh",
        disposition: "echo-suppressed",
        entity: `${key} ${payload.webhookEvent}`,
        summary: "event authored by the sync account",
        detail: "identity check, no fingerprint needed",
      });
      return;
    }

    if (this.paused) {
      eventLog.emit({
        direction: "jira->gh",
        disposition: "no-op",
        entity: key,
        summary: "dropped while paused",
        detail: "will be recovered by reconcile on resume",
      });
      return;
    }

    try {
      if (payload.webhookEvent === "comment_created" && payload.comment) {
        await this.mirrorJiraComment(key, payload.comment);
        return;
      }
      if (payload.webhookEvent === "jira:issue_created") {
        if (!this.links.byJira(key) && payload.issue) await this.createGithubFromJira(payload.issue);
        return;
      }
      const link = this.links.byJira(key);
      if (!link || !payload.issue) return;
      const summary = (payload.changelog?.items ?? []).map((item) => item.field).join(", ");
      await this.applyJiraToGithub(link, jiraSnapshot(payload.issue), summary || "update");
    } catch (error) {
      eventLog.emit({
        direction: "jira->gh",
        disposition: "error",
        entity: key,
        summary: "write to GitHub failed",
        detail: (error as Error).message,
      });
    }
  }
  private async ensureBranchForLink(link: IssueLink): Promise<void> {
    if (!link.branchName) link.branchName = branchNameFor(link.jiraKey, link.jira.summary);
    try {
      const result = await this.gh.ensureBranch(link.branchName);
      link.lastCommitSha = result.sha;
      this.links.save();
      eventLog.emit({
        direction: "system",
        disposition: result.created ? "created" : "no-op",
        entity: `${link.jiraKey} branch`,
        summary: result.created ? "created on GitHub" : "existing branch adopted",
        detail: link.branchName,
      });
    } catch (error) {
      eventLog.emit({
        direction: "gh->jira",
        disposition: "error",
        entity: `${link.jiraKey} branch`,
        summary: "could not create GitHub branch",
        detail: (error as Error).message,
      });
    }
  }


  private async createGithubFromJira(issue: JiraIssue): Promise<void> {
    const snapshot = jiraSnapshot(issue);
    const target = githubStateFor(snapshot.status, snapshot.labels);
    const created = await this.gh.createIssue({
      title: snapshot.summary,
      body: snapshot.description,
      labels: target.labels,
    });
    // A new issue is created open; close it separately if Jira says it is Done.
    if (target.state === "closed") {
      this.echo.mark(created.number, "status", snapshot.status);
      await this.gh.updateIssue(created.number, { state: "closed" });
    }
    const ghNow: GhSnapshot = { title: snapshot.summary, body: snapshot.description, state: target.state, labels: target.labels.sort() };
    this.ghCache.set(created.number, { ...created, state: target.state, labels: target.labels.map((name) => ({ name })) });
    const link: IssueLink = {
      ghNumber: created.number,
      jiraKey: issue.key,
      origin: "jira",
      branchName: branchNameFor(issue.key, snapshot.summary),
      gh: ghNow,
      jira: snapshot,
    };
    await this.ensureBranchForLink(link);
    this.links.add(link);
    eventLog.emit({
      direction: "jira->gh",
      disposition: "created",
      entity: issue.key,
      summary: `created GH#${created.number}`,
      detail: snapshot.summary,
    });
  }

  /** Applies a Jira-side change set to GitHub, fingerprinting every value written. */
  private async applyJiraToGithub(link: IssueLink, now: JiraSnapshot, reason: string): Promise<void> {
    const before = link.jira;
    const patch: { title?: string; body?: string; state?: "open" | "closed"; labels?: string[] } = {};
    const changed: string[] = [];

    if (now.summary !== before.summary) {
      patch.title = now.summary;
      this.echo.mark(link.ghNumber, "title", now.summary);
      changed.push("title");
    }
    if (now.description !== before.description) {
      patch.body = now.description;
      this.echo.mark(link.ghNumber, "body", now.description);
      changed.push("body");
    }

    const statusChanged = now.status !== before.status;
    const labelsChanged = portableLabels(now.labels).join(" ") !== portableLabels(before.labels).join(" ");
    if (statusChanged || labelsChanged) {
      const target = githubStateFor(now.status, now.labels);
      patch.state = target.state;
      patch.labels = target.labels;
      if (statusChanged) {
        this.echo.mark(link.ghNumber, "status", now.status);
        changed.push(`status ${before.status} -> ${now.status} (GitHub ${target.state})`);
      }
      if (labelsChanged) {
        this.echo.mark(link.ghNumber, "labels", portableLabels(now.labels).join(" "));
        changed.push("labels");
      }
    }

    link.jira = now;
    if (changed.length === 0) {
      this.links.save();
      return;
    }

    const updated = await this.gh.updateIssue(link.ghNumber, patch);
    this.ghCache.set(updated.number, updated);
    link.gh = ghSnapshot(updated);
    this.links.save();
    eventLog.emit({
      direction: "jira->gh",
      disposition: "applied",
      entity: `${link.jiraKey} -> GH#${link.ghNumber}`,
      summary: changed.join(", "),
      detail: reason,
    });
  }

  private async mirrorJiraComment(key: string, comment: JiraComment): Promise<void> {
    const link = this.links.byJira(key);
    if (!link) return;
    if (!this.links.claimJiraComment(comment.id)) return;
    const text = fromAdf(comment.body);
    if (isMirroredComment(text)) {
      eventLog.emit({
        direction: "jira->gh",
        disposition: "echo-suppressed",
        entity: `${key} comment`,
        summary: "mirrored comment not sent back",
        detail: "body carries an origin marker",
      });
      return;
    }
    const body = `${GH_MIRROR_PREFIX} ${comment.author.displayName} (${key})\n\n${text}`;
    const created = await this.gh.createComment(link.ghNumber, body);
    // Claim the GitHub id up front so the next poll does not treat it as new.
    this.links.claimGhComment(created.id);
    eventLog.emit({
      direction: "jira->gh",
      disposition: "applied",
      entity: `${key} comment`,
      summary: `comment mirrored to GH#${link.ghNumber}`,
      detail: text.slice(0, 80),
    });
  }
}

export type JiraWebhook = {
  webhookEvent: string;
  issue_event_type_name?: string;
  user?: { accountId: string; displayName: string; emailAddress: string };
  issue?: JiraIssue;
  comment?: JiraComment;
  changelog?: { id: string; items: { field: string; fromString: string | null; toString: string | null }[] };
};

export const engine = new SyncEngine();
