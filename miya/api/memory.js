// Что Мия помнит о пользователе: просмотр, добавление, удаление.
import { handler, badRequest } from '../lib/http.js';
import { getFacts, addFact, removeFact, clearFacts, getSummary } from '../lib/memory.js';

export default handler(
  async (req, res) => {
    if (req.method === 'POST') {
      if (!req.body.fact) throw badRequest('Пустой факт');
      await addFact(req.body.fact);
    } else if (req.method === 'DELETE') {
      if (req.query?.id) await removeFact({ id: String(req.query.id) });
      else await clearFacts();
    }
    const [facts, summary] = await Promise.all([getFacts(), getSummary()]);
    res.status(200).json({ facts, summary: summary.text });
  },
  { methods: ['GET', 'POST', 'DELETE'] },
);
