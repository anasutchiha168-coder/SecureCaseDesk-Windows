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
