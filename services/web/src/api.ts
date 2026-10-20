/** Thin fetch wrapper: adds the session token and turns errors into readable messages. */
const TOKEN_KEY = 'rased.token';

export type Role = 'operator' | 'supervisor' | 'manager' | 'admin';
export interface User { id: string; username: string; role: Role; fullName: string }

export function getToken(): string | null {
  try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; }
}
export function setToken(t: string | null) {
  try {
    if (t) sessionStorage.setItem(TOKEN_KEY, t);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch { /* private mode: session lives in memory only */ }
}

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void) { onUnauthorized = fn; }

const MESSAGES: Record<string, string> = {
  'wrong username or password': 'اسم المستخدم أو كلمة المرور غير صحيحة.',
  'too many attempts, try again later': 'محاولات كثيرة. حاول مرة أخرى بعد عشر دقائق.',
  'session expired': 'انتهت الجلسة. سجّل الدخول من جديد.',
  'a reason is required to dismiss an alert': 'اختر سبب الرفض.',
  'already reviewed': 'هذا التنبيه رُوجع من قبل. تغيير القرار يحتاج مشرفاً.',
  'insufficient role': 'صلاحياتك لا تسمح بهذا الإجراء.',
  'expected count is not set for this area': 'لم يُحدد العدد المتوقع لهذه المنطقة. أدخله يدوياً.',
  'no recent data from this area: are its cameras online?': 'لا توجد قراءات حديثة من هذه المنطقة. تحقق من اتصال كاميراتها.',
  'exporting clips needs a supervisor': 'تصدير المقاطع يحتاج صلاحية مشرف.',
};

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method: opts.method ?? 'GET', headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  } catch {
    throw new ApiError(0, 'تعذّر الاتصال بالخادم. تحقق من الشبكة.');
  }
  if (res.status === 401 && path !== '/auth/login') {
    onUnauthorized?.();
  }
  if (!res.ok) {
    let msg = `خطأ ${res.status}`;
    try {
      const body = await res.json();
      const raw = Array.isArray(body.message) ? body.message.join(', ') : body.message;
      if (raw) msg = MESSAGES[raw] ?? raw;
    } catch { /* not json */ }
    throw new ApiError(res.status, msg);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}
