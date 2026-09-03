import { readFileSync, writeFileSync } from "node:fs";
import { config } from "./config.js";

export type BoardColumns = {
  todo: string;
  inProgress: string;
  inReview: string;
  done: string;
};

export type ConnectorSettings = {
  workspaceName: string;
  githubRepo: string;
  jiraBaseUrl: string;
  jiraProjectKey: string;
  columns: BoardColumns;
};

const defaults: ConnectorSettings = {
  workspaceName: "Ember project",
  githubRepo: `${config.github.owner}/${config.github.repo}`,
  jiraBaseUrl: config.jira.baseUrl,
  jiraProjectKey: config.jira.projectKey,
  columns: {
    todo: "To Do",
    inProgress: "In Progress",
    inReview: "In Review",
    done: "Done",
  },
};

const settingsFile = `${config.dataDir}settings.json`;
let current = loadSettings();
applyRuntimeSettings(current);

function loadSettings(): ConnectorSettings {
  try {
    const stored = JSON.parse(readFileSync(settingsFile, "utf8")) as Partial<ConnectorSettings>;
    return {
      ...defaults,
      ...stored,
      columns: { ...defaults.columns, ...(stored.columns ?? {}) },
    };
  } catch {
    return defaults;
  }
}

function applyRuntimeSettings(settings: ConnectorSettings): void {
  const [owner, repo] = settings.githubRepo.split("/");
  if (!owner || !repo || settings.githubRepo.split("/").length !== 2) {
    throw new Error("GitHub repository must look like owner/repo");
  }
  config.github.owner = owner;
  config.github.repo = repo;
  config.jira.baseUrl = settings.jiraBaseUrl.replace(/\/$/, "");
  config.jira.projectKey = settings.jiraProjectKey.toUpperCase();
}

export function getConnectorSettings(): ConnectorSettings {
  return {
    ...current,
    columns: { ...current.columns },
  };
}

export function saveConnectorSettings(input: unknown): ConnectorSettings {
  const inputRecord =
    typeof input === "object" && input !== null ? input as Record<string, unknown> : {};
  const inputColumns =
    typeof inputRecord.columns === "object" && inputRecord.columns !== null
      ? inputRecord.columns as Record<string, unknown>
      : {};
  const next: ConnectorSettings = {
    workspaceName:
      typeof inputRecord.workspaceName === "string" ? inputRecord.workspaceName : current.workspaceName,
    githubRepo: typeof inputRecord.githubRepo === "string" ? inputRecord.githubRepo : current.githubRepo,
    jiraBaseUrl: typeof inputRecord.jiraBaseUrl === "string" ? inputRecord.jiraBaseUrl : current.jiraBaseUrl,
    jiraProjectKey:
      typeof inputRecord.jiraProjectKey === "string" ? inputRecord.jiraProjectKey : current.jiraProjectKey,
    columns: {
      todo: typeof inputColumns.todo === "string" ? inputColumns.todo : current.columns.todo,
      inProgress:
        typeof inputColumns.inProgress === "string" ? inputColumns.inProgress : current.columns.inProgress,
      inReview: typeof inputColumns.inReview === "string" ? inputColumns.inReview : current.columns.inReview,
      done: typeof inputColumns.done === "string" ? inputColumns.done : current.columns.done,
    },
  };
  applyRuntimeSettings(next);
  current = next;
  writeFileSync(settingsFile, JSON.stringify(current, null, 2));
  return getConnectorSettings();
}

export function connectorStatus() {
  return {
    githubConnected: config.github.token.length > 0,
    jiraConnected: config.jira.simulator || config.jira.syncToken !== "poc-token",
    jiraMode: config.jira.simulator ? "simulator" : "cloud",
  } as const;
}
