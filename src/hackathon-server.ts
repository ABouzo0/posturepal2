import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { parseAgentCommand } from "./agent.js";
import { buildSessionDebrief, conversationalReply, personalizedNudge, sessionRecap, VOICES, whyReply } from "./coach.js";
import {
  canSendAlert,
  emptyStats,
  goodPercent,
  normalizePhone,
  normalizeSlouchSeconds,
  type Stats,
} from "./core.js";
import {
  createStore,
  type ConversationMessage,
  type SessionRecord,
  type SlouchEvent,
  type User,
  type UserSettings,
} from "./store.js";

const execFileAsync = promisify(execFile);
const PORT = Number(process.env.PORT || 43131);
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC_DIR = join(process.cwd(), "public");
const PROJECT_ID = process.env.SPECTRUM_PROJECT_ID || process.env.PROJECT_ID || "";
const PROJECT_SECRET = process.env.SPECTRUM_PROJECT_SECRET || process.env.PROJECT_SECRET || "";
const WEBHOOK_SECRET = process.env.SPECTRUM_WEBHOOK_SECRET || "";
const INBOUND_MODE = process.env.PHOTON_INBOUND_MODE || "stream";
const COOLDOWN_MS = Number(process.env.ALERT_COOLDOWN_MINUTES || 1) * 60_000;
const ELEVENLABS_VOICE_SETTINGS = {
  stability: 0.32,
  similarityBoost: 0.72,
  style: 0.68,
  useSpeakerBoost: true,
  speed: 1.05,
};
const DEFAULT_SLOUCH_SECONDS = normalizeSlouchSeconds(process.env.DEFAULT_SLOUCH_SECONDS, 30);
const ELEVENLABS_MODEL_ID = process.env.ELEVENLABS_MODEL_ID || "eleven_multilingual_v2";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

type LiveState = {
  active: boolean;
  sessionId: string | null;
  sessionStart: number;
  stats: Stats;
  snoozedUntil: number;
  lastAlertAt: number;
  stopRequested: boolean;
  slouchSeconds: number;
  voiceId: string;
};

type DeliveryResult =
  | { delivered: true; channel: "imessage"; status: "sent" }
  | {
      delivered: false;
      channel: "terminal" | "imessage";
      status: "pending-allow-list" | "failed";
      reason: string;
      detail?: string;
    };

const store = await createStore();
const live = new Map<string, LiveState>();
const audioCache = new Map<string, { bytes: Uint8Array; expiresAt: number }>();
const processedMessages = new Set<string>();
const elevenlabs = process.env.ELEVENLABS_API_KEY ? new ElevenLabsClient() : null;

function newLive(): LiveState {
  return {
    active: false,
    sessionId: null,
    sessionStart: 0,
    stats: emptyStats(),
    snoozedUntil: 0,
    lastAlertAt: 0,
    stopRequested: false,
    slouchSeconds: DEFAULT_SLOUCH_SECONDS,
    voiceId: VOICES[0].id,
  };
}

function stateFor(userId: string): LiveState {
  const state = live.get(userId) || newLive();
  live.set(userId, state);
  return state;
}

function publicUser(user: User) {
  return {
    id: user.id,
    firstName: user.firstName,
    lastName: user.lastName,
    phone: user.phone,
    optedOut: user.optedOut,
    activated: user.activated,
  };
}

function allowedVoice(voiceId: unknown): string {
  const candidate = String(voiceId || "");
  return VOICES.some((voice) => voice.id === candidate) ? candidate : VOICES[0].id;
}

