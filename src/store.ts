import { Pool } from "pg";
import { emptyStats, type Stats } from "./core.js";

export type User = {
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

export type UserSettings = {
  userId: string;
  slouchSeconds: number;
  sensitivity: "low" | "medium" | "high";
  voiceId: string;
  audioEnabled: boolean;
  snoozedUntil: number;
  updatedAt: string;
};

export type SessionRecord = {
  id: string;
  userId: string;
  start: string;
  end: string;
  minutes: number;
  goodPct: number;
  alerts: number;
  topIssue: string | null;
  stats: Stats;
  recap: string | null;
};

export type SlouchEvent = {
  id: string;
  userId: string;
  sessionId: string | null;
  issue: string;
  sustainedSeconds: number;
  nudgeText: string;
  deliveryStatus: string;
  createdAt: string;
};

export type ConversationMessage = {
  id: string;
  userId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
};

export type DemoStats = {
  sessions: number;
  totalMinutes: number;
  uprightPct: number;
  alerts: number;
  slouchEvents: number;
  currentStreakDays: number;
  topIssue: string | null;
  lastSessionAt: string | null;
};

export interface PostureStore {
  readonly kind: "memory" | "postgres";
  init(): Promise<void>;
  close(): Promise<void>;
  findUserById(id: string): Promise<User | undefined>;
  findUserByPhone(phone: string): Promise<User | undefined>;
  findUserByAddress(address: string): Promise<User | undefined>;
  createUser(user: User): Promise<void>;
  updateUser(user: User): Promise<void>;
  getSettings(userId: string): Promise<UserSettings>;
  saveSettings(settings: UserSettings): Promise<void>;
  saveSession(session: SessionRecord): Promise<void>;
  recordSlouchEvent(event: SlouchEvent): Promise<void>;
  latestSlouchEvent(userId: string): Promise<SlouchEvent | undefined>;
  appendConversation(message: ConversationMessage): Promise<void>;
  conversation(userId: string, limit?: number): Promise<ConversationMessage[]>;
  demoStats(userId: string): Promise<DemoStats>;
}

const defaultSettings = (userId: string): UserSettings => ({
  userId,
  slouchSeconds: 30,
  sensitivity: "medium",
  voiceId: process.env.ELEVENLABS_VOICE_ID || "JBFqnCBsd6RMkjVDRZzb",
  audioEnabled: true,
  snoozedUntil: 0,
  updatedAt: new Date().toISOString(),
});

export class MemoryStore implements PostureStore {
  readonly kind = "memory" as const;
  private users = new Map<string, User>();
  private settings = new Map<string, UserSettings>();
  private sessions: SessionRecord[] = [];
  private events: SlouchEvent[] = [];
  private messages: ConversationMessage[] = [];

  async init() {}
  async close() {}
  async findUserById(id: string) { return this.users.get(id); }
  async findUserByPhone(phone: string) { return [...this.users.values()].find((user) => user.phone === phone); }
  async findUserByAddress(address: string) {
    if (address.includes("@")) return [...this.users.values()].find((user) => user.email.toLowerCase() === address.toLowerCase());
    const ending = address.replace(/\D/g, "").slice(-10);
    return [...this.users.values()].find((user) => user.phone.replace(/\D/g, "").slice(-10) === ending);
  }
  async createUser(user: User) { this.users.set(user.id, structuredClone(user)); }
  async updateUser(user: User) { this.users.set(user.id, structuredClone(user)); }
  async getSettings(userId: string) { return structuredClone(this.settings.get(userId) || defaultSettings(userId)); }
  async saveSettings(settings: UserSettings) { this.settings.set(settings.userId, structuredClone(settings)); }
  async saveSession(session: SessionRecord) { this.sessions.push(structuredClone(session)); }
  async recordSlouchEvent(event: SlouchEvent) { this.events.push(structuredClone(event)); }
  async latestSlouchEvent(userId: string) { return structuredClone(this.events.filter((event) => event.userId === userId).at(-1)); }
  async appendConversation(message: ConversationMessage) { this.messages.push(structuredClone(message)); }
  async conversation(userId: string, limit = 20) {
    return structuredClone(this.messages.filter((message) => message.userId === userId).slice(-limit));
  }
  async demoStats(userId: string): Promise<DemoStats> {
    const sessions = this.sessions.filter((session) => session.userId === userId);
    const events = this.events.filter((event) => event.userId === userId);
    return aggregateStats(sessions, events);
  }
}

function mapUser(row: Record<string, any>): User {
  return {
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    phone: row.phone,
    photonUserId: row.photon_user_id,
    optedOut: row.opted_out,
    activated: row.activated,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function mapEvent(row: Record<string, any>): SlouchEvent {
  return {
    id: row.id,
    userId: row.user_id,
    sessionId: row.session_id,
    issue: row.issue,
    sustainedSeconds: row.sustained_seconds,
    nudgeText: row.nudge_text,
    deliveryStatus: row.delivery_status,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export class PostgresStore implements PostureStore {
  readonly kind = "postgres" as const;
  private pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: Number(process.env.DATABASE_POOL_SIZE || 5) });
  }

  async init() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id text PRIMARY KEY, first_name text NOT NULL, last_name text NOT NULL,
        email text NOT NULL, phone text UNIQUE NOT NULL, photon_user_id text,
        opted_out boolean NOT NULL DEFAULT false, activated boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS user_settings (
        user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        slouch_seconds integer NOT NULL DEFAULT 30,
        sensitivity text NOT NULL DEFAULT 'medium',
        voice_id text NOT NULL,
        audio_enabled boolean NOT NULL DEFAULT true,
        snoozed_until bigint NOT NULL DEFAULT 0,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        started_at timestamptz NOT NULL, ended_at timestamptz NOT NULL,
        minutes integer NOT NULL, good_pct integer NOT NULL, alerts integer NOT NULL,
        top_issue text, stats jsonb NOT NULL, recap text
      );
      CREATE TABLE IF NOT EXISTS slouch_events (
        id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        session_id text, issue text NOT NULL, sustained_seconds integer NOT NULL,
        nudge_text text NOT NULL, delivery_status text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS conversation_messages (
        id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role text NOT NULL, content text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id, ended_at DESC);
      CREATE INDEX IF NOT EXISTS events_user_idx ON slouch_events(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS messages_user_idx ON conversation_messages(user_id, created_at DESC);
    `);
  }

  async close() { await this.pool.end(); }
  async findUserById(id: string) {
    const result = await this.pool.query("SELECT * FROM users WHERE id=$1", [id]);
    return result.rows[0] ? mapUser(result.rows[0]) : undefined;
  }
  async findUserByPhone(phone: string) {
    const result = await this.pool.query("SELECT * FROM users WHERE phone=$1", [phone]);
    return result.rows[0] ? mapUser(result.rows[0]) : undefined;
  }
  async findUserByAddress(address: string) {
    if (address.includes("@")) {
      const result = await this.pool.query("SELECT * FROM users WHERE lower(email)=lower($1)", [address]);
      return result.rows[0] ? mapUser(result.rows[0]) : undefined;
    }
    const ending = address.replace(/\D/g, "").slice(-10);
    const result = await this.pool.query("SELECT * FROM users WHERE regexp_replace(phone, '\\D', '', 'g') LIKE $1 LIMIT 1", [`%${ending}`]);
    return result.rows[0] ? mapUser(result.rows[0]) : undefined;
  }
  async createUser(user: User) {
    await this.pool.query(
      `INSERT INTO users (id,first_name,last_name,email,phone,photon_user_id,opted_out,activated,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [user.id, user.firstName, user.lastName, user.email, user.phone, user.photonUserId, user.optedOut, user.activated, user.createdAt],
    );
  }
  async updateUser(user: User) {
    await this.pool.query(
      `UPDATE users SET first_name=$2,last_name=$3,email=$4,phone=$5,photon_user_id=$6,opted_out=$7,activated=$8 WHERE id=$1`,
      [user.id, user.firstName, user.lastName, user.email, user.phone, user.photonUserId, user.optedOut, user.activated],
    );
  }
  async getSettings(userId: string): Promise<UserSettings> {
    const result = await this.pool.query("SELECT * FROM user_settings WHERE user_id=$1", [userId]);
    const row = result.rows[0];
    if (!row) return defaultSettings(userId);
    return {
      userId: row.user_id,
      slouchSeconds: row.slouch_seconds,
      sensitivity: row.sensitivity,
      voiceId: row.voice_id,
      audioEnabled: row.audio_enabled,
      snoozedUntil: Number(row.snoozed_until),
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }
  async saveSettings(settings: UserSettings) {
    await this.pool.query(
      `INSERT INTO user_settings (user_id,slouch_seconds,sensitivity,voice_id,audio_enabled,snoozed_until,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (user_id) DO UPDATE SET slouch_seconds=excluded.slouch_seconds,sensitivity=excluded.sensitivity,
       voice_id=excluded.voice_id,audio_enabled=excluded.audio_enabled,snoozed_until=excluded.snoozed_until,updated_at=excluded.updated_at`,
      [settings.userId, settings.slouchSeconds, settings.sensitivity, settings.voiceId, settings.audioEnabled, settings.snoozedUntil, settings.updatedAt],
    );
  }
  async saveSession(session: SessionRecord) {
    await this.pool.query(
      `INSERT INTO sessions (id,user_id,started_at,ended_at,minutes,good_pct,alerts,top_issue,stats,recap)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [session.id, session.userId, session.start, session.end, session.minutes, session.goodPct, session.alerts, session.topIssue, session.stats, session.recap],
    );
  }
  async recordSlouchEvent(event: SlouchEvent) {
    await this.pool.query(
      `INSERT INTO slouch_events (id,user_id,session_id,issue,sustained_seconds,nudge_text,delivery_status,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [event.id, event.userId, event.sessionId, event.issue, event.sustainedSeconds, event.nudgeText, event.deliveryStatus, event.createdAt],
    );
  }
  async latestSlouchEvent(userId: string) {
    const result = await this.pool.query("SELECT * FROM slouch_events WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1", [userId]);
    return result.rows[0] ? mapEvent(result.rows[0]) : undefined;
  }
  async appendConversation(message: ConversationMessage) {
    await this.pool.query(
      "INSERT INTO conversation_messages (id,user_id,role,content,created_at) VALUES ($1,$2,$3,$4,$5)",
      [message.id, message.userId, message.role, message.content, message.createdAt],
    );
  }
  async conversation(userId: string, limit = 20): Promise<ConversationMessage[]> {
    const result = await this.pool.query(
      "SELECT * FROM conversation_messages WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2",
      [userId, limit],
    );
    return result.rows.reverse().map((row) => ({
      id: row.id,
      userId: row.user_id,
      role: row.role,
      content: row.content,
      createdAt: new Date(row.created_at).toISOString(),
    }));
  }
  async demoStats(userId: string): Promise<DemoStats> {
    const sessions = await this.pool.query("SELECT * FROM sessions WHERE user_id=$1 ORDER BY ended_at", [userId]);
    const events = await this.pool.query("SELECT * FROM slouch_events WHERE user_id=$1 ORDER BY created_at", [userId]);
    return aggregateStats(
      sessions.rows.map((row) => ({
        id: row.id, userId: row.user_id, start: new Date(row.started_at).toISOString(),
        end: new Date(row.ended_at).toISOString(), minutes: row.minutes, goodPct: row.good_pct,
        alerts: row.alerts, topIssue: row.top_issue, stats: row.stats || emptyStats(), recap: row.recap,
      })),
      events.rows.map(mapEvent),
    );
  }
}

function aggregateStats(sessions: SessionRecord[], events: SlouchEvent[]): DemoStats {
  const totalTracked = sessions.reduce((sum, session) => sum + session.stats.goodSeconds + session.stats.badSeconds, 0);
  const good = sessions.reduce((sum, session) => sum + session.stats.goodSeconds, 0);
  const issueCounts = events.reduce<Record<string, number>>((counts, event) => {
    counts[event.issue] = (counts[event.issue] || 0) + 1;
    return counts;
  }, {});
  const days = new Set(sessions.map((session) => session.end.slice(0, 10)));
  let streak = 0;
  const cursor = new Date();
  while (days.has(cursor.toISOString().slice(0, 10))) {
    streak++;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return {
    sessions: sessions.length,
    totalMinutes: sessions.reduce((sum, session) => sum + session.minutes, 0),
    uprightPct: totalTracked ? Math.round((good / totalTracked) * 100) : 100,
    alerts: sessions.reduce((sum, session) => sum + session.alerts, 0),
    slouchEvents: events.length,
    currentStreakDays: streak,
    topIssue: Object.entries(issueCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null,
    lastSessionAt: sessions.at(-1)?.end || null,
  };
}

export async function createStore(): Promise<PostureStore> {
  if (!process.env.DATABASE_URL && process.env.NEON_DATA_API_URL) {
    console.warn(
      "NEON_DATA_API_URL is set, but PostgREST access needs a JWT and this server uses pg. " +
      "Set DATABASE_URL to the pooled Neon Postgres connection string; using memory until then.",
    );
  }
  const store: PostureStore = process.env.DATABASE_URL
    ? new PostgresStore(process.env.DATABASE_URL)
    : new MemoryStore();
  await store.init();
  console.log(`Storage ready: ${store.kind}`);
  return store;
}
