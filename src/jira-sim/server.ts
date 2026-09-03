import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AdfDoc } from "../adf.js";
import { config, jiraWebhookUrl } from "../config.js";
import { type ChangelogItem, type JiraIssue, JiraStore, type JiraUser, TRANSITIONS } from "./store.js";

/**
 * Stand-in for Jira Cloud, speaking the real REST v3 request and response
 * shapes and firing the real webhook payloads. The sync engine has no
 * knowledge that this is not a live Atlassian site: pointing
 * JIRA_BASE_URL at https://<site>.atlassian.net is the only change needed.
 *
 * Implemented surface:
 *   POST   /rest/api/3/issue
 *   GET    /rest/api/3/issue/:key
 *   PUT    /rest/api/3/issue/:key
 *   GET    /rest/api/3/issue/:key/transitions
 *   POST   /rest/api/3/issue/:key/transitions
 *   GET    /rest/api/3/issue/:key/comment
 *   POST   /rest/api/3/issue/:key/comment
 *   GET    /rest/api/3/search/jql
 */

export const jiraStore = new JiraStore();

/** Jira reports the authenticated principal on every event; the engine relies on it to ignore its own writes. */
function principal(request: IncomingMessage): JiraUser {
  const header = request.headers.authorization ?? "";
  const encoded = header.startsWith("Basic ") ? header.slice(6) : "";
  const email = Buffer.from(encoded, "base64").toString("utf8").split(":")[0] ?? "anonymous@ember.dev";
  const local = email.split("@")[0] ?? "anonymous";
  return {
    accountId: local === "sync" ? "ember-sync" : local,
    displayName: local === "sync" ? "Ember Sync" : local.charAt(0).toUpperCase() + local.slice(1),
    emailAddress: email,
  };
}

/** Jira omits internal collections from issue payloads; comments come from their own endpoint. */
function serialize(issue: JiraIssue) {
  return {
    id: issue.id,
    key: issue.key,
    self: `${config.jira.baseUrl}/rest/api/3/issue/${issue.key}`,
    fields: issue.fields,
  };
}

async function dispatchWebhook(body: Record<string, unknown>): Promise<void> {
  try {
    await fetch(jiraWebhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (error) {
    console.error("[jira-sim] webhook delivery failed:", (error as Error).message);
  }
}

function notifyIssueUpdate(issue: JiraIssue, items: ChangelogItem[], user: JiraUser): void {
  if (items.length === 0) return;
  void dispatchWebhook({
    timestamp: Date.now(),
    webhookEvent: "jira:issue_updated",
    issue_event_type_name: items.some((item) => item.field === "status")
      ? "issue_generic"
      : "issue_updated",
    user,
    issue: serialize(issue),
    changelog: { id: String(Date.now()), items },
  });
}

export function startJiraSim(): void {
  const server = createServer((request, response) => {
    void handle(request, response).catch((error: Error) => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ errorMessages: [error.message] }));
    });
  });
  server.listen(config.ports.jiraSim, "127.0.0.1", () => {
    console.log(`[jira-sim] Jira Cloud REST v3 stand-in on ${config.jira.baseUrl}`);
  });
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", config.jira.baseUrl);
  const method = request.method ?? "GET";
  const user = principal(request);

  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  const body = raw.length > 0 ? (JSON.parse(raw) as Record<string, any>) : {};

  const json = (status: number, payload: unknown): void => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(payload === undefined ? "" : JSON.stringify(payload));
  };

  const issueMatch = /^\/rest\/api\/3\/issue\/([A-Z]+-\d+)(\/transitions|\/comment)?$/.exec(url.pathname);

  if (method === "POST" && url.pathname === "/rest/api/3/issue") {
    const fields = body.fields ?? {};
    const projectKey = String(fields.project?.key ?? "");
    if (!projectKey) {
      json(400, { errorMessages: ["fields.project.key is required"] });
      return;
    }
    const issue = jiraStore.create({
      projectKey,
      summary: String(fields.summary ?? "Untitled"),
      description: (fields.description ?? null) as AdfDoc | null,
      labels: Array.isArray(fields.labels) ? fields.labels.map(String) : [],
      reporter: user,
    });
    void dispatchWebhook({
      timestamp: Date.now(),
      webhookEvent: "jira:issue_created",
      issue_event_type_name: "issue_created",
      user,
      issue: serialize(issue),
    });
    json(201, { id: issue.id, key: issue.key, self: serialize(issue).self });
    return;
  }

  if (url.pathname === "/rest/api/3/search/jql") {
    // The JQL string always takes the shape "project = KEY ORDER BY ...";
    // pulling the key out directly avoids writing a JQL parser for one clause.
    const jql = url.searchParams.get("jql") ?? "";
    const projectMatch = /project\s*=\s*(\S+)/.exec(jql);
    const issues = projectMatch ? jiraStore.allForProject(projectMatch[1]!) : jiraStore.all();
    json(200, {
      issues: issues.map(serialize),
      total: issues.length,
      isLast: true,
    });
    return;
  }


  if (issueMatch) {
    const key = issueMatch[1]!;
    const sub = issueMatch[2];
    const issue = jiraStore.find(key);
    if (!issue) {
      json(404, { errorMessages: [`Issue does not exist or you do not have permission to see it.`] });
      return;
    }

    if (sub === "/transitions") {
      if (method === "GET") {
        json(200, { transitions: TRANSITIONS.filter((t) => t.to.name !== issue.fields.status.name) });
        return;
      }
      const result = jiraStore.transition(key, String(body.transition?.id ?? ""));
      if (!result) {
        json(400, { errorMessages: ["Transition is not valid for this issue."] });
        return;
      }
      notifyIssueUpdate(result.issue, result.items, user);
      json(204, undefined);
      return;
    }

    if (sub === "/comment") {
      if (method === "GET") {
        json(200, { comments: issue.comments, total: issue.comments.length });
        return;
      }
      const result = jiraStore.addComment(key, body.body as AdfDoc, user);
      if (!result) {
        json(400, { errorMessages: ["Comment body is required."] });
        return;
      }
      void dispatchWebhook({
        timestamp: Date.now(),
        webhookEvent: "comment_created",
        issue_event_type_name: "issue_commented",
        user,
        issue: serialize(result.issue),
        comment: result.comment,
      });
      json(201, result.comment);
      return;
    }

    if (method === "GET") {
      json(200, serialize(issue));
      return;
    }

    if (method === "PUT") {
      const fields = body.fields ?? {};
      const patch: Parameters<JiraStore["update"]>[1] = {};
      if ("summary" in fields) patch.summary = String(fields.summary);
      if ("description" in fields) patch.description = fields.description as AdfDoc | null;
      if ("labels" in fields) patch.labels = (fields.labels as unknown[]).map(String);
      const result = jiraStore.update(key, patch);
      if (result) notifyIssueUpdate(result.issue, result.items, user);
      json(204, undefined);
      return;
    }
  }

  json(404, { errorMessages: [`No handler for ${method} ${url.pathname}`] });
}
