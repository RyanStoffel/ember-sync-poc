/**
 * Append-only log of every decision the sync engine makes, plus a fan-out to
 * dashboard subscribers over SSE. The log is the demo: it shows not just the
 * writes that happened but the echoes that were deliberately dropped.
 */

export type Direction = "gh->jira" | "jira->gh" | "system";

/** Why an inbound change did or did not produce an outbound write. */
export type Disposition = "applied" | "created" | "echo-suppressed" | "no-op" | "error";

export type SyncEvent = {
  seq: number;
  ts: string;
  direction: Direction;
  disposition: Disposition;
  /** Short human label, e.g. "GH#3 title" */
  entity: string;
  summary: string;
  detail?: string;
};

const MAX_EVENTS = 400;

export class EventLog {
  private seq = 0;
  readonly events: SyncEvent[] = [];
  private readonly subscribers = new Set<(event: SyncEvent) => void>();

  emit(event: Omit<SyncEvent, "seq" | "ts">): SyncEvent {
    const full: SyncEvent = { ...event, seq: ++this.seq, ts: new Date().toISOString() };
    this.events.push(full);
    if (this.events.length > MAX_EVENTS) this.events.shift();
    for (const subscriber of this.subscribers) subscriber(full);
    const tag = `${full.direction} ${full.disposition}`;
    console.log(`[${tag}] ${full.entity} ${full.summary}${full.detail ? ` (${full.detail})` : ""}`);
    return full;
  }

  counts(): Record<Disposition, number> {
    const counts: Record<Disposition, number> = {
      applied: 0,
      created: 0,
      "echo-suppressed": 0,
      "no-op": 0,
      error: 0,
    };
    for (const event of this.events) counts[event.disposition]++;
    return counts;
  }

  subscribe(fn: (event: SyncEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }
}

/** Global log for account-level events (OAuth, boot) that predate any workspace. */
export const eventLog = new EventLog();
