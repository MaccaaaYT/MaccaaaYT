// Хранилище: Upstash Redis (бесплатно через Vercel Marketplace).
// Если переменные окружения не заданы — временное хранилище в памяти процесса
// (подходит только для локальной разработки: на Vercel данные будут теряться).
import { Redis } from '@upstash/redis';

const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

export const isPersistent = Boolean(url && token);

class MemoryStore {
  constructor() {
    this.data = new Map();
  }
  async get(key) {
    return this.data.has(key) ? structuredClone(this.data.get(key)) : null;
  }
  async set(key, value, opts = {}) {
    if (opts.nx && this.data.has(key)) return null;
    this.data.set(key, structuredClone(value));
    if (opts.ex) setTimeout(() => this.data.delete(key), opts.ex * 1000).unref?.();
    return 'OK';
  }
  async del(key) {
    return this.data.delete(key) ? 1 : 0;
  }
  async rpush(key, ...values) {
    const list = this.data.get(key) || [];
    list.push(...values.map((v) => structuredClone(v)));
    this.data.set(key, list);
    return list.length;
  }
  async lrange(key, start, stop) {
    const list = this.data.get(key) || [];
    const n = list.length;
    const s = start < 0 ? Math.max(n + start, 0) : start;
    const e = stop < 0 ? n + stop : Math.min(stop, n - 1);
    return structuredClone(list.slice(s, e + 1));
  }
  async ltrim(key, start, stop) {
    const list = await this.lrange(key, start, stop);
    this.data.set(key, list);
    return 'OK';
  }
  async llen(key) {
    return (this.data.get(key) || []).length;
  }
  async hset(key, obj) {
    const h = this.data.get(key) || {};
    Object.assign(h, structuredClone(obj));
    this.data.set(key, h);
    return Object.keys(obj).length;
  }
  async hgetall(key) {
    const h = this.data.get(key);
    return h && Object.keys(h).length ? structuredClone(h) : null;
  }
  async hdel(key, ...fields) {
    const h = this.data.get(key) || {};
    let n = 0;
    for (const f of fields) if (f in h) (delete h[f], n++);
    return n;
  }
}

// Сохраняем экземпляр между «горячими» вызовами dev-сервера.
const globalStore = globalThis.__miyaStore || (globalThis.__miyaStore = new MemoryStore());

export const db = isPersistent ? new Redis({ url, token }) : globalStore;

export const KEYS = {
  history: 'miya:history', // список сообщений {role, text, ts, kind?}
  summary: 'miya:summary', // краткое содержание старых разговоров
  facts: 'miya:facts', // список фактов о пользователе
  subs: 'miya:subs', // hash: endpoint -> подписка web push
  settings: 'miya:settings',
  sent: (slot, date) => `miya:sent:${slot}:${date}`,
  summarizing: 'miya:lock:summarize',
};

/** Upstash возвращает уже распарсенный JSON, но на всякий случай нормализуем. */
export function parse(value) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
