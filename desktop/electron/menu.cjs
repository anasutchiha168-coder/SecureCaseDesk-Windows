'use strict';
const { Menu } = require('electron');

// قائمة مخفية تلقائياً (Alt لإظهارها). تُبقي اختصارات النسخ/اللصق والتكبير تعمل على Windows.
function installMenu({ dev }) {
  const template = [
    { label: 'تحرير', submenu: [
      { role: 'undo', label: 'تراجع' }, { role: 'redo', label: 'إعادة' }, { type: 'separator' },
      { role: 'cut', label: 'قص' }, { role: 'copy', label: 'نسخ' }, { role: 'paste', label: 'لصق' },
      { role: 'selectAll', label: 'تحديد الكل' },
    ] },
    { label: 'عرض', submenu: [
      { role: 'zoomIn', label: 'تكبير' }, { role: 'zoomOut', label: 'تصغير' }, { role: 'resetZoom', label: 'الحجم الافتراضي' },
      { type: 'separator' }, { role: 'togglefullscreen', label: 'ملء الشاشة' },
      ...(dev ? [{ type: 'separator' }, { role: 'reload', label: 'إعادة تحميل' }, { role: 'toggleDevTools', label: 'أدوات المطوّر' }] : []),
    ] },
    { label: 'نافذة', submenu: [{ role: 'minimize', label: 'تصغير النافذة' }, { role: 'close', label: 'إغلاق' }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
module.exports = { installMenu };
