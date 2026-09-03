import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { config } from "./config.js";
import { GithubClient } from "./github/client.js";
import { jiraAsHuman, jiraAsSync, type JiraUserProfile } from "./jira/client.js";
import {
  buildTokenRecord,
  clearToken,
  isFresh,
  loadTokens,
  persistToken,
  refreshAtlassianToken,
  refreshGithubToken,
} from "./tokens.js";

export type OAuthProvider = "github" | "atlassian";

type PendingState = {
  provider: OAuthProvider;
  sessionId: string;
  redirectUri: string;
  createdAt: number;
};

type AuthRuntime = {
  githubUser: { login: string; name: string | null; avatarUrl: string } | null;
  jiraUser: JiraUserProfile | null;
  jiraSite: { id: string; name: string; url: string } | null;
};

const states = new Map<string, PendingState>();
const sessions = new Set<string>();
const runtime: AuthRuntime = { githubUser: null, jiraUser: null, jiraSite: null };
const STATE_TTL_MS = 10 * 60 * 1000;
/** Refresh a token once less than this much time remains before it expires. */
const REFRESH_MARGIN_MS = 10 * 60 * 1000;

/** Mints a session cookie on first visit; every later request from that browser reuses it. */
export function ensureSessionCookie(request: IncomingMessage, response: ServerResponse): string {
  const cookieHeader = request.headers.cookie ?? "";
  const existing = cookieHeader.split(";").map((part) => part.trim()).find((part) => part.startsWith("ember_session="));
  const id = existing?.slice("ember_session=".length) || randomBytes(24).toString("hex");
  sessions.add(id);
  if (!existing) response.setHeader("Set-Cookie", `ember_session=${id}; HttpOnly; SameSite=Lax; Path=/`);
  return id;
}

/** True once a browser has loaded an Ember page at least once. Used to gate state-mutating routes. */
export function hasValidSession(request: IncomingMessage): boolean {
  const cookieHeader = request.headers.cookie ?? "";
  const found = cookieHeader.split(";").map((part) => part.trim()).find((part) => part.startsWith("ember_session="));
  const id = found?.slice("ember_session=".length);
  return id !== undefined && sessions.has(id);
}

function callbackUrl(provider: OAuthProvider, request: IncomingMessage): string {
  const configured = config.oauth.baseUrl.replace(/\/$/, "");
  if (configured) return `${configured}/auth/${provider}/callback`;
  const forwarded = request.headers["x-forwarded-proto"];
  const protocol = typeof forwarded === "string" ? forwarded.split(",")[0] : "http";
  const host = request.headers.host ?? `localhost:${config.ports.dashboard}`;
  return `${protocol}://${host}/auth/${provider}/callback`;
}

function providerConfig(provider: OAuthProvider): { clientId: string; clientSecret: string } {
  if (provider === "github") {
    return { clientId: config.oauth.githubClientId, clientSecret: config.oauth.githubClientSecret };
  }
  return { clientId: config.oauth.atlassianClientId, clientSecret: config.oauth.atlassianClientSecret };
}

function requireProviderConfig(provider: OAuthProvider): { clientId: string; clientSecret: string } {
  const credentials = providerConfig(provider);
  if (!credentials.clientId || !credentials.clientSecret) {
    throw new Error(`${provider} OAuth is not configured on the server`);
  }
  return credentials;
}

export function beginOAuth(provider: OAuthProvider, request: IncomingMessage, response: ServerResponse): void {
  clearExpiredOAuthStates();
  const credentials = requireProviderConfig(provider);
  const redirectUri = callbackUrl(provider, request);
  const state = randomBytes(24).toString("hex");
  states.set(state, { provider, sessionId: ensureSessionCookie(request, response), redirectUri, createdAt: Date.now() });

  const params = new URLSearchParams({
    client_id: credentials.clientId,
    redirect_uri: redirectUri,
    state,
    response_type: "code",
  });
  if (provider === "github") {
    params.set("scope", "repo read:user user:email");
    response.writeHead(302, { location: `https://github.com/login/oauth/authorize?${params}` }).end();
    return;
  }

  params.set("audience", "api.atlassian.com");
  params.set("prompt", "consent");
  params.set("scope", "read:jira-user read:jira-work write:jira-work manage:jira-webhook offline_access");
  response.writeHead(302, { location: `https://auth.atlassian.com/authorize?${params}` }).end();
}

