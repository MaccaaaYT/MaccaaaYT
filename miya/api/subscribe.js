// Подписка устройства на push-уведомления, отписка и тестовое уведомление.
import { handler, badRequest } from '../lib/http.js';
import { saveSubscription, removeSubscription, sendToAll, pushConfigured, listSubscriptions } from '../lib/push.js';

export default handler(
  async (req, res) => {
    if (req.method === 'GET') {
      const subs = await listSubscriptions();
      return res.status(200).json({ devices: subs.map((s) => ({ device: s.device, ts: s.ts })) });
    }
    if (req.method === 'DELETE') {
      if (!req.body.endpoint) throw badRequest('Нет endpoint');
      await removeSubscription(req.body.endpoint);
      return res.status(200).json({ ok: true });
    }
    if (!pushConfigured()) throw badRequest('На сервере не настроены VAPID-ключи');
    if (req.body.action === 'test') {
      const result = await sendToAll({
        title: 'Мия 🦊',
        body: 'Фыр-фыр! Это проверка: уведомления работают 💛',
        tag: 'test',
        url: '/',
      });
      return res.status(200).json(result);
    }
    try {
      await saveSubscription(req.body.subscription, req.body.device);
    } catch (err) {
      throw badRequest(err.message);
    }
    res.status(200).json({ ok: true });
  },
  { methods: ['GET', 'POST', 'DELETE'] },
);
