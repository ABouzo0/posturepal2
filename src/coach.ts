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

function deskExercisesFor(issue: string | null): [string, string, string] {
  const key = issue && /head|forward/.test(issue) ? "head forward" : issue || "slouching";
  const bank: Record<string, [string, string, string]> = {
    slouching: [
      "Seated thoracic lift: both feet flat, press sit bones down, grow tall through the crown for 15 seconds, repeat 5 times.",
      "Scapular squeeze: pinch shoulder blades together behind you, hold 5 seconds, release slowly for 10 reps.",
      "Rib-over-hip reset: exhale, gently draw ribs back over pelvis, then breathe into your upper back.",
    ],
    "head forward": [
      "Chin tuck: slide your head straight back (give yourself a double-chin), hold 5 seconds, repeat 8 times.",
      "Wall angel at your chair: sit tall, arms in a W, slide them up and down keeping ribs stacked.",
      "Chest opener: clasp hands behind the chair, lift sternum, hold 20 seconds, repeat 3 times.",
    ],
    "leaning in": [
      "Hip hinge reset: scoot hips back in the chair until your back meets the rest, then bring the screen closer to eye level.",
      "Standing break: stand, roll shoulders back, march in place 30 seconds every 30 minutes.",
      "Forearm shelf: elbows on desk at ~90°, let shoulders melt down away from ears for 20 seconds.",
    ],
    tilted: [
      "Pelvis leveler: feel both sit bones evenly, shift hips until weight is balanced, hold 10 seconds.",
      "Side neck stretch: gently tilt ear toward shoulder each side for 20 seconds to release the high shoulder.",
      "Single-arm reach: reach one arm overhead and lean slightly away to lengthen the compressed side.",
    ],
  };
  return bank[key] || bank.slouching!;
}

export function exerciseFallback(input: {
  stats: DemoStats;
  lastIssue: string | null;
}): string {
  const focus = input.stats.topIssue || input.lastIssue || "slouching";
  const [a, b, c] = deskExercisesFor(focus);
  const context = input.stats.sessions
    ? `Your logs point to ${focus.replace(/-/g, " ")} as a main pattern, with ${input.stats.uprightPct}% upright time and ${input.stats.alerts} nudges so far. `
    : "Try these at your desk to stack a taller sitting habit: ";
  return `${context}1) ${a} 2) ${b} 3) ${c}`;
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
  if (exercise) {
    if (message.length < 120) return false;
    const bullets = message.match(/\d[\).\]]/g)?.length || 0;
    return bullets >= 2 || message.split(/\n+/).length >= 3;
  }
  const words = message.split(/\s+/).filter(Boolean);
  return words.length >= 10 && message.length >= 45;
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
  const nameHint = useName ? `You may address them as ${input.user.firstName} once.` : "Do not use their first name in this reply.";
  const exercise = isExerciseQuestion(input.message);
  const exerciseFallbackText = exerciseFallback({ stats: input.stats, lastIssue: input.lastIssue });
  const generalFallback = input.stats.sessions
    ? `Looking at your numbers (${input.stats.uprightPct}% upright, top issue ${input.stats.topIssue || input.lastIssue || "still calibrating"}), think tall ribs over hips and micro-breaks every 30 minutes.`
    : "Start a browser session when you can so I can tie advice to your posture. Until then: both feet flat, hips back in the chair, screen at eye level.";

  const history = input.recent.map((entry) => `${entry.role}: ${entry.content}`).join("\n");
  const dataBlock = JSON.stringify({
    sessions: input.stats.sessions,
    uprightPct: input.stats.uprightPct,
    totalMinutes: input.stats.totalMinutes,
    alerts: input.stats.alerts,
    slouchEvents: input.stats.slouchEvents,
    topIssue: input.stats.topIssue,
    lastDetectedIssue: input.lastIssue,
  });

  if (exercise) {
    const result = await generate(
      `You are PosturePal, a friendly iMessage posture coach. ${nameHint}
The user asked for desk-friendly exercises. Use their REAL data below — tie drills to how they actually sit.
Data: ${dataBlock}
Give exactly 2-3 numbered desk exercises they can do in a chair (concrete reps/holds). No medical claims. No telling them to text "stats". Under 90 words.`,
      exerciseFallbackText,
      320,
    );
    const text = result.generatedBy === "gemini" && conversationLooksComplete(result.message, true)
      ? result.message
      : exerciseFallbackText;
    return text;
  }

  const result = await generate(
    `You are PosturePal, a conversational iMessage posture coach — not a command bot. ${nameHint}
Answer naturally in 2-3 sentences (under 75 words). Use their real data when relevant; never invent numbers or diagnose injuries.
Do NOT list command keywords or tell them those are their only options.
Data: ${dataBlock}
Recent conversation:
${history || "(none)"}
user: ${input.message}`,
    generalFallback,
    260,
  );
  if (result.generatedBy === "gemini" && conversationLooksComplete(result.message, false)) return result.message;
  return generalFallback;
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
