// Web Push (VAPID). Работает в Chrome/Edge/Firefox на Windows и Mac,
// в Safari на Mac и на iPhone (iOS 16.4+, если приложение добавлено «На экран Домой»).
import webpush from 'web-push';
import { db, KEYS, parse } from './storage.js';

let configured = false;

export function pushConfigured() {
  return Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

function ensureConfigured() {
  if (configured) return;
  if (!pushConfigured()) throw new Error('VAPID-ключи не заданы (npm run vapid)');
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:miya@example.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY,
  );
  configured = true;
}

function isValidSubscription(sub) {
  return sub && typeof sub.endpoint === 'string' && /^https:\/\//.test(sub.endpoint) && sub.keys?.p256dh && sub.keys?.auth;
}

export async function saveSubscription(sub, device = '') {
  if (!isValidSubscription(sub)) throw new Error('Некорректная подписка');
  const record = { endpoint: sub.endpoint, keys: sub.keys, device: String(device).slice(0, 80), ts: Date.now() };
  await db.hset(KEYS.subs, { [sub.endpoint]: record });
}

export async function removeSubscription(endpoint) {
  await db.hdel(KEYS.subs, endpoint);
}

export async function listSubscriptions() {
  const all = (await db.hgetall(KEYS.subs)) || {};
  return Object.values(all).map(parse).filter(isValidSubscription);
}

/** Отправляет уведомление на все устройства. Отписавшиеся удаляет. */
export async function sendToAll(payload) {
  ensureConfigured();
  const subs = await listSubscriptions();
  const body = JSON.stringify(payload);
  const results = await Promise.allSettled(
    subs.map((s) => webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, body, { TTL: 6 * 3600, urgency: 'normal' })),
  );
  let sent = 0;
  await Promise.all(
    results.map(async (r, i) => {
      if (r.status === 'fulfilled') return sent++;
      const code = r.reason?.statusCode;
      if (code === 404 || code === 410) await removeSubscription(subs[i].endpoint);
      else console.warn('[push] ошибка отправки:', code, r.reason?.body || r.reason?.message);
    }),
  );
  return { total: subs.length, sent };
}
