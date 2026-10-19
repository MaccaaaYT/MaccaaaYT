// Мия пишет первой. Вызывается Vercel Cron (см. vercel.json) или внешним планировщиком
// (например, cron-job.org каждые 15 минут) — с секретом CRON_SECRET.
//   GET /api/cron                 — отправить всё, что «наступило» по расписанию
//   GET /api/cron?slot=evening    — отправить конкретный слот (только если он наступил)
//   GET /api/cron?slot=evening&force=1 — отправить сейчас, без проверки времени (для теста)
import { createHash, timingSafeEqual } from 'node:crypto';
import { handler } from '../lib/http.js';
import { db, KEYS } from '../lib/storage.js';
import { SLOTS, dueSlots, zonedParts } from '../lib/schedule.js';
import { addMessage, getSettings } from '../lib/memory.js';
import { proactiveMessage } from '../lib/miya.js';
import { sendToAll, pushConfigured } from '../lib/push.js';

function authorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.authorization || '';
  const given = header.startsWith('Bearer ') ? header.slice(7) : String(req.query?.key || '');
  const h = (s) => createHash('sha256').update(s).digest();
  return timingSafeEqual(h(given), h(secret));
}

export default handler(
  async (req, res) => {
    if (!authorized(req)) return res.status(401).json({ error: 'Нужен CRON_SECRET' });

    const force = req.query?.force === '1';
    const slotId = req.query?.slot;
    const settings = await getSettings();
    let slots = force ? SLOTS.filter((s) => s.id === slotId) : dueSlots();
    if (slotId && !force) slots = slots.filter((s) => s.id === slotId);
    slots = slots.filter((s) => !settings.disabledSlots.includes(s.id));

    const { date } = zonedParts();
    const report = [];
    for (const slot of slots) {
      // Защита от повторной отправки: один слот — один раз в день.
      if (!force) {
        const claimed = await db.set(KEYS.sent(slot.id, date), Date.now(), { nx: true, ex: 3 * 24 * 3600 });
        if (!claimed) {
          report.push({ slot: slot.id, skipped: 'already sent' });
          continue;
        }
      }
      const text = await proactiveMessage(slot);
      const msg = await addMessage('miya', text, { kind: 'proactive', slot: slot.id });
      let push = { skipped: 'push not configured' };
      if (pushConfigured()) {
        push = await sendToAll({ title: 'Мия 🦊', body: text, tag: slot.id, url: `/?m=${msg.id}` });
      }
      report.push({ slot: slot.id, text, push });
    }
    res.status(200).json({ date, report });
  },
  { methods: ['GET', 'POST'], auth: false },
);