export async function completeOAuth(
  provider: OAuthProvider,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<boolean> {
  const url = new URL(request.url ?? "/", `http://localhost:${config.ports.dashboard}`);
  const stateKey = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const pending = stateKey === null ? undefined : states.get(stateKey);
  if (!pending || pending.provider !== provider || pending.createdAt + STATE_TTL_MS < Date.now() || !code) {
    response.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("Invalid or expired OAuth state");
    return false;
  }
  states.delete(stateKey!);
  requireProviderConfig(provider);
  if (provider === "github") await completeGithub(code, pending.redirectUri);
  else await completeAtlassian(code, pending.redirectUri);
  response.writeHead(302, { location: "/?connected=" + provider }).end();
  return true;
}

type ExchangeResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

async function completeGithub(code: string, redirectUri: string): Promise<void> {
  const credentials = requireProviderConfig("github");
  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });
  const token = (await tokenResponse.json()) as ExchangeResponse;
  if (!tokenResponse.ok || !token.access_token) {
    throw new Error(`GitHub OAuth exchange failed: ${token.error_description ?? token.error ?? tokenResponse.status}`);
  }
  config.github.token = token.access_token;
  const user = await new GithubClient().currentUser();
  runtime.githubUser = { login: user.login, name: user.name, avatarUrl: user.avatar_url };
  persistToken("github", buildTokenRecord(token));
}

