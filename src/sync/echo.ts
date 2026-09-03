import { config } from "../config.js";

/**
 * Content fingerprints for writes the engine itself made to GitHub.
 *
 * Loop prevention on the Jira side is exact: webhooks name the authenticated
 * principal, so the engine recognises its own writes by identity. GitHub is
 * polled, and a poll response says only that a field changed, never who
 * changed it.
 *
 * The first line of defence there is the link snapshot, which is refreshed
 * from the PATCH response, so a later poll usually sees no diff at all. This
 * guard covers the window that snapshot cannot: a poll already in flight when
 * the write lands diffs against the pre-write snapshot and would otherwise
 * push the engine's own change straight back to Jira.
 *
 * Entries expire so that a genuine human edit which happens to restore an
 * earlier value is still propagated.
 */
export class EchoGuard {
  private readonly pending = new Map<string, number>();

  private static key(issue: number, field: string, value: string): string {
    return `${issue}|${field}|${value}`;
  }

  /** Records that the engine is about to write `value` to `field` on GitHub issue `issue`. */
  mark(issue: number, field: string, value: string): void {
    this.pending.set(EchoGuard.key(issue, field, value), Date.now() + config.echoTtlMs);
  }

  /** Consumes a fingerprint. True means this observation is our own write coming back. */
  consume(issue: number, field: string, value: string): boolean {
    const now = Date.now();
    for (const [key, expiry] of this.pending) {
      if (expiry <= now) this.pending.delete(key);
    }
    const key = EchoGuard.key(issue, field, value);
    const expiry = this.pending.get(key);
    if (expiry === undefined) return false;
    this.pending.delete(key);
    return true;
  }

  get size(): number {
    return this.pending.size;
  }
}
