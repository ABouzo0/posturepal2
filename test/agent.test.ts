import assert from "node:assert/strict";
import test from "node:test";
import { parseAgentCommand } from "../src/agent.js";

test("parses two-way Photon commands", () => {
  assert.deepEqual(parseAgentCommand("snooze 20"), { type: "snooze", minutes: 20 });
  assert.deepEqual(parseAgentCommand("SNOOZE"), { type: "snooze", minutes: 30 });
  assert.deepEqual(parseAgentCommand("stats"), { type: "stats" });
  assert.deepEqual(parseAgentCommand("why?"), { type: "why" });
  assert.deepEqual(parseAgentCommand("stop"), { type: "stop" });
});

test("bounds snooze time and preserves free text", () => {
  assert.deepEqual(parseAgentCommand("snooze 999"), { type: "snooze", minutes: 240 });
  assert.deepEqual(parseAgentCommand("How should I set my monitor?"), {
    type: "free-text",
    text: "How should I set my monitor?",
  });
});
