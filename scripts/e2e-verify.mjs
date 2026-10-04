import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const BASE = "http://127.0.0.1:43131";

function loadEnv(path) {
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq);
    let value = trimmed.slice(eq + 1);
    if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadEnv(join(process.cwd(), ".env"));

async function tableCounts() {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const tables = ["users", "user_settings", "sessions", "slouch_events", "conversation_messages"];
  const counts = {};
  for (const table of tables) {
    const result = await pool.query(`SELECT COUNT(*)::int AS c FROM ${table}`);
    counts[table] = result.rows[0].c;
  }
  const user = await pool.query(
    "SELECT id, first_name, phone, activated FROM users ORDER BY created_at DESC LIMIT 1",
  );
  await pool.end();
  return { counts, user: user.rows[0] || null };
}

async function post(path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await response.json();
  return { status: response.status, json };
}

function signWebhook(body, secret) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const base = `v0:${timestamp}:${body}`;
  const digest = createHmac("sha256", secret).update(base).digest("hex");
  return {
    timestamp,
    signature: `v0=${digest}`,
  };
}

async function inboundWebhook(phone, text, messageId) {
  const envelope = {
    event: "messages",
    message: {
      id: messageId,
      platform: "imessage",
      direction: "inbound",
      timestamp: new Date().toISOString(),
      sender: { id: phone, platform: "imessage" },
      space: { id: `space-${messageId}`, platform: "imessage", phone },
      content: { type: "text", text },
    },
  };
  const body = JSON.stringify(envelope);
  const secret = process.env.SPECTRUM_WEBHOOK_SECRET || "";
  const { timestamp, signature } = signWebhook(body, secret);
  const response = await fetch(`${BASE}/api/photon/webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-spectrum-timestamp": timestamp,
      "x-spectrum-signature": signature,
    },
    body,
  });
  return { status: response.status, text: await response.text() };
}

function maskPhone(phone) {
  if (!phone) return null;
  return `${phone.slice(0, 4)}***${phone.slice(-2)}`;
}

const health = await fetch(`${BASE}/api/health`).then((r) => r.json());
const before = await tableCounts();
if (!before.user) throw new Error("No user in Postgres; add an allow-listed tester via signup first.");

const phone = before.user.phone;
const signup = await post("/api/signup", {
  firstName: before.user.first_name || "Test",
  lastName: "User",
  email: "e2e-verify@posturepal.test",
  phone,
  consent: true,
});

const userId = signup.json.user?.id;
if (!userId) throw new Error(`signup failed: ${JSON.stringify(signup.json)}`);

const { Pool: Pg } = await import("pg");
const resetPool = new Pg({ connectionString: process.env.DATABASE_URL, max: 1 });
await resetPool.query("UPDATE user_settings SET snoozed_until=0 WHERE user_id=$1", [userId]);
await resetPool.end();

const session = await post("/api/session/start", { userId });
const alert = await post("/api/alert", {
  userId,
  issue: "forward-head",
  seconds: 35,
});

await new Promise((r) => setTimeout(r, 1500));
const statsHook = await inboundWebhook(phone, "stats", crypto.randomUUID());
await new Promise((r) => setTimeout(r, 2500));
const snoozeHook = await inboundWebhook(phone, "snooze 10", crypto.randomUUID());
await new Promise((r) => setTimeout(r, 2500));

const after = await tableCounts();
const { Pool } = await import("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const settings = await pool.query("SELECT snoozed_until FROM user_settings WHERE user_id=$1", [userId]);
const convo = await pool.query(
  "SELECT role, left(content, 80) AS preview FROM conversation_messages WHERE user_id=$1 ORDER BY created_at DESC LIMIT 4",
  [userId],
);
await pool.end();

const snoozedUntil = Number(settings.rows[0]?.snoozed_until || 0);
const report = {
  health,
  phoneMask: maskPhone(phone),
  signup: {
    status: signup.status,
    returning: signup.json.returning,
    delivery: signup.json.delivery,
  },
  session: { ok: session.json.ok },
  alert: {
    sent: alert.json.sent,
    delivered: alert.json.delivered,
    reason: alert.json.reason,
    channel: alert.json.channel,
    generatedBy: alert.json.generatedBy,
    hasAudioUrl: Boolean(alert.json.audioUrl),
    audioProvider: alert.json.audioProvider,
    messagePreview: String(alert.json.message || "").slice(0, 120),
  },
  webhooks: { stats: statsHook, snooze: snoozeHook },
  postgres: {
    before: before.counts,
    after: after.counts,
    snoozeActive: snoozedUntil > Date.now(),
    recentConversation: convo.rows.reverse(),
  },
};

console.log(JSON.stringify(report, null, 2));
