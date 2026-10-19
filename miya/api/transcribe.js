// Запасной вариант распознавания речи: аудио → текст через Gemini.
// Нужен там, где в браузере нет Web Speech API (например, Firefox или некоторые PWA на iOS).
import { handler, badRequest } from '../lib/http.js';
import { hasGeminiKey } from '../lib/gemini.js';
import { transcribe } from '../lib/miya.js';

const ALLOWED = /^audio\/(webm|ogg|mp4|mpeg|mp3|wav|x-wav|aac|m4a|x-m4a|flac)/;

export default handler(
  async (req, res) => {
    const { audio, mimeType } = req.body;
    if (typeof audio !== 'string' || !audio) throw badRequest('Нет аудио');
    if (audio.length > 4_000_000) throw badRequest('Запись слишком длинная');
    const type = String(mimeType || '').split(';')[0];
    if (!ALLOWED.test(type)) throw badRequest('Неподдерживаемый формат аудио');
    if (!hasGeminiKey()) return res.status(200).json({ text: '', demo: true });
    // Gemini принимает mp4-аудио с iPhone как audio/mp4, webm из Chrome — как audio/webm.
    const text = await transcribe({ data: audio, mimeType: type === 'audio/x-m4a' || type === 'audio/m4a' ? 'audio/mp4' : type });
    res.status(200).json({ text });
  },
  { methods: ['POST'] },
);
