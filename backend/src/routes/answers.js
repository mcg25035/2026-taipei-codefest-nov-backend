import { Router } from 'express';
import { ApiError, forbidden, notFound, validationError } from '../errors.js';
import {
  decodeCursor, encodeCursor, newId, nowIso, optionalString, parseLanguage, parseLimit, parseMediaIds,
  requireBodyObject, requireEnum,
} from '../util.js';

export function answerRoutes({ db, config, serializers, notifier, getRealtime, limiter, rewards, removeMediaFiles, audit, semanticCache }) {
  const router = Router();
  const questionById = db.prepare('SELECT * FROM questions WHERE id = ?');
  const answerById = db.prepare('SELECT * FROM answers WHERE id = ?');
  const byRequest = db.prepare('SELECT * FROM answers WHERE author_id = ? AND client_request_id = ?');
  const insert = db.prepare(`
    INSERT INTO answers (id, question_id, author_id, body, language, client_request_id, created_at)
    VALUES (@id, @question_id, @author_id, @body, @language, @client_request_id, @created_at)
  `);
  const attach = db.prepare(`
    UPDATE media SET answer_id = ?, position = ? WHERE id = ? AND owner_id = ? AND question_id IS NULL AND answer_id IS NULL
  `);
  const bumpCount = db.prepare('UPDATE questions SET answer_count = answer_count + 1 WHERE id = ?');
  const adjustTrust = db.prepare('UPDATE users SET trust_score = trust_score + ? WHERE id = ?');

  const signalAnswers = (questionId) => {
    getRealtime().answersChanged(questionId);
  };

  router.get('/questions/:id/answers', (req, res) => {
    if (!questionById.get(req.params.id)) throw notFound();
    const sort = req.query.sort === undefined ? 'top' : requireEnum(req.query.sort, ['top', 'oldest'], 'sort');
    const limit = parseLimit(req.query);
    const cursor = decodeCursor(req.query.cursor);
    const offset = Number.isInteger(cursor?.o) && cursor.o >= 0 ? cursor.o : 0;
    // 低可信度回答者排在後面，但前端拿不到評分或倒讚數。
    const order = sort === 'top'
      ? `a.is_accepted DESC, (u.trust_score < @lowThreshold) ASC, (a.upvotes - a.downvotes) DESC, a.created_at ASC, a.id ASC`
      : 'a.created_at ASC, a.id ASC';
    const rows = db.prepare(`
      SELECT a.* FROM answers a JOIN users u ON u.id = a.author_id
      WHERE a.question_id = @questionId ORDER BY ${order} LIMIT @limit OFFSET @offset
    `).all({
      questionId: req.params.id, limit: limit + 1, offset,
      ...(sort === 'top' && { lowThreshold: config.trust.lowThreshold }),
    });
    res.json({
      data: rows.slice(0, limit).map((row) => serializers.answer(req, row)),
      next_cursor: rows.length > limit ? encodeCursor({ o: offset + limit }) : null,
    });
  });

  router.post('/questions/:id/answers', (req, res) => {
    const question = questionById.get(req.params.id);
    if (!question) throw notFound();
    const body = requireBodyObject(req.body);
    const clientRequestId = optionalString(body, 'client_request_id', { min: 1, max: 64 });
    const existing = clientRequestId && byRequest.get(req.user.id, clientRequestId);
    if (existing) return res.status(201).json({ data: serializers.answer(req, existing) });

    const text = optionalString(body, 'body', { max: 5000 });
    const mediaIds = parseMediaIds(body);
    if (!text?.trim() && !mediaIds.length) throw validationError('body 和 media_ids 至少要有一個');
    const language = body.language === undefined ? null : parseLanguage(body.language);
    if (!limiter.allow(`answers:${req.user.id}`, config.rateLimit.answers)) {
      throw new ApiError(429, 'RATE_LIMITED', '回答太頻繁，請稍後再試');
    }

    const id = newId('a');
    const create = db.transaction(() => {
      insert.run({
        id, question_id: question.id, author_id: req.user.id, body: text, language,
        client_request_id: clientRequestId, created_at: nowIso(),
      });
      mediaIds.forEach((mediaId, position) => {
        if (!attach.run(id, position, mediaId, req.user.id).changes) {
          throw validationError('media_ids 含有不存在或已被使用的檔案', { field: 'media_ids', media_id: mediaId });
        }
      });
      bumpCount.run(question.id);
    });
    create();

    if (question.author_id !== req.user.id) {
      notifier.create({
        userId: question.author_id,
        type: 'new_answer',
        title: '有人回答了你的問題',
        body: notifier.questionLabel(question),
        questionId: question.id,
      });
    }
    signalAnswers(question.id);
    getRealtime().questionChanged(question.id);
    getRealtime().feedChanged();
    res.status(201).json({ data: serializers.answer(req, answerById.get(id)) });
  });

  const acceptAnswer = db.prepare('UPDATE answers SET is_accepted = 1 WHERE id = ?');
  // 問題解決時清除精確座標，已送出的通知也一起清除。
  const resolveQuestion = db.prepare(`
    UPDATE questions SET status = 'resolved', accepted_answer_id = ?, exact_lat = NULL, exact_lng = NULL WHERE id = ?
  `);
  const purgeNotificationLocation = db.prepare('UPDATE notifications SET exact_lat = NULL, exact_lng = NULL WHERE question_id = ?');
  const addPoints = db.prepare('UPDATE users SET points = points + ? WHERE id = ?');
  const insertTransaction = db.prepare(`
    INSERT INTO point_transactions (id, user_id, amount, reason, question_id, created_at) VALUES (?, ?, ?, ?, ?, ?)
  `);

  const completedAssist = db.prepare("SELECT 1 FROM assists WHERE question_id = ? AND status = 'completed' LIMIT 1");

  router.post('/answers/:id/accept', (req, res) => {
    const answer = answerById.get(req.params.id);
    if (!answer) throw notFound();
    const question = questionById.get(answer.question_id);
    if (question.author_id !== req.user.id) throw forbidden('只有發問者可以採納回答');
    if (answer.author_id === req.user.id) throw new ApiError(403, 'SELF_ACTION_NOT_ALLOWED', '不能採納自己的回答');
    if (question.accepted_answer_id) throw new ApiError(409, 'ALREADY_ACCEPTED', '這個問題已經採納過回答');
    if (question.status === 'in_progress') throw new ApiError(409, 'ASSIST_ACTIVE', '現場協助進行中，不能採納回答');
    // 發問者先標記已解決，之後仍可採納回答；現場協助完成的問題已經發過積分，不能再採納。
    if (completedAssist.get(question.id)) throw new ApiError(409, 'INVALID_STATE', '現場協助已完成，不能採納回答');

    const amount = config.points.answerAccepted;
    db.transaction(() => {
      acceptAnswer.run(answer.id);
      resolveQuestion.run(answer.id, question.id);
      purgeNotificationLocation.run(question.id);
      addPoints.run(amount, answer.author_id);
      adjustTrust.run(config.trust.answerAccepted, answer.author_id);
      insertTransaction.run(newId('p'), answer.author_id, amount, 'answer_accepted', question.id, nowIso());
    })();

    notifier.create({
      userId: answer.author_id,
      type: 'answer_accepted',
      title: '你的回答被採納了',
      body: `獲得 ${amount} 積分。${notifier.questionLabel(question)}`,
      questionId: question.id,
    });
    rewards.awardBadges(answer.author_id);
    semanticCache.answerAccepted(question, answerById.get(answer.id));
    signalAnswers(question.id);
    getRealtime().questionChanged(question.id);
    getRealtime().feedChanged();
    res.json({ data: serializers.answer(req, answerById.get(answer.id)) });
  });

  const answerMediaRows = db.prepare('SELECT * FROM media WHERE answer_id = ?');
  const deleteAnswerStatements = [
    "DELETE FROM pii_reports WHERE target_type = 'answer' AND target_id = @id",
    'DELETE FROM votes WHERE answer_id = @id',
    'DELETE FROM media WHERE answer_id = @id',
    'DELETE FROM answers WHERE id = @id',
  ].map((sql) => db.prepare(sql));
  const clearAccepted = db.prepare('UPDATE questions SET accepted_answer_id = NULL WHERE id = ?');
  const dropCount = db.prepare('UPDATE questions SET answer_count = answer_count - 1 WHERE id = ?');

  // 可信度不回補，避免用刪除回答洗掉倒讚的影響。
  router.delete('/answers/:id', async (req, res) => {
    const answer = answerById.get(req.params.id);
    if (!answer) throw notFound();
    const isAdmin = req.user.role === 'admin';
    if (answer.author_id !== req.user.id && !isAdmin) throw forbidden('只能刪除自己的回答');
    if (answer.is_accepted && !isAdmin) throw new ApiError(409, 'ANSWER_ACCEPTED', '已採納的回答不能刪除');
    const files = answerMediaRows.all(answer.id);
    db.transaction(() => {
      if (isAdmin) {
        audit.record(req.user.id, 'answer.delete', 'answer', answer.id, {
          question_id: answer.question_id,
          author_id: answer.author_id,
          body: answer.body,
          was_accepted: Boolean(answer.is_accepted),
          media: files.map((f) => ({ id: f.id, kind: f.kind })),
        });
      }
      // 已發出的積分不收回；問題維持已解決，只是不再指向這則回答。
      if (answer.is_accepted) clearAccepted.run(answer.question_id);
      deleteAnswerStatements.forEach((statement) => statement.run({ id: answer.id }));
      dropCount.run(answer.question_id);
    })();
    await removeMediaFiles(files);
    if (answer.author_id !== req.user.id) {
      notifier.create({
        userId: answer.author_id,
        type: 'content_moderated',
        title: '你的回答已被管理員移除',
        body: '管理員移除了你發布的回答',
        questionId: answer.question_id,
      });
    }
    signalAnswers(answer.question_id);
    getRealtime().questionChanged(answer.question_id);
    getRealtime().feedChanged();
    res.status(204).end();
  });

  const getVote = db.prepare('SELECT value FROM votes WHERE answer_id = ? AND user_id = ?');
  const upsertVote = db.prepare(`
    INSERT INTO votes (answer_id, user_id, value) VALUES (?, ?, ?)
    ON CONFLICT (answer_id, user_id) DO UPDATE SET value = excluded.value
  `);
  const deleteVote = db.prepare('DELETE FROM votes WHERE answer_id = ? AND user_id = ?');
  const adjustVotes = db.prepare('UPDATE answers SET upvotes = upvotes + ?, downvotes = downvotes + ? WHERE id = ?');

  const voteEffect = (value) => ({
    up: value === 1 ? 1 : 0,
    down: value === -1 ? 1 : 0,
    trust: value === 1 ? config.trust.upvote : value === -1 ? config.trust.downvote : 0,
  });

  const changeVote = db.transaction((answer, userId, next) => {
    const previous = getVote.get(answer.id, userId)?.value ?? null;
    if (previous === next) return;
    if (next === null) deleteVote.run(answer.id, userId);
    else upsertVote.run(answer.id, userId, next);
    const before = voteEffect(previous);
    const after = voteEffect(next);
    adjustVotes.run(after.up - before.up, after.down - before.down, answer.id);
    // 對自己的回答按讚只影響讚數，不加可信度，避免自己刷分。
    if (userId !== answer.author_id) adjustTrust.run(after.trust - before.trust, answer.author_id);
  });

  router.put('/answers/:id/vote', (req, res) => {
    const answer = answerById.get(req.params.id);
    if (!answer) throw notFound();
    const value = requireBodyObject(req.body).value;
    if (value !== 1 && value !== -1) throw validationError('value 必須是 1 或 -1', { field: 'value' });
    if (answer.author_id === req.user.id && value === -1) throw new ApiError(403, 'SELF_ACTION_NOT_ALLOWED', '不能對自己的回答投倒讚');
    changeVote(answer, req.user.id, value);
    semanticCache.answerVoted(questionById.get(answer.question_id), answer, req.user.id, value);
    signalAnswers(answer.question_id);
    res.json({ data: serializers.voteSummary(answerById.get(answer.id), req.user.id) });
  });

  router.delete('/answers/:id/vote', (req, res) => {
    const answer = answerById.get(req.params.id);
    if (!answer) throw notFound();
    changeVote(answer, req.user.id, null);
    semanticCache.answerVoted(questionById.get(answer.question_id), answer, req.user.id, null);
    signalAnswers(answer.question_id);
    res.json({ data: serializers.voteSummary(answerById.get(answer.id), req.user.id) });
  });

  return router;
}
