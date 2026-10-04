import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import {
  canSendAlert,
  emptyStats,
  goodPercent,
  normalizePhone,
  normalizeSlouchSeconds,
  type Stats,
} from "./core.js";

const execFileAsync = promisify(execFile);
const PORT = Number(process.env.PORT || 43127);
const HOST = process.env.HOST || "0.0.0.0";
const DATA_DIR = process.env.DATA_DIR || "./data";
const USERS_FILE = join(DATA_DIR, "users.json");
const SESSIONS_FILE = join(DATA_DIR, "sessions.json");
const PUBLIC_DIR = join(process.cwd(), "public");
const PROJECT_ID = process.env.SPECTRUM_PROJECT_ID || process.env.PROJECT_ID || "";
const PROJECT_SECRET = process.env.SPECTRUM_PROJECT_SECRET || process.env.PROJECT_SECRET || "";
const COOLDOWN_MS = Number(process.env.ALERT_COOLDOWN_MINUTES || 10) * 60_000;
const DEFAULT_SLOUCH_SECONDS = normalizeSlouchSeconds(process.env.DEFAULT_SLOUCH_SECONDS, 30);
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "JBFqnCBsd6RMkjVDRZzb";
const ELEVENLABS_MODEL_ID = process.env.ELEVENLABS_MODEL_ID || "eleven_multilingual_v2";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

type User = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  photonUserId: string | null;
  optedOut: boolean;
  activated: boolean;
  createdAt: string;
};

type Session = {
  userId: string;
  start: string;
  end: string;
  minutes: number;
  goodPct: number;
  alerts: number;
  topIssue: string | null;
};

type LiveState = {
  active: boolean;
  sessionStart: number;
  stats: Stats;
  snoozedUntil: number;
  lastAlertAt: number;
  stopRequested: boolean;
  slouchSeconds: number;
};

const fallbackNudges: Record<string, string[]> = {
  slouching: ["Shoulders back, chin up.", "Quick reset: sit tall like you did at calibration.", "A little slump crept in. Reset your spine."],
  "head forward": ["Gently tuck your chin back. Your neck will thank you.", "Your head is drifting toward the screen. Pull it back."],
  "leaning in": ["You are leaning toward the screen. Sit back into your chair.", "Give your eyes space—scoot back a little."],
  tilted: ["Your shoulders are uneven. Center yourself.", "Level your shoulders and settle back in."],
};

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2), { mode: 0o600 });
}

let users = await readJson<User[]>(USERS_FILE, []);
const live = new Map<string, LiveState>();
const audioCache = new Map<string, { bytes: Uint8Array; expiresAt: number }>();
const elevenlabs = process.env.ELEVENLABS_API_KEY ? new ElevenLabsClient() : null;

function newLive(): LiveState {
  return {
    active: false,
    sessionStart: 0,
    stats: emptyStats(),
    snoozedUntil: 0,
    lastAlertAt: 0,
    stopRequested: false,
    slouchSeconds: DEFAULT_SLOUCH_SECONDS,
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

async function saveUsers() {
  await writeJson(USERS_FILE, users);
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
    });
    connection = { app, provider: imessage(app), spaces: new Map<string, any>() };
    console.log("Connected to Photon Spectrum iMessage.");
  } catch (error) {
    console.error("Photon connection failed; using terminal fallback.", error);
  }
} else {
  console.warn("Photon credentials absent; iMessage notifications will print to the terminal.");
}

async function sendTo(user: User, message: string): Promise<{ ok: boolean; reason?: string }> {
  if (user.optedOut) return { ok: false, reason: "unsubscribed" };
  if (!connection) {
    console.log(`[local notification for ${user.phone}] ${message}`);
    return { ok: true };
  }
  try {
    let space = connection.spaces.get(user.id);
    if (!space) {
      const target = await connection.provider.user(user.phone);
      space = await connection.provider.space.create(target);
      connection.spaces.set(user.id, space);
    }
    await space.send(message);
    return { ok: true };
  } catch (error) {
    const detail = String((error as Error).message || error);
    console.error(`Photon send failed for ${user.phone}: ${detail}`);
    connection.spaces.delete(user.id);
    if (/new contact|until they respond|RESOURCE_EXHAUSTED/i.test(detail)) return { ok: false, reason: "needs-reply" };
    if (/target not allowed/i.test(detail)) return { ok: false, reason: "not-allowed" };
    return { ok: false, reason: "send-error" };
  }
}

function findUserByAddress(address?: string): User | undefined {
  if (!address) return undefined;
  if (address.includes("@")) return users.find((user) => user.email.toLowerCase() === address.toLowerCase());
  const end = address.replace(/\D/g, "").slice(-10);
  return users.find((user) => user.phone.replace(/\D/g, "").slice(-10) === end);
}

async function handleIncomingText(user: User, text: string): Promise<string> {
  const command = text.trim().toLowerCase();
  const state = stateFor(user.id);
  if (command === "unsubscribe") {
    user.optedOut = true;
    await saveUsers();
    return "You are unsubscribed. Text “subscribe” to turn PosturePal messages back on.";
  }
  if (command === "subscribe") {
    user.optedOut = false;
    await saveUsers();
    return `Welcome back, ${user.firstName}!`;
  }
  if (/^(stop|end|off)\b/.test(command)) {
    state.stopRequested = true;
    return "Stopping tracking on your computer now.";
  }
  const snooze = command.match(/^snooze\s*(\d+)?/);
  if (snooze) {
    const minutes = Math.min(240, Math.max(1, Number(snooze[1] || 30)));
    state.snoozedUntil = Date.now() + minutes * 60_000;
    return `Posture alerts are snoozed for ${minutes} minutes.`;
  }
  if (command === "resume") {
    state.snoozedUntil = 0;
    return "Posture alerts are back on.";
  }
  if (command === "status") {
    return state.active
      ? `${Math.round((Date.now() - state.sessionStart) / 60_000)} minutes in and ${goodPercent(state.stats)}% upright.`
      : "Tracking is currently off.";
  }
  return "Commands: status, snooze 15, resume, stop, unsubscribe.";
}

