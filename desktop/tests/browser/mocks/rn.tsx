import * as React from 'react';
const NO_PX = new Set(['flex','flexGrow','flexShrink','opacity','zIndex','fontWeight','lineHeightRatio']);
function css(style: any) {
  const out: any = { display: 'flex', flexDirection: 'column', position: 'relative', boxSizing: 'border-box', alignItems: 'stretch', flexShrink: 0, minWidth: 0, minHeight: 0 };
  for (const [k, v] of Object.entries(style || {})) {
    if (v == null) continue;
    if (k === 'flex') { out.flexGrow = v; out.flexShrink = 1; out.flexBasis = '0%'; continue; }
    if (k === 'paddingHorizontal') { out.paddingLeft = out.paddingRight = typeof v === 'number' ? v + 'px' : v; continue; }
    if (k === 'paddingVertical') { out.paddingTop = out.paddingBottom = typeof v === 'number' ? v + 'px' : v; continue; }
    if (k === 'fontFamily') continue;
    out[k] = typeof v === 'number' && !NO_PX.has(k) ? v + 'px' : v;
  }
  return out;
}
export const StyleSheet = { create: (s: any) => s, flatten: (s: any): any => Array.isArray(s) ? Object.assign({}, ...s.map((x: any) => StyleSheet.flatten(x))) : (s || {}) };
export const View = React.forwardRef(function View({ style, children, dir, ...rest }: any, ref: any) {
  return <div ref={ref} dir={dir} style={css(StyleSheet.flatten(style))} data-name={rest['data-name']}>{children}</div>;
});
export const Text = ({ style, children, numberOfLines }: any) => <div style={{ ...css(StyleSheet.flatten(style)), display: 'block', flexShrink: 1 }}>{children}</div>;
export function Pressable({ style, children, onPress, accessibilityLabel, accessibilityState, disabled }: any) {
  const [hovered, setHovered] = React.useState(false);
  const st = typeof style === 'function' ? style({ pressed: false, hovered }) : style;
  return <div role="button" tabIndex={0} aria-label={accessibilityLabel} aria-selected={accessibilityState?.selected ? 'true' : undefined}
    onClick={disabled ? undefined : onPress} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} style={{ ...css(StyleSheet.flatten(st)), cursor: 'pointer' }}>{children}</div>;
}
export function useWindowDimensions() {
  const [d, setD] = React.useState({ width: window.innerWidth, height: window.innerHeight });
  React.useEffect(() => { const f = () => setD({ width: window.innerWidth, height: window.innerHeight }); window.addEventListener('resize', f); return () => window.removeEventListener('resize', f); }, []);
  return d;
}
