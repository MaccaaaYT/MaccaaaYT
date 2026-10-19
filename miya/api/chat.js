// Сообщение пользователя → ответ Мии. Обе реплики сохраняются в память.
import { waitUntil } from '@vercel/functions';
import { handler, badRequest } from '../lib/http.js';
import { addMessage, maybeSummarize } from '../lib/memory.js';
import { reply } from '../lib/miya.js';

export default handler(
  async (req, res) => {
    const text = String(req.body.text || '').trim();
    if (!text) throw badRequest('Пустое сообщение');
    if (text.length > 4000) throw badRequest('Слишком длинное сообщение');

    const userMsg = await addMessage('user', text, { via: req.body.via === 'voice' ? 'voice' : 'text' });
    const answer = await reply();
    const miyaMsg = await addMessage('miya', answer.text, answer.ok ? {} : { error: true });

    if (answer.ok) waitUntil(maybeSummarize());
    res.status(200).json({ user: userMsg, reply: miyaMsg, demo: Boolean(answer.demo) });
  },
  { methods: ['POST'] },
);
