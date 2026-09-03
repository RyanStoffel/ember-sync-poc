import { resolve } from "node:path";


const [owner = "", repo = ""] = (process.env.GITHUB_REPO ?? "RyanStoffel/ember-sync-poc").split("/");
if (!owner || !repo) throw new Error("GITHUB_REPO must look like owner/repo");

export const config = {
  github: {
    token: "",
    owner,
    repo,
    /** Label that encodes Jira's "In Progress" status. */
    inProgressLabel: "in-progress",
    /** Label that encodes Jira's "In Review" status. */
    inReviewLabel: "in-review",
  },
  jira: {
    /** Use the local REST v3 stand-in unless explicitly switching to Jira Cloud. */
    simulator: process.env.JIRA_USE_SIMULATOR !== "false",
    /** Point this at https://<site>.atlassian.net to run against real Jira Cloud. */
    baseUrl: process.env.JIRA_BASE_URL ?? "http://127.0.0.1:4001",
    apiBaseUrl: process.env.JIRA_API_BASE_URL,
    projectKey: process.env.JIRA_PROJECT_KEY ?? "EMB",
    /** Service account the sync engine authenticates as. */
    syncEmail: process.env.JIRA_SYNC_EMAIL ?? "sync@ember.dev",
    syncAccountId: process.env.JIRA_SYNC_ACCOUNT_ID ?? "ember-sync",
    syncToken: "",
    /** Optional separate credential for dashboard-triggered Jira actions. */
    humanEmail: process.env.JIRA_HUMAN_EMAIL ?? process.env.JIRA_SYNC_EMAIL ?? "ryan@ember.dev",
    humanToken: "",
  },
  ports: {
    dashboard: Number(process.env.DASHBOARD_PORT ?? 4000),
    jiraSim: Number(process.env.JIRA_SIM_PORT ?? 4001),
  },
  /** GitHub has no local webhook path without a public tunnel, so that side is polled. */
  githubPollMs: Number(process.env.GITHUB_POLL_MS ?? 5000),
  dataDir: process.env.EMBER_DATA_DIR
    ? `${resolve(process.env.EMBER_DATA_DIR)}/`
    : new URL("../data/", import.meta.url).pathname,
  oauth: {
    baseUrl: process.env.OAUTH_BASE_URL ?? "",
    githubClientId: process.env.GITHUB_OAUTH_CLIENT_ID ?? "",
    githubClientSecret: process.env.GITHUB_OAUTH_CLIENT_SECRET ?? "",
    atlassianClientId: process.env.ATLASSIAN_OAUTH_CLIENT_ID ?? "",
    atlassianClientSecret: process.env.ATLASSIAN_OAUTH_CLIENT_SECRET ?? "",
  },
  /** Shared secret Jira's classic webhook UI includes as a query param, since it does not sign requests. */
  jiraWebhookSecret: process.env.JIRA_WEBHOOK_SECRET ?? "",
  /** How long an outbound write suppresses the matching inbound echo. */
  echoTtlMs: 20_000,
};

export const jiraWebhookUrl =
  process.env.JIRA_WEBHOOK_URL ??
  `http://127.0.0.1:${config.ports.dashboard}/webhooks/jira${config.jiraWebhookSecret ? `?token=${config.jiraWebhookSecret}` : ""}`;
