import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fromAdf, toAdf } from "./adf.js";
import { config } from "./config.js";
import { eventLog } from "./events.js";
import { GithubClient } from "./github/client.js";
import { jiraAsHuman } from "./jira/client.js";
import { jiraStore } from "./jira-sim/server.js";
import { engine, type JiraWebhook } from "./sync/engine.js";
import { portableLabels } from "./sync/mapping.js";
import { connectorStatus, getConnectorSettings, saveConnectorSettings } from "./settings.js";
import { authStatus, beginOAuth, completeOAuth, ensureSessionCookie, hasValidSession, signOut } from "./oauth.js";

/**
 * Dashboard: the project management view from the requirements, plus the Jira
 * webhook receiver and the controls that drive the demo.
 *
 * Actions from the dashboard deliberately go through the ordinary GitHub and
 * Jira APIs as a human identity. They are never fed to the engine directly, so
 * everything the view shows is the engine reacting to real remote state.
 */

/** Separate client from the engine's: writes made here must not be fingerprinted as our own. */
const ghAsHuman = new GithubClient();

const webRoot = new URL("../web/", import.meta.url).pathname;

export function startDashboard(): void {
  const server = createServer((request, response) => {
    void handle(request, response).catch((error: Error) => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    });
  });
  server.listen(config.ports.dashboard, () => {
    console.log(`[dashboard] http://localhost:${config.ports.dashboard}`);
  });
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", `http://localhost:${config.ports.dashboard}`);
  const method = request.method ?? "GET";

  if (method === "GET" && url.pathname === "/health") {
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end("ok");
    return;
  }

  if (method === "GET" && url.pathname === "/auth/github/start") {
    beginOAuth("github", request, response);
    return;
  }
  if (method === "GET" && url.pathname === "/auth/github/callback") {
    const connected = await completeOAuth("github", request, response);
    if (connected) await engine.start();
    return;
  }
  if (method === "GET" && url.pathname === "/auth/atlassian/start") {
    beginOAuth("atlassian", request, response);
    return;
  }
  if (method === "GET" && url.pathname === "/auth/atlassian/callback") {
    const connected = await completeOAuth("atlassian", request, response);
    if (connected) await engine.start();
    return;
  }
  if (method === "POST" && url.pathname === "/auth/sign-out") {
    if (!requireSession(request, response)) return;
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw.length > 0 ? (JSON.parse(raw) as { provider?: string }) : {};
    if (body.provider === "github" || body.provider === "atlassian") signOut(body.provider);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ auth: authStatus() }));
    return;
  }

  if (method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    ensureSessionCookie(request, response);
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(readFileSync(`${webRoot}${authStatus().githubConnected && authStatus().jiraConnected ? "index.html" : "login.html"}`));
    return;
  }

  if (method === "GET" && url.pathname === "/api/auth/status") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ auth: authStatus() }));
    return;
  }
  if (method === "GET" && url.pathname === "/api/state") {
    if (!requireOAuth(response)) return;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(buildState()));
    return;
  }

  if (method === "GET" && url.pathname === "/api/settings") {
    if (!requireOAuth(response)) return;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      settings: getConnectorSettings(),
      auth: { ...connectorStatus(), ...authStatus() },
    }));
    return;
  }

  if (method === "GET" && url.pathname === "/api/setup/options") {
    if (!requireOAuth(response)) return;
    const [repositories, projects] = await Promise.all([
      ghAsHuman.listRepositories().catch(() => []),
      jiraAsHuman.listProjects().catch(() => []),
    ]);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ repositories, projects }));
    return;
  }

  if (method === "GET" && url.pathname === "/api/events") {
    if (!requireOAuth(response)) return;
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    response.write("retry: 2000\n\n");
    const unsubscribe = eventLog.subscribe((event) => {
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    request.on("close", unsubscribe);
    return;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  const body = raw.length > 0 ? (JSON.parse(raw) as Record<string, any>) : {};

  if (method === "POST" && url.pathname === "/webhooks/jira") {
    if (config.jiraWebhookSecret && url.searchParams.get("token") !== config.jiraWebhookSecret) {
      response.writeHead(403, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Invalid webhook token" }));
      return;
    }
    if (!requireOAuth(response)) return;
    await engine.onJiraWebhook(body as JiraWebhook);
    response.writeHead(204).end();
    return;
  }
  if (method === "POST" && url.pathname === "/api/settings") {
    if (!requireOAuth(response) || !requireSession(request, response)) return;
    const previous = getConnectorSettings();
    const next = saveConnectorSettings(body);
    const resetAssociations =
      previous.githubRepo !== next.githubRepo ||
      previous.jiraBaseUrl !== next.jiraBaseUrl ||
      previous.jiraProjectKey !== next.jiraProjectKey;
    await engine.reconfigure(resetAssociations);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      settings: next,
      auth: { ...connectorStatus(), ...authStatus() },
      resetAssociations,
    }));
    return;
  }

  if (method === "POST" && url.pathname === "/api/pause") {
    if (!requireOAuth(response) || !requireSession(request, response)) return;
    await engine.setPaused(Boolean(body.paused));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(engine.stats));
    return;
  }

  if (method === "POST" && url.pathname === "/api/act") {
    if (!requireOAuth(response) || !requireSession(request, response)) return;
    await act(String(body.action), body);
    response.writeHead(202).end();
    return;
  }

  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: `No handler for ${method} ${url.pathname}` }));
}

