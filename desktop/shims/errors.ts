// خطأ موحّد لأي واجهة shim لم تُنفَّذ بعد؛ يمنع الفشل الصامت.
export class DesktopNotImplementedError extends Error {
  readonly module: string;
  readonly api: string;
  readonly section: number;
  constructor(module: string, api: string, section: number) {
    super(`[SecureCaseDesk/Windows] ${module}.${api} غير منفَّذ بعد (القسم ${section})`);
    this.name = 'DesktopNotImplementedError';
    this.module = module;
    this.api = api;
    this.section = section;
  }
}
export function notImplemented(module: string, api: string, section: number): never {
  throw new DesktopNotImplementedError(module, api, section);
}
// للدوال التي تعيد Promise في الواجهة الأصلية: نرفض الوعد بدل الرمي المتزامن،
// فيعمل `.catch()` وtry/await في src كما يعمل مع الوحدة الأصلية (مثل _layout.tsx مع SecureStore).
export function notImplementedAsync<T = never>(module: string, api: string, section: number): Promise<T> {
  return Promise.reject(new DesktopNotImplementedError(module, api, section));
}