async function addPhotonUser(user: Pick<User, "firstName" | "lastName" | "email" | "phone">) {
  if (process.env.PHOTON_REGISTER_USERS !== "true") return { id: null, warning: "automatic Photon registration disabled" };
  if (!PROJECT_ID) return { id: null, warning: "SPECTRUM_PROJECT_ID is missing" };
  try {
    const { stdout } = await execFileAsync(process.env.PHOTON_CLI || "photon", [
      "spectrum", "users", "add",
      "--first-name", user.firstName,
      "--last-name", user.lastName,
      "--email", user.email,
      "--phone", user.phone,
      "--project", PROJECT_ID,
      "--json",
    ], { env: { ...process.env, PHOTON_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" } });
    return { id: (JSON.parse(stdout) as { id?: string }).id || null };
  } catch (error) {
    const message = String((error as Error).message || error);
    if (/already|exists|duplicate/i.test(message)) return { id: null };
    return { id: null, warning: `Photon registration failed: ${message}` };
  }
}

let connection: any = null;
if (PROJECT_ID && PROJECT_SECRET) {
  try {
    const app = await Spectrum({
      projectId: PROJECT_ID,
      projectSecret: PROJECT_SECRET,
      providers: [imessage.config()],
      ...(WEBHOOK_SECRET ? { webhookSecret: WEBHOOK_SECRET } : {}),
    });
    connection = { app, provider: imessage(app), spaces: new Map<string, any>() };
    console.log(`Connected to Photon Spectrum iMessage (${INBOUND_MODE} inbound).`);
  } catch (error) {
    console.error("Photon connection failed; using terminal fallback.", error);
  }
} else {
  console.warn("Photon credentials absent; iMessage notifications will print to the terminal.");
}

function safePhotonDetail(value: string, user: User): string {
  let safe = value;
  if (PROJECT_ID) safe = safe.replaceAll(PROJECT_ID, "[redacted project]");
  if (PROJECT_SECRET) safe = safe.replaceAll(PROJECT_SECRET, "[redacted credential]");
  return safe
    .replaceAll(user.phone, "[redacted phone]")
    .replace(/\+\d{8,15}/g, "[redacted phone]")
    .replace(/\s+/g, " ")
    .slice(0, 300);
}

async function sendTo(user: User, message: string): Promise<DeliveryResult> {
  if (user.optedOut) return { delivered: false, channel: "imessage", status: "failed", reason: "unsubscribed" };
  if (!connection) {
    console.log(`[local notification] ${message}`);
    return { delivered: false, channel: "terminal", status: "failed", reason: "photon-not-configured" };
  }
  try {
    let space = connection.spaces.get(user.id);
    if (!space) {
      const target = await connection.provider.user(user.phone);
      space = await connection.provider.space.create(target);
      connection.spaces.set(user.id, space);
    }
    await space.send(message);
    return { delivered: true, channel: "imessage", status: "sent" };
  } catch (error) {
    const detail = String((error as Error).message || error);
    const safeDetail = safePhotonDetail(detail, user);
    connection.spaces.delete(user.id);
    if (/new contact|until they respond|RESOURCE_EXHAUSTED/i.test(detail))
      return { delivered: false, channel: "imessage", status: "failed", reason: "needs-reply", detail: safeDetail };
    if (/target not allowed/i.test(detail))
      return { delivered: false, channel: "imessage", status: "pending-allow-list", reason: "not-allowed", detail: safeDetail };
    return { delivered: false, channel: "imessage", status: "failed", reason: "send-error", detail: safeDetail };
  }
}

async function sendWelcome(user: User, returning: boolean): Promise<DeliveryResult> {
  return sendTo(
    user,
    returning
      ? `Welcome back! Reply “hi” to verify your number, then ask any posture question in plain language.`
      : `Reply “hi” to activate PosturePal. Then ask how you sit, request desk exercises, or check in anytime.`,
  );
}

async function appendConversation(userId: string, role: "user" | "assistant", content: string) {
  const message: ConversationMessage = {
    id: crypto.randomUUID(),
    userId,
    role,
    content,
    createdAt: new Date().toISOString(),
  };
  await store.appendConversation(message);
}

async function handleText(user: User, raw: string): Promise<string> {
  const command = parseAgentCommand(raw);
  const state = stateFor(user.id);
  const settings = await store.getSettings(user.id);
  let answer: string;

  switch (command.type) {
    case "unsubscribe":
      user.optedOut = true;
      await store.updateUser(user);
      answer = "Messages are off. Text “subscribe” to turn them back on.";
      break;
    case "subscribe":
      user.optedOut = false;
      await store.updateUser(user);
      answer = `Messages are back on, ${user.firstName}.`;
      break;
    case "stop":
      state.stopRequested = true;
      answer = state.active ? "Stopping the active camera session now." : "No posture session is running.";
      break;
    case "snooze": {
      const until = Date.now() + command.minutes * 60_000;
      state.snoozedUntil = until;
      await store.saveSettings({ ...settings, snoozedUntil: until, updatedAt: new Date().toISOString() });
      answer = `Snoozed for ${command.minutes} minutes. Tracking can continue, but I will not nudge you.`;
      break;
    }
    case "stats": {
      const stats = await store.demoStats(user.id);
      const current = state.active ? ` Current session: ${goodPercent(state.stats)}% upright.` : "";
      answer = `${stats.sessions} sessions, ${stats.totalMinutes} minutes, ${stats.uprightPct}% upright, ${stats.alerts} nudges.${current}`;
      break;
    }
    case "why": {
      const latest = await store.latestSlouchEvent(user.id);
      answer = whyReply(latest?.issue || null, latest?.sustainedSeconds);
      break;
    }
    case "help":
      answer = "Ask me anything about how you sit — exercises, what’s been off, or how a session went. When you need quick controls, text stats, why, snooze 20, or stop.";
      break;
    case "free-text": {
      const [stats, recent, latest] = await Promise.all([
        store.demoStats(user.id),
        store.conversation(user.id, 12),
        store.latestSlouchEvent(user.id),
      ]);
      answer = await conversationalReply({ user, message: command.text, stats, recent, lastIssue: latest?.issue || null });
      break;
    }
  }
  return answer;
}

async function processInbound(space: any, message: any) {
  if (message.platform !== "imessage" || message.content.type !== "text") return;
  if (message.direction && message.direction !== "inbound") return;
  if (processedMessages.has(message.id)) return;
  processedMessages.add(message.id);
  if (processedMessages.size > 1000) processedMessages.delete(processedMessages.values().next().value!);

  const address = message.sender?.address || message.sender?.id;
  const user = address ? await store.findUserByAddress(address) : undefined;
  if (!user) {
    await space.send("I do not recognize this number. Sign up in PosturePal first.");
    return;
  }
  if (INBOUND_MODE === "stream") connection?.spaces.set(user.id, space);
  if (!user.activated) {
    user.activated = true;
    await store.updateUser(user);
  }
  const text = message.content.text;
  await appendConversation(user.id, "user", text);
  const answer = await handleText(user, text);
  const delivery = await sendTo(user, answer);
  await appendConversation(user.id, "assistant", answer);
  console.log(`Photon inbound reply: ${delivery.delivered ? "sent" : delivery.reason}`);
}

if (connection && INBOUND_MODE === "stream") {
  void (async () => {
    for await (const [space, message] of connection.app.messages) await processInbound(space, message);
  })().catch((error) => console.error("Photon inbound stream stopped.", error));
}

function mergeStats(state: LiveState, incoming: Partial<Stats> | undefined) {
  if (!incoming) return;
  state.stats = {
    ...state.stats,
    goodSeconds: Number(incoming.goodSeconds ?? state.stats.goodSeconds),
    badSeconds: Number(incoming.badSeconds ?? state.stats.badSeconds),
    awaySeconds: Number(incoming.awaySeconds ?? state.stats.awaySeconds),
    issueCounts: incoming.issueCounts || state.stats.issueCounts,
  };
}

async function createAudio(message: string, voiceId: string): Promise<{ url: string | null; error?: string }> {
  if (!elevenlabs) return { url: null, error: "elevenlabs-not-configured" };
  try {
    const stream = await elevenlabs.textToSpeech.convert(allowedVoice(voiceId), {
      text: message,
      modelId: ELEVENLABS_MODEL_ID,
      outputFormat: "mp3_44100_128",
      voiceSettings: ELEVENLABS_VOICE_SETTINGS,
    });
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    if (!bytes.byteLength) return { url: null, error: "elevenlabs-empty-audio" };
    const token = crypto.randomUUID();
    audioCache.set(token, { bytes, expiresAt: Date.now() + 2 * 60_000 });
    return { url: `/api/audio/${token}` };
  } catch (error) {
    const detail = String((error as Error).message || error).slice(0, 240);
    console.error("ElevenLabs generation failed; browser speech fallback will be used.", detail);
    return { url: null, error: "elevenlabs-generation-failed" };
  }
}

function corsHeaders(request: IncomingMessage): Record<string, string> {
  const origin = request.headers.origin;
  if (!origin) return {};
  const local = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  if (ALLOWED_ORIGINS.length && !ALLOWED_ORIGINS.includes(origin) && !local) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function sendJson(response: ServerResponse, value: unknown, status = 200, headers: Record<string, string> = {}) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
  response.end(JSON.stringify(value));
}

async function rawBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    length += buffer.length;
    if (length > 1_000_000) throw new Error("request too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function bodyOf(request: IncomingMessage): Promise<Record<string, any>> {
  const raw = await rawBody(request);
  return raw.length ? JSON.parse(raw.toString("utf8")) : {};
}

async function photonWebhook(request: IncomingMessage, response: ServerResponse) {
  if (!connection || !WEBHOOK_SECRET) return sendJson(response, { error: "Photon webhook is not configured" }, 503);
  const body = await rawBody(request);
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (value) headers.set(key, Array.isArray(value) ? value.join(",") : value);
  }
  const fetchRequest = new Request(`http://${request.headers.host}${request.url}`, {
    method: "POST",
    headers,
    body: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
  });
  const result = await connection.app.webhook(fetchRequest, processInbound);
  response.writeHead(result.status, Object.fromEntries(result.headers.entries()));
  response.end(Buffer.from(await result.arrayBuffer()));
}

async function statsResponse(userId: string | null, response: ServerResponse, headers: Record<string, string>) {
  if (!userId) return sendJson(response, { error: "userId is required" }, 400, headers);
  const user = await store.findUserById(userId);
  if (!user) return sendJson(response, { error: "unknown user" }, 401, headers);
  const stats = await store.demoStats(user.id);
  return sendJson(response, { stats, active: stateFor(user.id).active, storage: store.kind }, 200, headers);
}

async function api(request: IncomingMessage, response: ServerResponse, url: URL, headers: Record<string, string>) {
  if (request.method === "POST" && url.pathname === "/api/photon/webhook") return photonWebhook(request, response);
  if (request.method === "GET" && url.pathname === "/api/health") {
    return sendJson(response, {
      ok: true,
      photon: connection ? "connected" : "fallback",
      inbound: connection ? INBOUND_MODE : "disabled",
      audio: elevenlabs ? "elevenlabs" : "browser",
      gemini: process.env.GEMINI_API_KEY ? "connected" : "templates",
      storage: store.kind,
    }, 200, headers);
  }
  if (request.method === "GET" && url.pathname === "/api/stats")
    return statsResponse(url.searchParams.get("userId"), response, headers);
  if (request.method === "GET" && url.pathname.startsWith("/api/audio/")) {
    const token = url.pathname.slice("/api/audio/".length);
    const audio = audioCache.get(token);
    if (!audio || audio.expiresAt < Date.now()) {
      audioCache.delete(token);
      return sendJson(response, { error: "audio expired" }, 404, headers);
    }
    response.writeHead(200, { "Content-Type": "audio/mpeg", "Cache-Control": "no-store", ...headers });
    return response.end(audio.bytes);
  }
  if (request.method !== "POST") return sendJson(response, { error: "not found" }, 404, headers);
  const body = await bodyOf(request);

  if (url.pathname === "/api/signup") {
    const firstName = String(body.firstName || "").trim();
    const lastName = String(body.lastName || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const phone = normalizePhone(String(body.phone || ""));
    if (!firstName || !lastName) return sendJson(response, { error: "Enter your first and last name." }, 400, headers);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return sendJson(response, { error: "Enter a valid email." }, 400, headers);
    if (!phone) return sendJson(response, { error: "Enter a valid phone number." }, 400, headers);
    if (body.consent !== true) return sendJson(response, { error: "Consent is required for iMessage alerts." }, 400, headers);
    const existing = await store.findUserByPhone(phone);
    if (existing) {
      const delivery = await sendWelcome(existing, true);
      return sendJson(response, {
        user: publicUser(existing),
        returning: true,
        delivery,
        settings: await store.getSettings(existing.id),
      }, 200, headers);
    }
    const registration = await addPhotonUser({ firstName, lastName, email, phone });
    const user: User = {
      id: crypto.randomUUID(),
      firstName,
      lastName,
      email,
      phone,
      photonUserId: registration.id,
      optedOut: false,
      activated: !connection,
      createdAt: new Date().toISOString(),
    };
    await store.createUser(user);
    const settings = await store.getSettings(user.id);
    await store.saveSettings(settings);
    const delivery = await sendWelcome(user, false);
    return sendJson(response, { user: publicUser(user), returning: false, delivery, settings, registrationWarning: registration.warning }, 201, headers);
  }

  const user = await store.findUserById(String(body.userId || ""));
  if (!user) return sendJson(response, { error: "unknown user" }, 401, headers);
  const state = stateFor(user.id);

  if (url.pathname === "/api/me") return sendJson(response, { user: publicUser(user), settings: await store.getSettings(user.id) }, 200, headers);
  if (url.pathname === "/api/stats") return statsResponse(user.id, response, headers);
  if (url.pathname === "/api/settings") {
    const previous = await store.getSettings(user.id);
    const settings: UserSettings = {
      ...previous,
      slouchSeconds: normalizeSlouchSeconds(body.slouchSeconds, previous.slouchSeconds),
      sensitivity: ["low", "medium", "high"].includes(body.sensitivity) ? body.sensitivity : previous.sensitivity,
      voiceId: allowedVoice(body.voiceId || previous.voiceId),
      audioEnabled: body.audioEnabled === undefined ? previous.audioEnabled : Boolean(body.audioEnabled),
      updatedAt: new Date().toISOString(),
    };
    await store.saveSettings(settings);
    return sendJson(response, { settings }, 200, headers);
  }
  if (url.pathname === "/api/session/start") {
    const previous = await store.getSettings(user.id);
    const settings: UserSettings = {
      ...previous,
      slouchSeconds: normalizeSlouchSeconds(body.slouchSeconds, previous.slouchSeconds),
      sensitivity: ["low", "medium", "high"].includes(body.sensitivity) ? body.sensitivity : previous.sensitivity,
      voiceId: allowedVoice(body.voiceId || previous.voiceId),
      audioEnabled: body.audioEnabled === undefined ? previous.audioEnabled : Boolean(body.audioEnabled),
      updatedAt: new Date().toISOString(),
    };
    await store.saveSettings(settings);
    Object.assign(state, {
      active: true,
      sessionId: crypto.randomUUID(),
      sessionStart: Date.now(),
      stats: emptyStats(),
      stopRequested: false,
      lastAlertAt: 0,
      snoozedUntil: settings.snoozedUntil,
      slouchSeconds: settings.slouchSeconds,
      voiceId: settings.voiceId,
    });
    return sendJson(response, { ok: true, settings, activated: user.activated }, 200, headers);
  }
  if (url.pathname === "/api/heartbeat") {
    mergeStats(state, body.stats);
    const settings = await store.getSettings(user.id);
    state.snoozedUntil = settings.snoozedUntil;
    return sendJson(response, { stop: state.stopRequested, snoozedUntil: state.snoozedUntil }, 200, headers);
  }
  if (url.pathname === "/api/alert") {
    const issue = String(body.issue || "slouching");
    const seconds = Number(body.seconds || 0);
    if (!body.test) {
      const decision = canSendAlert({
        active: state.active,
        activated: user.activated,
        optedOut: user.optedOut,
        slouchSeconds: state.slouchSeconds,
        sustainedSeconds: seconds,
        now: Date.now(),
        snoozedUntil: state.snoozedUntil,
        lastAlertAt: state.lastAlertAt,
        cooldownMs: COOLDOWN_MS,
      });
      if (!decision.allowed) return sendJson(response, { sent: false, reason: decision.reason }, 200, headers);
    }
    const history = await store.demoStats(user.id);
    let message: string;
    let generatedBy: "gemini" | "template" = "template";
    if (body.test) {
      message = `Test successful, ${user.firstName}. PosturePal alerts are ready.`;
    } else {
      const nudge = await personalizedNudge({ user, issue, seconds, current: state.stats, history });
      message = nudge.message;
      generatedBy = nudge.generatedBy;
    }
    const delivery = await sendTo(user, message);
    if (!body.test) {
      state.lastAlertAt = Date.now();
      state.stats.alerts++;
      const event: SlouchEvent = {
        id: crypto.randomUUID(),
        userId: user.id,
        sessionId: state.sessionId,
        issue,
        sustainedSeconds: seconds,
        nudgeText: message,
        deliveryStatus: delivery.status,
        createdAt: new Date().toISOString(),
      };
      await store.recordSlouchEvent(event);
    }
    const audio = await createAudio(message, state.voiceId);
    return sendJson(response, {
      sent: delivery.delivered,
      delivered: delivery.delivered,
      channel: delivery.channel,
      reason: delivery.delivered ? undefined : delivery.reason,
      message,
      audioUrl: audio.url,
      audioProvider: audio.url ? "elevenlabs" : "browser",
      audioError: audio.error,
      generatedBy: body.test ? "template" : generatedBy,
    }, 200, headers);
  }
  if (url.pathname === "/api/session/stop") {
    if (!state.active) return sendJson(response, { ok: true }, 200, headers);
    mergeStats(state, body.stats);
    const endedAt = new Date().toISOString();
    const topIssue = Object.entries(state.stats.issueCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    const history = await store.demoStats(user.id);
    const minutes = Math.max(1, Math.round((Date.now() - state.sessionStart) / 60_000));
    const goodPct = goodPercent(state.stats);
    const nudges = state.stats.alerts;
    const debrief = buildSessionDebrief({ minutes, goodPct, nudges, priorHistory: history });
    const recapCopy = await sessionRecap({
      user,
      debrief,
      topIssue,
    });
    const session: SessionRecord = {
      id: state.sessionId || crypto.randomUUID(),
      userId: user.id,
      start: new Date(state.sessionStart).toISOString(),
      end: endedAt,
      minutes,
      goodPct,
      alerts: nudges,
      topIssue,
      stats: state.stats,
      recap: recapCopy.message,
    };
    await store.saveSession(session);
    const delivery = await sendTo(user, recapCopy.message);
    const audio = await createAudio(recapCopy.message, state.voiceId);
    state.active = false;
    state.stopRequested = false;
    state.sessionId = null;
    return sendJson(response, {
      ok: true,
      session,
      recap: recapCopy.message,
      debrief,
      delivery,
      audioUrl: audio.url,
      audioProvider: audio.url ? "elevenlabs" : "browser",
      audioError: audio.error,
      generatedBy: recapCopy.generatedBy,
    }, 200, headers);
  }
  return sendJson(response, { error: "not found" }, 404, headers);
}

const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

const server = createServer(async (request, response) => {
  const headers = corsHeaders(request);
  if (request.method === "OPTIONS") {
    response.writeHead(204, headers);
    return response.end();
  }
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) return await api(request, response, url, headers);
    const relative = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    if (relative.includes("..")) return sendJson(response, { error: "not found" }, 404, headers);
    const bytes = await readFile(join(PUBLIC_DIR, relative));
    response.writeHead(200, { "Content-Type": mime[extname(relative)] || "application/octet-stream", ...headers });
    response.end(bytes);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return sendJson(response, { error: "not found" }, 404, headers);
    console.error(error);
    sendJson(response, { error: "internal server error" }, 500, headers);
  }
});

server.listen(PORT, HOST, () => console.log(`PosturePal hackathon core running at http://${HOST}:${PORT}`));

async function shutdown() {
  server.close();
  await connection?.app.stop();
  await store.close();
  process.exit(0);
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
