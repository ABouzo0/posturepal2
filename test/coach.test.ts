import assert from "node:assert/strict";
import test from "node:test";
import {
  exerciseFallback,
  finalizeCoachReply,
  isGreeting,
  isThanks,
  mentionsCommandMenu,
} from "../src/coach.js";

test("detects command-menu spam in coach replies", () => {
  assert.equal(mentionsCommandMenu("Try stats, why, snooze, or stop anytime."), true);
  assert.equal(mentionsCommandMenu("Hey! What's up?"), false);
});

test("finalizeCoachReply strips menus and caps length", () => {
  const long = `${"A".repeat(400)}`;
  assert.ok(finalizeCoachReply(long).length <= 320);
  assert.match(finalizeCoachReply("Try stats and snooze for help."), /I'm here/);
  assert.equal(finalizeCoachReply("Controls: stats · stop", { allowCommands: true }), "Controls: stats · stop");
});

test("short social and exercise fallbacks stay iMessage-sized", () => {
  assert.equal(isGreeting("hey"), true);
  assert.equal(isThanks("thanks!"), true);
  const exercise = exerciseFallback({
    stats: {
      sessions: 2,
      totalMinutes: 40,
      uprightPct: 71,
      alerts: 3,
      slouchEvents: 5,
      currentStreakDays: 1,
      topIssue: "slouching",
      lastSessionAt: null,
    },
    lastIssue: null,
  });
  assert.ok(exercise.length <= 320);
  assert.ok(exercise.includes("•"));
});
