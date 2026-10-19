// Общие помощники для API: проверка пароля, методы, ошибки.
import { createHash, timingSafeEqual } from 'node:crypto';

const digest = (s) => createHash('sha256').update(String(s)).digest();

export function authRequired() {
  return Boolean(process.env.APP_PASSWORD);
}

export function checkPassword(candidate) {
  if (!authRequired()) return true;
  return timingSafeEqual(digest(candidate || ''), digest(process.env.APP_PASSWORD));
}

function tokenFrom(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

/**
 * Обёртка над обработчиком Vercel: метод, авторизация, JSON-ошибки.
 * options.methods — разрешённые методы; options.auth — требовать пароль (по умолчанию да).
 */
export function handler(fn, { methods = ['GET'], auth = true } = {}) {
  return async (req, res) => {
    res.setHeader('cache-control', 'no-store');
    if (!methods.includes(req.method)) {
      res.setHeader('allow', methods.join(', '));
      return res.status(405).json({ error: 'Method not allowed' });
    }
    if (auth && !checkPassword(tokenFrom(req))) {
      return res.status(401).json({ error: 'Нужен пароль' });
    }
    try {
      if (typeof req.body === 'string' && req.body) {
        try {
          req.body = JSON.parse(req.body);
        } catch {
          return res.status(400).json({ error: 'Некорректный JSON' });
        }
      }
      req.body = req.body || {};
      await fn(req, res);
    } catch (err) {
      console.error(`[api] ${req.url}:`, err);
      if (!res.headersSent) res.status(err.httpStatus || 500).json({ error: err.publicMessage || 'Внутренняя ошибка' });
    }
  };
}

export function badRequest(message) {
  const err = new Error(message);
  err.httpStatus = 400;
  err.publicMessage = message;
  return err;
}
