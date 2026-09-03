import type { AdfDoc } from "../adf.js";
import { config } from "../config.js";
import type { JiraComment, JiraIssue } from "../jira-sim/store.js";

export type JiraUserProfile = {
  accountId: string;
  displayName: string;
  emailAddress?: string;
  avatarUrls?: { "48x48"?: string };
};

type JiraAuth =
  | { mode: "basic"; email: string; token: string }
  | { mode: "bearer"; token: string };

/**
 * Jira Cloud REST v3 client. It supports the existing API-token Basic auth
 * path and Atlassian OAuth 2.0 bearer tokens. The API base changes to
 * api.atlassian.com/ex/jira/<cloud-id> for OAuth resources.
 */
export class JiraClient {
  private auth: JiraAuth;

  constructor(email: string, token: string = config.jira.syncToken) {
    this.auth = { mode: "basic", email, token };
  }

  setBearerToken(token: string): void {
    this.auth = { mode: "bearer", token };
  }

  setBasicAuth(email: string, token: string): void {
    this.auth = { mode: "basic", email, token };
  }

  private get apiBase(): string {
    return config.jira.apiBaseUrl ?? config.jira.baseUrl;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const authorization = this.auth.mode === "bearer"
      ? `Bearer ${this.auth.token}`
      : `Basic ${Buffer.from(`${this.auth.email}:${this.auth.token}`).toString("base64")}`;
    const headers: Record<string, string> = { authorization, accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await fetch(`${this.apiBase}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      throw new Error(`Jira ${method} ${path} -> ${response.status} ${await response.text()}`);
    }
    return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
  }

  async currentUser(): Promise<JiraUserProfile> {
    return this.request<JiraUserProfile>("GET", "/rest/api/3/myself");
  }

  async search(projectKey: string): Promise<JiraIssue[]> {
    const jql = `project = ${projectKey} ORDER BY created ASC`;
    const fields = "summary,description,status,labels,issuetype,project,reporter,created,updated";
    const result = await this.request<{ issues: JiraIssue[] }>(
      "GET",
      `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&fields=${encodeURIComponent(fields)}`,
    );
    return result.issues;
  }

  async getIssue(key: string): Promise<JiraIssue> {
    const fields = "summary,description,status,labels,issuetype,project,reporter,created,updated";
    return this.request<JiraIssue>("GET", `/rest/api/3/issue/${key}?fields=${encodeURIComponent(fields)}`);
  }

  async listProjects(): Promise<{ key: string; name: string }[]> {
    const result = await this.request<{ values: { key: string; name: string }[] }>(
      "GET",
      "/rest/api/3/project/search?maxResults=100&orderBy=name",
    );
    return result.values;
  }

  async createIssue(
    projectKey: string,
    input: { summary: string; description: AdfDoc; labels: string[] },
  ): Promise<{ key: string }> {
    return this.request<{ key: string }>("POST", "/rest/api/3/issue", {
      fields: {
        project: { key: projectKey },
        issuetype: { name: "Task" },
        summary: input.summary,
        description: input.description,
        labels: input.labels,
      },
    });
  }

  async updateIssue(
    key: string,
    fields: { summary?: string; description?: AdfDoc; labels?: string[] },
  ): Promise<void> {
    await this.request<void>("PUT", `/rest/api/3/issue/${key}`, { fields });
  }

  /** Jira exposes status changes as transitions, so resolve a target first. */
  async transitionTo(key: string, statusName: string): Promise<boolean> {
    const { transitions } = await this.request<{ transitions: { id: string; to: { name: string } }[] }>(
      "GET",
      `/rest/api/3/issue/${key}/transitions`,
    );
    const target = transitions.find((transition) => transition.to.name === statusName);
    if (!target) return false;
    await this.request<void>("POST", `/rest/api/3/issue/${key}/transitions`, { transition: { id: target.id } });
    return true;
  }

  async addComment(key: string, body: AdfDoc): Promise<JiraComment> {
    return this.request<JiraComment>("POST", `/rest/api/3/issue/${key}/comment`, { body });
  }

  async deleteIssue(key: string): Promise<void> {
    await this.request<void>("DELETE", `/rest/api/3/issue/${key}`);
  }

  async listComments(key: string): Promise<JiraComment[]> {
    const result = await this.request<{ comments: JiraComment[] }>("GET", `/rest/api/3/issue/${key}/comment`);
    return result.comments;
  }
}

/** Identity the sync engine writes as. */
export const jiraAsSync = new JiraClient(config.jira.syncEmail);
/** Identity used when the dashboard acts on behalf of a human Jira user. */
export const jiraAsHuman = new JiraClient(config.jira.humanEmail, config.jira.humanToken);
