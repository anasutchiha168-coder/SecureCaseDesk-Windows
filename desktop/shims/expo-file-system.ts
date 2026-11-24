// Shim لـ expo-file-system (File/Directory/Paths/FileMode المستعملة في src) فوق IPC آمن — القسم 5.
// العناوين file:///C:/... . كل عملية تُفحص في main داخل documents/cache/المجلدات التي منحها المستخدم عبر الحوارات.
// فروق موثّقة عن Android: move لملف فوق ملف يستبدله؛ move لمجلد فوق وجهة موجودة يفشل؛ writeBytes متزامنة (يحفظ الترتيب).
import { SCD_CHANNELS } from './bridge-contract';
import { callSync, callAsync, DesktopFsError } from './fs-bridge';

export { DesktopFsError };
const CH = SCD_CHANNELS.fs;

export const FileMode = { ReadOnly: 'r', WriteOnly: 'w', ReadWrite: 'rw' } as const;
type Mode = 'r' | 'w' | 'rw';
type Part = string | File | Directory;
interface Stat { exists: boolean; isFile: boolean; isDirectory: boolean; size: number; modificationTime: number }
interface Entry { name: string; uri: string; isDirectory: boolean; size: number; modificationTime: number }

const WIN_PATH = /^[a-zA-Z]:[\\/]/;
const enc = (s: string) => encodeURIComponent(s);
const dec = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };

function pathToUri(p: string): string {
  const segs = p.replace(/\\/g, '/').split('/');
  const drive = segs.shift() ?? '';
  return 'file:///' + [drive, ...segs.filter(Boolean).map(enc)].join('/');
}
function joinParts(parts: Part[]): string {
  if (parts.length === 0) throw new DesktopFsError('INVALID_PAYLOAD', 'مسار فارغ');
  const first = typeof parts[0] === 'string' ? parts[0] : parts[0].uri;
  let out = WIN_PATH.test(first) ? pathToUri(first) : first;
  for (const part of parts.slice(1)) {
    const rel = typeof part === 'string' ? part.split('/').filter(Boolean).map(enc).join('/') : enc(part.name);
    if (rel) out = out.replace(/\/+$/, '') + '/' + rel;
  }
  return out.replace(/\/+$/, '');
}
const lastSeg = (uri: string) => dec(uri.split('/').pop() ?? '');
const parentUri = (uri: string) => uri.replace(/\/[^/]*$/, '');

let ROOTS: { document: string; cache: string } | null = null;
function roots() {
  if (!ROOTS) ROOTS = callSync<{ document: string; cache: string }>(CH.roots);
  return ROOTS;
}
const stat = (uri: string) => callSync<Stat>(CH.stat, { uri });
const toBytes = (v: unknown): Uint8Array => (v instanceof Uint8Array ? v : new Uint8Array(v as ArrayBuffer));

// وجهة move/copy: File/Directory/نص. ملف → مجلد موجود = داخله بنفس الاسم.
function targetUri(source: File | Directory, dest: Part): string {
  if (typeof dest === 'string') return joinParts([dest]);
  if (source instanceof File && dest instanceof Directory) return joinParts([dest, source.name]);
  return dest.uri;
}

export class FileHandle {
  offset = 0;
  private closed = false;
  private readonly uri: string;
  private readonly mode: Mode;
  constructor(uri: string, mode: Mode) { this.uri = uri; this.mode = mode; }
  private live(write: boolean) {
    if (this.closed) throw new DesktopFsError('INVALID_PAYLOAD', 'المقبض مغلق');
    if (write && this.mode === 'r') throw new DesktopFsError('INVALID_PAYLOAD', 'المقبض للقراءة فقط');
    if (!write && this.mode === 'w') throw new DesktopFsError('INVALID_PAYLOAD', 'المقبض للكتابة فقط');
  }
  get size(): number { return stat(this.uri).size; }
  readBytesSync(length: number): Uint8Array {
    this.live(false);
    const r = toBytes(callSync(CH.readRange, { uri: this.uri, offset: this.offset, length }));
    this.offset += r.length;
    return r;
  }
  readBytes(length: number): Uint8Array { return this.readBytesSync(length); }
  writeBytesSync(bytes: Uint8Array): void {
    this.live(true);
    callSync(CH.writeAt, { uri: this.uri, offset: this.offset, bytes });
    this.offset += bytes.length;
  }
  writeBytes(bytes: Uint8Array): void { this.writeBytesSync(bytes); }
  close(): void { this.closed = true; }
}

