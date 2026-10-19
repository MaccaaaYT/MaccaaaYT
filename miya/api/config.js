// Публичные настройки для клиента + проверка пароля (POST).
import { handler, authRequired, checkPassword } from '../lib/http.js';
import { pushConfigured } from '../lib/push.js';
import { hasGeminiKey } from '../lib/gemini.js';
import { isPersistent } from '../lib/storage.js';
import { SLOTS, getTimezone } from '../lib/schedule.js';

export default handler(
  async (req, res) => {
    if (req.method === 'POST') {
      const ok = checkPassword(req.body.password);
      // Небольшая задержка усложняет перебор пароля.
      if (!ok) await new Promise((r) => setTimeout(r, 800));
      return res.status(ok ? 200 : 401).json({ ok });
    }
    res.status(200).json({
      authRequired: authRequired(),
      vapidPublicKey: process.env.VAPID_PUBLIC_KEY || null,
      push: pushConfigured(),
      gemini: hasGeminiKey(),
      persistent: isPersistent,
      timezone: getTimezone(),
      slots: SLOTS.map(({ id, time, title }) => ({ id, time, title })),
    });
  },
  { methods: ['GET', 'POST'], auth: false },
);
