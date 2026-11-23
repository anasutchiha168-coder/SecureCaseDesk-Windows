'use strict';
const fs = require('node:fs');
const path = require('node:path');

const APP_SCHEME = 'app';
const APP_HOST = 'bundle';
const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
// المسار '/' وليس '/index.html': expo-router يقرأ location.pathname، و'/index.html' لا يطابق أي شاشة (Unmatched Route).
// معالج البروتوكول يخدم index.html لأي مسار بلا امتداد (resolveRequest).
const APP_ENTRY = `${APP_ORIGIN}/`;

// يُقبل مصدر التطوير فقط عندما يُمرَّر صراحةً (والتطبيق غير مُحزَّم) وعلى localhost حصراً.
function parseDevUrl(raw, packaged) {
  if (packaged || !raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(u.hostname)) return null;
    return u.origin;
  } catch { return null; }
}

function isTrustedUrl(url, devOrigin) {
  if (typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    // لا نعتمد u.origin للبروتوكول المخصص: في Node يعيد 'null' لغير القياسي. نقارن protocol/host صراحةً.
    if (u.protocol === `${APP_SCHEME}:` && u.host === APP_HOST && !u.username && !u.password) return true;
    return Boolean(devOrigin) && u.protocol === 'http:' && u.origin === devOrigin;
  } catch { return false; }
}

// فقط https، بلا بيانات اعتماد، لفتح الروابط الخارجية في المتصفح الافتراضي.
function isSafeExternalUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && !u.username && !u.password;
  } catch { return false; }
}

// يحوّل pathname لطلب app:// إلى مسار داخل root أو null إن كان خطِراً (traversal/NUL/باكسلاش).
function safeResolve(root, pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const rootAbs = path.resolve(root);
  const target = path.resolve(rootAbs, '.' + (decoded.startsWith('/') ? decoded : '/' + decoded));
  const rel = path.relative(rootAbs, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return target;
}

function isFile(p, fsImpl = fs) { try { return fsImpl.statSync(p).isFile(); } catch { return false; } }

// 200 ملف | 400 طلب خطِر | 404 غير موجود. مسار بلا امتداد غير موجود => index.html (توجيه SPA).
function resolveRequest(root, pathname, fsImpl = fs) {
  const file = safeResolve(root, pathname);
  if (!file) return { status: 400 };
  if (isFile(file, fsImpl)) return { status: 200, file };
  if (path.extname(pathname)) return { status: 404 };
  const index = path.join(path.resolve(root), 'index.html');
  return isFile(index, fsImpl) ? { status: 200, file: index, spa: true } : { status: 404 };
}

function buildCsp() {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'", // react-native-web يحقن عناصر <style> وقت التشغيل
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': buildCsp(),
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), usb=(), serial=(), hid=(), bluetooth=()',
});

module.exports = {
  APP_SCHEME, APP_HOST, APP_ORIGIN, APP_ENTRY,
  parseDevUrl, isTrustedUrl, isSafeExternalUrl, safeResolve, resolveRequest, buildCsp, SECURITY_HEADERS,
};
