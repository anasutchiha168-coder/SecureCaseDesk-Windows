// Hook لاختبارات الـ shims: يحلّ الاستيراد النسبي بلا امتداد إلى .ts كما يفعل Metro (الاختبارات تعمل بـ --experimental-strip-types).
export async function resolve(specifier, context, nextResolve) {
  try { return await nextResolve(specifier, context); } catch (e) {
    if (e && e.code === 'ERR_MODULE_NOT_FOUND' && /^\.\.?\//.test(specifier)) return nextResolve(specifier + '.ts', context);
    throw e;
  }
}
