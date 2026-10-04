import assert from "node:assert/strict";
import test from "node:test";
import { canSendAlert, goodPercent, normalizePhone, normalizeSlouchSeconds } from "../src/core.js";

test("normalizes configurable slouch timing", () => {
  assert.equal(normalizeSlouchSeconds("45"), 45);
  assert.equal(normalizeSlouchSeconds(1), 5);
  assert.equal(normalizeSlouchSeconds(999), 300);
  assert.equal(normalizeSlouchSeconds("nope", 20), 20);
});

test("normalizes North American and international phone numbers", () => {
  assert.equal(normalizePhone("(415) 555-0137"), "+14155550137");
  assert.equal(normalizePhone("+44 20 7946 0958"), "+442079460958");
  assert.equal(normalizePhone("123"), null);
});

test("requires a sustained slouch before allowing an alert", () => {
  const base = {
    active: true,
    activated: true,
    optedOut: false,
    slouchSeconds: 30,
    sustainedSeconds: 29,
    now: 100_000,
    snoozedUntil: 0,
    lastAlertAt: 0,
    cooldownMs: 60_000,
  };
  assert.deepEqual(canSendAlert(base), { allowed: false, reason: "not-sustained" });
  assert.deepEqual(canSendAlert({ ...base, sustainedSeconds: 30 }), { allowed: true });
  assert.deepEqual(canSendAlert({ ...base, sustainedSeconds: 30, snoozedUntil: 200_000 }), { allowed: false, reason: "snoozed" });
  assert.deepEqual(canSendAlert({ ...base, sustainedSeconds: 30, lastAlertAt: 90_000 }), { allowed: false, reason: "cooldown" });
});

test("computes upright percentage", () => {
  assert.equal(goodPercent({ goodSeconds: 75, badSeconds: 25, awaySeconds: 10, alerts: 0, issueCounts: {} }), 75);
});
