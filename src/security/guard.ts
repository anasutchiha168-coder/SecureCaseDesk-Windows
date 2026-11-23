import { can } from '@/security/permissions';

type Role = Parameters<typeof can>[0];
type Perm = Parameters<typeof can>[1];

export interface Session {
  userId: string;
  role: Role;
}

export class ForbiddenError extends Error {
  constructor(public readonly perm: string) {
    super('FORBIDDEN:' + perm);
    this.name = 'ForbiddenError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// SECURECASEDESK_PHASE8_S3: مستمعو الرفض (يستخدمها سجل التدقيق دون أن يعتمد الحارس عليه).
export interface ForbiddenEvent {
  userId: string | null;
  role: string | null;
  permission: string;
  at: number;
}

type ForbiddenListener = (event: ForbiddenEvent) => void;
const forbiddenListeners = new Set<ForbiddenListener>();

export function onForbidden(listener: ForbiddenListener): () => void {
  forbiddenListeners.add(listener);
  return () => {
    forbiddenListeners.delete(listener);
  };
}

function notifyForbidden(session: Session | null | undefined, perm: string): void {
  const event: ForbiddenEvent = {
    userId: session?.userId ?? null,
    role: session?.role ? String(session.role) : null,
    permission: perm,
    at: Date.now(),
  };
  for (const listener of forbiddenListeners) {
    try {
      listener(event);
    } catch {
      // فشل المستمع لا يجوز أن يغيّر قرار الرفض.
    }
  }
}

// يفشل مغلقاً: جلسة ناقصة أو دور غير معروف = رفض.
export function requirePerm(session: Session | null | undefined, perm: Perm): Session {
  if (!session || !session.userId || !session.role || !can(session.role, perm)) {
    notifyForbidden(session, String(perm));
    throw new ForbiddenError(String(perm));
  }
  return session;
}
