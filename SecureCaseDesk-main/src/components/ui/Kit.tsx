// SECURECASEDESK_UI_V3 — مكتبة المكونات الموحدة: كل الشاشات تبنى منها لتبدو منتجاً واحداً.
import React from 'react';
import {
  View, Text, TextInput, Pressable, Modal, ScrollView, StyleSheet, ActivityIndicator,
  KeyboardAvoidingView, Platform, type StyleProp, type ViewStyle, type TextInputProps,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Search, X, ChevronDown } from 'lucide-react-native';
import { Colors, Palette, Type, tint, Glow } from '@/constants/theme';
import { ROW } from '@/constants/rtl';
import { GradientFill } from './Gradient';
import { PressableScale, FadeIn } from './Motion';
import { Skeleton } from './Skeleton';

/* ───────────── هيكل الشاشة ───────────── */
export function Screen({ children }: { children: React.ReactNode }) {
  return (
    <SafeAreaView style={s.screen} edges={['top']}>
      <GradientFill colors={[Palette.bg0, Palette.bg1, Palette.bg2]} glow={{ color: Palette.blue, opacity: 0.1, cx: '100%', cy: '0%', r: '80%' }} />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding"><FormScope>{children}</FormScope></KeyboardAvoidingView>
    </SafeAreaView>
  );
}

export function IconBtn({ icon: Icon, onPress, color = Palette.cyan, label, solid }: {
  icon: React.ElementType; onPress: () => void; color?: string; label: string; solid?: boolean;
}) {
  return (
    <PressableScale onPress={onPress} accessibilityRole="button" accessibilityLabel={label}
      style={[s.iconBtn, solid
        ? { backgroundColor: color, borderColor: color, ...Glow(color) }
        : { backgroundColor: tint(color, 0.12), borderColor: tint(color, 0.4) }]}>
      <Icon color={solid ? '#fff' : color} size={20} />
    </PressableScale>
  );
}

export function PageHeader({ title, subtitle, icon: Icon, color = Palette.blue, actions }: {
  title: string; subtitle?: string; icon?: React.ElementType; color?: string; actions?: React.ReactNode;
}) {
  return (
    <FadeIn style={s.pageHeader}>
      <View style={{ flexDirection: ROW, alignItems: 'center', flex: 1 }}>
        {Icon ? (
          <View style={[s.hIcon, { backgroundColor: tint(color, 0.16), borderColor: tint(color, 0.45) }, Glow(color)]}>
            <Icon color={color} size={22} />
          </View>
        ) : null}
        <View style={{ flex: 1, paddingHorizontal: 12 }}>
          <Text style={[Type.h1, { color: Colors.textPrimary, textAlign: 'right' }]} numberOfLines={1}>{title}</Text>
          {subtitle ? <Text style={[Type.caption, { color: Colors.textMuted, textAlign: 'right' }]} numberOfLines={1}>{subtitle}</Text> : null}
        </View>
      </View>
      {actions ? <View style={{ flexDirection: ROW, gap: 8 }}>{actions}</View> : null}
    </FadeIn>
  );
}

export function SectionTitle({ title, hint, action, top = 22 }: { title: string; hint?: string; action?: React.ReactNode; top?: number }) {
  return (
    <View style={{ marginTop: top, marginBottom: 10, flexDirection: ROW, alignItems: 'center', justifyContent: 'space-between' }}>
      <View style={{ flex: 1 }}>
        <Text style={[Type.h2, { color: Colors.textPrimary, textAlign: 'right' }]}>{title}</Text>
        {hint ? <Text style={[Type.caption, { color: Colors.textMuted, textAlign: 'right' }]}>{hint}</Text> : null}
      </View>
      {action}
    </View>
  );
}

