import { config } from "./config.js";
import { hydrateSessionsFromDisk, startTokenMaintenance } from "./oauth.js";
import { startJiraSim } from "./jira-sim/server.js";
import { startDashboard } from "./server.js";
import { engine } from "./sync/engine.js";

/**
 * Boot order matters: the dashboard owns the Jira webhook endpoint and must be
 * listening before the stand-in starts delivering events, and both HTTP
 * surfaces must be up before the engine performs its first reconcile.
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
  `[ember] syncing github.com/${config.github.owner}/${config.github.repo} <-> ${config.jira.projectKey} on ${config.jira.baseUrl}${config.jira.simulator ? " (local Jira stand-in)" : " (Jira Cloud)"}`,
);

await engine.start();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    engine.stop();
    process.exit(0);
  });
}
