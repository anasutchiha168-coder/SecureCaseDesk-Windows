'use strict';
const fs = require('node:fs');
const path = require('node:path');

const MIN = Object.freeze({ width: 1024, height: 680 });
const DEFAULT = Object.freeze({ width: 1360, height: 860 });

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : undefined);
const overlap = (a, b) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
  * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

// يُنقّي الحالة المحفوظة: يقيّد الأبعاد ويُسقط الموضع إن صار خارج كل الشاشات (فصل شاشة ثانوية مثلاً).
function sanitizeState(raw, workAreas) {
  const areas = Array.isArray(workAreas) && workAreas.length ? workAreas : [{ x: 0, y: 0, width: 1920, height: 1080 }];
  const primary = areas[0];
  const r = raw && typeof raw === 'object' ? raw : {};
  const width = Math.min(Math.max(num(r.width) ?? DEFAULT.width, MIN.width), Math.max(primary.width, MIN.width));
  const height = Math.min(Math.max(num(r.height) ?? DEFAULT.height, MIN.height), Math.max(primary.height, MIN.height));
  const out = { width, height, maximized: r.maximized === true };
  const x = num(r.x); const y = num(r.y);
  if (x !== undefined && y !== undefined) {
    const rect = { x, y, width, height };
    if (areas.some((a) => overlap(rect, a) >= 200 * 120)) { out.x = x; out.y = y; }
  }
  return out;
}

function loadState(file, workAreas, fsImpl = fs) {
  try { return sanitizeState(JSON.parse(fsImpl.readFileSync(file, 'utf8')), workAreas); }
  catch { return sanitizeState(null, workAreas); }
}

function saveState(file, state, fsImpl = fs) {
  try {
    fsImpl.mkdirSync(path.dirname(file), { recursive: true });
    fsImpl.writeFileSync(file, JSON.stringify(state), 'utf8');
  } catch { /* حفظ موضع النافذة ليس حرجاً */ }
}

module.exports = { MIN, DEFAULT, sanitizeState, loadState, saveState };
