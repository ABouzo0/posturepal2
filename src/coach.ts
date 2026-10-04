import { GoogleGenAI } from "@google/genai";
import type { DemoStats, User, ConversationMessage } from "./store.js";
import type { Stats } from "./core.js";

export const VOICES = [
  { id: "JBFqnCBsd6RMkjVDRZzb", name: "George — warm" },
  { id: "21m00Tcm4TlvDq8ikWAM", name: "Rachel — calm" },
  { id: "pNInz6obpgDQGcFmaJgB", name: "Adam — direct" },
] as const;

export type GeneratedCopy = { message: string; generatedBy: "gemini" | "template" };

export type SessionDebrief = {
  minutes: number;
  nudges: number;
  uprightPct: number;
  lifetimeUprightPct: number | null;
  comparison: "first_session" | "higher" | "lower" | "equal";
  deltaPct: number | null;
};

const ai = process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;

function modelChain(): string[] {
  const preferred = process.env.GEMINI_MODEL || "gemini-3.8-flash";
  return [...new Set([preferred, "gemini-3.8-flash", "gemini-flash-latest", "gemini-3-flash-preview"].filter(Boolean))];
}

function retryableGeminiError(error: unknown): boolean {
  const message = String((error as Error).message || error);
  return /503|429|UNAVAILABLE|high demand|rate limit/i.test(message);
}

function issueLabel(issue: string): string {
  const labels: Record<string, string> = {
    slouching: "slouching with your head dropped",
    "head forward": "leaning forward with your head ahead of your shoulders",
    "leaning in": "leaning too close to the screen",
    tilted: "sitting unevenly with one shoulder lifted",
    "forward-head": "leaning forward with your head ahead of your shoulders",
  };
  return labels[issue] || `slouching (${issue.replace(/-/g, " ")})`;
}

function physicalCue(issue: string): string {
  const cues: Record<string, string> = {
    slouching: "Stack your ribs over your hips, lift your chest, and lengthen the back of your neck.",
    "head forward": "Sit up tall and pull your ears back over your shoulders with a gentle chin tuck.",
    "forward-head": "Sit up tall and pull your ears back over your shoulders with a gentle chin tuck.",
    "leaning in": "Sit back in your chair, plant both feet, and bring the screen up to eye level.",
    tilted: "Level your shoulders, square your sternum, and press both feet evenly into the floor.",
  };
  return cues[issue] || cues.slouching!;
}

export function pickUseName(userId: string, salt: string): boolean {
  let hash = 0;
  const key = `${userId}:${salt}`;
  for (let i = 0; i < key.length; i += 1) hash = (hash * 33 + key.charCodeAt(i)) >>> 0;
  return hash % 100 < 34;
}

export function isExerciseQuestion(message: string): boolean {
  return /exercise|stretch|strengthen|sit up straight|desk routine|what can i do|help me sit|posture drill|workout|mobility/i.test(message);
}

export const IMESSAGE_MAX_CHARS = 320;

export function mentionsCommandMenu(text: string): boolean {
  const lower = text.toLowerCase();
  if (/try (stats|snooze|why|stop)|text stats|when you need quick|what you can text|command menu|only options/i.test(lower)) return true;
  const hits = ["stats", "snooze", " why", "stop"].filter((token) => lower.includes(token.trim()));
  return hits.length >= 2;
}

export function clampCoachReply(text: string, allowLong = false): string {
  const trimmed = text.replace(/\n{3,}/g, "\n\n").trim();
  if (!trimmed) return "";
  if (!allowLong && mentionsCommandMenu(trimmed)) return "";
  if (allowLong || trimmed.length <= IMESSAGE_MAX_CHARS) return trimmed;
  const maxBody = IMESSAGE_MAX_CHARS - 1;
  const cut = trimmed.slice(0, maxBody);
  const boundary = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "), cut.lastIndexOf("\n"));
  if (boundary > 80) return cut.slice(0, boundary + 1).trim();
  return `${cut.trim()}…`.slice(0, IMESSAGE_MAX_CHARS);
}