if (connection) {
  void (async () => {
    for await (const [space, message] of connection.app.messages) {
      if (message.platform !== "imessage" || message.content.type !== "text") continue;
      const user = findUserByAddress(message.sender?.address || message.sender?.id);
      if (!user) {
        await space.send("Sign up at posturepal.tech before messaging PosturePal.");
        continue;
      }
      connection.spaces.set(user.id, space);
      if (!user.activated) {
        user.activated = true;
        await saveUsers();
      }
      await space.send(await handleIncomingText(user, message.content.text));
    }
  })().catch((error) => console.error("Photon incoming-message loop stopped.", error));
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

function nudge(issue: string): string {
  const choices = fallbackNudges[issue] || fallbackNudges.slouching!;
  return choices[Math.floor(Math.random() * choices.length)]!;
}

async function createAudio(message: string): Promise<string | null> {
  if (!elevenlabs) return null;
  try {
    const stream = await elevenlabs.textToSpeech.convert(ELEVENLABS_VOICE_ID, {
      text: message,
      modelId: ELEVENLABS_MODEL_ID,
      outputFormat: "mp3_44100_128",
    });
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    const token = crypto.randomUUID();
    audioCache.set(token, { bytes, expiresAt: Date.now() + 2 * 60_000 });
    return `/api/audio/${token}`;
  } catch (error) {
    console.error("ElevenLabs generation failed; browser speech fallback will be used.", error);
    return null;
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

async function bodyOf(request: IncomingMessage): Promise<Record<string, any>> {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 100_000) throw new Error("request too large");
  }
  return raw ? JSON.parse(raw) : {};
}

async function api(request: IncomingMessage, response: ServerResponse, url: URL, headers: Record<string, string>) {
  if (request.method === "GET" && url.pathname === "/api/health") {
    return sendJson(response, {
      ok: true,
      photon: connection ? "connected" : "fallback",
      audio: elevenlabs ? "elevenlabs" : "browser",
    }, 200, headers);
  }
  if (request.method === "GET" && url.pathname.startsWith("/api/audio/")) {
    const token = url.pathname.slice("/api/audio/".length);
    const audio = audioCache.get(token);
    audioCache.delete(token);
    if (!audio || audio.expiresAt < Date.now()) return sendJson(response, { error: "audio expired" }, 404, headers);
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
    const existing = users.find((user) => user.phone === phone);
    if (existing) return sendJson(response, { user: publicUser(existing), returning: true }, 200, headers);
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
    users.push(user);
    await saveUsers();
    await sendTo(user, `Hi ${firstName}! Reply “hi” to activate PosturePal slouch alerts. Reply “unsubscribe” anytime.`);
    return sendJson(response, { user: publicUser(user), returning: false, warning: registration.warning }, 201, headers);
  }

  const user = users.find((candidate) => candidate.id === body.userId);
  if (!user) return sendJson(response, { error: "unknown user" }, 401, headers);
  const state = stateFor(user.id);

  if (url.pathname === "/api/me") return sendJson(response, { user: publicUser(user) }, 200, headers);
  if (url.pathname === "/api/session/start") {
    Object.assign(state, {
      active: true,
      sessionStart: Date.now(),
      stats: emptyStats(),
      stopRequested: false,
      lastAlertAt: 0,
      slouchSeconds: normalizeSlouchSeconds(body.slouchSeconds, DEFAULT_SLOUCH_SECONDS),
    });
    return sendJson(response, { ok: true, slouchSeconds: state.slouchSeconds, activated: user.activated }, 200, headers);
  }
  if (url.pathname === "/api/heartbeat") {
    mergeStats(state, body.stats);
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
    const message = body.test ? `Test successful, ${user.firstName}. PosturePal alerts are ready.` : nudge(issue);
    const sent = await sendTo(user, message);
    if (!sent.ok) return sendJson(response, { sent: false, reason: sent.reason }, 200, headers);
    if (!body.test) {
      state.lastAlertAt = Date.now();
      state.stats.alerts++;
    }
    const audioUrl = await createAudio(message);
    return sendJson(response, { sent: true, message, audioUrl, audioProvider: audioUrl ? "elevenlabs" : "browser" }, 200, headers);
  }
  if (url.pathname === "/api/session/stop") {
    if (state.active) {
      mergeStats(state, body.stats);
      const sessions = await readJson<Session[]>(SESSIONS_FILE, []);
      const issue = Object.entries(state.stats.issueCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
      sessions.push({
        userId: user.id,
        start: new Date(state.sessionStart).toISOString(),
        end: new Date().toISOString(),
        minutes: Math.max(1, Math.round((Date.now() - state.sessionStart) / 60_000)),
        goodPct: goodPercent(state.stats),
        alerts: state.stats.alerts,
        topIssue: issue,
      });
      await writeJson(SESSIONS_FILE, sessions.slice(-1000));
    }
    state.active = false;
    state.stopRequested = false;
    return sendJson(response, { ok: true }, 200, headers);
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

server.listen(PORT, HOST, () => console.log(`PosturePal is running at http://${HOST}:${PORT}`));

async function shutdown() {
  server.close();
  await connection?.app.stop();
  process.exit(0);
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
