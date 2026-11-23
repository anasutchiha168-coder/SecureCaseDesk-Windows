// SECURECASEDESK_PHASE9_S2 + SECURECASEDESK_UI_V3_ATTACHMENTS
// نافذة سفلية موحدة (Sheet) تحمل لوحة المرفقات، وزر "المرفقات" الذي يفتحها ويعرض العدد.

import React, { useEffect, useMemo, useState } from 'react';
import { Text, View, StyleSheet } from 'react-native';
import { Paperclip } from 'lucide-react-native';
import { Colors, Palette, Type, tint } from '@/constants/theme';
import { ROW } from '@/constants/rtl';
import { useAuth } from '@/context/AuthContext';
import { getAttachmentCount, type AttachmentEntityType } from '@/services/attachments.service';
import { attachmentUiPermissions, toArabicDigits } from '@/modules/attachments/attachments-ui-logic';
import { Sheet } from '@/components/ui/Kit';
import { PressableScale } from '@/components/ui/Motion';
import AttachmentsPanel from './AttachmentsPanel';

export function AttachmentsSheet(props: {
  visible: boolean; onClose: () => void; entityType: AttachmentEntityType; entityId: string; title: string;
}) {
  return (
    <Sheet visible={props.visible} onClose={props.onClose} title={props.title} subtitle="ملفات مشفّرة على الجهاز، تُفحص سلامتها بالبصمة عند الفتح">
      {props.visible ? <AttachmentsPanel entityType={props.entityType} entityId={props.entityId} /> : null}
    </Sheet>
  );
}

// زر مضغوط للبطاقات: لا يظهر أصلاً لمن لا يملك صلاحية عرض مرفقات هذا النوع.
export function AttachmentsButton(props: { entityType: AttachmentEntityType; entityId: string; title: string }) {
  const { user } = useAuth();
  const session = useMemo(() => (user ? { userId: user.id, role: user.role } : null), [user?.id, user?.role]);
  const canView = attachmentUiPermissions(user?.role, props.entityType).canView;
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    if (!canView || open) return;
    let alive = true;
    getAttachmentCount(session, props.entityType, props.entityId)
      .then((c) => { if (alive) setCount(c); })
      .catch(() => { if (alive) setCount(null); });
    return () => { alive = false; };
  }, [canView, open, session, props.entityType, props.entityId]);

  if (!canView) return null;
  const has = (count ?? 0) > 0;
  const c = Palette.cyan;
  return (
    <>
      <PressableScale onPress={() => setOpen(true)} accessibilityRole="button" accessibilityLabel="المرفقات"
        style={[styles.btn, { backgroundColor: tint(c, has ? 0.14 : 0.08), borderColor: tint(c, has ? 0.5 : 0.3) }]}>
        <Paperclip size={15} color={c} />
        <Text style={[Type.body, { color: c, fontFamily: 'Cairo_700Bold' }]}>المرفقات</Text>
        {count !== null ? (
          <View style={[styles.badge, { backgroundColor: has ? c : tint('#94A3B8', 0.2) }]}>
            <Text style={[Type.caption, { color: has ? Palette.bg0 : Colors.textMuted, fontFamily: 'Cairo_800ExtraBold' }]}>{toArabicDigits(count)}</Text>
          </View>
        ) : null}
      </PressableScale>
      <AttachmentsSheet visible={open} onClose={() => setOpen(false)}
        entityType={props.entityType} entityId={props.entityId} title={props.title} />
    </>
  );
}

const styles = StyleSheet.create({
  btn: { flexDirection: ROW, alignItems: 'center', alignSelf: 'flex-start', gap: 7, marginTop: 8, paddingHorizontal: 12, height: 36, borderRadius: 12, borderWidth: 1 },
  badge: { minWidth: 20, height: 20, paddingHorizontal: 6, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
});
