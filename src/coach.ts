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

export function templateNudge(user: User, issue: string): string {
  const name = user.firstName;
  const problem = issueLabel(issue);
  const cue = physicalCue(issue);
  return `${name}, you're ${problem} — sit up tall right now. ${cue} Stay with it; you’re building stronger posture every minute!`;
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
  const lead = `${user.firstName}, session debrief: ${mins} minute${mins === 1 ? "" : "s"} tracked, ${nudges} nudge${nudges === 1 ? "" : "s"} sent, and ${upright}% upright time this session.`;
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

export async function personalizedNudge(input: {
  user: User;
  issue: string;
  seconds: number;
  current: Stats;
  history: DemoStats;
}): Promise<GeneratedCopy> {
  const fallback = templateNudge(input.user, input.issue);
  const label = issueLabel(input.issue);
  return generate(
    `You are PosturePal, an energetic posture coach speaking to ${input.user.firstName} mid-session (this will be read aloud).
Write exactly TWO sentences (about 35–55 words total). Sentence 1: name what is wrong (${label}) and tell them to sit up tall. Sentence 2: one clear physical cue and a motivational close.
Be warm, loud-in-spirit, and specific — not a one-liner. No hashtags, guilt, diagnosis, or mention of cameras/AI.
Issue held for ${input.seconds}s. Session so far: ${Math.round(input.current.goodSeconds)}s upright, ${Math.round(input.current.badSeconds)}s slouching, ${input.current.alerts} prior nudges.
Lifetime context: ${input.history.sessions} saved sessions, ${input.history.uprightPct}% historical upright.`,
    fallback,
    220,
  );
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
  return generate(
    `You are PosturePal giving ${input.user.firstName} a spoken end-of-session debrief (two or three sentences, under 70 words).
MUST include ALL of these exact facts: ${input.debrief.minutes} minutes, ${input.debrief.nudges} nudges, ${input.debrief.uprightPct}% upright this session.
${comparisonLine}
Top slouch pattern this session: ${input.topIssue || "none noted"}.
Sound upbeat and proud. Do not invent numbers.`,
    fallback,
    280,
  );
}

export async function conversationalReply(input: {
  user: User;
  message: string;
  stats: DemoStats;
  recent: ConversationMessage[];
  lastIssue: string | null;
}): Promise<string> {
  const fallback = input.stats.sessions
    ? `You’re at ${input.stats.sessions} sessions and ${input.stats.uprightPct}% upright lifetime — roll those shoulders back and breathe big!`
    : "Start a session and I’ll coach with your real numbers. For now: feet flat, chest open, go!";
  const history = input.recent.map((entry) => `${entry.role}: ${entry.content}`).join("\n");
  const result = await generate(
    `You are PosturePal, a concise iMessage posture coach for ${input.user.firstName}.
Answer in at most 50 words with warm, motivational energy. Never invent stats or diagnose injuries.
Data: ${JSON.stringify(input.stats)}. Last issue: ${input.lastIssue || "none"}.
Recent:
${history || "(none)"}
user: ${input.message}`,
    fallback,
    180,
  );
  return result.message;
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
