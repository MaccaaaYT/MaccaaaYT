// Тесты без сети: Gemini и RSS подменяются заглушками fetch.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

delete process.env.KV_REST_API_URL;
delete process.env.UPSTASH_REDIS_REST_URL;
process.env.GEMINI_API_KEY = 'test-key';
process.env.CRON_SECRET = 'cron-secret';
process.env.MIYA_TIMEZONE = 'Europe/Moscow';

const { dueSlots, zonedParts, timezoneOffsetMinutes } = await import('../lib/schedule.js');
const { parseFeed } = await import('../lib/news.js');
const memory = await import('../lib/memory.js');
const { db } = await import('../lib/storage.js');
const { reply } = await import('../lib/miya.js');
const cron = (await import('../api/cron.js')).default;

const realFetch = globalThis.fetch;
let geminiCalls = [];

function geminiReply(parts) {
  return new Response(JSON.stringify({ candidates: [{ content: { role: 'model', parts } }] }), { status: 200 });
}

function stubFetch(script) {
  geminiCalls = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('generativelanguage')) {
      const body = JSON.parse(init.body);
      geminiCalls.push({ url: u, body });
      return script(u, body, geminiCalls.length);
    }
    if (u.includes('news.google.com') || u.includes('lenta') || u.includes('ria') || u.includes('tass')) {
      return new Response(SAMPLE_RSS, { status: 200 });
    }
    return realFetch(url, init);
  };
}

const SAMPLE_RSS = `<?xml version="1.0"?><rss><channel><title>Google Новости</title>
<item><title>Учёные нашли воду на Марсе - РИА Новости</title><source url="https://ria.ru">РИА Новости</source>
<pubDate>${new Date().toUTCString()}</pubDate><link>https://example.com/1</link></item>
<item><title><![CDATA[Сборная России &amp; победа]]></title><description><![CDATA[<p>Матч завершился со счётом 2:1</p>]]></description>
<pubDate>${new Date().toUTCString()}</pubDate></item>
<item><title>Старая новость</title><pubDate>Mon, 01 Jan 2024 10:00:00 GMT</pubDate></item>
</channel></rss>`;

function mockRes() {
  const res = { statusCode: 200, headers: {}, body: null, headersSent: false };
  res.setHeader = (k, v) => (res.headers[k.toLowerCase()] = v);
  res.status = (c) => ((res.statusCode = c), res);
  res.json = (d) => ((res.body = d), (res.headersSent = true), res);
  return res;
}

beforeEach(async () => {
  await db.del('miya:history');
  await db.del('miya:facts');
  await db.del('miya:summary');
  await db.del('miya:settings');
  globalThis.fetch = realFetch;
});

test('расписание: слоты срабатывают в окне с учётом часового пояса', () => {
  // 08:30 по Москве = 05:30 UTC
  const due = dueSlots(new Date('2026-10-20T05:30:00Z')).map((s) => s.id);
  assert.deepEqual(due, ['morning']);
  // 07:55 — уже можно (раннее окно 10 минут), 10:00 — утро прошло
  assert.deepEqual(dueSlots(new Date('2026-10-20T04:55:00Z')).map((s) => s.id), ['morning']);
  assert.deepEqual(dueSlots(new Date('2026-10-20T07:00:00Z')).map((s) => s.id), []);
  assert.equal(zonedParts(new Date('2026-10-20T22:30:00Z')).date, '2026-10-21');
  assert.equal(timezoneOffsetMinutes('Europe/Moscow'), 180);
});

test('RSS: разбор заголовков, CDATA, источник и отсев старого', () => {
  const items = parseFeed(SAMPLE_RSS);
  assert.equal(items[0].title, 'Учёные нашли воду на Марсе');
  assert.equal(items[0].source, 'РИА Новости');
  assert.equal(items[1].title, 'Сборная России & победа');
  assert.equal(items[1].summary, 'Матч завершился со счётом 2:1');
});