async function completeAtlassian(code: string, redirectUri: string): Promise<void> {
  const credentials = requireProviderConfig("atlassian");
  const tokenResponse = await fetch("https://auth.atlassian.com/oauth/token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });
  const token = (await tokenResponse.json()) as ExchangeResponse;
  if (!tokenResponse.ok || !token.access_token) {
    throw new Error(`Atlassian OAuth exchange failed: ${token.error_description ?? token.error ?? tokenResponse.status}`);
  }

  const resourcesResponse = await fetch("https://api.atlassian.com/oauth/token/accessible-resources", {
    headers: { authorization: `Bearer ${token.access_token}`, accept: "application/json" },
  });
  const resources = (await resourcesResponse.json()) as { id: string; name: string; url: string; scopes: string[] }[];
  if (!resourcesResponse.ok || resources.length === 0) throw new Error("Atlassian OAuth returned no accessible Jira sites");
  const resource = resources.find((candidate) => candidate.url === config.jira.baseUrl) ?? resources[0]!;

  config.jira.apiBaseUrl = `https://api.atlassian.com/ex/jira/${resource.id}`;
  config.jira.baseUrl = resource.url;
  jiraAsSync.setBearerToken(token.access_token);
  jiraAsHuman.setBearerToken(token.access_token);
  const user = await jiraAsSync.currentUser();
  config.jira.syncAccountId = user.accountId;
  if (user.emailAddress) config.jira.syncEmail = user.emailAddress;
  runtime.jiraUser = user;
  runtime.jiraSite = { id: resource.id, name: resource.name, url: resource.url };
  persistToken("jira", {
    ...buildTokenRecord(token),
    apiBaseUrl: config.jira.apiBaseUrl,
    baseUrl: resource.url,
    siteId: resource.id,
    siteName: resource.name,
  });
}

export function authStatus() {
  return {
    githubConnected: runtime.githubUser !== null,
    jiraConnected: runtime.jiraUser !== null,
    githubUser: runtime.githubUser,
    jiraUser: runtime.jiraUser,
    jiraSite: runtime.jiraSite,
    oauthConfigured: {
      github: Boolean(config.oauth.githubClientId && config.oauth.githubClientSecret),
      atlassian: Boolean(config.oauth.atlassianClientId && config.oauth.atlassianClientSecret),
    },
  };
}

export function signOut(provider: OAuthProvider): void {
  if (provider === "github") {
    config.github.token = "";
    runtime.githubUser = null;
    clearToken("github");
  } else {
    jiraAsSync.setBearerToken("");
    jiraAsHuman.setBearerToken("");
    runtime.jiraUser = null;
    runtime.jiraSite = null;
    clearToken("jira");
  }
}

export function clearExpiredOAuthStates(): void {
  const expiry = Date.now() - STATE_TTL_MS;
  for (const [key, pending] of states) if (pending.createdAt < expiry) states.delete(key);
}

/**
 * Restores both provider sessions from disk on boot. This is what makes a
 * Fly machine restart (redeploy, wake from sleep) resume without asking the
 * user to sign in again, as long as the refresh token is still valid.
 */
export async function hydrateSessionsFromDisk(): Promise<void> {
  const stored = loadTokens();

  if (stored.github) {
    config.github.token = stored.github.accessToken;
    try {
      const user = await new GithubClient().currentUser();
      runtime.githubUser = { login: user.login, name: user.name, avatarUrl: user.avatar_url };
    } catch {
      if (!stored.github.refreshToken) {
        console.warn("[oauth] Stored GitHub session expired and has no refresh token; sign in again.");
      } else {
        try {
          const refreshed = await refreshGithubToken(stored.github.refreshToken);
          config.github.token = refreshed.accessToken;
          const restoredUser = await new GithubClient().currentUser();
          runtime.githubUser = { login: restoredUser.login, name: restoredUser.name, avatarUrl: restoredUser.avatar_url };
          persistToken("github", refreshed);
        } catch (error) {
          console.warn("[oauth] Could not restore GitHub session; sign in again.", (error as Error).message);
        }
      }
    }
  }

  if (stored.jira) {
    config.jira.apiBaseUrl = stored.jira.apiBaseUrl;
    config.jira.baseUrl = stored.jira.baseUrl;
    jiraAsSync.setBearerToken(stored.jira.accessToken);
    jiraAsHuman.setBearerToken(stored.jira.accessToken);
    try {
      const user = await jiraAsSync.currentUser();
      runtime.jiraUser = user;
      runtime.jiraSite = { id: stored.jira.siteId, name: stored.jira.siteName, url: stored.jira.baseUrl };
    } catch {
      if (!stored.jira.refreshToken) {
        console.warn("[oauth] Stored Jira session expired and has no refresh token; sign in again.");
      } else {
        try {
          const refreshed = await refreshAtlassianToken(stored.jira.refreshToken);
          jiraAsSync.setBearerToken(refreshed.accessToken);
          jiraAsHuman.setBearerToken(refreshed.accessToken);
          const user = await jiraAsSync.currentUser();
          runtime.jiraUser = user;
          runtime.jiraSite = { id: stored.jira.siteId, name: stored.jira.siteName, url: stored.jira.baseUrl };
          persistToken("jira", { ...stored.jira, ...refreshed });
        } catch (error) {
          console.warn("[oauth] Could not restore Jira session; sign in again.", (error as Error).message);
        }
      }
    }
  }
}

/** Proactively refreshes tokens nearing expiry so a live session never has to 401 mid-poll. */
export function startTokenMaintenance(): void {
  setInterval(() => {
    void maintainTokens();
  }, 4 * 60 * 1000);
}

async function maintainTokens(): Promise<void> {
  const stored = loadTokens();

  if (stored.github?.refreshToken && !isFresh(stored.github, REFRESH_MARGIN_MS)) {
    try {
      const refreshed = await refreshGithubToken(stored.github.refreshToken);
      config.github.token = refreshed.accessToken;
      persistToken("github", refreshed);
    } catch (error) {
      console.warn("[oauth] GitHub token refresh failed; the session will need a fresh sign-in.", (error as Error).message);
    }
  }

  if (stored.jira?.refreshToken && !isFresh(stored.jira, REFRESH_MARGIN_MS)) {
    try {
      const refreshed = await refreshAtlassianToken(stored.jira.refreshToken);
      jiraAsSync.setBearerToken(refreshed.accessToken);
      jiraAsHuman.setBearerToken(refreshed.accessToken);
      persistToken("jira", { ...stored.jira, ...refreshed });
    } catch (error) {
      console.warn("[oauth] Jira token refresh failed; the session will need a fresh sign-in.", (error as Error).message);
    }
  }
}
