// «Мозг» Мии: ответ на сообщение и сообщения, которые она пишет первой.
import { chatWithTools, simpleText, hasGeminiKey } from './gemini.js';
import { buildSystemPrompt, PERSONA, nowDescription } from './persona.js';
import { loadContext, toContents, addFact, removeFact, getSettings } from './memory.js';
import { getNews } from './news.js';

const TOOLS = [
  {
    name: 'remember_fact',
    description: 'Запомнить надолго важный факт о пользователе (одно короткое предложение в третьем лице).',
    parameters: {
      type: 'object',
      properties: {
        fact: { type: 'string', description: 'Например: «Пользователя зовут Аня», «В пятницу у него экзамен по физике».' },
      },
      required: ['fact'],
    },
  },
  {
    name: 'forget_fact',
    description: 'Забыть сохранённые факты, содержащие указанные слова.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Слово или фраза из факта, который нужно забыть.' } },
      required: ['query'],
    },
  },
  {
    name: 'get_news',
    description: 'Получить свежие заголовки новостей за последние сутки.',
    parameters: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description: 'Тема (например «технологии», «спорт», «космос», «Apple»). Пусто — главные новости.',
        },
      },
    },
  },
];

const handlers = {
  remember_fact: ({ fact }) => addFact(fact),
  forget_fact: ({ query }) => removeFact({ query }),
  get_news: ({ topic }) => getNews({ topic, limit: 10 }),
};

function demoReply(text) {
  return `Фыр! Я пока в демо-режиме: на сервере не задан ключ Gemini, поэтому пока просто повторяю: «${text.slice(0, 200)}» 🦊`;
}

function friendlyError(err) {
  if (err?.status === 429) return 'Ой, я сегодня столько болтала, что бесплатный лимит закончился. Давай чуть-чуть передохнём и поговорим попозже? 🦊';
  return 'Ой, у меня что-то запуталось в мыслях, ушки поникли… Попробуй, пожалуйста, ещё разок.';
}

/** Ответ Мии на новое сообщение пользователя (сообщение уже должно быть в истории). */
export async function reply() {
  const [{ history, summary, facts }, settings] = await Promise.all([loadContext(), getSettings()]);
  const last = history[history.length - 1];
  if (!hasGeminiKey()) return { text: demoReply(last?.text || ''), ok: true, demo: true };
  try {
    const text = await chatWithTools({
      system: buildSystemPrompt({ settings, facts, summary: summary.text }),
      contents: toContents(history),
      tools: TOOLS,
      handlers,
    });
    return { text, ok: true };
  } catch (err) {
    console.error('[miya] ошибка ответа:', err.status, err.message);
    return { text: friendlyError(err), ok: false };
  }
}

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/** Короткое сообщение, которое Мия пишет первой по расписанию. */
export async function proactiveMessage(slot) {
  if (!hasGeminiKey()) return pick(slot.fallbacks);
  try {
    const [{ history, summary, facts }, settings] = await Promise.all([loadContext(), getSettings()]);
    const recent = history
      .slice(-8)
      .map((m) => `${m.role === 'user' ? 'Пользователь' : 'Мия'}: ${m.text}`)
      .join('\n');
    const text = await simpleText({
      system: buildSystemPrompt({ settings, facts, summary: summary.text }) || PERSONA,
      temperature: 1,
      prompt:
        `Сейчас ${nowDescription()}. Ты сама пишешь пользователю первой — это текст push-уведомления.\n` +
        `Повод: ${slot.theme}\n` +
        (recent ? `Последние реплики вашего разговора (для контекста, не повторяй их):\n${recent}\n` : '') +
        'Напиши одно-два коротких тёплых предложения (до 160 символов), можно одно эмодзи. ' +
        'Если в памяти есть что-то подходящее (планы, самочувствие, события) — упомяни это. Только текст сообщения.',
    });
    return text.replace(/^["«]|["»]$/g, '').slice(0, 300);
  } catch (err) {
    console.warn('[miya] не удалось сгенерировать сообщение, беру заготовку:', err.message);
    return pick(slot.fallbacks);
  }
}

/** Расшифровка голосового сообщения через Gemini (если в браузере нет распознавания речи). */
export async function transcribe({ data, mimeType }) {
  const text = await simpleText({
    temperature: 0,
    parts: [
      { inlineData: { mimeType, data } },
      {
        text:
          'Расшифруй эту аудиозапись дословно на русском языке. Верни только сам текст, без пояснений и кавычек. ' +
          'Если речи не слышно — верни пустую строку.',
      },
    ],
  }).catch((err) => {
    if (/Пустой ответ/.test(err.message)) return '';
    throw err;
  });
  return text.trim();
}
