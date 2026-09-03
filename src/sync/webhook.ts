import { config, jiraWebhookUrl } from "../config.js";
import { jiraAsSync } from "../jira/client.js";
import { type WorkspaceRecord, workspaceStore } from "../workspaces.js";

/**
 * Jira Cloud has two unrelated webhook systems: the classic one configured
 * by a human in Jira Settings -> System -> Webhooks, and dynamic webhooks
 * registered by an OAuth app directly against the REST API. This uses the
 * second one, so a workspace starts delivering live Jira events the moment
 * its project is connected, with no manual Jira-side setup step.
 *
 * Dynamic webhooks expire after 30 days and must be refreshed, and Jira may
 * also drop one outright (repeated delivery failures, revoked consent), so
 * this always reconciles against what Jira actually has registered rather
 * than trusting the locally stored id blindly. Only meaningful against real
 * Jira Cloud; the local stand-in has no dynamic webhook endpoint to call.
 */
const EVENTS = ["jira:issue_created", "jira:issue_updated", "comment_created"];

/** Ensures this workspace has a live, non-expiring dynamic webhook scoped to its Jira project. */
export async function ensureWebhook(record: WorkspaceRecord): Promise<void> {
  if (config.jira.simulator) return;
  const registered = await jiraAsSync.listWebhooks();
  const mine = record.jiraWebhookId !== undefined ? registered.find((hook) => hook.id === record.jiraWebhookId) : undefined;
  if (mine) {
    await jiraAsSync.extendWebhookLife([mine.id]);
    return;
  }
  const id = await jiraAsSync.registerWebhook(jiraWebhookUrl, `project = ${record.jiraProjectKey}`, EVENTS);
  workspaceStore.setWebhookId(record.id, id);
}

/** Deletes the workspace's dynamic webhook, if one is registered. Used on retarget and removal. */
export async function removeWebhook(record: WorkspaceRecord): Promise<void> {
  if (config.jira.simulator || record.jiraWebhookId === undefined) return;
  await jiraAsSync.deleteWebhooks([record.jiraWebhookId]).catch(() => {
    // Already gone (expired, or Jira dropped it); nothing to clean up.
  });
}

/** Re-checks and extends every workspace's webhook. Called at boot and on a recurring timer. */
export async function refreshAllWebhooks(): Promise<void> {
  for (const record of workspaceStore.list()) {
    try {
      await ensureWebhook(record);
    } catch (error) {
      console.error(
        `[ember] could not maintain the Jira webhook for "${record.name}": ${(error as Error).message}. ` +
          `If this persists, confirm the Atlassian OAuth app has the manage:jira-webhook scope and reconnect Jira.`,
      );
    }
  }
}

/** Once a day is generous against a 30-day expiration; frequent enough to notice and self-heal a dropped webhook quickly. */
export function startWebhookMaintenance(): void {
  if (config.jira.simulator) return;
  setInterval(() => void refreshAllWebhooks(), 24 * 60 * 60 * 1000);
}
