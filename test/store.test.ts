import assert from "node:assert/strict";
import test from "node:test";
import { emptyStats } from "../src/core.js";
import { MemoryStore, type User } from "../src/store.js";

const user: User = {
  id: "user-1",
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@example.com",
  phone: "+14155550111",
  photonUserId: null,
  optedOut: false,
  activated: true,
  createdAt: "2026-10-04T00:00:00.000Z",
};

test("memory fallback persists all hackathon entities", async () => {
  const store = new MemoryStore();
  await store.init();
  await store.createUser(user);
  assert.equal((await store.findUserByPhone(user.phone))?.id, user.id);

  const settings = await store.getSettings(user.id);
  await store.saveSettings({ ...settings, voiceId: "voice-test", slouchSeconds: 20 });
  assert.equal((await store.getSettings(user.id)).slouchSeconds, 20);

  await store.recordSlouchEvent({
    id: "event-1",
    userId: user.id,
    sessionId: "session-1",
    issue: "slouching",
    sustainedSeconds: 20,
    nudgeText: "Sit tall.",
    deliveryStatus: "sent",
    createdAt: "2026-10-04T00:10:00.000Z",
  });
  const stats = { ...emptyStats(), goodSeconds: 80, badSeconds: 20, alerts: 1 };
  await store.saveSession({
    id: "session-1",
    userId: user.id,
    start: "2026-10-04T00:00:00.000Z",
    end: "2026-10-04T00:10:00.000Z",
    minutes: 10,
    goodPct: 80,
    alerts: 1,
    topIssue: "slouching",
    stats,
    recap: "Good work.",
  });
  await store.appendConversation({
    id: "message-1",
    userId: user.id,
    role: "user",
    content: "why",
    createdAt: "2026-10-04T00:11:00.000Z",
  });

  assert.equal((await store.latestSlouchEvent(user.id))?.issue, "slouching");
  assert.equal((await store.conversation(user.id))[0]?.content, "why");
  assert.deepEqual(await store.demoStats(user.id), {
    sessions: 1,
    totalMinutes: 10,
    uprightPct: 80,
    alerts: 1,
    slouchEvents: 1,
    currentStreakDays: 0,
    topIssue: "slouching",
    lastSessionAt: "2026-10-04T00:10:00.000Z",
  });
});
