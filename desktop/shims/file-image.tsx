// Image يقبل عناوين file:// (الصور المفكوكة في cache) على Windows (القسم 5).
// Chromium يمنع صفحة app:// من تحميل file:// مباشرة، فنقرأ البايتات عبر IPC ونعرضها كـ blob: URL (مسموح في CSP)؛
// تُحرَّر عند إلغاء التركيب. تُمرَّر react-native-web من react-native.tsx لتفادي استيرادها (فهي مُعاد توجيهها للـ shim).
import * as React from 'react';
import { File } from './expo-file-system';

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };

export function createScdImage(R: any) {
  const ScdImage: any = React.forwardRef(function ScdImage(props: any, ref: any) {
    const src = props.source;
    const fileUri: string | null = src && typeof src === 'object' && typeof src.uri === 'string' && /^file:/i.test(src.uri) ? src.uri : null;
    const [blobUrl, setBlobUrl] = React.useState<string | null>(null);
    const onError = props.onError;
    React.useEffect(() => {
      if (!fileUri) { setBlobUrl(null); return undefined; }
      let alive = true;
      let url: string | null = null;
      (async () => {
        try {
          const f = new File(fileUri);
          const bytes = await f.bytes();
          if (!alive) return;
          url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: MIME[f.extension.slice(1).toLowerCase()] ?? 'application/octet-stream' }));
          setBlobUrl(url);
        } catch {
          if (alive) { setBlobUrl(null); if (typeof onError === 'function') onError({ nativeEvent: { error: 'FILE_READ_FAILED' } }); }
        }
      })();
      return () => { alive = false; if (url) URL.revokeObjectURL(url); };
    }, [fileUri]);
    if (!fileUri) return React.createElement(R.Image, { ...props, ref });
    if (!blobUrl) return React.createElement(R.View, { style: props.style, accessibilityLabel: props.accessibilityLabel });
    return React.createElement(R.Image, { ...props, ref, source: { ...src, uri: blobUrl } });
  });
  for (const k of ['getSize', 'getSizeWithHeaders', 'prefetch', 'queryCache', 'resolveAssetSource']) {
    if (R.Image && R.Image[k]) ScdImage[k] = R.Image[k];
  }
  return ScdImage;
}