/* ───────────── بطاقات وشارات ───────────── */
export const Card = React.memo(function Card({ children, accent, style, onPress, label }: {
  children: React.ReactNode; accent?: string; style?: StyleProp<ViewStyle>; onPress?: () => void; label?: string;
}) {
  const body = (
    <>
      {accent ? <View style={[s.accent, { backgroundColor: accent }]} /> : null}
      {children}
    </>
  );
  if (onPress) {
    return <PressableScale onPress={onPress} accessibilityRole="button" accessibilityLabel={label} style={[s.card, style]}>{body}</PressableScale>;
  }
  return <View style={[s.card, style]}>{body}</View>;
});

export function Pill({ label, color, icon: Icon }: { label: string; color: string; icon?: React.ElementType }) {
  return (
    <View style={[s.pill, { backgroundColor: tint(color, 0.14), borderColor: tint(color, 0.45) }]}>
      {Icon ? <Icon color={color} size={12} /> : null}
      <Text style={[Type.caption, { color, fontFamily: 'Cairo_700Bold' }]} numberOfLines={1}>{label}</Text>
    </View>
  );
}

// سطر معلومة: أيقونة صغيرة + تسمية + قيمة. يُستخدم في البطاقات وصفحات التفاصيل.
export function MetaItem({ icon: Icon, label, value, color = Colors.textMuted }: { icon?: React.ElementType; label: string; value: string; color?: string }) {
  return (
    <View style={s.meta}>
      <View style={{ flexDirection: ROW, alignItems: 'center', gap: 5 }}>
        {Icon ? <Icon color={color} size={12} /> : null}
        <Text style={[Type.caption, { color: Colors.textMuted }]} numberOfLines={1}>{label}</Text>
      </View>
      <Text style={[Type.body, { color: Colors.textPrimary, textAlign: 'right', fontFamily: 'Cairo_600SemiBold' }]} numberOfLines={1}>{value}</Text>
    </View>
  );
}

export interface MiniStat { key: string; label: string; value: number | string; color: string; icon: React.ElementType }
// شبكة إحصائيات مدمجة: بطاقتان في كل صف، والبطاقة الأخيرة المنفردة تتمدد على كامل العرض.
export const StatStrip = React.memo(function StatStrip({ items }: { items: MiniStat[] }) {
  return (
    <View style={{ flexDirection: ROW, flexWrap: 'wrap', gap: 10, paddingHorizontal: 18 }}>
      {items.map((it) => {
        const Icon = it.icon;
        return (
          <View key={it.key} style={[s.mini, { borderColor: tint(it.color, 0.3) }]}>
            <GradientFill colors={[Palette.surfaceHi, Palette.surface]} glow={{ color: it.color, opacity: 0.2, cx: '90%', cy: '0%', r: '90%' }} />
            <View style={[s.miniIcon, { backgroundColor: tint(it.color, 0.16), borderColor: tint(it.color, 0.4) }]}>
              <Icon color={it.color} size={17} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[Type.stat, { color: Colors.textPrimary, fontSize: 24, lineHeight: 32, textAlign: 'right' }]}>{it.value}</Text>
              <Text style={[Type.caption, { color: Colors.textMuted, textAlign: 'right', marginTop: -2 }]} numberOfLines={1}>{it.label}</Text>
            </View>
          </View>
        );
      })}
    </View>
  );
});

/* ───────────── بحث وفلاتر ───────────── */
export function SearchField({ value, onChangeText, placeholder }: { value: string; onChangeText: (t: string) => void; placeholder: string }) {
  return (
    <View style={s.search}>
      <Search color={Palette.cyan} size={18} />
      <TextInput
        style={s.searchInput} value={value} onChangeText={onChangeText}
        placeholder={placeholder} placeholderTextColor={Colors.textMuted}
        returnKeyType="search" autoCorrect={false}
      />
      {value.length > 0 ? (
        <Pressable onPress={() => onChangeText('')} hitSlop={10} accessibilityLabel="مسح البحث"><X color={Colors.textMuted} size={18} /></Pressable>
      ) : null}
    </View>
  );
}