export function finalizeCoachReply(answer: string, options: { allowLong?: boolean; allowCommands?: boolean } = {}): string {
  if (options.allowCommands) return clampCoachReply(answer, true);
  if (mentionsCommandMenu(answer)) return "I'm here — tell me what's feeling tight or slouchy.";
  const clamped = clampCoachReply(answer, options.allowLong);
  return clamped || "I'm here — tell me what's feeling tight or slouchy.";
}

export function isGreeting(message: string): boolean {
  return /^(hi|hey|hello|yo|sup|good (morning|afternoon|evening))[\s!.?]*$/i.test(message.trim());
}

export function isThanks(message: string): boolean {
  return /^(thanks|thank you|thx|ty|appreciate it)[\s!.?]*$/i.test(message.trim());
}

function shortDeskCues(issue: string | null): [string, string, string] {
  const key = issue && /head|forward/.test(issue) ? "head forward" : issue || "slouching";
  const bank: Record<string, [string, string, string]> = {
    slouching: [
      "Sit tall — ribs stacked over hips, 5 slow breaths",
      "Pinch shoulder blades back, hold 5 sec, repeat 10x",
      "Feet flat, unclench jaw, lengthen the back of your neck",
    ],
    "head forward": [
      "Chin tuck — head straight back, hold 5 sec, 8 reps",
      "Ears over shoulders; open chest without arching low back",
      "Bring phone or screen up — stop hovering toward the desk",
    ],
    "leaning in": [
      "Scoot hips back until your back meets the chair rest",
      "Forearms on desk, shoulders melted down, screen at eye level",
      "Stand break — 30 sec march, roll shoulders back",
    ],
    tilted: [
      "Even both sit bones; level hips and shoulders",
      "Gentle side neck stretch — 20 sec each way",
      "Reach one arm up and lean away from the tight side",
    ],
  };
  return bank[key] || bank.slouching!;
}

export function exerciseFallback(input: {
  stats: DemoStats;
  lastIssue: string | null;
}): string {
  const focus = input.stats.topIssue || input.lastIssue || "slouching";
  const [a, b, c] = shortDeskCues(focus);
  const label = focus.replace(/-/g, " ");
  const intro = input.stats.sessions
    ? `For ${label} (your logs: ${input.stats.uprightPct}% upright):`
    : "Quick desk reset:";
  return clampCoachReply(`${intro}\n• ${a}\n• ${b}\n• ${c}`);
}

export function templateNudge(user: User, issue: string): string {
  const useName = pickUseName(user.id, issue);
  const opener = useName ? `${user.firstName}, you're` : "You're";
  const problem = issueLabel(issue);
  const cue = physicalCue(issue);
  return `${opener} ${problem} — sit up tall right now. ${cue} Stay with it; you’re building stronger posture every minute!`;
}

export function buildSessionDebrief(input: {
  minutes: number;
  goodPct: number;
  nudges: number;
  priorHistory: DemoStats;
}): SessionDebrief {
  if (input.priorHistory.sessions === 0) {
    return {
      minutes: input.minutes,
      nudges: input.nudges,
      uprightPct: input.goodPct,
      lifetimeUprightPct: null,
      comparison: "first_session",
      deltaPct: null,
    };
  }
  const lifetime = input.priorHistory.uprightPct;
  const delta = input.goodPct - lifetime;
  let comparison: SessionDebrief["comparison"] = "equal";
  if (delta > 0) comparison = "higher";
  else if (delta < 0) comparison = "lower";
  return {
    minutes: input.minutes,
    nudges: input.nudges,
    uprightPct: input.goodPct,
    lifetimeUprightPct: lifetime,
    comparison,
    deltaPct: Math.abs(delta),
  };
}

