import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { config } from "./config.js";

/**
 * Encrypted-at-rest storage for provider OAuth tokens, plus the raw refresh
 * calls for both providers.
 *
 * This is what lets Ember stay signed in across process restarts (a Fly
 * machine redeploy, a sleep/wake cycle) without asking the user to click
 * through both OAuth flows every time. Access tokens are short-lived
 * (GitHub ~8h when expiring tokens are enabled, Atlassian ~1h); the refresh
 * token is what makes that invisible to the user.
 */

export type ProviderTokenRecord = {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms. Absent means the provider issued a non-expiring token. */
  expiresAt?: number;
};

export type JiraTokenRecord = ProviderTokenRecord & {
  apiBaseUrl: string;
  baseUrl: string;
  siteId: string;
  siteName: string;
};

export type StoredTokens = {
  github?: ProviderTokenRecord;
  jira?: JiraTokenRecord;
};
type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

const ALGORITHM = "aes-256-gcm";

/**
 * Derives the at-rest encryption key from SESSION_SECRET. Required in
 * production: this file is the only thing standing between an attacker with
 * filesystem access and a live GitHub + Jira session for a real account.
 */
function encryptionKey(): Buffer {
  const secret = process.env.SESSION_SECRET;
  if (secret) return createHash("sha256").update(secret).digest();
  if (process.env.NODE_ENV === "production") {
    throw new Error("SESSION_SECRET is required in production to encrypt stored OAuth tokens.");
  }
  console.warn(
    "[tokens] SESSION_SECRET is not set. Using an insecure development-only key; set SESSION_SECRET before deploying.",
  );
  return createHash("sha256").update("ember-dev-only-insecure-key").digest();
}

function tokenFile(): string {
  return `${config.dataDir}oauth-tokens.enc`;
}

export function loadTokens(): StoredTokens {
  const path = tokenFile();
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path);
    const iv = raw.subarray(0, 12);
    const authTag = raw.subarray(12, 28);
    const ciphertext = raw.subarray(28);
    const decipher = createDecipheriv(ALGORITHM, encryptionKey(), iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString("utf8")) as StoredTokens;
  } catch (error) {
    console.warn("[tokens] Stored tokens could not be read; starting signed out.", (error as Error).message);
    return {};
  }
}

export function saveTokens(tokens: StoredTokens): void {
  mkdirSync(config.dataDir, { recursive: true });
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, encryptionKey(), iv);
  const plaintext = Buffer.from(JSON.stringify(tokens), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  writeFileSync(tokenFile(), Buffer.concat([iv, authTag, ciphertext]));
}

/** Merges one provider's record into whatever is already on disk. */
export function persistToken(provider: "github", record: ProviderTokenRecord): void;
export function persistToken(provider: "jira", record: JiraTokenRecord): void;
export function persistToken(provider: "github" | "jira", record: ProviderTokenRecord | JiraTokenRecord): void {
  const current = loadTokens();
  if (provider === "github") current.github = record as ProviderTokenRecord;
  else current.jira = record as JiraTokenRecord;
  saveTokens(current);
}

export function clearToken(provider: "github" | "jira"): void {
  const current = loadTokens();
  delete current[provider];
  saveTokens(current);
}

export function buildTokenRecord(data: TokenResponse, fallbackRefreshToken?: string): ProviderTokenRecord {
  const refreshToken = data.refresh_token ?? fallbackRefreshToken;
  return {
    accessToken: data.access_token!,
    ...(refreshToken ? { refreshToken } : {}),
    ...(typeof data.expires_in === "number" ? { expiresAt: Date.now() + data.expires_in * 1000 } : {}),
  };
}

export async function refreshGithubToken(refreshToken: string): Promise<ProviderTokenRecord> {
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: config.oauth.githubClientId,
      client_secret: config.oauth.githubClientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  const data = (await response.json()) as TokenResponse;
  if (!response.ok || !data.access_token) {
    throw new Error(`GitHub token refresh failed: ${data.error_description ?? data.error ?? response.status}`);
  }
  return buildTokenRecord(data, refreshToken);
}

/** Atlassian issues rotating refresh tokens: the old one is invalid after this call. */
export async function refreshAtlassianToken(refreshToken: string): Promise<ProviderTokenRecord> {
  const response = await fetch("https://auth.atlassian.com/oauth/token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: config.oauth.atlassianClientId,
      client_secret: config.oauth.atlassianClientSecret,
      refresh_token: refreshToken,
    }),
  });
  const data = (await response.json()) as TokenResponse;
  if (!response.ok || !data.access_token) {
    throw new Error(`Atlassian token refresh failed: ${data.error_description ?? data.error ?? response.status}`);
  }
  return buildTokenRecord(data, refreshToken);
}

/** True when a token is missing an expiry (non-expiring) or still has more than `marginMs` left. */
export function isFresh(record: ProviderTokenRecord | undefined, marginMs: number): boolean {
  if (!record) return false;
  if (record.expiresAt === undefined) return true;
  return record.expiresAt - Date.now() > marginMs;
}
