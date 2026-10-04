export type Stats = {
  goodSeconds: number;
  badSeconds: number;
  awaySeconds: number;
  alerts: number;
  issueCounts: Record<string, number>;
};

export const MIN_SLOUCH_SECONDS = 5;
export const MAX_SLOUCH_SECONDS = 300;

export function normalizeSlouchSeconds(value: unknown, fallback = 30): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(MAX_SLOUCH_SECONDS, Math.max(MIN_SLOUCH_SECONDS, Math.round(number)));
}

export function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (raw.trim().startsWith("+") && digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

export function emptyStats(): Stats {
  return { goodSeconds: 0, badSeconds: 0, awaySeconds: 0, alerts: 0, issueCounts: {} };
}

export function goodPercent(stats: Stats): number {
  const total = stats.goodSeconds + stats.badSeconds;
  return total === 0 ? 100 : Math.round((stats.goodSeconds / total) * 100);
}

export function canSendAlert(input: {
  active: boolean;
  activated: boolean;
  optedOut: boolean;
  slouchSeconds: number;
  sustainedSeconds: number;
  now: number;
  snoozedUntil: number;
  lastAlertAt: number;
  cooldownMs: number;
}): { allowed: true } | { allowed: false; reason: string } {
  if (input.optedOut) return { allowed: false, reason: "unsubscribed" };
  if (!input.activated) return { allowed: false, reason: "needs-reply" };
  if (!input.active) return { allowed: false, reason: "tracking-off" };
  if (input.sustainedSeconds < input.slouchSeconds) return { allowed: false, reason: "not-sustained" };
  if (input.now < input.snoozedUntil) return { allowed: false, reason: "snoozed" };
  if (input.now - input.lastAlertAt < input.cooldownMs) return { allowed: false, reason: "cooldown" };
  return { allowed: true };
}