export interface ChipOpt<T extends string> { key: T; label: string; count?: number; color?: string }
export function FilterChips<T extends string>({ options, value, onChange }: { options: ChipOpt<T>[]; value: T; onChange: (k: T) => void }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ paddingHorizontal: 18, gap: 8 }}>
      {options.map((o) => {
        const on = o.key === value;
        const c = o.color ?? Palette.cyan;
        return (
          <Pressable key={o.key} onPress={() => onChange(o.key)} accessibilityRole="button" accessibilityState={{ selected: on }}
            style={[s.chip, on ? { backgroundColor: tint(c, 0.2), borderColor: tint(c, 0.6) } : null]}>
            <Text style={[Type.body, { color: on ? c : Colors.textSecondary, fontFamily: on ? 'Cairo_700Bold' : 'Cairo_500Medium' }]}>{o.label}</Text>
            {o.count != null ? (
              <View style={[s.chipCount, { backgroundColor: on ? tint(c, 0.28) : tint('#94A3B8', 0.16) }]}>
                <Text style={[Type.caption, { color: on ? c : Colors.textMuted, fontFamily: 'Cairo_700Bold' }]}>{o.count}</Text>
              </View>
            ) : null}
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

/* ───────────── أزرار ونماذج ───────────── */
export function Btn({ label, onPress, icon: Icon, variant = 'primary', loading, disabled, style }: {
  label: string; onPress: () => void; icon?: React.ElementType; variant?: 'primary' | 'ghost' | 'danger'; loading?: boolean; disabled?: boolean; style?: StyleProp<ViewStyle>;
}) {
  const c = variant === 'danger' ? Palette.red : variant === 'ghost' ? Palette.cyan : Palette.blue;
  const filled = variant === 'primary';
  const off = !!(disabled || loading);
  return (
    <PressableScale onPress={onPress} disabled={off} accessibilityRole="button" accessibilityLabel={label}
      style={[s.btn, filled ? { backgroundColor: Palette.blue, ...Glow(Palette.blue) } : { backgroundColor: tint(c, 0.12), borderWidth: 1, borderColor: tint(c, 0.45) }, off && { opacity: 0.55 }, style]}>
      {loading ? <ActivityIndicator color={filled ? '#fff' : c} /> : (
        <>
          {Icon ? <Icon color={filled ? '#fff' : c} size={18} /> : null}
          <Text style={[Type.h3, { color: filled ? '#fff' : c }]}>{label}</Text>
        </>
      )}
    </PressableScale>
  );
}

/* Next key: moves focus to the following field inside the same form (Sheet or Screen) */
type Focusable = { focus: () => void; blur: () => void };
type ChainEntry = { ref: React.RefObject<Focusable | null>; setHasNext: (v: boolean) => void };
type ChainScope = { add: (e: ChainEntry) => () => void; focusNext: (e: ChainEntry) => void };
const ChainCtx = React.createContext<ChainScope | null>(null);

function makeChainScope(): ChainScope {
  let list: ChainEntry[] = [];
  const sync = () => list.forEach((e, i) => e.setHasNext(i < list.length - 1));
  return {
    add: (e) => { list = [...list, e]; sync(); return () => { list = list.filter((x) => x !== e); sync(); }; },
    focusNext: (e) => {
      const n = list[list.indexOf(e) + 1];
      if (n) n.ref.current?.focus(); else e.ref.current?.blur();
    },
  };
}

export function FormScope({ children }: { children: React.ReactNode }) {
  const scope = React.useMemo(makeChainScope, []);
  return <ChainCtx.Provider value={scope}>{children}</ChainCtx.Provider>;
}

export function ChainInput({ multiline, editable, returnKeyType, submitBehavior, onSubmitEditing, ...rest }: TextInputProps) {
  const scope = React.useContext(ChainCtx);
  const ref = React.useRef<Focusable | null>(null);
  const setRef = React.useCallback((r: Focusable | null) => { ref.current = r; }, []);
  const [hasNext, setHasNext] = React.useState(false);
  const entry = React.useRef<ChainEntry>({ ref, setHasNext });
  const active = !!scope && editable !== false;
  React.useEffect(() => {
    if (!scope || !active) return undefined;
    return scope.add(entry.current);
  }, [scope, active]);
  const chain = active && !multiline;
  return (
    <TextInput ref={setRef} multiline={multiline} editable={editable} {...rest}
      returnKeyType={returnKeyType ?? (chain ? (hasNext ? 'next' : 'done') : undefined)}
      submitBehavior={submitBehavior ?? (chain ? (hasNext ? 'submit' : 'blurAndSubmit') : undefined)}
      onSubmitEditing={(e) => {
        onSubmitEditing?.(e);
        if (chain && hasNext && scope) scope.focusNext(entry.current);
      }} />
  );
}

export function Field({ label, style, multiline, ...rest }: TextInputProps & { label: string }) {
  return (
    <View style={{ marginBottom: 14 }}>
      <Text style={[Type.caption, { color: Colors.textSecondary, textAlign: 'right', marginBottom: 6 }]}>{label}</Text>
      <ChainInput placeholderTextColor={Colors.textMuted} multiline={multiline} {...rest}
        style={[s.input, multiline ? { height: 104, textAlignVertical: 'top', paddingTop: 12 } : null, style]} />
    </View>
  );
}

export function SelectField({ label, value, placeholder, onPress, disabled }: { label: string; value?: string | null; placeholder: string; onPress: () => void; disabled?: boolean }) {
  return (
    <View style={{ marginBottom: 14 }}>
      <Text style={[Type.caption, { color: Colors.textSecondary, textAlign: 'right', marginBottom: 6 }]}>{label}</Text>
      <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button" style={[s.input, { flexDirection: ROW, alignItems: 'center', justifyContent: 'space-between' }]}>
        <Text style={[Type.bodyLg, { color: value ? Colors.textPrimary : Colors.textMuted }]} numberOfLines={1}>{value || placeholder}</Text>
        <ChevronDown color={Colors.textMuted} size={18} />
      </Pressable>
    </View>
  );
}

/* ───────────── نافذة سفلية موحدة ───────────── */
export function Sheet({ visible, title, subtitle, onClose, children, footer }: {
  visible: boolean; title: string; subtitle?: string; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="slide" statusBarTranslucent onRequestClose={onClose}>
      <KeyboardAvoidingView behavior="padding" style={s.backdrop}>
        <Pressable style={{ flex: 1 }} onPress={onClose} accessibilityLabel="إغلاق" />
        <View style={s.sheet}>
          <GradientFill colors={[Palette.surfaceHi, Palette.surface, Palette.bg1]} />
          <View style={s.handle} />
          <View style={{ flexDirection: ROW, alignItems: 'center', paddingHorizontal: 18, paddingTop: 6, paddingBottom: 6 }}>
            <View style={{ flex: 1 }}>
              <Text style={[Type.h1, { color: Colors.textPrimary, textAlign: 'right' }]} numberOfLines={1}>{title}</Text>
              {subtitle ? <Text style={[Type.caption, { color: Colors.textMuted, textAlign: 'right' }]} numberOfLines={1}>{subtitle}</Text> : null}
            </View>
            <Pressable onPress={onClose} hitSlop={10} accessibilityLabel="إغلاق" style={s.closeBtn}><X color={Colors.textSecondary} size={18} /></Pressable>
          </View>
          <ScrollView style={{ flexShrink: 1 }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingHorizontal: 18, paddingTop: 10, paddingBottom: footer ? 12 : 24 + insets.bottom }}>
            <FormScope>{children}</FormScope>
          </ScrollView>
          {footer ? <View style={[s.footer, { paddingBottom: 14 + insets.bottom }]}>{footer}</View> : null}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/* ───────────── تحميل ───────────── */
export function ListSkeleton({ count = 4 }: { count?: number }) {
  return (
    <View style={{ paddingHorizontal: 18, gap: 12 }}>
      {Array.from({ length: count }).map((_, i) => (
        <View key={i} style={s.card}>
          <View style={{ flexDirection: ROW, justifyContent: 'space-between' }}>
            <Skeleton width={90} height={18} />
            <Skeleton width={64} height={22} radius={999} />
          </View>
          <Skeleton width="80%" height={16} style={{ marginTop: 12 }} />
          <Skeleton width="55%" height={12} style={{ marginTop: 10 }} />
          <Skeleton height={34} radius={12} style={{ marginTop: 14 }} />
        </View>
      ))}
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: Palette.bg1 },
  pageHeader: { flexDirection: ROW, alignItems: 'center', paddingHorizontal: 18, paddingTop: 10, paddingBottom: 14 },
  hIcon: { width: 48, height: 48, borderRadius: 16, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  iconBtn: { width: 44, height: 44, borderRadius: 15, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  card: { backgroundColor: Palette.surface, borderRadius: 22, padding: 16, borderWidth: 1, borderColor: Palette.glassBorder, overflow: 'hidden' },
  accent: { position: 'absolute', start: 0, top: 16, bottom: 16, width: 3, borderRadius: 2 },
  pill: { flexDirection: ROW, alignItems: 'center', gap: 4, paddingHorizontal: 9, paddingVertical: 1, borderRadius: 999, borderWidth: 1 },
  meta: { flex: 1, minWidth: '45%', gap: 1 },
  mini: { flexBasis: '47%', flexGrow: 1, flexDirection: ROW, alignItems: 'center', gap: 10, borderRadius: 18, paddingHorizontal: 12, paddingVertical: 10, borderWidth: 1, overflow: 'hidden', backgroundColor: Palette.surface },
  miniIcon: { width: 36, height: 36, borderRadius: 12, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  search: { flexDirection: ROW, alignItems: 'center', gap: 10, marginHorizontal: 18, paddingHorizontal: 14, height: 48, borderRadius: 16, backgroundColor: Palette.surface, borderWidth: 1, borderColor: Palette.glassBorder },
  searchInput: { flex: 1, color: Colors.textPrimary, fontFamily: 'Cairo_400Regular', fontSize: 14, textAlign: 'right', paddingVertical: 0 },
  chip: { flexDirection: ROW, alignItems: 'center', gap: 6, paddingHorizontal: 14, height: 38, borderRadius: 999, backgroundColor: Palette.surface, borderWidth: 1, borderColor: Palette.glassBorder },
  chipCount: { minWidth: 20, paddingHorizontal: 6, borderRadius: 10, alignItems: 'center' },
  btn: { flexDirection: ROW, alignItems: 'center', justifyContent: 'center', gap: 8, height: 50, borderRadius: 16, paddingHorizontal: 20 },
  input: { minHeight: 48, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 10, backgroundColor: Palette.bg1, borderWidth: 1, borderColor: Palette.glassBorder, color: Colors.textPrimary, fontFamily: 'Cairo_400Regular', fontSize: 14, textAlign: 'right' },
  backdrop: { flex: 1, backgroundColor: 'rgba(3, 6, 14, 0.72)' },
  sheet: { maxHeight: '90%', borderTopLeftRadius: 28, borderTopRightRadius: 28, overflow: 'hidden', borderWidth: 1, borderBottomWidth: 0, borderColor: Palette.glassBorder, backgroundColor: Palette.surface },
  handle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, marginTop: 10, marginBottom: 6, backgroundColor: 'rgba(148,163,255,0.3)' },
  closeBtn: { width: 36, height: 36, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(148,163,255,0.1)' },
  footer: { paddingHorizontal: 18, paddingTop: 12, borderTopWidth: 1, borderTopColor: Palette.glassBorder, flexDirection: ROW, gap: 10 },
});

// SECURECASEDESK_KEYBOARD_FIX: رفع النماذج فوق لوحة المفاتيح على أندرويد وiOS.
