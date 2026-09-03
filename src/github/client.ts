import { config } from "../config.js";

/**
 * Minimal GitHub REST client for the issue surface the sync engine needs.
 *
 * One client instance is shared across every workspace, since it only wraps
 * the OAuth bearer token (account-level). The repository is a parameter on
 * each call, not baked into the client, so the same instance can poll many
 * repositories concurrently. The ETag cache is keyed accordingly.
 *
 * GitHub does not charge a 304 against the rate limit, so an idle demo
 * across many repos still costs nothing while polling continues.
 */

export type GithubRepoRef = { owner: string; repo: string };

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

function repositoryPath(ref: GithubRepoRef): string {
  return `/repos/${ref.owner}/${ref.repo}`;
}

export class GithubClient {
  private readonly etags = new Map<string, string>();

  /** Clears cached ETags for one repository, used when a workspace's target repo changes. */
  resetCache(ref?: GithubRepoRef): void {
    if (!ref) {
      this.etags.clear();
      return;
    }
    const prefix = `${ref.owner}/${ref.repo}:`;
    for (const key of this.etags.keys()) if (key.startsWith(prefix)) this.etags.delete(key);
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
    // Keyed by repo + endpoint, not by full path: `since` moves forward on every
    // poll, so a path-keyed cache would never produce a hit. GitHub compares the
    // tag against the response the current query would return, so a 304 still
    // means exactly "identical to what you already processed".
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
  async listIssues(ref: GithubRepoRef, options: ListOptions = {}): Promise<GithubIssue[] | typeof NOT_MODIFIED> {
    const path = `${repositoryPath(ref)}/issues?state=all&per_page=100&sort=updated&direction=asc${options.since ? `&since=${encodeURIComponent(options.since)}` : ""}`;
    const issues = await this.request<GithubIssue[] | typeof NOT_MODIFIED>("GET", path, {
      ...(options.conditional ? { etagKey: `${ref.owner}/${ref.repo}:issues` } : {}),
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

  async listComments(ref: GithubRepoRef, options: ListOptions = {}): Promise<GithubComment[] | typeof NOT_MODIFIED> {
    const path = `${repositoryPath(ref)}/issues/comments?per_page=100&sort=updated&direction=asc${options.since ? `&since=${encodeURIComponent(options.since)}` : ""}`;
    return this.request<GithubComment[] | typeof NOT_MODIFIED>("GET", path, {
      ...(options.conditional ? { etagKey: `${ref.owner}/${ref.repo}:comments` } : {}),
    });
  }

  async defaultBranch(ref: GithubRepoRef): Promise<string> {
    const repository = await this.request<{ default_branch: string }>("GET", repositoryPath(ref));
    return repository.default_branch;
  }

  /** Returns null for a missing branch, preserving other GitHub API errors. */
  async branchHead(ref: GithubRepoRef, branch: string): Promise<string | null> {
    const path = `${repositoryPath(ref)}/git/ref/heads/${branch.split("/").map(encodeURIComponent).join("/")}`;
    try {
      const result = await this.request<{ object: { sha: string } }>("GET", path);
      return result.object.sha;
    } catch (error) {
      if ((error as Error).message.includes(" -> 404 ")) return null;
      throw error;
    }
  }

  /** Creates a branch from the repository default branch, or adopts an existing one. */
  async ensureBranch(ref: GithubRepoRef, branch: string): Promise<GithubWorkflowBranch> {
    const existing = await this.branchHead(ref, branch);
    if (existing) return { created: false, sha: existing };
    const base = await this.branchHead(ref, await this.defaultBranch(ref));
    if (!base) throw new Error("Default branch has no resolvable head");
    try {
      await this.request<void>("POST", `${repositoryPath(ref)}/git/refs`, {
        body: {
          ref: `refs/heads/${branch}`,
          sha: base,
        },
      });
      return { created: true, sha: base };
    } catch (error) {
      // A concurrent creator can win between the existence check and POST.
      if ((error as Error).message.includes(" -> 422 ")) {
        const concurrent = await this.branchHead(ref, branch);
        if (concurrent) return { created: false, sha: concurrent };
      }
      throw error;
    }
  }

  async pullRequestsForBranch(ref: GithubRepoRef, branch: string): Promise<GithubPullRequest[]> {
    const head = encodeURIComponent(`${ref.owner}:${branch}`);
    return this.request<GithubPullRequest[]>(
      "GET",
      `${repositoryPath(ref)}/pulls?state=all&head=${head}&per_page=20&sort=updated&direction=desc`,
    );
  }

  async createIssue(ref: GithubRepoRef, input: { title: string; body: string; labels?: string[] }): Promise<GithubIssue> {
    return this.request<GithubIssue>("POST", `${repositoryPath(ref)}/issues`, { body: input });
  }

  async updateIssue(
    ref: GithubRepoRef,
    number: number,
    patch: { title?: string; body?: string; state?: "open" | "closed"; labels?: string[] },
  ): Promise<GithubIssue> {
    return this.request<GithubIssue>("PATCH", `${repositoryPath(ref)}/issues/${number}`, { body: patch });
  }

  async createComment(ref: GithubRepoRef, number: number, body: string): Promise<GithubComment> {
    return this.request<GithubComment>("POST", `${repositoryPath(ref)}/issues/${number}/comments`, { body: { body } });
  }
}

/** Sentinel for a conditional request GitHub answered with 304. */
export const NOT_MODIFIED = Symbol("not-modified");
