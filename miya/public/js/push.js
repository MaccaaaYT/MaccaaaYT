// Подписка на push-уведомления.
import { api } from './api.js';

export const isStandalone =
  window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;
export const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

function deviceName() {
  const ua = navigator.userAgent;
  if (/iphone/i.test(ua)) return 'iPhone';
  if (/ipad/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'iPad';
  if (/android/i.test(ua)) return 'Android';
  if (/mac/i.test(ua)) return 'Mac';
  if (/windows/i.test(ua)) return 'Windows';
  return 'Устройство';
}

export async function currentSubscription() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

/** Должна вызываться из обработчика нажатия (особенно на iPhone). */
export async function enablePush(vapidPublicKey) {
  if (!pushSupported()) throw new Error(isIOS && !isStandalone ? 'На iPhone сначала добавь Мию на экран «Домой»' : 'Этот браузер не поддерживает уведомления');
  if (!vapidPublicKey) throw new Error('На сервере не настроены VAPID-ключи');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Уведомления не разрешены в настройках браузера');
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) });
  }
  await api('subscribe', { method: 'POST', body: { subscription: sub.toJSON(), device: deviceName() } });
  return sub;
}

/** При каждом запуске обновляем подписку на сервере (она может смениться). */
export async function syncPush(vapidPublicKey) {
  if (!pushSupported() || Notification.permission !== 'granted' || !vapidPublicKey) return false;
  try {
    const sub = await enablePush(vapidPublicKey);
    return Boolean(sub);
  } catch {
    return false;
  }
}

export async function disablePush() {
  const sub = await currentSubscription();
  if (!sub) return;
  await api('subscribe', { method: 'DELETE', body: { endpoint: sub.endpoint } }).catch(() => {});
  await sub.unsubscribe();
}
