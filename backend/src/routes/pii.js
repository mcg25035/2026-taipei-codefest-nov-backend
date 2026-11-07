import fs from 'node:fs/promises';
import path from 'node:path';
import { Router } from 'express';
import sharp from 'sharp';
import { ApiError, forbidden, notFound, validationError } from '../errors.js';
import {
  decodeCursor, encodeCursor, isObject, newId, nowIso, parseLimit, requireBodyObject, requireEnum,
} from '../util.js';

const MASK = '█';
const invalidState = () => new ApiError(409, 'INVALID_STATE', '這筆標記已經處理過');

function parseRegions(value) {
  const valid = Array.isArray(value) && value.length >= 1 && value.length <= 20 && value.every((r) => (
    isObject(r) &&
    [r.x, r.y, r.w, r.h].every((n) => Number.isFinite(n) && n >= 0 && n <= 1) && r.w > 0 && r.h > 0
  ));
  if (!valid) throw validationError('regions 必須是 1 到 20 個 0 到 1 的比例區域', { field: 'regions' });
  return value.map(({ x, y, w, h }) => ({ x, y, w, h }));
}

function parseTextRanges(value, text) {
  const length = [...(text ?? '')].length;
  const valid = Array.isArray(value) && value.length >= 1 && value.length <= 20 && value.every((r) => (
    isObject(r) && Number.isInteger(r.start) && Number.isInteger(r.end) && r.start >= 0 && r.end > r.start && r.end <= length
  ));
  if (!valid) throw validationError('text_ranges 超出內容範圍', { field: 'text_ranges' });
  return value.map(({ start, end }) => ({ start, end }));
}

// 遮蔽時逐字替換，字數不變，其他待決定標記的位置才不會跑掉。
function maskText(text, ranges) {
  const chars = [...text];
  for (const { start, end } of ranges) for (let i = start; i < end && i < chars.length; i++) chars[i] = MASK;
  return chars.join('');
}

