import { Router } from 'express';
import { ApiError, forbidden, notFound } from '../errors.js';
import { distanceM } from '../geo.js';
import { publicUser } from '../serialize.js';
import { newId, nowIso, optionalString, parseCoordinates, requireBodyObject } from '../util.js';

const invalidState = () => new ApiError(409, 'INVALID_STATE', '目前狀態不能進行這個操作');
const ACTIVE = ['claimed', 'arrived'];

export function assistRoutes({ db, config, notifier, getRealtime, rewards }) {
  const router = Router();
  const questionById = db.prepare('SELECT * FROM questions WHERE id = ?');
  const userById = db.prepare('SELECT * FROM users WHERE id = ?');
  const assistById = db.prepare('SELECT * FROM assists WHERE id = ?');
  const activeOf = db.prepare("SELECT * FROM assists WHERE question_id = ? AND status IN ('claimed', 'arrived')");
  const latestForUser = db.prepare(`
    SELECT * FROM assists WHERE question_id = @question AND (asker_id = @user OR helper_id = @user)
    ORDER BY claimed_at DESC, id DESC LIMIT 1
  `);
  const insert = db.prepare(`
    INSERT INTO assists (id, question_id, asker_id, helper_id, status, claimed_at) VALUES (?, ?, ?, ?, 'claimed', ?)
  `);
  const setQuestionStatus = db.prepare('UPDATE questions SET status = ? WHERE id = ?');
  const markArrived = db.prepare("UPDATE assists SET status = 'arrived', arrived_at = ? WHERE id = ?");
  const markCompleted = db.prepare("UPDATE assists SET status = 'completed', completed_at = ? WHERE id = ?");
  const markCancelled = db.prepare(`
    UPDATE assists SET status = 'cancelled', cancelled_at = ?, cancelled_by = ?, cancel_reason = ? WHERE id = ?
  `);
  const purgeQuestionLocation = db.prepare(`
    UPDATE questions SET status = 'resolved', exact_lat = NULL, exact_lng = NULL WHERE id = ?
  `);
  const purgeNotificationLocation = db.prepare('UPDATE notifications SET exact_lat = NULL, exact_lng = NULL WHERE question_id = ?');
  const addPoints = db.prepare('UPDATE users SET points = points + ?, trust_score = trust_score + ? WHERE id = ?');
  const insertTransaction = db.prepare(`
    INSERT INTO point_transactions (id, user_id, amount, reason, question_id, created_at) VALUES (?, ?, ?, 'assist_completed', ?, ?)
  `);

  const serialize = (assist) => {
    const question = questionById.get(assist.question_id);
    return {
      id: assist.id,
      question_id: assist.question_id,
      status: assist.status,
      asker: publicUser(userById.get(assist.asker_id)),
      helper: publicUser(userById.get(assist.helper_id)),
      exact_location: ACTIVE.includes(assist.status) && question.exact_lat !== null
        ? { lat: question.exact_lat, lng: question.exact_lng }
        : null,
      claimed_at: assist.claimed_at,
      arrived_at: assist.arrived_at,
      completed_at: assist.completed_at,
      cancelled_at: assist.cancelled_at,
      cancelled_by: assist.cancelled_by,
      cancel_reason: assist.cancel_reason,
    };
  };

  const signal = (assist) => {
    const rt = getRealtime();
    rt.assistChanged(assist.question_id, [assist.asker_id, assist.helper_id]);
    rt.questionChanged(assist.question_id);
    rt.feedChanged();
  };

  // 非參與者一律拿不到內容；沒有進行中的任務時，也不透露曾有誰接過。
  router.get('/questions/:id/assist', (req, res) => {
    if (!questionById.get(req.params.id)) throw notFound();
    const mine = latestForUser.get({ question: req.params.id, user: req.user.id });
    if (mine) return res.json({ data: serialize(mine) });
    if (activeOf.get(req.params.id)) throw forbidden('只有發問者和接案者可以查看');
    throw notFound('目前沒有現場協助');
  });

  router.post('/questions/:id/assist', (req, res) => {
    const question = questionById.get(req.params.id);
    if (!question) throw notFound();
    const location = parseCoordinates(requireBodyObject(req.body).location);
    if (question.author_id === req.user.id) throw new ApiError(403, 'SELF_ACTION_NOT_ALLOWED', '不能接自己的任務');
    if (req.user.location_sharing === 'off') throw new ApiError(403, 'LOCATION_SHARING_OFF', '位置分享已關閉，不能接現場任務');
    if (req.user.trust_score < config.trust.lowThreshold) throw new ApiError(403, 'ASSIST_NOT_ALLOWED', '目前不能接現場任務');
    if (question.assistance_mode === 'online') throw invalidState();
    if (activeOf.get(question.id)) throw new ApiError(409, 'ASSIST_ALREADY_CLAIMED', '任務已被接走');
    if (question.status !== 'open') throw invalidState();
    // 距離只跟公開的網格點比，錯誤回應才不會被用來反推精確位置。
    if (distanceM(location, { lat: question.approx_lat, lng: question.approx_lng }) > config.assistMaxDistanceM) {
      throw new ApiError(403, 'TOO_FAR', '超出接案距離');
    }

    const id = newId('as');
    db.transaction(() => {
      insert.run(id, question.id, question.author_id, req.user.id, nowIso());
      setQuestionStatus.run('in_progress', question.id);
    })();
    const assist = assistById.get(id);
    notifier.create({
      userId: question.author_id,
      type: 'assist_claimed',
      title: '有人接下你的現場任務',
      body: `${req.user.nickname} 正在前往協助你`,
      questionId: question.id,
    });
    signal(assist);
    res.status(201).json({ data: serialize(assist) });
  });

  const loadAssist = (req) => {
    const assist = assistById.get(req.params.id);
    if (!assist) throw notFound();
    return assist;
  };

  router.post('/assists/:id/arrive', (req, res) => {
    const assist = loadAssist(req);
    if (assist.helper_id !== req.user.id) throw forbidden('只有接案者可以回報抵達');
    if (assist.status !== 'claimed') throw invalidState();
    markArrived.run(nowIso(), assist.id);
    notifier.create({
      userId: assist.asker_id,
      type: 'assist_arrived',
      title: '幫手已抵達',
      body: `${req.user.nickname} 已抵達現場`,
      questionId: assist.question_id,
    });
    const updated = assistById.get(assist.id);
    signal(updated);
    res.json({ data: serialize(updated) });
  });

  router.post('/assists/:id/complete', (req, res) => {
    const assist = loadAssist(req);
    if (assist.asker_id !== req.user.id) throw forbidden('只有發問者可以確認完成');
    if (!ACTIVE.includes(assist.status)) throw invalidState();
    const amount = config.points.assistCompleted;
    db.transaction(() => {
      markCompleted.run(nowIso(), assist.id);
      purgeQuestionLocation.run(assist.question_id);
      purgeNotificationLocation.run(assist.question_id);
      addPoints.run(amount, config.trust.assistCompleted, assist.helper_id);
      insertTransaction.run(newId('p'), assist.helper_id, amount, assist.question_id, nowIso());
    })();
    notifier.create({
      userId: assist.helper_id,
      type: 'assist_completed',
      title: '現場任務完成',
      body: `謝謝你的協助，獲得 ${amount} 積分`,
      questionId: assist.question_id,
    });
    rewards.awardBadges(assist.helper_id);
    const updated = assistById.get(assist.id);
    signal(updated);
    res.json({ data: serialize(updated) });
  });

  router.post('/assists/:id/cancel', (req, res) => {
    const assist = loadAssist(req);
    const isAsker = assist.asker_id === req.user.id;
    if (!isAsker && assist.helper_id !== req.user.id) throw forbidden('只有發問者和接案者可以取消');
    if (!ACTIVE.includes(assist.status)) throw invalidState();
    const reason = optionalString(req.body ?? {}, 'reason', { max: 200 });
    db.transaction(() => {
      markCancelled.run(nowIso(), isAsker ? 'asker' : 'helper', reason, assist.id);
      setQuestionStatus.run('open', assist.question_id);
    })();
    notifier.create({
      userId: isAsker ? assist.helper_id : assist.asker_id,
      type: 'assist_cancelled',
      title: '現場任務已取消',
      body: isAsker ? '發問者取消了這次協助' : '幫手取消了這次協助，問題已重新開放',
      questionId: assist.question_id,
    });
    const updated = assistById.get(assist.id);
    signal(updated);
    res.json({ data: serialize(updated) });
  });

  return router;
}
