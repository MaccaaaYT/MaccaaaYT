// Генерирует пару VAPID-ключей для push-уведомлений.
// Запуск: npm run vapid — затем добавьте значения в переменные окружения Vercel.
import webpush from 'web-push';

const { publicKey, privateKey } = webpush.generateVAPIDKeys();
console.log('Добавьте в Vercel → Settings → Environment Variables:\n');
console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
console.log('VAPID_SUBJECT=mailto:ваша-почта@example.com');