export class File {
  uri: string;
  constructor(...parts: Part[]) { this.uri = joinParts(parts); }
  get name(): string { return lastSeg(this.uri); }
  get extension(): string { const n = this.name; const i = n.lastIndexOf('.'); return i > 0 ? n.slice(i) : ''; }
  get parentDirectory(): Directory { return new Directory(parentUri(this.uri)); }
  get exists(): boolean { return stat(this.uri).isFile; }
  get size(): number { return stat(this.uri).size; }
  get modificationTime(): number | null { const s = stat(this.uri); return s.exists ? s.modificationTime : null; }
  bytes(): Promise<Uint8Array> { return callAsync(CH.read, { uri: this.uri, as: 'bytes' }).then(toBytes); }
  text(): Promise<string> { return callAsync<string>(CH.read, { uri: this.uri, as: 'text' }); }
  bytesSync(): Uint8Array { return toBytes(callSync(CH.read, { uri: this.uri, as: 'bytes' })); }
  textSync(): string { return callSync<string>(CH.read, { uri: this.uri, as: 'text' }); }
  async base64(): Promise<string> {
    const b = await this.bytes();
    let s = '';
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
    return btoa(s);
  }
  create(options?: { intermediates?: boolean; overwrite?: boolean }): void {
    callSync(CH.write, { uri: this.uri, data: new Uint8Array(0), mode: options?.overwrite ? 'create-overwrite' : 'create', intermediates: !!options?.intermediates });
  }
  write(data: string | Uint8Array): void { callSync(CH.write, { uri: this.uri, data, mode: 'overwrite' }); }
  open(mode: Mode = FileMode.ReadOnly): FileHandle {
    if (!this.exists) throw new DesktopFsError('NOT_FOUND', 'الملف غير موجود');
    return new FileHandle(this.uri, mode);
  }
  delete(): void { callSync(CH.remove, { uri: this.uri, kind: 'file' }); }
  move(dest: Part): void { const to = targetUri(this, dest); callSync(CH.move, { from: this.uri, to, kind: 'file' }); this.uri = to; }
  copy(dest: Part): void { callSync(CH.copy, { from: this.uri, to: targetUri(this, dest), kind: 'file' }); }
}

export class Directory {
  uri: string;
  constructor(...parts: Part[]) { this.uri = joinParts(parts); }
  get name(): string { return lastSeg(this.uri); }
  get parentDirectory(): Directory { return new Directory(parentUri(this.uri)); }
  get exists(): boolean { return stat(this.uri).isDirectory; }
  get size(): number { return this.list().reduce((n, x) => n + x.size, 0); }
  create(options?: { intermediates?: boolean; idempotent?: boolean; overwrite?: boolean }): void {
    callSync(CH.mkdir, { uri: this.uri, intermediates: !!options?.intermediates, idempotent: !!options?.idempotent });
  }
  delete(): void { callSync(CH.remove, { uri: this.uri, kind: 'dir' }); }
  list(): Array<File | Directory> {
    return callSync<Entry[]>(CH.list, { uri: this.uri }).map((e) => (e.isDirectory ? new Directory(e.uri) : new File(e.uri)));
  }
  move(dest: Part): void { const to = targetUri(this, dest); callSync(CH.move, { from: this.uri, to, kind: 'dir' }); this.uri = to; }
  copy(dest: Part): void { callSync(CH.copy, { from: this.uri, to: targetUri(this, dest), kind: 'dir' }); }
  createDirectory(name: string): Directory {
    const d = new Directory(this, name);
    d.create({ intermediates: true, idempotent: true });
    return d;
  }
  // إن وُجد ملف بنفس الاسم يُضاف « (1)» كما يفعل منتقي المجلدات في Android.
  createFile(name: string, _mimeType?: string | null): File {
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    for (let i = 0; i < 100; i++) {
      const f = new File(this, i === 0 ? name : `${base} (${i})${ext}`);
      if (!f.exists) { f.create(); return f; }
    }
    throw new DesktopFsError('ALREADY_EXISTS', 'تعذّر إيجاد اسم ملف غير مستعمل');
  }
  static async pickDirectoryAsync(): Promise<Directory> {
    const r = await callAsync<{ canceled: boolean; uri?: string }>(CH.openDialog, { directory: true, title: 'اختر مجلد الحفظ' });
    if (r.canceled || !r.uri) throw new DesktopFsError('CANCELED', 'User cancelled the directory picker');
    return new Directory(r.uri);
  }
}

export const Paths = {
  get document(): Directory { return new Directory(roots().document); },
  get cache(): Directory { return new Directory(roots().cache); },
  join: (...parts: Part[]): string => joinParts(parts),
  basename: (p: string): string => lastSeg(p),
  extname: (p: string): string => { const n = lastSeg(p); const i = n.lastIndexOf('.'); return i > 0 ? n.slice(i) : ''; },
  dirname: (p: string): string => parentUri(p),
};
