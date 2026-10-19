// Запросы к серверу и локальные настройки устройства.

export const local = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem('miya.' + key);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem('miya.' + key, JSON.stringify(value));
    } catch {
      /* приватный режим — просто не запоминаем */
    }
  },
  remove(key) {
    try {
      localStorage.removeItem('miya.' + key);
    } catch {}
  },
};

export class AuthError extends Error {}

let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

export async function api(path, { method = 'GET', body, timeout = 60000 } = {}) {
  const token = local.get('token', '');
  const res = await fetch('/api/' + path, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: 'Bearer ' + token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout ? AbortSignal.timeout(timeout) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== 'config') {
    onUnauthorized();
    throw new AuthError(data.error || 'Нужен пароль');
  }
  if (!res.ok) throw new Error(data.error || `Ошибка сервера (${res.status})`);
  return data;
}
