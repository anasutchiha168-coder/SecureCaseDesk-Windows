// يُربط في metro.config داخل desktop/.stage (القسم 3) دون تعديل جذر المشروع.
// يستبدل الوحدات الأصلية بالـ shims فقط عند: platform=web و SCD_TARGET=windows.
const path = require('node:path');
const registry = require('./registry.json');

const norm = (p) => {
  const r = path.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
};

// moduleName → { entry, filePath }. 'aliases' تُعترَض أيضاً (مثل react-native-web) ما لم يكن الطالب هو ملف الـ shim نفسه،
// كي يستطيع الـ shim استيراد الحزمة الحقيقية دون حلقة لا نهائية.
function buildTable(reg, dir) {
  const table = new Map();
  for (const [name, entry] of Object.entries(reg.modules)) {
    if (entry.action !== 'shim') continue;
    const filePath = path.join(dir, entry.file);
    table.set(name, { filePath });
    for (const alias of entry.aliases || []) table.set(alias, { filePath });
  }
  return table;
}

function createShimResolver(baseResolveRequest, opts = {}) {
  const enabled = (opts.enabled ?? (() => process.env.SCD_TARGET === 'windows'));
  const table = buildTable(opts.registry || registry, opts.dir || __dirname);
  return (context, moduleName, platform) => {
    if (enabled() && platform === 'web') {
      const hit = table.get(moduleName);
      if (hit) {
        const origin = context && context.originModulePath;
        if (!origin || norm(origin) !== norm(hit.filePath)) {
          return { type: 'sourceFile', filePath: hit.filePath };
        }
      }
    }
    return (baseResolveRequest || context.resolveRequest)(context, moduleName, platform);
  };
}
module.exports = { createShimResolver, buildTable };