export function templateSessionRecap(user: User, debrief: SessionDebrief): string {
  const mins = debrief.minutes;
  const nudges = debrief.nudges;
  const upright = debrief.uprightPct;
  const named = pickUseName(user.id, `recap-${debrief.minutes}-${debrief.uprightPct}`);
  const prefix = named ? `${user.firstName}, session debrief:` : "Session debrief:";
  const lead = `${prefix} ${mins} minute${mins === 1 ? "" : "s"} tracked, ${nudges} nudge${nudges === 1 ? "" : "s"} sent, and ${upright}% upright time this session.`;
  if (debrief.comparison === "first_session") {
    return `${lead} This is your first PosturePal session, so there is no lifetime average yet — great start. Sit tall and we will compare your next sessions to today!`;
  }
  const avg = debrief.lifetimeUprightPct!;
  if (debrief.comparison === "equal") {
    return `${lead} That matches your lifetime average of ${avg}% upright. Keep stacking those calm, aligned minutes!`;
  }
  const direction = debrief.comparison === "higher" ? "higher" : "lower";
  return `${lead} That is ${debrief.deltaPct} points ${direction} than your lifetime average of ${avg}% upright. ${direction === "higher" ? "Strong work — ride that momentum!" : "Reset tall now and aim to beat your average next time!"}`;
}

async function generate(prompt: string, fallback: string, maxOutputTokens = 220): Promise<GeneratedCopy> {
  if (!ai) return { message: fallback, generatedBy: "template" };
  for (const model of modelChain()) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await ai.models.generateContent({
          model,
          contents: prompt,
          config: { temperature: 0.92, maxOutputTokens },
        });
        const text = response.text?.trim();
        if (text) return { message: text, generatedBy: "gemini" };
      } catch (error) {
        const detail = String((error as Error).message || error);
        console.error(`Gemini failed (${model}, attempt ${attempt + 1}): ${detail.slice(0, 240)}`);
        if (!retryableGeminiError(error)) break;
        await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
      }
    }
  }
  return { message: fallback, generatedBy: "template" };
}

function nudgeLooksComplete(message: string): boolean {
  const words = message.split(/\s+/).filter(Boolean);
  return words.length >= 18 && message.length >= 90;
}

function conversationLooksComplete(message: string, exercise: boolean): boolean {
  if (mentionsCommandMenu(message)) return false;
  if (message.length > IMESSAGE_MAX_CHARS) return false;
  if (exercise) {
    if (message.length < 60) return false;
    return message.includes("•") || /\d[\).\]]/.test(message) || message.split("\n").length >= 2;
  }
  const words = message.split(/\s+/).filter(Boolean);
  return words.length >= 4 && message.length >= 20;
}

function recapLooksComplete(message: string, debrief: SessionDebrief): boolean {
  if (message.length < 120) return false;
  if (!message.includes(String(debrief.minutes))) return false;
  if (!message.includes(String(debrief.nudges))) return false;
  if (!message.includes(String(debrief.uprightPct))) return false;
  if (debrief.comparison === "first_session") return /first/i.test(message);
  return debrief.lifetimeUprightPct !== null && message.includes(String(debrief.lifetimeUprightPct));
}

