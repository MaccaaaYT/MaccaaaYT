// Тонкий клиент Gemini API (REST), без SDK.
// Ключ берётся только из переменной окружения на сервере и никогда не уходит в браузер.

const API = 'https://generativelanguage.googleapis.com/v1beta/models';

// Если основная модель недоступна (нет такой / кончилась бесплатная квота) —
// пробуем следующую: у каждой модели на бесплатном тарифе свои лимиты.
const FALLBACK_MODELS = ['gemini-flash-latest', 'gemini-2.5-flash', 'gemini-flash-lite-latest', 'gemini-2.5-flash-lite'];

export function hasGeminiKey() {
  return Boolean(process.env.GEMINI_API_KEY);
}

function modelChain() {
  const preferred = process.env.GEMINI_MODEL?.trim();
  return [...new Set([preferred, ...FALLBACK_MODELS].filter(Boolean))];
}

export class GeminiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function callModel(model, body, timeoutMs) {
  const res = await fetch(`${API}/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': process.env.GEMINI_API_KEY,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new GeminiError(data?.error?.message || `Gemini HTTP ${res.status}`, res.status);
  }
  return data;
}

/** Один запрос generateContent с перебором моделей при 404/429/5xx. */
export async function generate(body, { timeoutMs = 25000 } = {}) {
  if (!hasGeminiKey()) throw new GeminiError('GEMINI_API_KEY не задан', 0);
  let lastError;
  for (const model of modelChain()) {
    try {
      return await callModel(model, body, timeoutMs);
    } catch (err) {
      lastError = err;
      const retriable = [404, 429, 500, 502, 503, 504].includes(err.status) || err.name === 'TimeoutError';
      if (!retriable) throw err;
      console.warn(`[gemini] ${model}: ${err.message} — пробую следующую модель`);
    }
  }
  throw lastError;
}

export function textOf(response) {
  const parts = response?.candidates?.[0]?.content?.parts || [];
  return parts
    .filter((p) => typeof p.text === 'string' && !p.thought)
    .map((p) => p.text)
    .join('')
    .trim();
}

/**
 * Диалог с поддержкой вызова функций (tools).
 * handlers: { [name]: async (args) => result }
 */
export async function chatWithTools({ system, contents, tools = [], handlers = {}, temperature = 0.9, maxRounds = 4 }) {
  const convo = [...contents];
  const body = () => ({
    systemInstruction: { parts: [{ text: system }] },
    contents: convo,
    ...(tools.length ? { tools: [{ functionDeclarations: tools }] } : {}),
    generationConfig: { temperature },
  });

  for (let round = 0; round < maxRounds; round++) {
    const response = await generate(body());
    const content = response?.candidates?.[0]?.content;
    const calls = (content?.parts || []).filter((p) => p.functionCall);
    if (!calls.length) {
      const text = textOf(response);
      if (!text) {
        const reason = response?.candidates?.[0]?.finishReason || response?.promptFeedback?.blockReason;
        throw new GeminiError(`Пустой ответ модели (${reason || 'unknown'})`, 200);
      }
      return text;
    }
    // Возвращаем модели её же ответ целиком (включая служебные подписи мыслей),
    // а затем результаты функций.
    convo.push(content);
    const responses = [];
    for (const { functionCall } of calls) {
      const handler = handlers[functionCall.name];
      let result;
      try {
        result = handler ? await handler(functionCall.args || {}) : { error: 'unknown function' };
      } catch (err) {
        result = { error: String(err.message || err) };
      }
      responses.push({ functionResponse: { name: functionCall.name, response: { result } } });
    }
    convo.push({ role: 'user', parts: responses });
  }
  throw new GeminiError('Слишком много вызовов функций подряд', 200);
}

/** Простая генерация текста по одному промпту. */
export async function simpleText({ system, prompt, temperature = 0.9, parts }) {
  const response = await generate({
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    contents: [{ role: 'user', parts: parts || [{ text: prompt }] }],
    generationConfig: { temperature },
  });
  const text = textOf(response);
  if (!text) throw new GeminiError('Пустой ответ модели', 200);
  return text;
}
