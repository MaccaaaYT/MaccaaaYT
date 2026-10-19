// Настройки: имя пользователя и какие напоминания включены.
import { handler } from '../lib/http.js';
import { getSettings, saveSettings } from '../lib/memory.js';

export default handler(
  async (req, res) => {
    const settings = req.method === 'POST' ? await saveSettings(req.body) : await getSettings();
    res.status(200).json({ settings });
  },
  { methods: ['GET', 'POST'] },
);
