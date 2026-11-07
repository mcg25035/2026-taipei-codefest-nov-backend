import { distanceM } from './geo.js';
import { newId, nowIso } from './util.js';

export const serializeNotification = (row) => ({
  id: row.id,
  type: row.type,
  title: row.title,
  body: row.body,
  question_id: row.question_id,
  exact_location: row.exact_lat === null ? null : { lat: row.exact_lat, lng: row.exact_lng },
  read: Boolean(row.read),
  created_at: row.created_at,
});

export function createNotifier({ db, config, getRealtime, push }) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO notifications (id, user_id, type, title, body, question_id, exact_lat, exact_lng, created_at)
    VALUES (@id, @user_id, @type, @title, @body, @question_id, @exact_lat, @exact_lng, @created_at)
  `);
  const select = db.prepare('SELECT * FROM notifications WHERE id = ?');
  const touchNearby = db.prepare('UPDATE users SET last_nearby_notified_at = ? WHERE id = ?');

  const create = ({ userId, type, title, body, questionId = null, exact = null }) => {
    const id = newId('n');
    const { changes } = insert.run({
      id, user_id: userId, type, title, body, question_id: questionId,
      exact_lat: exact?.lat ?? null, exact_lng: exact?.lng ?? null, created_at: nowIso(),
    });
    if (!changes) return null;
    const row = select.get(id);
    getRealtime().deliverNotification(row);
    push.notificationCreated(row);
    return row;
  };

  const pendingTitleReport = db.prepare(`
    SELECT 1 FROM pii_reports
    WHERE target_type = 'question' AND target_id = @id AND status = 'pending'
      AND (text_field = 'title' OR (text_field = 'body' AND @auto = 1))
    LIMIT 1
  `);

  // 城市通的 notify 會比對「已訂閱」開頭的文字，所以使用者內容前面一律加上固定文字。
  // 標題待個資確認時，通知也不可帶標題。
  const questionLabel = (question) => (
    pendingTitleReport.get({ id: question.id, auto: question.title_is_auto })
      ? '問題內容已更新，請開啟查看'
      : `問題：${question.title}`
  );

  const sendNearby = (question, userId) => {
    const row = create({
      userId,
      type: 'nearby_question',
      title: '附近有人需要幫忙',
      body: questionLabel(question),
      questionId: question.id,
      exact: question.location_sharing === 'exact' ? { lat: question.exact_lat, lng: question.exact_lng } : null,
    });
    if (row) touchNearby.run(row.created_at, userId);
    return row;
  };

  const questionPoint = (q) => (
    q.location_sharing === 'exact' ? { lat: q.exact_lat, lng: q.exact_lng } : { lat: q.approx_lat, lng: q.approx_lng }
  );

  const eligibleUsers = db.prepare(`
    SELECT id, last_lat, last_lng, nearby_radius_m FROM users
    WHERE id != @author
      AND nearby_notifications_enabled = 1
      AND location_sharing != 'off'
      AND trust_score >= @minTrust
      AND last_lat IS NOT NULL
      AND location_updated_at >= @fresh
      AND (last_nearby_notified_at IS NULL OR last_nearby_notified_at <= @throttle)
  `);

  const notifyUsersNearQuestion = (question) => {
    if (question.location_sharing === 'off') return;
    const now = Date.now();
    const point = questionPoint(question);
    eligibleUsers
      .all({
        author: question.author_id,
        minTrust: config.trust.lowThreshold,
        fresh: new Date(now - config.nearby.locationFreshMs).toISOString(),
        throttle: new Date(now - config.nearby.perUserThrottleMs).toISOString(),
      })
      .map((user) => ({ user, distance: distanceM(point, { lat: user.last_lat, lng: user.last_lng }) }))
      .filter(({ user, distance }) => distance <= user.nearby_radius_m)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, config.nearby.maxRecipients)
      .forEach(({ user }) => sendNearby(question, user.id));
  };

  const openQuestionsNotYetSent = db.prepare(`
    SELECT q.* FROM questions q
    WHERE q.status = 'open'
      AND q.location_sharing != 'off'
      AND q.author_id != @user
      AND q.created_at >= @since
      AND NOT EXISTS (
        SELECT 1 FROM notifications n
        WHERE n.user_id = @user AND n.question_id = q.id AND n.type = 'nearby_question'
      )
  `);

  // 使用者走進某個問題的範圍時，由 heartbeat 觸發，一次最多通知一題。
  const notifyQuestionNearUser = (user) => {
    if (
      !user.nearby_notifications_enabled ||
      user.location_sharing === 'off' ||
      user.trust_score < config.trust.lowThreshold ||
      user.last_lat === null
    ) return;
    const now = Date.now();
    if (user.last_nearby_notified_at && now - Date.parse(user.last_nearby_notified_at) < config.nearby.perUserThrottleMs) return;
    const here = { lat: user.last_lat, lng: user.last_lng };
    const nearest = openQuestionsNotYetSent
      .all({ user: user.id, since: new Date(now - config.nearby.questionMaxAgeMs).toISOString() })
      .map((question) => ({ question, distance: distanceM(here, questionPoint(question)) }))
      .filter(({ distance }) => distance <= user.nearby_radius_m)
      .sort((a, b) => a.distance - b.distance)[0];
    if (nearest) sendNearby(nearest.question, user.id);
  };

  return { create, questionLabel, notifyUsersNearQuestion, notifyQuestionNearUser };
}
