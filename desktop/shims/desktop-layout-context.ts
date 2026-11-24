// سياق التخطيط المشترك بين الغلاف (desktop-shell.tsx) ومكوّنات react-native.tsx (القوائم والنوافذ).
// ملف مستقل بلا استيراد من react-native كي لا تنشأ حلقة استيراد.
import * as React from 'react';
import { LAYOUT, listColumnsFor, type ShellMode, type SidebarMode } from './desktop-layout-core';

export interface DesktopLayoutValue {
  windowWidth: number;
  contentWidth: number;
  sidebarMode: SidebarMode;
  shell: ShellMode;
  columns: 1 | 2;
}

const KEY = '__scdDesktopLayoutCtx';
const g = globalThis as any;
export const DesktopLayoutContext: React.Context<DesktopLayoutValue | null> =
  g[KEY] ?? (g[KEY] = React.createContext<DesktopLayoutValue | null>(null));

/** يعيد قيمة الغلاف إن وُجد، وإلا تقديراً من عرض النافذة (خارج الغلاف: نوافذ منبثقة أو اختبارات). */
export function useDesktopLayout(windowWidth: number): DesktopLayoutValue {
  const ctx = React.useContext(DesktopLayoutContext);
  if (ctx) return ctx;
  const cw = Math.min(windowWidth, LAYOUT.CONTENT_MAX);
  return { windowWidth, contentWidth: cw, sidebarMode: 'expanded', shell: 'app', columns: listColumnsFor(cw) };
}
