// يُستخدم في metro.config (يُربط في القسم 3 دون تعديل جذر المشروع).
// يستبدل الوحدات الأصلية بالـ shims فقط عند: platform=web و SCD_TARGET=windows.
const path = require('node:path');
const registry = require('./registry.json');

function createShimResolver(baseResolveRequest) {
  const enabled = process.env.SCD_TARGET === 'windows';
  return (context, moduleName, platform) => {
    if (enabled && platform === 'web') {
      const entry = registry.modules[moduleName];
      if (entry && entry.action === 'shim') {
        return { type: 'sourceFile', filePath: path.join(__dirname, entry.file) };
      }
    }
    return (baseResolveRequest || context.resolveRequest)(context, moduleName, platform);
  };
}
module.exports = { createShimResolver };
