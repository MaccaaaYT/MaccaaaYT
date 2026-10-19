// Расписание, по которому Мия пишет первой.
// Время указано в часовом поясе пользователя (MIYA_TIMEZONE, по умолчанию Europe/Moscow).
// После изменения времени выполните `npm run crons`, чтобы обновить vercel.json.

export const DEFAULT_TIMEZONE = 'Europe/Moscow';

export const SLOTS = [
  {
    id: 'morning',
    time: '08:00',
    title: 'Утро',
    theme:
      'Доброе утро. Мягко разбуди пользователя: пора просыпаться, умыться, выпить стакан воды. ' +
      'Можно пожелать хорошего дня или вспомнить, что у него запланировано.',
    fallbacks: [
      'Доброе утро, солнышко! 🦊 Пора потягиваться, умываться и выпить стаканчик воды.',
      'Просыпайся-просыпайся! ☀️ Умойся тёплой водичкой — и день начнётся хорошо.',
    ],
  },
  {
    id: 'stretch_morning',
    time: '11:00',
    title: 'Разминка',
    theme:
      'Середина утра. Попроси встать из-за стола, потянуться, размять шею и плечи, дать отдых глазам.',
    fallbacks: [
      'Тук-тук! 🦊 Давай встанем из-за стола и потянемся — шейке и спинке нужна передышка.',
      'Минутка разминки! Покрути плечами и посмотри вдаль — глазкам станет легче.',
    ],
  },
  {
    id: 'lunch',
    time: '13:00',
    title: 'Обед',
    theme: 'Время обеда. Заботливо напомни поесть нормально, не на бегу, и попить воды.',
    fallbacks: [
      'Обеденное время! 🍲 Пожалуйста, поешь что-нибудь вкусное и тёплое.',
      'Хвостиком машу: пора кушать! Не забывай про обед, хорошо? 🦊',
    ],
  },
  {
    id: 'stretch_afternoon',
    time: '16:00',
    title: 'Разминка',
    theme:
      'Вторая половина дня. Предложи встать, пройтись, размяться, сделать пару глубоких вдохов.',
    fallbacks: [
      'Давай немножко пройдёмся? 🐾 Встань, потянись и сделай пару глубоких вдохов.',
      'Ты долго сидишь — пора размять лапки! Хотя бы пару минут 🦊',
    ],
  },
  {
    id: 'evening',
    time: '21:00',
    title: 'Вечер',
    theme:
      'Вечер. Тепло спроси, как прошёл день, что было хорошего. Если в памяти есть планы на сегодня — спроси про них.',
    fallbacks: [
      'Добрый вечер! 🌙 Расскажешь, как прошёл твой день?',
      'Я соскучилась! 🦊 Как ты сегодня? Что было хорошего?',
    ],
  },
];

export function getTimezone() {
  return process.env.MIYA_TIMEZONE || DEFAULT_TIMEZONE;
}

/** Части даты/времени в заданном часовом поясе. */
export function zonedParts(date = new Date(), timeZone = getTimezone()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    minutes: Number(p.hour) * 60 + Number(p.minute),
  };
}

export function slotMinutes(slot) {
  const [h, m] = slot.time.split(':').map(Number);
  return h * 60 + m;
}

// Окно, в течение которого слот считается «наступившим».
// Vercel Cron на бесплатном тарифе срабатывает в пределах часа (±59 минут),
// поэтому окно с запасом: чуть раньше и почти два часа после.
export const EARLY_MINUTES = 10;
export const LATE_MINUTES = 110;

/** Какие слоты должны сработать прямо сейчас. */
export function dueSlots(date = new Date(), timeZone = getTimezone()) {
  const { minutes } = zonedParts(date, timeZone);
  return SLOTS.filter((s) => {
    const diff = minutes - slotMinutes(s);
    return diff >= -EARLY_MINUTES && diff < LATE_MINUTES;
  });
}

/** Смещение часового пояса относительно UTC в минутах на заданную дату. */
export function timezoneOffsetMinutes(timeZone, date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, Number(x.value)]));
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return Math.round((asUtc - Math.floor(date.getTime() / 60000) * 60000) / 60000);
}
