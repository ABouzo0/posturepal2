import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PROD = "https://posturepal2.onrender.com";

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
    process.env[key] ??= value;
  }
}

loadEnv(join(process.cwd(), ".env"));

function signWebhook(body, secret) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const base = `v0:${timestamp}:${body}`;
  const digest = createHmac("sha256", secret).update(base).digest("hex");
  return { timestamp, signature: `v0=${digest}` };
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
  const response = await fetch(`${PROD}/api/photon/webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-spectrum-timestamp": timestamp,
      "x-spectrum-signature": signature,
    },
    body,
  });
  return { status: response.status, ok: response.ok };
}

async function latestAssistant(userId, sinceIso) {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const result = await pool.query(
    `SELECT content, length(content)::int AS len, created_at
     FROM conversation_messages
     WHERE user_id=$1 AND role='assistant' AND created_at >= $2
     ORDER BY created_at DESC LIMIT 1`,
    [userId, sinceIso],
  );
  await pool.end();
  return result.rows[0] || null;
}

async function runCase(phone, userId, text) {
  const since = new Date().toISOString();
  const messageId = `verify-${crypto.randomUUID()}`;
  const hook = await inboundWebhook(phone, text, messageId);
  await new Promise((r) => setTimeout(r, 9000));
  const row = await latestAssistant(userId, since);
  return {
    inbound: text,
    webhookStatus: hook.status,
    reply: row?.content || null,
    len: row?.len || 0,
  };
}

const { Pool } = await import("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const userRow = await pool.query("SELECT id, phone FROM users ORDER BY created_at DESC LIMIT 1");
await pool.end();
const user = userRow.rows[0];
if (!user) {
  console.error("No user in database");
  process.exit(1);
}

const cases = [
  "hey",
  "thanks!",
  "what exercises help me sit up straight?",
];

const results = [];
for (const text of cases) {
  results.push(await runCase(user.phone, user.id, text));
}

console.log(JSON.stringify({ health: await (await fetch(`${PROD}/api/health`)).json(), results }, null, 2));
