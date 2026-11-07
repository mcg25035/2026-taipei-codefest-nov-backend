import { Router } from 'express';
import { ApiError, forbidden, notFound, validationError } from '../errors.js';
import { meUser, publicUser } from '../serialize.js';
import { decodeCursor, encodeCursor, optionalString, parseLimit, requireBodyObject, requireEnum } from '../util.js';

const ROLES = ['user', 'admin', 'bot'];
const firstChars = (text, count) => [...text].slice(0, count).join('');

const adminUser = (row) => ({
  ...meUser(row),
  townpass_user_id: row.townpass_user_id,
  trust_score: row.trust_score,
  banned_at: row.banned_at,
  ban_reason: row.ban_reason,
  created_at: row.created_at,
});

export function adminRoutes({ db, audit, serializers, notifier, getRealtime, requireAdmin }) {
  const router = Router();
  router.use(requireAdmin);
  const userById = db.prepare('SELECT * FROM users WHERE id = ?');
  const questionById = db.prepare('SELECT * FROM questions WHERE id = ?');
  const answerById = db.prepare('SELECT * FROM answers WHERE id = ?');

  router.get('/users', (req, res) => {
    const limit = parseLimit(req.query);
    const cursor = decodeCursor(req.query.cursor);
    const clauses = [];
    const params = { limit: limit + 1 };
    if (req.query.role !== undefined) {
      params.role = requireEnum(req.query.role, ROLES, 'role');
      clauses.push('role = @role');
    }
    if (req.query.q !== undefined) {
      params.q = `%${String(req.query.q).replace(/[\\%_]/g, '\\$&')}%`;
      clauses.push("(nickname LIKE @q ESCAPE '\\' OR townpass_user_id LIKE @q ESCAPE '\\')");
    }
    if (cursor) {
      clauses.push('(created_at, id) < (@cursorAt, @cursorId)');
      params.cursorAt = String(cursor.c);
      params.cursorId = String(cursor.i);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = db.prepare(`SELECT * FROM users ${where} ORDER BY created_at DESC, id DESC LIMIT @limit`).all(params);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    res.json({
      data: page.map(adminUser),
      next_cursor: rows.length > limit ? encodeCursor({ c: last.created_at, i: last.id }) : null,
    });
  });

  const loadOtherUser = (req) => {
    const user = userById.get(req.params.id);
    if (!user) throw notFound();
    if (user.id === req.user.id) throw forbidden('不能變更自己的帳號，避免把自己鎖在外面');
    return user;
  };

  router.put('/users/:id/role', (req, res) => {
    const user = loadOtherUser(req);
    const role = requireEnum(requireBodyObject(req.body).role, ROLES, 'role');
    db.transaction(() => {
      db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, user.id);
      audit.record(req.user.id, 'user.role', 'user', user.id, { before: user.role, after: role });
    })();
    res.json({ data: adminUser(userById.get(user.id)) });
  });

  router.post('/users/:id/ban', (req, res) => {
    const user = loadOtherUser(req);
    const reason = optionalString(req.body ?? {}, 'reason', { max: 200 });
    db.transaction(() => {
      db.prepare('UPDATE users SET banned_at = ?, ban_reason = ? WHERE id = ?').run(new Date().toISOString(), reason, user.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
      db.prepare('DELETE FROM push_tokens WHERE user_id = ?').run(user.id);
      audit.record(req.user.id, 'user.ban', 'user', user.id, { reason });
    })();
    getRealtime().disconnectUser(user.id);
    res.json({ data: adminUser(userById.get(user.id)) });
  });

  router.post('/users/:id/unban', (req, res) => {
    const user = loadOtherUser(req);
    db.transaction(() => {
      db.prepare('UPDATE users SET banned_at = NULL, ban_reason = NULL WHERE id = ?').run(user.id);
      audit.record(req.user.id, 'user.unban', 'user', user.id);
    })();
    res.json({ data: adminUser(userById.get(user.id)) });
  });

  const hasPendingTextReport = db.prepare(`
    SELECT 1 FROM pii_reports WHERE target_type = ? AND target_id = ? AND status = 'pending' AND text_field IS NOT NULL LIMIT 1
  `);
  const rejectIfPending = (type, id) => {
    // 個資標記記錄的是文字位置，內容改了位置就會錯，所以要先處理標記。
    if (hasPendingTextReport.get(type, id)) throw new ApiError(409, 'INVALID_STATE', '有待決定的個資標記，請先處理');
  };
  const notifyEdited = (authorId, adminId, questionId) => {
    if (authorId === adminId) return;
    notifier.create({
      userId: authorId,
      type: 'content_moderated',
      title: '你的內容已被管理員修改',
      body: '管理員修改了你發布的內容，請開啟查看',
      questionId,
    });
  };

  router.patch('/questions/:id', (req, res) => {
    const row = questionById.get(req.params.id);
    if (!row) throw notFound();
    const body = requireBodyObject(req.body);
    if (body.title === undefined && body.body === undefined) throw validationError('title 和 body 至少要有一個');
    rejectIfPending('question', row.id);
    const text = body.body === undefined ? row.body : optionalString(body, 'body', { max: 5000 });
    let { title } = row;
    let titleIsAuto = row.title_is_auto;
    if (body.title !== undefined) {
      title = optionalString(body, 'title', { min: 1, max: 80 });
      if (!title) throw validationError('title 不可為空', { field: 'title' });
      titleIsAuto = 0;
    } else if (titleIsAuto && text?.trim()) {
      title = firstChars(text.trim(), 30);
    }
    db.transaction(() => {
      db.prepare('UPDATE questions SET title = ?, title_is_auto = ?, body = ? WHERE id = ?').run(title, titleIsAuto, text, row.id);
      audit.record(req.user.id, 'question.edit', 'question', row.id, {
        before: { title: row.title, body: row.body },
        after: { title, body: text },
      });
    })();
    notifyEdited(row.author_id, req.user.id, row.id);
    getRealtime().questionChanged(row.id);
    getRealtime().feedChanged();
    res.json({ data: serializers.questionDetail(req, questionById.get(row.id)) });
  });

  router.patch('/answers/:id', (req, res) => {
    const row = answerById.get(req.params.id);
    if (!row) throw notFound();
    const text = optionalString(requireBodyObject(req.body), 'body', { min: 1, max: 5000 });
    if (!text) throw validationError('缺少 body', { field: 'body' });
    rejectIfPending('answer', row.id);
    db.transaction(() => {
      db.prepare('UPDATE answers SET body = ? WHERE id = ?').run(text, row.id);
      audit.record(req.user.id, 'answer.edit', 'answer', row.id, {
        question_id: row.question_id, before: { body: row.body }, after: { body: text },
      });
    })();
    notifyEdited(row.author_id, req.user.id, row.question_id);
    getRealtime().answersChanged(row.question_id);
    res.json({ data: serializers.answer(req, answerById.get(row.id)) });
  });

  const parseDate = (query, field) => {
    if (query[field] === undefined) return null;
    const time = Date.parse(String(query[field]));
    if (Number.isNaN(time)) throw validationError(`${field} 必須是有效的時間`, { field });
    return new Date(time).toISOString();
  };
  // 開著對話框（+dialog、+sheet）仍算同一個頁面。
  const pageKey = (route) => (route ?? '').replace(/\+[a-z]+$/i, '') || null;

  router.get('/analytics/pages', (req, res) => {
    const limit = parseLimit(req.query);
    const since = parseDate(req.query, 'since');
    const until = parseDate(req.query, 'until');
    const clauses = [];
    const params = {};
    if (since) { clauses.push('created_at >= @since'); params.since = since; }
    if (until) { clauses.push('created_at <= @until'); params.until = until; }
    if (req.query.service_id !== undefined) { clauses.push('service_id = @service'); params.service = String(req.query.service_id); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = db.prepare(`SELECT context, status, category, answer_count, created_at FROM questions ${where} ORDER BY created_at`).all(params);

    const pages = new Map();
    let withoutPage = 0;
    for (const row of rows) {
      const context = row.context ? JSON.parse(row.context) : null;
      const route = pageKey(context?.page_route);
      if (!route) { withoutPage++; continue; }
      const key = `${context.service_id}\n${route}`;
      if (!pages.has(key)) {
        pages.set(key, {
          service_id: context.service_id,
          service_name: context.service_name,
          page_route: route,
          page_title: null,
          question_count: 0,
          open_count: 0,
          in_progress_count: 0,
          resolved_count: 0,
          unanswered_count: 0,
          categories: {},
          last_asked_at: null,
        });
      }
      const page = pages.get(key);
      page.page_title = context.page_title ?? page.page_title;
      page.question_count++;
      page[`${row.status}_count`]++;
      if (row.answer_count === 0) page.unanswered_count++;
      page.categories[row.category] = (page.categories[row.category] ?? 0) + 1;
      page.last_asked_at = row.created_at;
    }
    res.json({
      data: {
        total_questions: rows.length,
        questions_with_page: rows.length - withoutPage,
        questions_without_page: withoutPage,
        pages: [...pages.values()]
          .sort((a, b) => b.question_count - a.question_count || (b.last_asked_at > a.last_asked_at ? 1 : -1))
          .slice(0, limit)
          .map((p) => ({
            ...p,
            categories: Object.entries(p.categories)
              .map(([category, count]) => ({ category, count }))
              .sort((a, b) => b.count - a.count),
          })),
      },
    });
  });

  router.get('/audit-log', (req, res) => {
    const limit = parseLimit(req.query);
    const cursor = decodeCursor(req.query.cursor);
    const clauses = [];
    const params = { limit: limit + 1 };
    for (const [field, column] of [['action', 'action'], ['target_id', 'target_id'], ['admin_id', 'admin_id']]) {
      if (req.query[field] !== undefined) {
        params[field] = String(req.query[field]);
        clauses.push(`${column} = @${field}`);
      }
    }
    if (cursor) {
      clauses.push('(created_at, id) < (@cursorAt, @cursorId)');
      params.cursorAt = String(cursor.c);
      params.cursorId = String(cursor.i);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = db.prepare(`SELECT * FROM admin_actions ${where} ORDER BY created_at DESC, id DESC LIMIT @limit`).all(params);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    res.json({
      data: page.map((row) => ({
        id: row.id,
        admin: publicUser(userById.get(row.admin_id)),
        action: row.action,
        target_type: row.target_type,
        target_id: row.target_id,
        detail: JSON.parse(row.detail),
        created_at: row.created_at,
      })),
      next_cursor: rows.length > limit ? encodeCursor({ c: last.created_at, i: last.id }) : null,
    });
  });

  return router;
}
