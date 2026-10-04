import { GoogleGenAI } from "@google/genai";
import type { DemoStats, User, ConversationMessage } from "./store.js";
import type { Stats } from "./core.js";

export const VOICES = [
  { id: "JBFqnCBsd6RMkjVDRZzb", name: "George — warm" },
  { id: "21m00Tcm4TlvDq8ikWAM", name: "Rachel — calm" },
  { id: "pNInz6obpgDQGcFmaJgB", name: "Adam — direct" },
] as const;

const fallbacks: Record<string, string[]> = {
  slouching: ["Shoulders back, chin up.", "Reset: ribs over hips, shoulders loose.", "Sit tall for the next few breaths."],
  "head forward": ["Bring your ears back over your shoulders.", "Tuck your chin gently and move the screen closer."],
  "leaning in": ["Sit back into your chair and bring the screen to you.", "Give your eyes some space. Scoot back."],
  tilted: ["Level your shoulders and put both feet on the floor.", "Center your weight instead of leaning to one side."],
};

const pick = (values: string[]) => values[Math.floor(Math.random() * values.length)]!;
const ai = process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;
const model = process.env.GEMINI_MODEL || "gemini-3.8-flash";

async function generate(prompt: string, fallback: string): Promise<string> {
  if (!ai) return fallback;
  try {
    const response = await ai.models.generateContent({
      model,
      contents: prompt,
      config: { temperature: 0.7, maxOutputTokens: 120 },
    });
    return response.text?.trim() || fallback;
  } catch (error) {
    console.error("Gemini generation failed; using template.", String((error as Error).message || error));
    return fallback;
  }
}

export async function personalizedNudge(input: {
  user: User;
  issue: string;
  seconds: number;
  current: Stats;
  history: DemoStats;
}): Promise<string> {
  const fallback = pick(fallbacks[input.issue] || fallbacks.slouching!);
  return generate(
    `You are PosturePal, a practical posture coach texting ${input.user.firstName}.
Write one plain-language posture correction under 22 words. No hashtags, diagnosis, guilt, or camera mention.
Current issue: ${input.issue} for ${input.seconds} seconds.
This session: ${Math.round(input.current.goodSeconds)} upright seconds, ${Math.round(input.current.badSeconds)} slouch seconds, ${input.current.alerts} prior nudges.
History: ${input.history.sessions} sessions, ${input.history.uprightPct}% upright, top issue ${input.history.topIssue || "none yet"}.
Give one specific physical action and vary the wording.`,
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
}): Promise<string> {
  const fallback = `Done: ${input.minutes} min, ${input.goodPct}% upright, ${input.alerts} nudges. ${input.topIssue ? `Watch for ${input.topIssue} next time.` : "Solid posture session."}`;
  return generate(
    `You are PosturePal. Give ${input.user.firstName} a spoken end-of-session recap in at most 38 words.
Use these exact facts: ${input.minutes} minutes, ${input.goodPct}% upright, ${input.alerts} nudges, top issue ${input.topIssue || "none"}.
They have completed ${input.history.sessions} earlier sessions and their historical upright rate is ${input.history.uprightPct}%.
Compare only when facts support it. End with one concrete adjustment. No hype or medical claims.`,
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
    ? `You have ${input.stats.sessions} sessions and ${input.stats.uprightPct}% upright time. Try a 30-second shoulder reset now.`
    : "Start a session so I can answer with your posture numbers. For now, put both feet down and relax your shoulders.";
  const history = input.recent.map((entry) => `${entry.role}: ${entry.content}`).join("\n");
  return generate(
    `You are PosturePal, a concise two-way iMessage posture coach for ${input.user.firstName}.
Answer the latest message in at most 45 words using their real data. Never invent numbers or diagnose an injury.
Real data: ${JSON.stringify(input.stats)}. Last detected issue: ${input.lastIssue || "none"}.
Recent conversation:
${history || "(none)"}
user: ${input.message}
Reply naturally. Mention at most two numbers and give one actionable posture step when useful.`,
    fallback,
  );
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
