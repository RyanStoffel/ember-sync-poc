import { config } from "../config.js";

/**
 * Minimal GitHub REST client for the issue surface the sync engine needs.
 *
 * Polled endpoints are sent with an `If-None-Match` ETag. GitHub does not
 * charge a 304 against the rate limit, so an idle demo costs nothing while
 * still polling every few seconds.
 */

export type GithubIssue = {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  labels: { name: string }[];
  user: { login: string };
  updated_at: string;
  html_url: string;
  /** Present only on pull requests, which share the issues endpoint. */
  pull_request?: unknown;
};

export type GithubPullRequest = {
  number: number;
  title: string;
  state: "open" | "closed";
  merged_at: string | null;
  closed_at: string | null;
  updated_at: string;
  html_url: string;
  head: { ref: string; sha: string };
};

export type GithubWorkflowBranch = { created: boolean; sha: string };

export type GithubComment = {
  id: number;
  body: string;
  user: { login: string };
  created_at: string;
  updated_at: string;
  html_url: string;
  /** e.g. https://api.github.com/repos/o/r/issues/3 */
  issue_url: string;
};

/** Options shared by the two polled list endpoints. */
export type ListOptions = {
  /**
   * Lower bound on `updated_at`. Omit for a full sweep: GitHub answers `since`
   * values at or near the Unix epoch with an empty array rather than
   * everything, so an epoch sentinel silently hides every issue.
   */
  since?: string;
  /** Send the cached ETag. GitHub does not charge a 304 against the rate limit. */
  conditional?: boolean;
};

const API = "https://api.github.com";

export class GithubClient {
  private readonly etags = new Map<string, string>();
  private get repositoryPath(): string {
    return `/repos/${config.github.owner}/${config.github.repo}`;
  }

  resetCache(): void {
    this.etags.clear();
  }

  private async request<T>(
    method: string,
    path: string,
    options: { body?: unknown; conditional?: boolean; etagKey?: string } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${config.github.token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "ember-sync-poc",
    };
    if (options.body !== undefined) headers["content-type"] = "application/json";
    // Keyed by endpoint, not by full path: `since` moves forward on every poll,
    // so a path-keyed cache would never produce a hit. GitHub compares the tag
    // against the response the current query would return, so a 304 still means
    // exactly "identical to what you already processed".
    const etagKey = options.etagKey;
    const cached = etagKey === undefined ? undefined : this.etags.get(etagKey);
    if (cached) headers["if-none-match"] = cached;

    const response = await fetch(`${API}${path}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });

    if (response.status === 304) return NOT_MODIFIED as T;
    if (!response.ok) {
      throw new Error(`GitHub ${method} ${path} -> ${response.status} ${await response.text()}`);
    }
    if (etagKey !== undefined) {
      const etag = response.headers.get("etag");
      if (etag) this.etags.set(etagKey, etag);
    }
    return (await response.json()) as T;
  }

  /** Issues ordered oldest update first. Pull requests share this endpoint and are filtered out. */
  async listIssues(options: ListOptions = {}): Promise<GithubIssue[] | typeof NOT_MODIFIED> {
    const path = `${this.repositoryPath}/issues?state=all&per_page=100&sort=updated&direction=asc${options.since ? `&since=${encodeURIComponent(options.since)}` : ""}`;
    const issues = await this.request<GithubIssue[] | typeof NOT_MODIFIED>("GET", path, {
      ...(options.conditional ? { etagKey: "issues" } : {}),
    });
    if (issues === NOT_MODIFIED) return NOT_MODIFIED;
    return issues.filter((issue) => issue.pull_request === undefined);
  }

  async listRepositories(): Promise<{ full_name: string; private: boolean }[]> {
    return this.request<{ full_name: string; private: boolean }[]>(
      "GET",
      "/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member",
    );
  }
  async currentUser(): Promise<{ login: string; name: string | null; email: string | null; avatar_url: string }> {
    return this.request<{ login: string; name: string | null; email: string | null; avatar_url: string }>(
      "GET",
      "/user",
    );
  }


  async listComments(options: ListOptions = {}): Promise<GithubComment[] | typeof NOT_MODIFIED> {
    const path = `${this.repositoryPath}/issues/comments?per_page=100&sort=updated&direction=asc${options.since ? `&since=${encodeURIComponent(options.since)}` : ""}`;
    return this.request<GithubComment[] | typeof NOT_MODIFIED>("GET", path, {
      ...(options.conditional ? { etagKey: "comments" } : {}),
    });
  }

  async defaultBranch(): Promise<string> {
    const repository = await this.request<{ default_branch: string }>("GET", this.repositoryPath);
    return repository.default_branch;
  }

  /** Returns null for a missing branch, preserving other GitHub API errors. */
  async branchHead(branch: string): Promise<string | null> {
    const path = `${this.repositoryPath}/git/ref/heads/${branch.split("/").map(encodeURIComponent).join("/")}`;
    try {
      const ref = await this.request<{ object: { sha: string } }>("GET", path);
      return ref.object.sha;
    } catch (error) {
      if ((error as Error).message.includes(" -> 404 ")) return null;
      throw error;
    }
  }

  /** Creates a branch from the repository default branch, or adopts an existing one. */
  async ensureBranch(branch: string): Promise<GithubWorkflowBranch> {
    const existing = await this.branchHead(branch);
    if (existing) return { created: false, sha: existing };
    const base = await this.branchHead(await this.defaultBranch());
    if (!base) throw new Error("Default branch has no resolvable head");
    try {
      await this.request<void>("POST", `${this.repositoryPath}/git/refs`, {
        body: {
          ref: `refs/heads/${branch}`,
          sha: base,
        },
      });
      return { created: true, sha: base };
    } catch (error) {
      // A concurrent creator can win between the existence check and POST.
      if ((error as Error).message.includes(" -> 422 ")) {
        const concurrent = await this.branchHead(branch);
        if (concurrent) return { created: false, sha: concurrent };
      }
      throw error;
    }
  }

  async pullRequestsForBranch(branch: string): Promise<GithubPullRequest[]> {
    const head = encodeURIComponent(`${config.github.owner}:${branch}`);
    return this.request<GithubPullRequest[]>(
      "GET",
      `${this.repositoryPath}/pulls?state=all&head=${head}&per_page=20&sort=updated&direction=desc`,
    );
  }

  async createIssue(input: { title: string; body: string; labels?: string[] }): Promise<GithubIssue> {
    return this.request<GithubIssue>("POST", `${this.repositoryPath}/issues`, { body: input });
  }

  async updateIssue(
    number: number,
    patch: { title?: string; body?: string; state?: "open" | "closed"; labels?: string[] },
  ): Promise<GithubIssue> {
    return this.request<GithubIssue>("PATCH", `${this.repositoryPath}/issues/${number}`, { body: patch });
  }

  async createComment(number: number, body: string): Promise<GithubComment> {
    return this.request<GithubComment>("POST", `${this.repositoryPath}/issues/${number}/comments`, { body: { body } });
  }
}

/** Sentinel for a conditional request GitHub answered with 304. */
export const NOT_MODIFIED = Symbol("not-modified");
