import assert from "node:assert/strict";
import { test } from "node:test";
import { fromAdf, toAdf } from "../src/adf.js";
import { EchoGuard } from "../src/sync/echo.js";
import { githubStateFor, jiraStatusFor, portableLabels } from "../src/sync/mapping.js";
import { branchNameFor } from "../src/sync/engine.js";
import type { JiraStatusName } from "../src/jira-sim/store.js";

const STATUSES: JiraStatusName[] = ["To Do", "In Progress", "In Review", "Done"];

/**
 * The state mapping is the one place the two systems genuinely disagree: Jira
 * has four workflow statuses while GitHub has two issue states. If the round
 * trip is not lossless, an In Progress or In Review ticket collapses to To Do
 * the next time GitHub is polled.
 */
test("every Jira status survives a round trip through GitHub state", () => {
  for (const status of STATUSES) {
    const gh = githubStateFor(status, ["ingestion"]);
    const back = jiraStatusFor({ title: "t", body: "b", state: gh.state, labels: gh.labels });
    assert.equal(back, status, `${status} did not round trip`);
  }
});

/** A status change adds or removes the control label; that must not read as a label edit. */
test("the control label is invisible to label comparison", () => {
  const todo = githubStateFor("To Do", ["ingestion"]);
  const inProgress = githubStateFor("In Progress", ["ingestion"]);
  assert.notDeepEqual(todo.labels, inProgress.labels);
  assert.deepEqual(portableLabels(todo.labels), portableLabels(inProgress.labels));
});

test("Jira tickets get stable developer-friendly branch names", () => {
  assert.equal(branchNameFor("ESP-123", "Add login / callback support!"), "feature/ESP-123-add-login-callback-support");
  assert.equal(branchNameFor("ESP-124", "!!!"), "feature/ESP-124-work");
});

/**
 * Covers the window the link snapshot cannot: a GitHub poll already in flight
 * when the engine's own write lands will diff against the pre-write snapshot.
 * The fingerprint must absorb that observation exactly once, so a later
 * genuine edit back to the same value still propagates.
 */
test("an echo fingerprint is consumed once and only by its own value", () => {
  const guard = new EchoGuard();
  guard.mark(7, "title", "Renamed by Jira");

  assert.equal(guard.consume(7, "title", "Renamed by a human"), false, "wrong value must not match");
  assert.equal(guard.consume(8, "title", "Renamed by Jira"), false, "wrong issue must not match");
  assert.equal(guard.consume(7, "body", "Renamed by Jira"), false, "wrong field must not match");

  assert.equal(guard.consume(7, "title", "Renamed by Jira"), true, "our own write is absorbed");
  assert.equal(guard.consume(7, "title", "Renamed by Jira"), false, "a second edit is a real change");
  assert.equal(guard.size, 0);
});

/** Descriptions cross the boundary as ADF and must come back as the same text. */
test("multi-paragraph text round trips through ADF", () => {
  const text = "First line\nsecond line of the same paragraph\n\nA separate paragraph.";
  assert.equal(fromAdf(toAdf(text)), text);
});
