// SECURECASEDESK_PHASE9_S2 + SECURECASEDESK_UI_V3_ATTACHMENTS
// لوحة المرفقات (عربية RTL): بطاقات ملفات مع حالة السلامة وبصمة SHA-256، إضافة، معاينة، فحص سلامة، حذف مصرّح (للمدير فقط مع سبب).
// الواجهة تُخفي الأزرار حسب الدور، لكن الإنفاذ الفعلي في خدمة المرفقات وطبقة البيانات (لم يتغير شيء منه).

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, Modal, Image, Pressable, ActivityIndicator, StyleSheet } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import { File } from 'expo-file-system';
import { FileText, Image as ImageIcon, Plus, Shield, ShieldCheck, ShieldAlert, Trash2, X, Eye, Check, Clock, UserRound, HardDrive, Paperclip, Lock, AlertTriangle } from 'lucide-react-native';
import { Colors, Palette, Type, tint, Glow } from '@/constants/theme';
import { ROW } from '@/constants/rtl';
import { useAuth } from '@/context/AuthContext';
import type { Session } from '@/security/guard';
import {
  addAttachmentFromUri, getAttachments, removeAttachment, checkAttachment,
  openAttachmentToCache, purgeDecryptedCache,
  type AttachmentInfo, type AttachmentEntityType,
} from '@/services/attachments.service';
import {
  attachmentUiPermissions, formatFileSize, fileTypeLabel, isImageMime, precheckPickedFile,
  validateDeleteReason, friendlyAttachmentError, integrityMessage, toArabicDigits, ENTITY_LABELS,
} from '@/modules/attachments/attachments-ui-logic';
import { Card, Pill, Btn, Field } from '@/components/ui/Kit';
import { EmptyState } from '@/components/ui/States';
import { PressableScale, FadeIn } from '@/components/ui/Motion';
import { Skeleton } from '@/components/ui/Skeleton';

const p2 = (n: number) => String(n).padStart(2, '0');
function formatDate(ts: number): string {
  const d = new Date(ts);
  return toArabicDigits(`${d.getFullYear()}/${p2(d.getMonth() + 1)}/${p2(d.getDate())}`);
}
function formatTime(ts: number): string {
  const d = new Date(ts);
  return toArabicDigits(`${p2(d.getHours())}:${p2(d.getMinutes())}`);
}
// بصمة مختصرة للعرض فقط (الأصلية كاملة في قاعدة البيانات).
function shortHash(h: string): string {
  return h.length > 16 ? h.slice(0, 8) + '…' + h.slice(-6) : h;
}

type Verify = { state: 'busy' } | { state: 'ok'; at: number } | { state: 'bad'; message: string };

interface Props {
  entityType: AttachmentEntityType;
  entityId: string;
  onCountChange?: (count: number) => void;
}

