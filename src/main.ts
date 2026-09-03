import { config } from "./config.js";
import { hydrateSessionsFromDisk, startTokenMaintenance } from "./oauth.js";
import { startJiraSim } from "./jira-sim/server.js";
import { startDashboard } from "./server.js";
import { workspaceManager } from "./sync/manager.js";

/**
 * Boot order matters: the dashboard owns the Jira webhook endpoint and must
 * be listening before the stand-in starts delivering events, and both HTTP
 * surfaces must be up before any workspace's engine performs its first
 * reconcile. Every workspace configured on disk gets its own poll loop.
 */
await hydrateSessionsFromDisk();
startTokenMaintenance();
startDashboard();
if (config.jira.simulator) startJiraSim();
if (!config.jira.simulator && !config.jiraWebhookSecret) {
  console.warn(
    "[ember] JIRA_WEBHOOK_SECRET is not set. /webhooks/jira accepts unsigned POSTs from anyone who finds the URL. Set it and include ?token=<secret> in the Jira webhook URL.",
  );
}

console.log(
  `[ember] ${workspaceManager.list().length} workspace(s) configured on ${config.jira.baseUrl}${config.jira.simulator ? " (local Jira stand-in)" : " (Jira Cloud)"}`,
);

await workspaceManager.startAll();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    for (const workspace of workspaceManager.list()) workspaceManager.engineFor(workspace.id)?.stop();
    process.exit(0);
  });
}
