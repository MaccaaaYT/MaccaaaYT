// История переписки (общая для всех устройств).
import { handler } from '../lib/http.js';
import { getHistory, clearHistory } from '../lib/memory.js';

export default handler(
  async (req, res) => {
    if (req.method === 'DELETE') {
      await clearHistory();
      return res.status(200).json({ ok: true });
    }
    const since = Number(req.query?.since) || 0;
    const limit = Math.min(Number(req.query?.limit) || 100, 400);
    const messages = (await getHistory(limit)).filter((m) => m.ts > since);
    res.status(200).json({ messages });
  },
  { methods: ['GET', 'DELETE'] },
);