export function piiRoutes({ db, config, notifier, getRealtime, hourlyLimiter, signatures, removeMediaFiles }) {
  const router = Router();
  const mediaDir = path.join(config.dataDir, 'media');
  const questionById = db.prepare('SELECT * FROM questions WHERE id = ?');
  const answerById = db.prepare('SELECT * FROM answers WHERE id = ?');
  const reportById = db.prepare('SELECT * FROM pii_reports WHERE id = ?');
  const mediaById = db.prepare('SELECT * FROM media WHERE id = ?');
  const insert = db.prepare(`
    INSERT INTO pii_reports (id, question_id, target_type, target_id, media_id, text_field, regions, text_ranges, status, reporter_id, created_at)
    VALUES (@id, @question_id, @target_type, @target_id, @media_id, @text_field, @regions, @text_ranges, 'pending', @reporter_id, @created_at)
  `);
  const scrubNotifications = db.prepare(`
    UPDATE notifications SET body = '問題內容已更新，請開啟查看' WHERE question_id = ? AND body LIKE '%問題：%'
  `);
  const resolve = db.prepare("UPDATE pii_reports SET status = ?, resolved_at = ? WHERE id = ? AND status = 'pending'");

  const signal = (report) => {
    const rt = getRealtime();
    const question = questionById.get(report.question_id);
    rt.piiReportsChanged(question.author_id);
    rt.questionChanged(report.question_id);
    rt.answersChanged(report.question_id);
    rt.feedChanged();
  };

  const affectsTitle = (report, question) => report.target_type === 'question' && report.text_field !== null
    && (report.text_field === 'title' || question.title_is_auto);

  const finish = (report, status) => {
    if (report.reporter_id !== questionById.get(report.question_id).author_id) {
      notifier.create({
        userId: report.reporter_id,
        type: 'pii_report_resolved',
        title: '你的個資標記已處理',
        body: status === 'accepted' ? '發問者已同意遮蔽，謝謝你的提醒' : '發問者確認內容可以公開',
        questionId: report.question_id,
      });
    }
    signal(reportById.get(report.id));
  };

  // 圖片遮蔽是非同步的，排隊處理才不會有兩筆標記互相覆蓋，讓其中一塊遮蔽消失。
  let queue = Promise.resolve();
  const enqueue = (task) => {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  };

  async function maskImage(media, regions) {
    const input = await fs.readFile(path.join(mediaDir, media.filename));
    const { width, height } = await sharp(input).metadata();
    const composite = regions.map((r) => {
      const left = Math.min(Math.floor(r.x * width), width - 1);
      const top = Math.min(Math.floor(r.y * height), height - 1);
      return {
        input: {
          create: {
            width: Math.max(1, Math.min(Math.ceil(r.w * width), width - left)),
            height: Math.max(1, Math.min(Math.ceil(r.h * height), height - top)),
            channels: 3,
            background: '#000000',
          },
        },
        left,
        top,
      };
    });
    return sharp(input).composite(composite).jpeg({ quality: 85 }).toBuffer();
  }

  const applyTextMask = db.transaction((report) => {
    const ranges = JSON.parse(report.text_ranges);
    if (report.target_type === 'answer') {
      const answer = answerById.get(report.target_id);
      db.prepare('UPDATE answers SET body = ? WHERE id = ?').run(maskText(answer.body, ranges), answer.id);
      return;
    }
    const question = questionById.get(report.target_id);
    if (report.text_field === 'title') {
      db.prepare('UPDATE questions SET title = ? WHERE id = ?').run(maskText(question.title, ranges), question.id);
      return;
    }
    const body = maskText(question.body, ranges);
    const title = question.title_is_auto ? [...body.trim()].slice(0, 30).join('') : question.title;
    db.prepare('UPDATE questions SET body = ?, title = ? WHERE id = ?').run(body, title, question.id);
  });

  const accept = (reportId) => enqueue(async () => {
    const report = reportById.get(reportId);
    if (report.status !== 'pending') throw invalidState();

    if (report.media_id) {
      const media = mediaById.get(report.media_id);
      if (media.kind === 'audio') {
        db.transaction(() => {
          // 語音無法局部遮蔽，整段移除後，同一檔案的其他標記也一併結案。
          db.prepare(`
            UPDATE pii_reports SET status = 'accepted', resolved_at = ? WHERE media_id = ? AND status = 'pending'
          `).run(nowIso(), media.id);
          db.prepare('DELETE FROM media WHERE id = ?').run(media.id);
        })();
        await removeMediaFiles([media]);
      } else {
        const masked = await maskImage(media, JSON.parse(report.regions));
        // 換新 ID 和檔名，舊網址立刻失效。
        const newMediaId = newId('m');
        const filename = `${newMediaId}.jpg`;
        await fs.writeFile(path.join(mediaDir, filename), masked);
        db.transaction(() => {
          db.prepare('UPDATE media SET id = ?, filename = ? WHERE id = ?').run(newMediaId, filename, media.id);
          db.prepare('UPDATE pii_reports SET media_id = ? WHERE media_id = ?').run(newMediaId, media.id);
          resolve.run('accepted', nowIso(), report.id);
        })();
        await removeMediaFiles([media]);
      }
    } else {
      db.transaction(() => {
        applyTextMask(report);
        resolve.run('accepted', nowIso(), report.id);
      })();
    }
    finish(report, 'accepted');
    return reportById.get(report.id);
  });

  const parseTarget = (body) => {
    const targetType = requireEnum(body.target_type, ['question', 'answer'], 'target_type');
    if (typeof body.target_id !== 'string') throw validationError('缺少 target_id', { field: 'target_id' });
    if (targetType === 'question') {
      const question = questionById.get(body.target_id);
      if (!question) throw notFound();
      return { targetType, target: question, question };
    }
    const answer = answerById.get(body.target_id);
    if (!answer) throw notFound();
    return { targetType, target: answer, question: questionById.get(answer.question_id) };
  };

  router.post('/pii-reports', async (req, res) => {
    const body = requireBodyObject(req.body);
    const { targetType, target, question } = parseTarget(body);
    const hasMedia = body.media_id !== undefined;
    const hasText = body.text_ranges !== undefined;
    if (hasMedia === hasText) throw validationError('media_id 和 text_ranges 必須擇一');

    const row = {
      id: newId('pr'),
      question_id: question.id,
      target_type: targetType,
      target_id: target.id,
      media_id: null,
      text_field: null,
      regions: '[]',
      text_ranges: '[]',
      reporter_id: req.user.id,
      created_at: nowIso(),
    };
    if (hasMedia) {
      const media = typeof body.media_id === 'string' ? mediaById.get(body.media_id) : null;
      const owned = media && (targetType === 'question' ? media.question_id : media.answer_id) === target.id;
      if (!owned) throw validationError('media_id 不屬於這則內容', { field: 'media_id' });
      row.media_id = media.id;
      if (media.kind === 'image') row.regions = JSON.stringify(parseRegions(body.regions));
    } else {
      row.text_field = body.text_field === undefined ? 'body' : requireEnum(body.text_field, ['body', 'title'], 'text_field');
      if (row.text_field === 'title' && targetType !== 'question') throw validationError('只有問題有標題', { field: 'text_field' });
      row.text_ranges = JSON.stringify(parseTextRanges(body.text_ranges, target[row.text_field]));
    }
    if (!hourlyLimiter.allow(`pii:${req.user.id}`, config.piiReportsPerHour)) {
      throw new ApiError(429, 'RATE_LIMITED', '標記太頻繁，請稍後再試');
    }

    insert.run(row);
    const report = reportById.get(row.id);
    if (affectsTitle(report, question)) scrubNotifications.run(question.id);

    if (question.author_id === req.user.id) {
      const accepted = await accept(report.id);
      return res.status(201).json({ data: { id: accepted.id, status: accepted.status } });
    }
    notifier.create({
      userId: question.author_id,
      type: 'pii_report_pending',
      title: '有人提醒你的內容可能含個資',
      body: '內容已先隱藏，請確認是否要遮蔽',
      questionId: question.id,
    });
    signal(report);
    res.status(201).json({ data: { id: report.id, status: report.status } });
  });

  const serialize = (req, row) => {
    const pending = row.status === 'pending';
    const origin = config.publicBaseUrl ?? `${req.protocol}://${req.get('host')}`;
    let originalText = null;
    if (pending && row.text_field) {
      const target = row.target_type === 'question' ? questionById.get(row.target_id) : answerById.get(row.target_id);
      originalText = target[row.text_field];
    }
    return {
      id: row.id,
      status: row.status,
      target_type: row.target_type,
      target_id: row.target_id,
      question_id: row.question_id,
      media_id: row.media_id,
      text_field: row.text_field,
      regions: JSON.parse(row.regions),
      text_ranges: JSON.parse(row.text_ranges),
      original_text: originalText,
      preview_url: pending && row.media_id ? `${origin}/media/${row.media_id}?${signatures.query(row.media_id)}` : null,
      created_at: row.created_at,
      resolved_at: row.resolved_at,
    };
  };

  router.get('/me/pii-reports', (req, res) => {
    const limit = parseLimit(req.query);
    const cursor = decodeCursor(req.query.cursor);
    const clauses = ['q.author_id = @user'];
    const params = { user: req.user.id, limit: limit + 1 };
    if (req.query.status !== undefined) {
      params.status = requireEnum(req.query.status, ['pending', 'accepted', 'denied'], 'status');
      clauses.push('r.status = @status');
    }
    if (cursor) {
      clauses.push('(r.created_at, r.id) < (@cursorAt, @cursorId)');
      params.cursorAt = String(cursor.c);
      params.cursorId = String(cursor.i);
    }
    const rows = db.prepare(`
      SELECT r.* FROM pii_reports r JOIN questions q ON q.id = r.question_id
      WHERE ${clauses.join(' AND ')} ORDER BY r.created_at DESC, r.id DESC LIMIT @limit
    `).all(params);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    res.json({
      data: page.map((row) => serialize(req, row)),
      next_cursor: rows.length > limit ? encodeCursor({ c: last.created_at, i: last.id }) : null,
    });
  });

  const loadOwnReport = (req) => {
    const report = reportById.get(req.params.id);
    if (!report) throw notFound();
    if (questionById.get(report.question_id).author_id !== req.user.id) throw forbidden('只有發問者可以決定');
    return report;
  };

  router.post('/pii-reports/:id/accept', async (req, res) => {
    const report = loadOwnReport(req);
    if (report.status !== 'pending') throw invalidState();
    res.json({ data: serialize(req, await accept(report.id)) });
  });

  router.post('/pii-reports/:id/deny', (req, res) => {
    const report = loadOwnReport(req);
    if (!resolve.run('denied', nowIso(), report.id).changes) throw invalidState();
    finish(report, 'denied');
    res.json({ data: serialize(req, reportById.get(report.id)) });
  });

  return router;
}