function requireOAuth(response: ServerResponse): boolean {
  const auth = authStatus();
  if (auth.githubConnected && auth.jiraConnected) return true;
  response.writeHead(401, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "Authenticate with GitHub and Jira first." }));
  return false;
}

/** Extra bar for state-mutating routes: the caller must have loaded an Ember page at least once. */
function requireSession(request: IncomingMessage, response: ServerResponse): boolean {
  if (hasValidSession(request)) return true;
  response.writeHead(403, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "No active Ember session." }));
  return false;
}

/** Human-initiated edits on either system, issued exactly as an ordinary API client would. */
async function act(action: string, input: Record<string, any>): Promise<void> {
  const number = Number(input.number);
  const key = String(input.key ?? "");

  switch (action) {
    case "gh.create":
      await ghAsHuman.createIssue({ title: String(input.title), body: String(input.body ?? "") });
      return;
    case "gh.retitle":
      await ghAsHuman.updateIssue(number, { title: String(input.title) });
      return;
    case "gh.comment":
      await ghAsHuman.createComment(number, String(input.body));
      return;
    case "gh.progress": {
      const issue = engine.ghCache.get(number);
      const labels = portableLabels(issue?.labels.map((label) => label.name) ?? []);
      const next = input.on ? [...labels, config.github.inProgressLabel] : labels;
      await ghAsHuman.updateIssue(number, { labels: next });
      return;
    }
    case "gh.state":
      await ghAsHuman.updateIssue(number, { state: input.state === "closed" ? "closed" : "open" });
      return;
    case "jira.create":
      await jiraAsHuman.createIssue({
        summary: String(input.summary),
        description: toAdf(String(input.description ?? "")),
        labels: [],
      });
      return;
    case "jira.rename":
      await jiraAsHuman.updateIssue(key, { summary: String(input.summary) });
      return;
    case "jira.transition":
      await jiraAsHuman.transitionTo(key, String(input.status));
      return;
    case "jira.comment":
      await jiraAsHuman.addComment(key, toAdf(String(input.body)));
      return;
    default:
      throw new Error(`Unknown action ${action}`);
  }
}

function buildState() {
  const links = engine.links.links;
  const linkByGithub = new Map(links.map((link) => [link.ghNumber, link]));
  const linkByJira = new Map(links.map((link) => [link.jiraKey.trim().toUpperCase(), link]));
  const jiraIssues = config.jira.simulator ? jiraStore.all() : [...engine.jiraCache.values()];
  const github = [...engine.ghCache.values()]
    .sort((a, b) => a.number - b.number)
    .map((issue) => {
      const link = linkByGithub.get(issue.number);
      return {
        number: issue.number,
        title: issue.title,
        body: issue.body ?? "",
        state: issue.state,
        labels: issue.labels.map((label) => label.name),
        url: issue.html_url,
        jiraKey: link?.jiraKey ?? null,
        branch: link?.branchName ?? null,
        linked: link !== undefined,
      };
    });
  const jira = jiraIssues.map((issue) => {
    const link = linkByJira.get(String(issue.key).trim().toUpperCase());
    return {
      key: issue.key,
      summary: issue.fields.summary,
      description: fromAdf(issue.fields.description),
      status: issue.fields.status.name,
      labels: issue.fields.labels,
      comments: (issue.comments ?? []).map((comment) => ({
        id: comment.id,
        author: comment.author.displayName,
        body: fromAdf(comment.body),
      })),
      ghNumber: link?.ghNumber ?? null,
      branch: link?.branchName ?? null,
      linked: link !== undefined,
    };
  });
  return {
    repo: `${config.github.owner}/${config.github.repo}`,
    repoUrl: `https://github.com/${config.github.owner}/${config.github.repo}`,
    jiraBaseUrl: config.jira.baseUrl,
    projectKey: config.jira.projectKey,
    pollMs: config.githubPollMs,
    stats: engine.stats,
    setup: {
      settings: getConnectorSettings(),
      auth: { ...connectorStatus(), ...authStatus() },
    },
    connections: links.map((link) => ({
      ghNumber: link.ghNumber,
      jiraKey: link.jiraKey,
      branch: link.branchName ?? null,
      origin: link.origin,
      workflow: link.jira.status,
    })),
    github,
    jira,
    events: eventLog.events,
    counts: eventLog.counts(),
  };
}