export default function AttachmentsPanel({ entityType, entityId, onCountChange }: Props) {
  const { user } = useAuth();
  const session = useMemo<Session | null>(
    () => (user ? { userId: user.id, role: user.role } : null),
    [user?.id, user?.role]
  );
  const perms = useMemo(() => attachmentUiPermissions(user?.role, entityType), [user?.role, entityType]);

  const [items, setItems] = useState<AttachmentInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null); // 'add' أو معرّف المرفق قيد المعالجة
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [imageName, setImageName] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<AttachmentInfo | null>(null);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [verified, setVerified] = useState<Record<string, Verify>>({});

  const load = useCallback(async () => {
    if (!perms.canView) { setItems([]); setLoading(false); return; }
    try {
      const list = await getAttachments(session, entityType, entityId);
      setItems(list);
      onCountChange?.(list.length);
    } catch (e) {
      setMessage({ text: friendlyAttachmentError(e), ok: false });
    } finally {
      setLoading(false);
    }
  }, [session, entityType, entityId, perms.canView, onCountChange]);

  useEffect(() => {
    purgeDecryptedCache(); // تنظيف أي نسخ مفكوكة متبقية من جلسة سابقة
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleAdd = async () => {
    if (busy) return;
    setMessage(null);
    let picked: DocumentPicker.DocumentPickerResult;
    try {
      picked = await DocumentPicker.getDocumentAsync({
        type: ['application/pdf', 'image/jpeg', 'image/png'],
        copyToCacheDirectory: true,
        multiple: false,
      });
    } catch {
      setMessage({ text: 'تعذر فتح منتقي الملفات.', ok: false });
      return;
    }
    if (picked.canceled || !picked.assets?.length) return;
    const asset = picked.assets[0];

    const pre = precheckPickedFile({ name: asset.name, size: asset.size ?? null });
    if (pre) {
      deleteCacheCopy(asset.uri);
      setMessage({ text: pre, ok: false });
      return;
    }

    setBusy('add');
    try {
      await addAttachmentFromUri(session, entityType, entityId,
        { uri: asset.uri, name: asset.name, mimeType: asset.mimeType ?? null });
      setMessage({ text: 'تمت إضافة المرفق وتشفيره بنجاح.', ok: true });
      await load();
    } catch (e) {
      setMessage({ text: friendlyAttachmentError(e), ok: false });
    } finally {
      deleteCacheCopy(asset.uri); // لا تبقى نسخة غير مشفرة في الكاش
      setBusy(null);
    }
  };

  const handleOpen = async (a: AttachmentInfo) => {
    if (busy) return;
    setMessage(null);
    setBusy(a.id);
    try {
      const out = await openAttachmentToCache(session, a.id);
      if (isImageMime(out.mimeType)) {
        setImageName(out.name);
        setImageUri(out.uri);
      } else {
        if (!(await Sharing.isAvailableAsync())) {
          purgeDecryptedCache();
          setMessage({ text: 'لا يتوفر تطبيق لعرض ملفات PDF على هذا الجهاز.', ok: false });
        } else {
          await Sharing.shareAsync(out.uri, { mimeType: 'application/pdf', dialogTitle: out.name });
        }
      }
    } catch (e) {
      setMessage({ text: friendlyAttachmentError(e), ok: false });
    } finally {
      setBusy(null);
    }
  };

  const closeImage = () => {
    setImageUri(null);
    purgeDecryptedCache();
  };

  const handleVerify = async (a: AttachmentInfo) => {
    if (busy) return;
    setBusy(a.id);
    setVerified((p) => ({ ...p, [a.id]: { state: 'busy' } }));
    try {
      const r = await checkAttachment(session, a.id);
      setVerified((p) => ({ ...p, [a.id]: r.ok ? { state: 'ok', at: Date.now() } : { state: 'bad', message: integrityMessage(r.problem) } }));
    } catch (e) {
      setVerified((p) => { const n = { ...p }; delete n[a.id]; return n; });
      setMessage({ text: friendlyAttachmentError(e), ok: false });
    } finally {
      setBusy(null);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const err = validateDeleteReason(reason);
    if (err) { setReasonError(err); return; }
    setBusy(deleteTarget.id);
    try {
      await removeAttachment(session, deleteTarget.id, reason.trim());
      setDeleteTarget(null); setReason(''); setReasonError(null);
      setMessage({ text: 'تم حذف المرفق وتسجيل العملية في سجل التدقيق.', ok: true });
      await load();
    } catch (e) {
      setReasonError(friendlyAttachmentError(e));
    } finally {
      setBusy(null);
    }
  };

  if (!perms.canView) {
    return <EmptyState icon={Lock} color={Palette.red} compact title="ليس لديك صلاحية عرض المرفقات." />;
  }

  const totalBytes = items.reduce((a, x) => a + (x.size_bytes || 0), 0);

  return (
    <View style={{ gap: 12 }}>
      <View style={s.headerRow}>
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: ROW, alignItems: 'center', gap: 8 }}>
            <Text style={[Type.h3, { color: Colors.textPrimary }]}>المرفقات</Text>
            <Pill label={toArabicDigits(items.length)} color={Palette.cyan} />
          </View>
          <Text style={[Type.caption, { color: Colors.textMuted, textAlign: 'right' }]} numberOfLines={1}>
            {items.length > 0 ? 'الحجم الإجمالي ' + formatFileSize(totalBytes) + ' • مشفّرة على الجهاز' : 'كل ملف يُشفَّر قبل حفظه على الجهاز'}
          </Text>
        </View>
        {perms.canAdd ? (
          <Btn label="إضافة مرفق" icon={Plus} onPress={handleAdd} loading={busy === 'add'} disabled={busy !== null} style={s.addBtn} />
        ) : null}
      </View>

      {message ? (
        <FadeIn>
          <View style={[s.msg, { backgroundColor: tint(message.ok ? Palette.green : Palette.red, 0.1), borderColor: tint(message.ok ? Palette.green : Palette.red, 0.4) }]}>
            {message.ok ? <Check color={Palette.green} size={18} /> : <AlertTriangle color={Palette.red} size={18} />}
            <Text style={[Type.body, { flex: 1, textAlign: 'right', color: message.ok ? Palette.green : Palette.red, fontFamily: 'Cairo_600SemiBold' }]}>{message.text}</Text>
            <Pressable onPress={() => setMessage(null)} hitSlop={10} accessibilityLabel="إخفاء الرسالة"><X color={Colors.textMuted} size={16} /></Pressable>
          </View>
        </FadeIn>
      ) : null}

      {busy === 'add' ? (
        <View style={[s.uploading, { borderColor: tint(Palette.cyan, 0.4), backgroundColor: tint(Palette.cyan, 0.08) }]}>
          <ActivityIndicator color={Palette.cyan} />
          <View style={{ flex: 1 }}>
            <Text style={[Type.h3, { color: Colors.textPrimary, textAlign: 'right' }]}>جارٍ تشفير الملف وحفظه…</Text>
            <Text style={[Type.caption, { color: Colors.textMuted, textAlign: 'right' }]}>لا تغلق هذه النافذة حتى يكتمل الحفظ.</Text>
          </View>
        </View>
      ) : null}

      {loading ? (
        <View style={{ gap: 12 }}>{[0, 1].map((i) => <AttachmentSkeleton key={i} />)}</View>
      ) : items.length === 0 && busy !== 'add' ? (
        <EmptyState icon={Paperclip} color={Palette.cyan} title="لا توجد مرفقات لهذا السجل" hint="الملفات المسموحة: PDF وJPG وPNG حتى ١٥ ميغابايت."
          actionLabel={perms.canAdd ? 'إضافة مرفق' : undefined} onAction={perms.canAdd ? handleAdd : undefined} />
      ) : (
        items.map((a) => (
          <AttachmentCard
            key={a.id} a={a} v={verified[a.id]} working={busy === a.id} locked={busy !== null}
            canVerify={perms.canVerify} canDelete={perms.canDelete}
            onOpen={() => void handleOpen(a)} onVerify={() => void handleVerify(a)}
            onDelete={() => { setDeleteTarget(a); setReason(''); setReasonError(null); }}
          />
        ))
      )}

      {/* معاينة الصور */}
      <Modal visible={imageUri !== null} transparent animationType="fade" statusBarTranslucent onRequestClose={closeImage}>
        <View style={s.imgOverlay}>
          <View style={s.imgTop}>
            <View style={{ flex: 1 }}>
              <Text style={[Type.h3, { color: Colors.textPrimary, textAlign: 'right' }]} numberOfLines={1}>{imageName}</Text>
              <Text style={[Type.caption, { color: Colors.textMuted, textAlign: 'right' }]}>نسخة مؤقتة مفكوكة التشفير تُحذف عند الإغلاق</Text>
            </View>
            <Pressable onPress={closeImage} accessibilityLabel="إغلاق المعاينة" hitSlop={10} style={s.closeBtn}><X size={20} color={Colors.textPrimary} /></Pressable>
          </View>
          {imageUri ? <Image source={{ uri: imageUri }} style={s.img} resizeMode="contain" /> : null}
        </View>
      </Modal>

      {/* سبب الحذف */}
      <Modal visible={deleteTarget !== null} transparent animationType="fade" statusBarTranslucent onRequestClose={() => setDeleteTarget(null)}>
        <View style={s.dlgOverlay}>
          <View style={s.dlg}>
            <View style={{ flexDirection: ROW, alignItems: 'center', gap: 12 }}>
              <View style={[s.dlgIcon, { backgroundColor: tint(Palette.red, 0.14), borderColor: tint(Palette.red, 0.45) }]}><Trash2 color={Palette.red} size={22} /></View>
              <View style={{ flex: 1 }}>
                <Text style={[Type.h2, { color: Colors.textPrimary, textAlign: 'right' }]}>حذف المرفق</Text>
                <Text style={[Type.caption, { color: Colors.textMuted, textAlign: 'right' }]} numberOfLines={2}>{deleteTarget?.original_name}</Text>
              </View>
            </View>
            <View style={s.dlgNote}>
              <ShieldCheck color={Palette.cyan} size={16} />
              <Text style={[Type.caption, { flex: 1, color: Colors.textSecondary, textAlign: 'right' }]}>
                يُحذف الملف المشفر ويبقى سجل المرفق (الاسم والبصمة والسبب والمنفّذ) محفوظاً في السجل.
              </Text>
            </View>
            <View style={{ marginTop: 14 }}>
              <Field
                label={'سبب الحذف (٥ أحرف على الأقل) — ' + toArabicDigits(reason.trim().length)}
                placeholder="اكتب سبب الحذف"
                value={reason}
                onChangeText={(t) => { setReason(t); setReasonError(null); }}
                multiline
              />
              {reasonError ? <Text style={[Type.caption, { color: Palette.red, textAlign: 'right', marginTop: -8, marginBottom: 8 }]}>{reasonError}</Text> : null}
            </View>
            <View style={{ flexDirection: ROW, gap: 10 }}>
              <Btn label="إلغاء" variant="ghost" onPress={() => setDeleteTarget(null)} style={{ flex: 1 }} />
              <Btn label="تأكيد الحذف" variant="danger" icon={Trash2} onPress={() => void confirmDelete()} loading={busy !== null && busy === deleteTarget?.id} disabled={busy !== null} style={{ flex: 1 }} />
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

/* ───────────── بطاقة المرفق ───────────── */
const AttachmentCard = React.memo(function AttachmentCard({ a, v, working, locked, canVerify, canDelete, onOpen, onVerify, onDelete }: {
  a: AttachmentInfo; v: Verify | undefined; working: boolean; locked: boolean; canVerify: boolean; canDelete: boolean;
  onOpen: () => void; onVerify: () => void; onDelete: () => void;
}) {
  const img = isImageMime(a.mime_type);
  const c = img ? Palette.cyan : Palette.red;
  const Icon = img ? ImageIcon : FileText;
  const ext = a.extension.toLowerCase() === 'jpeg' ? 'JPG' : a.extension.toUpperCase();
  const st = v?.state;
  const sc = st === 'ok' ? Palette.green : st === 'bad' ? Palette.red : Palette.cyan;
  return (
    <Card accent={c}>
      <View style={{ flexDirection: ROW, alignItems: 'center', gap: 12 }}>
        <View style={[s.tile, { backgroundColor: tint(c, 0.14), borderColor: tint(c, 0.45) }, Glow(c)]}>
          <Icon color={c} size={22} />
          <Text style={[Type.caption, { color: c, fontFamily: 'Cairo_800ExtraBold', marginTop: 1 }]}>{ext}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[Type.h3, { color: Colors.textPrimary, textAlign: 'right' }]} numberOfLines={2}>{a.original_name}</Text>
          <View style={{ flexDirection: ROW, marginTop: 4 }}>
            <Pill label={fileTypeLabel(a.mime_type)} color={c} />
          </View>
        </View>
      </View>

      <View style={s.metaGrid}>
        <MetaCell icon={HardDrive} label="الحجم" value={formatFileSize(a.size_bytes)} />
        <MetaCell icon={Clock} label="تاريخ الرفع" value={formatDate(a.created_at) + ' • ' + formatTime(a.created_at)} />
        {a.created_by_name ? <MetaCell icon={UserRound} label="أضافه" value={a.created_by_name} /> : null}
      </View>

      <View style={[s.integrity, { backgroundColor: tint(sc, st ? 0.1 : 0.06), borderColor: tint(sc, st ? 0.4 : 0.25) }]}>
        {st === 'busy' ? <ActivityIndicator size="small" color={sc} /> : st === 'ok' ? <ShieldCheck color={sc} size={20} /> : st === 'bad' ? <ShieldAlert color={sc} size={20} /> : <Shield color={Colors.textMuted} size={20} />}
        <View style={{ flex: 1, gap: 2 }}>
          {st === 'ok' ? (
            <>
              <StatusLine color={sc} text="ملف سليم" />
              <StatusLine color={sc} text="تم التحقق من SHA-256 وفك التشفير" />
              <Text style={[Type.caption, { color: Colors.textMuted, textAlign: 'right' }]}>آخر فحص: {formatTime((v as { at: number }).at)}</Text>
            </>
          ) : st === 'bad' ? (
            <Text style={[Type.body, { color: sc, fontFamily: 'Cairo_700Bold', textAlign: 'right' }]}>{(v as { message: string }).message}</Text>
          ) : st === 'busy' ? (
            <Text style={[Type.body, { color: Colors.textSecondary, textAlign: 'right' }]}>جارٍ فحص السلامة…</Text>
          ) : (
            <>
              <Text style={[Type.body, { color: Colors.textSecondary, fontFamily: 'Cairo_600SemiBold', textAlign: 'right' }]}>لم يُفحص في هذه الجلسة</Text>
              <Text style={[Type.caption, { color: Colors.textMuted, textAlign: 'right' }]}>يُتحقق منه تلقائياً عند كل فتح.</Text>
            </>
          )}
          <Text style={[Type.caption, { color: Colors.textMuted, textAlign: 'right', writingDirection: 'ltr' }]} numberOfLines={1}>SHA-256: {shortHash(a.sha256_plain)}</Text>
        </View>
      </View>

      <View style={{ flexDirection: ROW, alignItems: 'center', gap: 8, marginTop: 12 }}>
        <PressableScale onPress={onOpen} disabled={locked} accessibilityRole="button" accessibilityLabel={img ? 'معاينة' : 'فتح'}
          style={[s.act, { flex: 1.2, backgroundColor: Palette.blue, borderColor: Palette.blue, opacity: locked && !working ? 0.55 : 1 }, Glow(Palette.blue)]}>
          {working && st !== 'busy' ? <ActivityIndicator size="small" color="#fff" /> : <Eye color="#fff" size={17} />}
          <Text style={[Type.body, { color: '#fff', fontFamily: 'Cairo_700Bold' }]}>{img ? 'معاينة' : 'فتح'}</Text>
        </PressableScale>
        {canVerify ? (
          <PressableScale onPress={onVerify} disabled={locked} accessibilityRole="button" accessibilityLabel="فحص السلامة"
            style={[s.act, { flex: 1.4, backgroundColor: tint(Palette.green, 0.12), borderColor: tint(Palette.green, 0.45), opacity: locked && !working ? 0.55 : 1 }]}>
            <ShieldCheck color={Palette.green} size={17} />
            <Text style={[Type.body, { color: Palette.green, fontFamily: 'Cairo_700Bold' }]}>{st === 'ok' ? 'إعادة الفحص' : 'فحص السلامة'}</Text>
          </PressableScale>
        ) : null}
        {canDelete ? (
          <PressableScale onPress={onDelete} disabled={locked} accessibilityRole="button" accessibilityLabel="حذف المرفق"
            style={[s.act, { width: 46, backgroundColor: tint(Palette.red, 0.12), borderColor: tint(Palette.red, 0.45), opacity: locked && !working ? 0.55 : 1 }]}>
            <Trash2 color={Palette.red} size={17} />
          </PressableScale>
        ) : null}
      </View>
    </Card>
  );
});

function StatusLine({ color, text }: { color: string; text: string }) {
  return (
    <View style={{ flexDirection: ROW, alignItems: 'center', gap: 6 }}>
      <Check color={color} size={14} />
      <Text style={[Type.body, { color, fontFamily: 'Cairo_700Bold', textAlign: 'right' }]}>{text}</Text>
    </View>
  );
}

function MetaCell({ icon: Icon, label, value }: { icon: React.ElementType; label: string; value: string }) {
  return (
    <View style={s.metaCell}>
      <View style={{ flexDirection: ROW, alignItems: 'center', gap: 5 }}>
        <Icon color={Colors.textMuted} size={12} />
        <Text style={[Type.caption, { color: Colors.textMuted }]} numberOfLines={1}>{label}</Text>
      </View>
      <Text style={[Type.body, { color: Colors.textPrimary, textAlign: 'right', fontFamily: 'Cairo_600SemiBold' }]} numberOfLines={1}>{value}</Text>
    </View>
  );
}

function AttachmentSkeleton() {
  return (
    <View style={s.skel}>
      <View style={{ flexDirection: ROW, alignItems: 'center', gap: 12 }}>
        <Skeleton width={52} height={62} radius={14} />
        <View style={{ flex: 1, gap: 8 }}>
          <Skeleton width="80%" height={16} />
          <Skeleton width={70} height={20} radius={999} />
        </View>
      </View>
      <Skeleton height={44} radius={14} style={{ marginTop: 14 }} />
      <Skeleton height={44} radius={14} style={{ marginTop: 12 }} />
    </View>
  );
}

function deleteCacheCopy(uri: string): void {
  try {
    const f = new File(uri);
    if (f.exists) f.delete();
  } catch {
    // فشل تنظيف الكاش لا يؤثر على نتيجة العملية.
  }
}

const s = StyleSheet.create({
  headerRow: { flexDirection: ROW, alignItems: 'center', gap: 10 },
  addBtn: { height: 44, paddingHorizontal: 14, borderRadius: 14 },
  msg: { flexDirection: ROW, alignItems: 'center', gap: 10, padding: 12, borderRadius: 16, borderWidth: 1 },
  uploading: { flexDirection: ROW, alignItems: 'center', gap: 12, padding: 14, borderRadius: 18, borderWidth: 1 },
  tile: { width: 52, height: 62, borderRadius: 14, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  metaGrid: { flexDirection: ROW, flexWrap: 'wrap', gap: 10, marginTop: 14 },
  metaCell: { flexBasis: '46%', flexGrow: 1, gap: 1 },
  integrity: { flexDirection: ROW, alignItems: 'center', gap: 10, marginTop: 12, padding: 12, borderRadius: 16, borderWidth: 1 },
  act: { height: 46, borderRadius: 14, flexDirection: ROW, alignItems: 'center', justifyContent: 'center', gap: 6, borderWidth: 1 },
  skel: { backgroundColor: Palette.surface, borderRadius: 22, padding: 16, borderWidth: 1, borderColor: Palette.glassBorder },
  imgOverlay: { flex: 1, backgroundColor: 'rgba(3,6,14,0.96)', paddingTop: 44 },
  imgTop: { flexDirection: ROW, alignItems: 'center', gap: 12, paddingHorizontal: 18, paddingBottom: 14 },
  closeBtn: { width: 40, height: 40, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(148,163,255,0.14)' },
  img: { flex: 1, width: '100%' },
  dlgOverlay: { flex: 1, backgroundColor: 'rgba(3,6,14,0.78)', justifyContent: 'center', padding: 20 },
  dlg: { backgroundColor: Palette.surface, borderRadius: 26, padding: 18, borderWidth: 1, borderColor: tint(Palette.red, 0.35) },
  dlgIcon: { width: 48, height: 48, borderRadius: 16, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  dlgNote: { flexDirection: ROW, alignItems: 'center', gap: 8, marginTop: 14, padding: 10, borderRadius: 14, backgroundColor: tint(Palette.cyan, 0.08), borderWidth: 1, borderColor: tint(Palette.cyan, 0.28) },
});
