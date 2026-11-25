// SECURECASEDESK_DETAINEES_V22_S3A
// Pure validation helpers (no database). Errors are plain Error('CODE:detail').

export function requireText(value: unknown, field: string): string {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s) throw new Error('VALIDATION:' + field);
  return s;
}

export function optionalText(value: unknown): string | null {
  const s = typeof value === 'string' ? value.trim() : '';
  return s ? s : null;
}

export function optionalInt(value: unknown, field: string): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error('VALIDATION:' + field);
  }
  return value;
}

export function startOfDay(ts: number): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function endOfDay(ts: number): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999).getTime();
}

export function requireTimestamp(value: unknown, field: string, now: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error('VALIDATION:' + field);
  }
  if (value > endOfDay(now)) throw new Error('VALIDATION:' + field + '_future');
  return value;
}