test('история: соседние реплики одной роли склеиваются, начало — с пользователя', () => {
  const contents = memory.toContents([
    { role: 'miya', text: 'Доброе утро!', kind: 'proactive' },
    { role: 'user', text: 'Привет' },
    { role: 'user', text: 'Как дела?' },
  ]);
  assert.equal(contents[0].role, 'user');
  assert.equal(contents[1].role, 'model');
  assert.match(contents[1].parts[0].text, /написала первой/);
  assert.equal(contents[2].parts[0].text, 'Привет\nКак дела?');
});

test('ответ: Мия вызывает remember_fact и get_news, затем отвечает текстом', async () => {
  stubFetch((url, body, n) => {
    if (n === 1) {
      return geminiReply([
        { functionCall: { name: 'remember_fact', args: { fact: 'Пользователя зовут Аня' } } },
        { functionCall: { name: 'get_news', args: {} } },
      ]);
    }
    // Второй запрос должен содержать результаты функций
    const last = body.contents.at(-1);
    assert.equal(last.parts[0].functionResponse.name, 'remember_fact');
    assert.equal(last.parts[1].functionResponse.response.result.items[0].title, 'Учёные нашли воду на Марсе');
    return geminiReply([{ text: 'Приятно познакомиться, Аня! А на Марсе нашли воду 🦊' }]);
  });
  await memory.addMessage('user', 'Привет, я Аня. Что нового?');
  const answer = await reply();
  assert.equal(answer.ok, true);
  assert.match(answer.text, /Аня/);
  const facts = await memory.getFacts();
  assert.deepEqual(facts.map((f) => f.text), ['Пользователя зовут Аня']);
  // Факт попадает в системный промпт следующего запроса
  stubFetch(() => geminiReply([{ text: 'ok' }]));
  await reply();
  assert.match(geminiCalls[0].body.systemInstruction.parts[0].text, /Пользователя зовут Аня/);
});

test('резервная модель: при 429 пробуем следующую', async () => {
  stubFetch((url, body, n) =>
    n === 1 ? new Response(JSON.stringify({ error: { message: 'quota' } }), { status: 429 }) : geminiReply([{ text: 'Я тут!' }]),
  );
  await memory.addMessage('user', 'Ты тут?');
  const answer = await reply();
  assert.equal(answer.text, 'Я тут!');
  assert.notEqual(geminiCalls[0].url, geminiCalls[1].url);
});

test('ошибка Gemini превращается в мягкий ответ', async () => {
  stubFetch(() => new Response(JSON.stringify({ error: { message: 'bad' } }), { status: 400 }));
  await memory.addMessage('user', 'Привет');
  const answer = await reply();
  assert.equal(answer.ok, false);
  assert.match(answer.text, /ещё разок/);
});

test('резюме: старые сообщения сжимаются', async () => {
  stubFetch(() => geminiReply([{ text: 'Аня готовится к экзамену.' }]));
  for (let i = 0; i < 60; i++) await db.rpush('miya:history', { id: String(i), role: i % 2 ? 'miya' : 'user', text: 'msg ' + i, ts: 1000 + i });
  await memory.maybeSummarize();
  const s = await memory.getSummary();
  assert.equal(s.text, 'Аня готовится к экзамену.');
  assert.equal(s.upto, 1000 + 60 - 24 - 1);
});

test('cron: нужен секрет, слот отправляется один раз в день, выключенные пропускаются', async () => {
  stubFetch(() => geminiReply([{ text: 'Доброе утро, солнышко!' }]));
  let res = mockRes();
  await cron({ method: 'GET', headers: {}, query: {} }, res);
  assert.equal(res.statusCode, 401);

  const req = { method: 'GET', headers: { authorization: 'Bearer cron-secret' }, query: { slot: 'evening', force: '1' } };
  res = mockRes();
  await cron(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.report[0].text, 'Доброе утро, солнышко!');
  const history = await memory.getHistory();
  assert.equal(history.at(-1).kind, 'proactive');

  await memory.saveSettings({ disabledSlots: ['evening'] });
  res = mockRes();
  await cron(req, res);
  assert.deepEqual(res.body.report, []);
});
