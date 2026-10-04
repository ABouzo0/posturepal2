import { GoogleGenAI } from "@google/genai";
import type { DemoStats, User, ConversationMessage } from "./store.js";
import type { Stats } from "./core.js";

export const VOICES = [
  { id: "JBFqnCBsd6RMkjVDRZzb", name: "George — warm" },
  { id: "21m00Tcm4TlvDq8ikWAM", name: "Rachel — calm" },
  { id: "pNInz6obpgDQGcFmaJgB", name: "Adam — direct" },
] as const;

export type GeneratedCopy = { message: string; generatedBy: "gemini" | "template" };

const fallbacks: Record<string, string[]> = {
  slouching: ["Shoulders back — sit tall like you mean it!", "Ribs over hips. Lift your chest. You’ve got this!", "Stack up tall for the next ten breaths."],
  "head forward": ["Pull your head back — ears over shoulders. Strong posture!", "Chin in, chest open. Show your neck some love."],
  "leaning in": ["Sit back in the chair — bring the screen to you!", "Scoot back and open your chest. Eyes need space too."],
  tilted: ["Level those shoulders. Both feet flat — reset now!", "Center your weight. Square up and breathe deep."],
};

const pick = (values: string[]) => values[Math.floor(Math.random() * values.length)]!;
const ai = process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;

function modelChain(): string[] {
  const preferred = process.env.GEMINI_MODEL || "gemini-3.8-flash";
  return [...new Set([preferred, "gemini-3.8-flash", "gemini-flash-latest", "gemini-3-flash-preview"].filter(Boolean))];
}

function retryableGeminiError(error: unknown): boolean {
  const message = String((error as Error).message || error);
  return /503|429|UNAVAILABLE|high demand|rate limit/i.test(message);
}

async function generate(prompt: string, fallback: string): Promise<GeneratedCopy> {
  if (!ai) return { message: fallback, generatedBy: "template" };
  for (const model of modelChain()) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await ai.models.generateContent({
          model,
          contents: prompt,
          config: { temperature: 0.95, maxOutputTokens: 120 },
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
  const fallback = pick(fallbacks[input.issue] || fallbacks.slouching!);
  return generate(
    `You are PosturePal, an energetic posture coach texting ${input.user.firstName} mid-session.
Write ONE short nudge (max 18 words) that feels loud-in-spirit, motivational, and human — like a friend cheering them on.
Use an exclamation or crisp imperative. No hashtags, guilt, diagnosis, or mention of cameras/AI.
Issue: ${input.issue} for ${input.seconds}s. Session upright ${Math.round(input.current.goodSeconds)}s, slouch ${Math.round(input.current.badSeconds)}s, ${input.current.alerts} prior nudges.
History: ${input.history.sessions} sessions, ${input.history.uprightPct}% upright. One concrete physical fix only.`,
    fallback,
  );
}

export async function sessionRecap(input: {
  user: User;
  minutes: number;
  goodPct: number;
  alerts: number;
  topIssue: string | null;
  history: DemoStats;
}): Promise<GeneratedCopy> {
  const fallback = `Nice work, ${input.user.firstName}! ${input.minutes} minutes, ${input.goodPct}% upright, ${input.alerts} nudges. ${input.topIssue ? `Next time, watch ${input.topIssue}.` : "Keep that energy up."}`;
  return generate(
    `You are PosturePal. Give ${input.user.firstName} a spoken end-of-session recap in at most 32 words.
Sound upbeat and proud — not flat. Use these facts: ${input.minutes} min, ${input.goodPct}% upright, ${input.alerts} nudges, top issue ${input.topIssue || "none"}.
${input.history.sessions} prior sessions, ${input.history.uprightPct}% historical upright. End with one energizing adjustment. No medical claims.`,
    fallback,
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
    ? `You’re at ${input.stats.sessions} sessions and ${input.stats.uprightPct}% upright — roll those shoulders back and breathe big!`
    : "Start a session and I’ll coach with your real numbers. For now: feet flat, chest open, go!";
  const history = input.recent.map((entry) => `${entry.role}: ${entry.content}`).join("\n");
  const result = await generate(
    `You are PosturePal, a concise iMessage posture coach for ${input.user.firstName}.
Answer in at most 40 words with warm, motivational energy. Never invent stats or diagnose injuries.
Data: ${JSON.stringify(input.stats)}. Last issue: ${input.lastIssue || "none"}.
Recent:
${history || "(none)"}
user: ${input.message}`,
    fallback,
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
