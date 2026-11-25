// SECURECASEDESK_DETAINEES_V22_S3A
// Constants for the detainees services (Arabic text is written as \u escapes on purpose).

export const STATUS_HELD = '\u0645\u062D\u062A\u062C\u0632';
export const STATUS_RELEASED = '\u0645\u0641\u0631\u062C \u0639\u0646\u0647';

export const MOVE_ADMISSION = '\u0625\u064A\u062F\u0627\u0639';
export const MOVE_RELEASE = '\u0625\u0641\u0631\u0627\u062C';
export const MOVE_TRANSFER = '\u0646\u0642\u0644';
export const MOVE_CORRECTION = '\u062A\u0635\u062D\u064A\u062D';

export const REASON_ADMISSION = '\u062A\u0633\u062C\u064A\u0644 \u062F\u062E\u0648\u0644 \u0627\u0644\u0645\u062D\u062A\u062C\u0632';
export const REASON_RELEASE = '\u0625\u0641\u0631\u0627\u062C \u0639\u0646 \u0627\u0644\u0645\u062D\u062A\u062C\u0632';
export const REASON_TRANSFER = '\u0646\u0642\u0644 \u0627\u0644\u0645\u062D\u062A\u062C\u0632';

export const FIELD_LABELS = {
  full_name: '\u0627\u0644\u0627\u0633\u0645',
  alleged_offense: '\u0627\u0644\u062A\u0647\u0645\u0629',
} as const;

export function authorityLabel(
  categoryName: string | null | undefined,
  authority: string | null | undefined
): string {
  return [categoryName ?? '', authority ?? ''].map((s) => s.trim()).filter(Boolean).join(' - ');
}

// SECURECASEDESK_DETAINEES_V22_S6A
export const REASON_REDETENTION = '\u0625\u0639\u0627\u062F\u0629 \u0627\u062D\u062A\u062C\u0627\u0632 - \u0627\u0644\u0641\u062A\u0631\u0629 ';
