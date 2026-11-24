'use strict';
// القسم 9: إعداد electron-builder — مثبّت NSIS + نسخة Portable لـ Windows 10/11 (x64).
// الإصدار والاسم يُقرآن من package.json. لا توقيع رقمي (لا شهادة)؛ SmartScreen قد يحذّر عند أول تشغيل.
// مجلد البيانات (للمثبّت والـ Portable معاً): %APPDATA%\SecureCaseDesk  (مفاتيح DPAPI مربوطة بحساب المستخدم، فلا نخزّن بجوار الـ exe).
const pkg = require('./package.json');

module.exports = {
  appId: 'gov.moi.hajjah.securecasedesk', // نفس معرّف Android/app.json
  productName: 'SecureCaseDesk',
  copyright: 'Copyright © 2026 SecureCaseDesk',
  buildVersion: pkg.version,
  directories: { output: 'release', buildResources: 'build' },
  forceCodeSigning: false,
  compression: 'normal',
  electronLanguages: ['ar', 'en-US'],

  // لا يدخل الحزمة إلا ما يلزم للتشغيل (لا src ولا backup ولا tests ولا scripts ولا docs).
  files: ['electron/**/*', 'web-dist/**/*', 'package.json', '!**/*.map', '!**/*.md'],
  asar: true,
  // الوحدة الأصلية (SQLCipher) خارج asar كي تُحمَّل .node بأمان.
  asarUnpack: ['**/node_modules/better-sqlite3-multiple-ciphers/**'],
  npmRebuild: true,
  buildDependenciesFromSource: false,

  win: {
    target: [
      { target: 'nsis', arch: ['x64'] },
      { target: 'portable', arch: ['x64'] },
    ],
    icon: 'build/icon.png',
    requestedExecutionLevel: 'asInvoker',
    signAndEditExecutable: true,
  },

  nsis: {
    artifactName: 'SecureCaseDesk-Setup.${ext}',
    oneClick: false,
    perMachine: false,
    allowElevation: true,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: 'always',
    createStartMenuShortcut: true,
    shortcutName: 'SecureCaseDesk',
    uninstallDisplayName: 'SecureCaseDesk',
    deleteAppDataOnUninstall: false, // بيانات القضايا لا تُحذف عند إزالة البرنامج أبداً
    runAfterFinish: true,
    language: '1025', // العربية
  },

  portable: {
    artifactName: 'SecureCaseDesk-Portable.${ext}',
    requestExecutionLevel: 'user',
  },
};
