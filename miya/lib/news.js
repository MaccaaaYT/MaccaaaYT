// Свежие новости из открытых RSS-лент — бесплатно и без ключей.
// Ленты можно переопределить переменной окружения NEWS_FEEDS (адреса через запятую).

const DEFAULT_FEEDS = [
  'https://news.google.com/rss?hl=ru&gl=RU&ceid=RU:ru',
  'https://lenta.ru/rss/news',
  'https://ria.ru/export/rss2/archive/index.xml',
  'https://tass.ru/rss/v2.xml',
];

const topicFeed = (topic) =>
  `https://news.google.com/rss/search?q=${encodeURIComponent(topic + ' when:2d')}&hl=ru&gl=RU&ceid=RU:ru`;

function decodeEntities(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

function stripTags(s) {
  return s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? stripTags(decodeEntities(m[1])) : '';
}

/** Разбирает RSS 2.0 / Atom в список {title, summary, source, date, link}. */
export function parseFeed(xml, fallbackSource = '') {
  const channelTitle = tag(xml.split(/<item[\s>]|<entry[\s>]/i)[0] || '', 'title') || fallbackSource;
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>|<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  return blocks
    .map((b) => {
      let title = tag(b, 'title');
      let source = tag(b, 'source') || channelTitle;
      // В Google News заголовок выглядит как «Заголовок - Источник».
      const dash = title.lastIndexOf(' - ');
      if (source && dash > 0 && title.slice(dash + 3) === source) title = title.slice(0, dash);
      const dateText = tag(b, 'pubDate') || tag(b, 'updated') || tag(b, 'published');
      const date = dateText ? new Date(dateText) : null;
      const linkTag = tag(b, 'link') || (b.match(/<link[^>]*href="([^"]+)"/i) || [])[1] || '';
      let summary = tag(b, 'description') || tag(b, 'summary');
      if (summary === title || summary.startsWith(title)) summary = '';
      return {
        title,
        summary: summary.slice(0, 280),
        source,
        date: date && !isNaN(date) ? date.toISOString() : null,
        link: linkTag,
      };
    })
    .filter((x) => x.title);
}

async function fetchFeed(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; MiyaAssistant/1.0)', accept: 'application/rss+xml, application/xml, text/xml, */*' },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return parseFeed(await res.text(), new URL(url).hostname);
}

const normalize = (t) => t.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').slice(0, 60);

export async function getNews({ topic = '', limit = 10 } = {}) {
  const custom = process.env.NEWS_FEEDS?.split(',').map((s) => s.trim()).filter(Boolean);
  const cleanTopic = String(topic || '').trim();
  const isGeneral = !cleanTopic || /^(главн|общ|все|сегодн|мир$|новост)/i.test(cleanTopic);
  const feeds = isGeneral ? (custom?.length ? custom : DEFAULT_FEEDS) : [topicFeed(cleanTopic)];

  const results = await Promise.allSettled(feeds.map(fetchFeed));
  const dayAgo = Date.now() - 36 * 3600 * 1000;
  const seen = new Set();
  const items = [];
  // Берём по очереди из каждой ленты, чтобы источники перемешались.
  const lists = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  for (let i = 0; items.length < limit && lists.some((l) => l.length > i); i++) {
    for (const list of lists) {
      const item = list[i];
      if (!item || (item.date && Date.parse(item.date) < dayAgo)) continue;
      const key = normalize(item.title);
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(item);
      if (items.length >= limit) break;
    }
  }
  if (!items.length) {
    const errors = results.filter((r) => r.status === 'rejected').map((r) => String(r.reason?.message || r.reason));
    return { items: [], note: 'Не удалось получить свежие новости', errors: errors.slice(0, 3) };
  }
  return { topic: cleanTopic || 'главное', fetchedAt: new Date().toISOString(), items };
}