export async function personalizedNudge(input: {
  user: User;
  issue: string;
  seconds: number;
  current: Stats;
  history: DemoStats;
}): Promise<GeneratedCopy> {
  const fallback = templateNudge(input.user, input.issue);
  const label = issueLabel(input.issue);
  const result = await generate(
    `You are PosturePal, an energetic posture coach speaking mid-session (this will be read aloud).
${pickUseName(input.user.id, input.issue) ? `You may use ${input.user.firstName}'s first name once.` : "Do not use their first name."}
Write exactly TWO sentences (about 35–55 words total). Sentence 1: name what is wrong (${label}) and tell them to sit up tall. Sentence 2: one clear physical cue and a motivational close.
Be warm, loud-in-spirit, and specific — not a one-liner. No hashtags, guilt, diagnosis, or mention of cameras/AI.
Issue held for ${input.seconds}s. Session so far: ${Math.round(input.current.goodSeconds)}s upright, ${Math.round(input.current.badSeconds)}s slouching, ${input.current.alerts} prior nudges.
Lifetime context: ${input.history.sessions} saved sessions, ${input.history.uprightPct}% historical upright.`,
    fallback,
    220,
  );
  if (result.generatedBy === "gemini" && !nudgeLooksComplete(result.message)) {
    return { message: fallback, generatedBy: "template" };
  }
  return result;
}

export async function sessionRecap(input: {
  user: User;
  debrief: SessionDebrief;
  topIssue: string | null;
}): Promise<GeneratedCopy> {
  const fallback = templateSessionRecap(input.user, input.debrief);
  const comparisonLine = input.debrief.comparison === "first_session"
    ? "Say this is their first PosturePal session and do NOT compare to a lifetime average."
    : input.debrief.comparison === "equal"
      ? `Say their ${input.debrief.uprightPct}% upright matches their lifetime average of ${input.debrief.lifetimeUprightPct}%.`
      : `Say their ${input.debrief.uprightPct}% upright is ${input.debrief.deltaPct} points ${input.debrief.comparison} than their lifetime average of ${input.debrief.lifetimeUprightPct}%.`;
  const result = await generate(
    `You are PosturePal giving ${input.user.firstName} a spoken end-of-session debrief (two or three sentences, under 70 words).
MUST include ALL of these exact facts: ${input.debrief.minutes} minutes, ${input.debrief.nudges} nudges, ${input.debrief.uprightPct}% upright this session.
${comparisonLine}
Top slouch pattern this session: ${input.topIssue || "none noted"}.
Sound upbeat and proud. Do not invent numbers.`,
    fallback,
    280,
  );
  if (result.generatedBy === "gemini" && !recapLooksComplete(result.message, input.debrief)) {
    return { message: fallback, generatedBy: "template" };
  }
  return result;
}

export async function conversationalReply(input: {
  user: User;
  message: string;
  stats: DemoStats;
  recent: ConversationMessage[];
  lastIssue: string | null;
}): Promise<string> {
  const useName = pickUseName(input.user.id, input.message);
  const exercise = isExerciseQuestion(input.message);
  const exerciseFallbackText = exerciseFallback({ stats: input.stats, lastIssue: input.lastIssue });

  if (isThanks(input.message)) {
    return finalizeCoachReply("You're welcome — glad I could help.");
  }
  if (isGreeting(input.message)) {
    const greet = useName ? `Hey ${input.user.firstName}! What's up?` : "Hey! What's up?";
    return finalizeCoachReply(greet);
  }

  const nameHint = useName ? `You may use their first name once.` : "Do not use their first name.";
  const generalFallback = input.stats.sessions
    ? `I'm tracking about ${input.stats.uprightPct}% upright for you lately. What's feeling off right now?`
    : "Tell me what feels tight or slouchy — I'm here to help.";

  const history = input.recent.map((entry) => `${entry.role}: ${entry.content}`).join("\n");
  const dataBlock = JSON.stringify({
    uprightPct: input.stats.uprightPct,
    topIssue: input.stats.topIssue,
    lastDetectedIssue: input.lastIssue,
    alerts: input.stats.alerts,
  });

  if (exercise) {
    const result = await generate(
      `You are PosturePal on iMessage. ${nameHint}
User wants desk exercises. Use their data: ${dataBlock}
Reply in under 280 characters: one short intro line, then 2-3 bullet lines starting with "•". Each bullet is one short cue. No command keywords. No essays.`,
      exerciseFallbackText,
      140,
    );
    const candidate = result.generatedBy === "gemini" && conversationLooksComplete(result.message, true)
      ? result.message
      : exerciseFallbackText;
    return finalizeCoachReply(candidate);
  }

  const result = await generate(
    `You are PosturePal on iMessage — talk like a person, not a bot. ${nameHint}
Reply in 1-2 short sentences (under 220 characters). Match their tone. Never list commands or say "try stats/snooze/why/stop".
Use real data only if it fits naturally: ${dataBlock}
Recent:
${history || "(none)"}
user: ${input.message}`,
    generalFallback,
    120,
  );
  const candidate = result.generatedBy === "gemini" && conversationLooksComplete(result.message, false)
    ? result.message
    : generalFallback;
  return finalizeCoachReply(candidate);
}

export function whyReply(issue: string | null, seconds?: number): string {
  if (!issue) return "I have not logged a slouch event yet. Start tracking, then ask “why” after a nudge.";
  const action: Record<string, string> = {
    slouching: "your head dropped relative to your calibrated shoulder line",
    "head forward": "your ears moved forward and down from calibration",
    "leaning in": "your shoulders appeared larger because you moved toward the screen",
    tilted: "one shoulder stayed higher than the other",
  };
  return `That nudge fired because ${action[issue] || `I detected ${issue}`}${seconds ? ` for ${seconds} seconds` : ""}.`;
}
