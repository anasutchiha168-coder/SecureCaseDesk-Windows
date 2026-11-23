export const Colors = {
  background: '#0B1120', card: '#111A2E', secondary: '#16213B',
  primary: '#2563EB', primaryLight: '#3B82F6', secondaryAccent: '#38BDF8',
  success: '#22C55E', warning: '#F59E0B', danger: '#EF4444', info: '#38BDF8',
  textPrimary: '#F9FAFB', textSecondary: '#9CA3AF', textMuted: '#6B7280', textOnPrimary: '#FFFFFF',
  border: '#232C47', borderLight: '#33405F', overlay: 'rgba(11, 17, 32, 0.85)',
} as const;
export const Spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 48 } as const;
export const Radius = { sm: 10, md: 14, lg: 18, xl: 24, full: 999 } as const;
export const Fonts = {
  light: 'Cairo_300Light', regular: 'Cairo_400Regular', medium: 'Cairo_500Medium', semiBold: 'Cairo_600SemiBold',
  bold: 'Cairo_700Bold', extraBold: 'Cairo_800ExtraBold',
} as const;
export const FontSizes = { xs: 11, sm: 13, md: 15, lg: 17, xl: 20, xxl: 24, xxxl: 30, display: 36 } as const;
export const Shadows = {
  card: { shadowColor: '#000000', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.3, shadowRadius: 14, elevation: 6 },
  primary: { shadowColor: Colors.primary, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.35, shadowRadius: 12, elevation: 8 },
} as const;

// ===== SECURECASEDESK_UI_V2: نظام التصميم الموحد (إضافات فقط؛ لا تغيير على القيم القديمة) =====
export const Palette = {
  // خلفيات متدرجة: من الأعمق إلى الأفتح
  bg0: '#070B16', bg1: '#0B1120', bg2: '#0F1730', surface: '#111A2E', surfaceHi: '#16213B',
  glassBorder: 'rgba(148, 163, 255, 0.14)', glassFill: 'rgba(17, 26, 46, 0.72)',
  // ألوان دلالية
  blue: '#3B82F6', cyan: '#22D3EE', green: '#22C55E', gold: '#F5B73B', red: '#F0525A', purple: '#8B5CF6',
} as const;

// كل لون دلالي له لون فاتح للنص/الأيقونة ولون خافت للخلفية.
export function tint(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + alpha + ')';
}

export const Radius2 = { card: 22, tile: 18, chip: 999, button: 16 } as const;

// سلّم الخطوط (Cairo فقط: هو المحمَّل في _layout)
export const Type = {
  display: { fontFamily: Fonts.bold, fontSize: 30, lineHeight: 44 },
  h1: { fontFamily: Fonts.semiBold, fontSize: 22, lineHeight: 34 },
  h2: { fontFamily: Fonts.semiBold, fontSize: 18, lineHeight: 28 },
  h3: { fontFamily: Fonts.medium, fontSize: 15, lineHeight: 24 },
  bodyLg: { fontFamily: Fonts.medium, fontSize: 15, lineHeight: 26 },
  body: { fontFamily: Fonts.regular, fontSize: 13, lineHeight: 22 },
  caption: { fontFamily: Fonts.regular, fontSize: 11, lineHeight: 18 },
  stat: { fontFamily: Fonts.light, fontSize: 34, lineHeight: 46 },
} as const;

export const Glow = (color: string) => ({
  shadowColor: color, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.28, shadowRadius: 14, elevation: 6,
});

// SECURECASEDESK_SMOOTH_UI: خطوط أخف (Cairo Light/Medium/SemiBold) لمظهر أنعم.
