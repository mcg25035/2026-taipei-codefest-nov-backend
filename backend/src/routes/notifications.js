import { Router } from 'express';
import { validationError } from '../errors.js';
import { serializeNotification } from '../notifications.js';
import { decodeCursor, encodeCursor, parseLimit, requireBodyObject } from '../util.js';

export function notificationRoutes({ db, getRealtime }) {
  const router = Router();
  const unreadCount = db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read = 0');
  const markAll = db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ?');
  const markOne = db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ? AND id = ?');

  router.get('/notifications/stream', (req, res) => getRealtime().openNotificationStream(req, res));

  router.get('/notifications', (req, res) => {
    const unreadOnly = req.query.unread_only === 'true';
    const limit = parseLimit(req.query);
    const cursor = decodeCursor(req.query.cursor);
    const clauses = ['user_id = @user'];
    const params = { user: req.user.id, limit: limit + 1 };
    if (unreadOnly) clauses.push('read = 0');
    if (cursor) {
      clauses.push('(created_at, id) < (@cursorAt, @cursorId)');
      params.cursorAt = String(cursor.c);
      params.cursorId = String(cursor.i);
    }
    const rows = db.prepare(`SELECT * FROM notifications WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT @limit`).all(params);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    res.json({
      data: page.map(serializeNotification),
      next_cursor: rows.length > limit ? encodeCursor({ c: last.created_at, i: last.id }) : null,
      unread_count: unreadCount.get(req.user.id).n,
    });
  });

  router.post('/notifications/read', (req, res) => {
    const { ids, all } = requireBodyObject(req.body);
    const hasIds = Array.isArray(ids) && ids.length > 0 && ids.every((id) => typeof id === 'string');
    if (hasIds === (all === true)) throw validationError('ids 和 all 必須擇一');
    if (all === true) markAll.run(req.user.id);
    else db.transaction(() => ids.forEach((id) => markOne.run(req.user.id, id)))();
    res.status(204).end();
  });

  return router;
}
