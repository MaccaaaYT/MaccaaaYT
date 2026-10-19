// Пересчитывает расписание из lib/schedule.js в UTC и записывает в vercel.json.
// Запуск: MIYA_TIMEZONE=Asia/Yekaterinburg npm run crons
// (Vercel Cron всегда работает в UTC, а бесплатный тариф — не чаще раза в день на задачу.)
import { readFileSync, writeFileSync } from 'node:fs';
import { SLOTS, getTimezone, slotMinutes, timezoneOffsetMinutes } from '../lib/schedule.js';

const path = new URL('../vercel.json', import.meta.url);
const tz = getTimezone();
const offset = timezoneOffsetMinutes(tz);

const crons = SLOTS.map((slot) => {
  const utc = (((slotMinutes(slot) - offset) % 1440) + 1440) % 1440;
  return { path: `/api/cron?slot=${slot.id}`, schedule: `${utc % 60} ${Math.floor(utc / 60)} * * *` };
});

const config = JSON.parse(readFileSync(path, 'utf8'));
config.crons = crons;
writeFileSync(path, JSON.stringify(config, null, 2) + '\n');
console.log(`Часовой пояс ${tz} (UTC${offset >= 0 ? '+' : ''}${offset / 60}). Обновлён vercel.json:`);
for (const c of crons) console.log(`  ${c.schedule.padEnd(12)} ${c.path}`);
