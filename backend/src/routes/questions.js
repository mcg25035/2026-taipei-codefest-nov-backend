import { Router } from 'express';
import { ApiError, forbidden, notFound, validationError } from '../errors.js';
import { distanceM, snap } from '../geo.js';
import { matchTagKeys, parseTags, tagKey } from '../tags.js';
import {
  ASSISTANCE_MODES, CATEGORIES, LOCATION_LEVELS, QUESTION_STATUSES, decodeCursor, encodeCursor, isObject, newId, nowIso,
  optionalString, parseCoordinates, parseLanguage, parseLimit, parseMediaIds, queryNumber, requireBodyObject, requireEnum, requireString,
} from '../util.js';

const firstChars = (text, count) => [...text].slice(0, count).join('');

function parseContext(value) {
  if (value === undefined || value === null) return null;
  if (!isObject(value)) throw validationError('context 必須是物件', { field: 'context' });
  const context = {
    service_id: requireString(value, 'service_id', { max: 64 }),
    service_name: requireString(value, 'service_name', { max: 64 }),
  };
  const route = optionalString(value, 'page_route', { max: 256 });
  // 情境會公開，去掉 query string 以免帶到個資。
  if (route) context.page_route = route.split(/[?#]/)[0];
  const title = optionalString(value, 'page_title', { max: 128 });
  if (title) context.page_title = title;
  if (value.extra !== undefined) {
    if (!isObject(value.extra) || Buffer.byteLength(JSON.stringify(value.extra)) > 8192) {
      throw validationError('context.extra 必須是 8 KB 以內的物件', { field: 'context.extra' });
    }
    context.extra = value.extra;
  }
  return context;
}

function parseQuestionLocation(body, level, mode) {
  const hasLocation = body.location !== undefined && body.location !== null;
  if (level === 'off') {
    if (hasLocation) throw validationError('位置分享關閉時不可帶 location', { field: 'location' });
    if (mode !== 'online') throw validationError('現場協助不能關閉位置分享', { field: 'location_sharing' });
    return { approx: null, exact: null };
  }
  if (!hasLocation) throw validationError('此位置分享等級必須帶 location', { field: 'location' });
  const location = parseCoordinates(body.location);
  // 模糊等級只有現場問題要保留精確座標，供接案者使用；其他情況立即丟棄。
  return { approx: snap(location), exact: level === 'exact' || mode !== 'online' ? location : null };
}

export function questionRoutes({ db, config, serializers, notifier, getRealtime, limiter, removeMediaFiles, classifier, audit, semanticCache }) {
  const router = Router();
  const byId = db.prepare('SELECT * FROM questions WHERE id = ?');
  const byRequest = db.prepare('SELECT * FROM questions WHERE author_id = ? AND client_request_id = ?');
  const insert = db.prepare(`
    INSERT INTO questions (id, author_id, title, title_is_auto, body, category, language, assistance_mode, location_sharing, context, service_id,
      approx_lat, approx_lng, exact_lat, exact_lng, client_request_id, created_at)
    VALUES (@id, @author_id, @title, @title_is_auto, @body, @category, @language, @assistance_mode, @location_sharing, @context, @service_id,
      @approx_lat, @approx_lng, @exact_lat, @exact_lng, @client_request_id, @created_at)
  `);
  const insertTag = db.prepare('INSERT INTO question_tags (question_id, tag_key, tag, position) VALUES (?, ?, ?, ?)');
  const attach = db.prepare(`
    UPDATE media SET question_id = ?, position = ? WHERE id = ? AND owner_id = ? AND question_id IS NULL AND answer_id IS NULL
  `);

  // 分類只是輔助，出錯時不可以擋住發問。
  const autoCategory = (text) => {
    if (!text.trim()) return 'uncategorized';
    try {
      return classifier.classify(text).category;
    } catch (err) {
      console.error(`classifier error: ${err.message}`);
      return 'uncategorized';
    }
  };

  router.post('/questions', (req, res) => {
    const body = requireBodyObject(req.body);
    const clientRequestId = requireString(body, 'client_request_id', { max: 64 });
    const existing = byRequest.get(req.user.id, clientRequestId);
    if (existing) return res.status(200).json({ data: serializers.questionDetail(req, existing) });

    const text = optionalString(body, 'body', { max: 5000 });
    const mediaIds = parseMediaIds(body);
    if (!text?.trim() && !mediaIds.length) throw validationError('body 和 media_ids 至少要有一個');

    const mode = requireEnum(body.assistance_mode, ASSISTANCE_MODES, 'assistance_mode');
    const level = requireEnum(body.location_sharing ?? req.user.location_sharing, LOCATION_LEVELS, 'location_sharing');
    const { approx, exact } = parseQuestionLocation(body, level, mode);
    const context = parseContext(body.context);
    // 發問者可以不選分類，降低長輩的負擔。分類器有把握才自動分類，否則留給志工。
    const category = body.category === undefined || body.category === null
      ? autoCategory(`${optionalString(body, 'title', { max: 80 }) ?? ''} ${text ?? ''}`)
      : requireEnum(body.category, Object.keys(CATEGORIES), 'category');
    const language = parseLanguage(body.language);
    const tags = parseTags(body.tags);
    const customTitle = optionalString(body, 'title', { max: 80 });
    const title = customTitle || (text?.trim() ? firstChars(text.trim(), 30) : '圖片或語音問題');

    if (!limiter.allow(`questions:${req.user.id}`, config.rateLimit.questions)) {
      throw new ApiError(429, 'RATE_LIMITED', '發問太頻繁，請稍後再試');
    }

    const id = newId('q');
    const create = db.transaction(() => {
      insert.run({
        id, author_id: req.user.id, title, title_is_auto: customTitle ? 0 : 1, body: text, category, language, assistance_mode: mode, location_sharing: level,
        context: context && JSON.stringify(context), service_id: context?.service_id ?? null,
        approx_lat: approx?.lat ?? null, approx_lng: approx?.lng ?? null,
        exact_lat: exact?.lat ?? null, exact_lng: exact?.lng ?? null,
        client_request_id: clientRequestId, created_at: nowIso(),
      });
      mediaIds.forEach((mediaId, position) => {
        if (!attach.run(id, position, mediaId, req.user.id).changes) {
          throw validationError('media_ids 含有不存在或已被使用的檔案', { field: 'media_ids', media_id: mediaId });
        }
      });
      tags.forEach(({ key, tag }, position) => insertTag.run(id, key, tag, position));
    });
    create();

    const row = byId.get(id);
    notifier.notifyUsersNearQuestion(row);
    getRealtime().feedChanged();
    semanticCache.questionCreated(row);
    res.status(201).json({ data: serializers.questionDetail(req, row) });
  });

  const allTagKeys = db.prepare('SELECT DISTINCT tag_key FROM question_tags');
  const tagKeysOf = db.prepare('SELECT tag_key FROM question_tags WHERE question_id = ?');

  function parseListQuery(query, user) {
    const scope = query.scope === undefined ? 'global' : requireEnum(query.scope, ['global', 'nearby'], 'scope');
    const sort = query.sort === undefined ? 'latest' : requireEnum(query.sort, ['latest', 'nearest', 'unanswered'], 'sort');
    const lat = queryNumber(query, 'lat', { min: -90, max: 90 });
    const lng = queryNumber(query, 'lng', { min: -180, max: 180 });
    const hasPoint = lat !== undefined && lng !== undefined;
    if ((scope === 'nearby' || sort === 'nearest') && !hasPoint) {
      throw validationError('附近列表必須帶 lat 和 lng', { field: 'lat' });
    }
    const where = [];
    const params = {};
    const equals = (column, value) => {
      if (value === undefined) return;
      where.push(`${column} = @${column}`);
      params[column] = value;
    };
    equals('status', query.status === undefined ? undefined : requireEnum(query.status, QUESTION_STATUSES, 'status'));
    equals('category', query.category === undefined ? undefined : requireEnum(query.category, Object.keys(CATEGORIES), 'category'));
    equals('language', query.language);
    equals('assistance_mode', query.assistance_mode === undefined ? undefined : requireEnum(query.assistance_mode, ASSISTANCE_MODES, 'assistance_mode'));
    equals('service_id', query.service_id);
    if (query.author !== undefined) {
      requireEnum(query.author, ['me'], 'author');
      equals('author_id', user.id);
    }
    if (sort === 'unanswered') where.push('answer_count = 0');
    if (query.tag !== undefined) {
      where.push('id IN (SELECT question_id FROM question_tags WHERE tag_key = @exactTag)');
      params.exactTag = tagKey(query.tag);
    }
    let tagScores = null;
    if (query.tag_q !== undefined) {
      if (typeof query.tag_q !== 'string' || !tagKey(query.tag_q) || [...query.tag_q].length > 50) {
        throw validationError('tag_q 必須是 1 到 50 字的文字', { field: 'tag_q' });
      }
      tagScores = matchTagKeys(query.tag_q, allTagKeys.all().map((r) => r.tag_key));
      const keys = [...tagScores.keys()];
      keys.forEach((key, i) => { params[`fuzzy${i}`] = key; });
      where.push(keys.length
        ? `id IN (SELECT question_id FROM question_tags WHERE tag_key IN (${keys.map((_, i) => `@fuzzy${i}`).join(', ')}))`
        : '0');
    }
    return {
      scope, sort, where, params, tagScores,
      byRelevance: tagScores !== null && query.sort === undefined && scope === 'global',
      point: hasPoint ? { lat, lng } : null,
      radius: queryNumber(query, 'radius_m', { min: 100, max: 5000, integer: true, fallback: 1000 }),
      limit: parseLimit(query),
      cursor: decodeCursor(query.cursor),
    };
  }

  const whereSql = (clauses) => (clauses.length ? `WHERE ${clauses.join(' AND ')}` : '');

  // 距離用網格點計算，附近或依距離排序時在記憶體裡過濾，並以 offset 分頁。
  function listByDistance(q) {
    const center = snap(q.point);
    let rows = db.prepare(`SELECT * FROM questions ${whereSql([...q.where, 'approx_lat IS NOT NULL'])} ORDER BY created_at DESC, id DESC`).all(q.params)
      .map((row) => ({ row, distance: distanceM(center, { lat: row.approx_lat, lng: row.approx_lng }) }));
    if (q.scope === 'nearby') rows = rows.filter(({ distance }) => distance <= q.radius);
    if (q.sort === 'nearest') rows.sort((a, b) => a.distance - b.distance);
    const offset = Number.isInteger(q.cursor?.o) && q.cursor.o >= 0 ? q.cursor.o : 0;
    const page = rows.slice(offset, offset + q.limit).map(({ row }) => row);
    const next = offset + q.limit < rows.length ? encodeCursor({ o: offset + q.limit }) : null;
    return { page, next };
  }

  // 模糊搜尋預設依相似度排序，相同時新的在前。
  function listByRelevance(q) {
    const best = (row) => Math.max(0, ...tagKeysOf.all(row.id).map((t) => q.tagScores.get(t.tag_key) ?? 0));
    const rows = db.prepare(`SELECT * FROM questions ${whereSql(q.where)} ORDER BY created_at DESC, id DESC`).all(q.params)
      .map((row) => ({ row, score: best(row) }))
      .sort((a, b) => b.score - a.score);
    const offset = Number.isInteger(q.cursor?.o) && q.cursor.o >= 0 ? q.cursor.o : 0;
    const page = rows.slice(offset, offset + q.limit).map(({ row }) => row);
    return { page, next: offset + q.limit < rows.length ? encodeCursor({ o: offset + q.limit }) : null };
  }

  function listByTime(q) {
    const clauses = [...q.where];
    const params = { ...q.params, limit: q.limit + 1 };
    if (q.cursor) {
      clauses.push('(created_at, id) < (@cursorAt, @cursorId)');
      params.cursorAt = String(q.cursor.c);
      params.cursorId = String(q.cursor.i);
    }
    const rows = db.prepare(`SELECT * FROM questions ${whereSql(clauses)} ORDER BY created_at DESC, id DESC LIMIT @limit`).all(params);
    const page = rows.slice(0, q.limit);
    const last = page.at(-1);
    return { page, next: rows.length > q.limit ? encodeCursor({ c: last.created_at, i: last.id }) : null };
  }

  router.get('/questions', (req, res) => {
    const q = parseListQuery(req.query, req.user);
    const list = q.byRelevance ? listByRelevance : q.scope === 'nearby' || q.sort === 'nearest' ? listByDistance : listByTime;
    const { page, next } = list(q);
    res.json({ data: page.map((row) => serializers.questionSummary(req, row, q.point)), next_cursor: next });
  });

  router.get('/questions/:id', (req, res) => {
    const row = byId.get(req.params.id);
    if (!row) throw notFound();
    res.json({ data: serializers.questionDetail(req, row) });
  });

  const markResolved = db.prepare(`
    UPDATE questions SET status = 'resolved', exact_lat = NULL, exact_lng = NULL WHERE id = ?
  `);
  const purgeNotificationLocation = db.prepare('UPDATE notifications SET exact_lat = NULL, exact_lng = NULL WHERE question_id = ?');

  // 已解決不綁定回答：不需要留言或採納，也不會發積分。
  router.post('/questions/:id/resolve', (req, res) => {
    const row = byId.get(req.params.id);
    if (!row) throw notFound();
    const isAdmin = req.user.role === 'admin';
    if (row.author_id !== req.user.id && !isAdmin) throw forbidden('只有發問者可以標記已解決');
    if (row.status === 'in_progress') throw new ApiError(409, 'ASSIST_ACTIVE', '現場協助進行中，請先確認完成或取消');
    if (row.status !== 'open') throw new ApiError(409, 'INVALID_STATE', '這個問題已經解決了');
    db.transaction(() => {
      markResolved.run(row.id);
      purgeNotificationLocation.run(row.id);
      if (isAdmin) audit.record(req.user.id, 'question.resolve', 'question', row.id);
    })();
    getRealtime().questionChanged(row.id);
    getRealtime().feedChanged();
    res.json({ data: serializers.questionDetail(req, byId.get(row.id)) });
  });

  const tagsOf = db.prepare('SELECT tag_key FROM question_tags WHERE question_id = ?');
  const clearTags = db.prepare('DELETE FROM question_tags WHERE question_id = ?');

  // 發問者可以任意修改；其他人只能新增，避免別人的標籤被刪掉，發問者也能移除不想要的標籤。
  router.put('/questions/:id/tags', (req, res) => {
    const row = byId.get(req.params.id);
    if (!row) throw notFound();
    const tags = parseTags(requireBodyObject(req.body).tags ?? null);
    if (!Array.isArray(req.body.tags)) throw validationError('缺少 tags', { field: 'tags' });
    const isAdmin = req.user.role === 'admin';
    if (row.author_id !== req.user.id && !isAdmin) {
      if (req.user.trust_score < config.trust.lowThreshold) throw forbidden('目前不能編輯標籤');
      const next = new Set(tags.map((t) => t.key));
      if (tagsOf.all(row.id).some((t) => !next.has(t.tag_key))) throw forbidden('只有發問者可以移除標籤');
    }
    const previous = serializers.questionDetail(req, row).tags;
    db.transaction(() => {
      clearTags.run(row.id);
      tags.forEach(({ key, tag }, position) => insertTag.run(row.id, key, tag, position));
      if (isAdmin) audit.record(req.user.id, 'question.tags', 'question', row.id, { before: previous, after: tags.map((t) => t.tag) });
    })();
    getRealtime().questionChanged(row.id);
    getRealtime().feedChanged();
    res.json({ data: serializers.questionDetail(req, byId.get(row.id)) });
  });

  const updateCategory = db.prepare('UPDATE questions SET category = ? WHERE id = ?');

  // 志工只能替未分類的問題分類，避免已分類的問題被亂改；發問者隨時可以改。
  router.put('/questions/:id/category', (req, res) => {
    const row = byId.get(req.params.id);
    if (!row) throw notFound();
    const isAdmin = req.user.role === 'admin';
    const assignable = Object.keys(CATEGORIES).filter((c) => isAdmin || c !== 'uncategorized');
    const category = requireEnum(requireBodyObject(req.body).category, assignable, 'category');
    if (row.author_id !== req.user.id && !isAdmin) {
      if (req.user.trust_score < config.trust.lowThreshold) throw forbidden('目前不能替問題分類');
      if (row.category !== 'uncategorized') throw new ApiError(409, 'INVALID_STATE', '這個問題已經分類過了');
    }
    db.transaction(() => {
      updateCategory.run(category, row.id);
      if (isAdmin) audit.record(req.user.id, 'question.category', 'question', row.id, { before: row.category, after: category });
    })();
    getRealtime().questionChanged(row.id);
    getRealtime().feedChanged();
    res.json({ data: serializers.questionDetail(req, byId.get(row.id)) });
  });

  const activeAssist = db.prepare("SELECT * FROM assists WHERE question_id = ? AND status IN ('claimed', 'arrived')");
  const relatedMedia = db.prepare(`
    SELECT * FROM media WHERE question_id = @id OR answer_id IN (SELECT id FROM answers WHERE question_id = @id)
  `);
  const deleteRelated = [
    'DELETE FROM question_tags WHERE question_id = @id',
    'DELETE FROM question_embeddings WHERE question_id = @id',
    'DELETE FROM pii_reports WHERE question_id = @id',
    'DELETE FROM votes WHERE answer_id IN (SELECT id FROM answers WHERE question_id = @id)',
    'DELETE FROM media WHERE question_id = @id OR answer_id IN (SELECT id FROM answers WHERE question_id = @id)',
    'DELETE FROM answers WHERE question_id = @id',
    'DELETE FROM assists WHERE question_id = @id',
    'DELETE FROM notifications WHERE question_id = @id',
    'DELETE FROM questions WHERE id = @id',
  ].map((sql) => db.prepare(sql));

  // 撤回直接刪除資料，內容和座標都不再保留；已發出的積分維持不變。
  router.delete('/questions/:id', async (req, res) => {
    const row = byId.get(req.params.id);
    if (!row) throw notFound();
    const isAdmin = req.user.role === 'admin';
    if (row.author_id !== req.user.id && !isAdmin) throw forbidden('只有發問者可以撤回問題');
    const assist = activeAssist.get(row.id);
    const files = relatedMedia.all({ id: row.id });
    // 精確座標不保留；媒體檔會真的刪除，稽核只記錄檔案種類。
    const snapshot = isAdmin && {
      title: row.title,
      body: row.body,
      category: row.category,
      author_id: row.author_id,
      tags: tagsOf.all(row.id).map((t) => t.tag_key),
      answers: db.prepare('SELECT id, author_id, body FROM answers WHERE question_id = ?').all(row.id),
      media: files.map((f) => ({ id: f.id, kind: f.kind })),
    };
    db.transaction(() => {
      if (snapshot) audit.record(req.user.id, 'question.delete', 'question', row.id, snapshot);
      deleteRelated.forEach((statement) => statement.run({ id: row.id }));
    })();
    await removeMediaFiles(files);
    if (row.author_id !== req.user.id) {
      notifier.create({
        userId: row.author_id,
        type: 'content_moderated',
        title: '你的問題已被管理員移除',
        body: '管理員移除了你發布的問題',
      });
    }

    if (assist) {
      notifier.create({
        userId: assist.helper_id,
        type: 'assist_cancelled',
        title: '現場任務已取消',
        body: '發問者撤回了問題，任務已取消',
      });
      getRealtime().assistChanged(row.id, [assist.helper_id]);
    }
    getRealtime().questionChanged(row.id);
    getRealtime().answersChanged(row.id);
    getRealtime().feedChanged();
    res.status(204).end();
  });

  return router;
}
