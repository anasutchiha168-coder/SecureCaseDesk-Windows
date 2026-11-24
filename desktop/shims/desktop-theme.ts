// رموز التصميم لواجهة سطح المكتب (القسم 4). نسخة من src/constants/theme.ts و identity.ts دون استيراد من src
// (قاعدة المشروع: shims لا تستورد من src). اختبار parity.test يفشل إن انحرفت القيم عن الأصل.
export const DT = Object.freeze({
  bg0: '#070B16',
  bg1: '#0B1120',
  surface: '#111A2E',
  glassBorder: 'rgba(148, 163, 255, 0.14)',
  cyan: '#22D3EE',
  blue: '#3B82F6',
  gold: '#F5B73B',
  textPrimary: '#F9FAFB',
  textSecondary: '#9CA3AF',
  textMuted: '#6B7280',
  fontMedium: 'Cairo_500Medium',
  fontSemiBold: 'Cairo_600SemiBold',
  fontBold: 'Cairo_700Bold',
  fontExtraBold: 'Cairo_800ExtraBold',
  fontRegular: 'Cairo_400Regular',
});

export const DT_IDENTITY = Object.freeze({
  appName: 'SecureCaseDesk',
  appVersion: 'v2.2',
  department: 'إدارة المباحث الجنائية',
  tagline: 'نظام إدارة القضايا والاحتجاز',
});

export function tintColor(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + alpha + ')';
}
