// Память Мии: история сообщений, факты о пользователе и сжатое резюме старых разговоров.
import { db, KEYS, parse } from './storage.js';
import { simpleText, hasGeminiKey } from './gemini.js';

const MAX_HISTORY = 400; // сколько сообщений храним для отображения в чате
const CONTEXT_MESSAGES = 24; // сколько последних сообщений отдаём модели целиком
const SUMMARIZE_BATCH = 30; // когда «несжатых» старых сообщений набралось столько — сжимаем
const MAX_FACTS = 120;

export async function getHistory(limit = MAX_HISTORY) {
  const items = await db.lrange(KEYS.history, -limit, -1);
  return (items || []).map(parse).filter(Boolean);
}

export async function addMessage(role, text, extra = {}) {
  const msg = { id: crypto.randomUUID(), role, text, ts: Date.now(), ...extra };
  await db.rpush(KEYS.history, msg);
  await db.ltrim(KEYS.history, -MAX_HISTORY, -1);
  return msg;
}

export async function clearHistory() {
  await db.del(KEYS.history);
  await db.del(KEYS.summary);
}

export async function getSummary() {
  return parse(await db.get(KEYS.summary)) || { text: '', upto: 0 };
}

export async function getFacts() {
  return (parse(await db.get(KEYS.facts)) || []).filter((f) => f && f.text);
}

export async function addFact(text) {
  const clean = String(text || '').trim().slice(0, 300);
  if (!clean) return { saved: false };
  const facts = await getFacts();
  if (facts.some((f) => f.text.toLowerCase() === clean.toLowerCase())) return { saved: false, reason: 'already known' };
  facts.push({ id: crypto.randomUUID(), text: clean, ts: Date.now() });
  await db.set(KEYS.facts, facts.slice(-MAX_FACTS));
  return { saved: true };
}

export async function removeFact({ id, query }) {
  const facts = await getFacts();
  const q = query?.toLowerCase().trim();
  const left = facts.filter((f) => (id ? f.id !== id : !(q && f.text.toLowerCase().includes(q))));
  await db.set(KEYS.facts, left);
  return { removed: facts.length - left.length };
}

export async function clearFacts() {
  await db.del(KEYS.facts);
}

/** Переводит историю в формат contents для Gemini (роль user/model). */
export function toContents(messages) {
  const contents = [];
  for (const m of messages) {
    const role = m.role === 'user' ? 'user' : 'model';
    const text = m.kind === 'proactive' ? `(Ты написала первой) ${m.text}` : m.text;
    const last = contents[contents.length - 1];
    // Gemini не любит две реплики одной роли подряд — склеиваем.
    if (last && last.role === role) last.parts[0].text += '\n' + text;
    else contents.push({ role, parts: [{ text }] });
  }
  // Диалог должен начинаться с пользователя.
  if (contents[0]?.role === 'model') contents.unshift({ role: 'user', parts: [{ text: '(начало разговора)' }] });
  return contents;
}

/** Всё, что нужно для ответа: последние сообщения, резюме, факты. */
export async function loadContext() {
  const [history, summary, facts] = await Promise.all([getHistory(CONTEXT_MESSAGES), getSummary(), getFacts()]);
  return { history, summary, facts };
}

/**
 * Сжимает старые сообщения в резюме, чтобы Мия «помнила» давние разговоры,
 * не раздувая запрос к модели. Вызывается в фоне после ответа.
 */
export async function maybeSummarize() {
  if (!hasGeminiKey()) return;
  const all = await getHistory(MAX_HISTORY);
  const summary = await getSummary();
  const older = all.slice(0, -CONTEXT_MESSAGES).filter((m) => m.ts > (summary.upto || 0));
  if (older.length < SUMMARIZE_BATCH) return;

  // Простая блокировка, чтобы два запроса не сжимали одновременно.
  const locked = await db.set(KEYS.summarizing, 1, { nx: true, ex: 120 });
  if (!locked) return;
  try {
    const transcript = older
      .map((m) => `${m.role === 'user' ? 'Пользователь' : 'Мия'}: ${m.text}`)
      .join('\n');
    const text = await simpleText({
      temperature: 0.3,
      prompt:
        'Ты ведёшь память лисички-помощницы Мии. Обнови краткое резюме её разговоров с пользователем. ' +
        'Сохрани важное: события из жизни пользователя, планы и обещания, настроение, о чём договорились, ' +
        'темы, к которым стоит вернуться. Пиши по-русски, сжато, не больше 1200 символов, без markdown.\n\n' +
        `Прежнее резюме:\n${summary.text || '(пусто)'}\n\nНовые реплики:\n${transcript}`,
    });
    await db.set(KEYS.summary, { text: text.slice(0, 2000), upto: older[older.length - 1].ts });
  } catch (err) {
    console.warn('[memory] не удалось обновить резюме:', err.message);
  } finally {
    await db.del(KEYS.summarizing);
  }
}

export async function getSettings() {
  const s = parse(await db.get(KEYS.settings)) || {};
  return {
    userName: s.userName ?? process.env.USER_NAME ?? '',
    disabledSlots: Array.isArray(s.disabledSlots) ? s.disabledSlots : [],
  };
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = { ...current };
  if (typeof patch.userName === 'string') next.userName = patch.userName.trim().slice(0, 60);
  if (Array.isArray(patch.disabledSlots)) next.disabledSlots = patch.disabledSlots.map(String).slice(0, 20);
  await db.set(KEYS.settings, next);
  return next;
}
