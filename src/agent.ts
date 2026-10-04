export type AgentCommand =
  | { type: "snooze"; minutes: number }
  | { type: "stats" }
  | { type: "why" }
  | { type: "stop" }
  | { type: "help" }
  | { type: "unsubscribe" }
  | { type: "subscribe" }
  | { type: "free-text"; text: string };

export function parseAgentCommand(raw: string): AgentCommand {
  const text = raw.trim();
  const normalized = text.toLowerCase();
  const snooze = normalized.match(/^snooze(?:\s+(\d+))?$/);
  if (snooze) return { type: "snooze", minutes: Math.min(240, Math.max(1, Number(snooze[1] || 30))) };
  if (/^(stats|status|how am i doing)\??$/.test(normalized)) return { type: "stats" };
  if (/^why\??$/.test(normalized)) return { type: "why" };
  if (/^(stop|end|off)$/.test(normalized)) return { type: "stop" };
  if (/^(help|\?)$/.test(normalized)) return { type: "help" };
  if (/^(unsubscribe|stop messages)$/.test(normalized)) return { type: "unsubscribe" };
  if (/^(subscribe|start messages)$/.test(normalized)) return { type: "subscribe" };
  return { type: "free-text", text };
}
