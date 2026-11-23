// Shim لـ expo-file-system (واجهة File/Directory/Paths الجديدة المستخدمة في src). التنفيذ: القسم 5.
import { notImplemented, notImplementedAsync } from './errors';
const M = 'expo-file-system';
const S = 5;

export const FileMode = { ReadOnly: 'r', WriteOnly: 'w', ReadWrite: 'rw' } as const;

type Part = string | File | Directory;

export class File {
  readonly uri: string;
  constructor(...parts: Part[]) {
    this.uri = parts.map((p) => (typeof p === 'string' ? p : p.uri)).join('/');
  }
  get name(): string { return this.uri.split('/').pop() ?? ''; }
  get extension(): string { const n = this.name; const i = n.lastIndexOf('.'); return i >= 0 ? n.slice(i) : ''; }
  get exists(): boolean { return notImplemented(M, 'File.exists', S); }
  get size(): number { return notImplemented(M, 'File.size', S); }
  bytes(): Promise<Uint8Array> { return notImplementedAsync(M, 'File.bytes', S); }
  create(_options?: Record<string, unknown>): void { return notImplemented(M, 'File.create', S); }
  write(_data: string | Uint8Array): void { return notImplemented(M, 'File.write', S); }
  open(_mode?: string): unknown { return notImplemented(M, 'File.open', S); }
  delete(): void { return notImplemented(M, 'File.delete', S); }
}

export class Directory {
  readonly uri: string;
  constructor(...parts: Part[]) {
    this.uri = parts.map((p) => (typeof p === 'string' ? p : p.uri)).join('/');
  }
  get name(): string { return this.uri.split('/').filter(Boolean).pop() ?? ''; }
  get exists(): boolean { return notImplemented(M, 'Directory.exists', S); }
  create(_options?: Record<string, unknown>): void { return notImplemented(M, 'Directory.create', S); }
  list(): Array<File | Directory> { return notImplemented(M, 'Directory.list', S); }
  delete(): void { return notImplemented(M, 'Directory.delete', S); }
}

export const Paths = {
  get document(): Directory { return notImplemented(M, 'Paths.document', S); },
  get cache(): Directory { return notImplemented(M, 'Paths.cache', S); },
};
