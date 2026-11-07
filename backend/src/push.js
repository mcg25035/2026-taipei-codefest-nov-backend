import fs from 'node:fs';
import { deleteApp, initializeApp, cert } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { nowIso } from './util.js';

const DEAD_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);

// 精確位置不經過 Google：推播只帶通知 ID，App 再用 GET /notifications 取完整內容。
export function buildMessage(row, token) {
  return {
    token,
    notification: { title: row.title, body: row.body },
    data: { notification_id: row.id, type: row.type, question_id: row.question_id ?? '' },
    android: { priority: 'high' },
  };
}

export function createPush({ db, config }) {
  const tokensOf = db.prepare('SELECT fcm_token FROM devices WHERE user_id = ?');
  const removeToken = db.prepare('DELETE FROM devices WHERE fcm_token = ?');
  const markDelivered = db.prepare('UPDATE notifications SET delivered_at = ? WHERE id = ?');

  let app = null;
  let client = config.pushClient ?? null;
  if (!client && config.firebaseServiceAccountFile) {
    const account = JSON.parse(fs.readFileSync(config.firebaseServiceAccountFile, 'utf8'));
    app = initializeApp({ credential: cert(account) }, `push-${Date.now()}`);
    client = getMessaging(app);
  }

  async function deliver(row) {
    const tokens = tokensOf.all(row.user_id).map((d) => d.fcm_token);
    if (!tokens.length) return;
    const { responses } = await client.sendEach(tokens.map((token) => buildMessage(row, token)));
    responses.forEach((res, i) => {
      if (!res.success && DEAD_TOKEN_CODES.has(res.error?.code)) removeToken.run(tokens[i]);
      else if (!res.success) console.error(`FCM send failed: ${res.error?.code ?? 'unknown'}`);
    });
    // 送達 FCM 後由 FCM 負責離線重送；全部失敗時保留給 heartbeat 取回。
    if (responses.some((res) => res.success)) markDelivered.run(nowIso(), row.id);
  }

  return {
    enabled: Boolean(client),
    // 推播失敗不影響主流程，通知仍可從 heartbeat 和通知列表取得。
    send(row) {
      if (!client) return Promise.resolve();
      return deliver(row).catch((err) => console.error(`FCM error: ${err.code ?? err.message}`));
    },
    close: () => (app ? deleteApp(app) : Promise.resolve()),
  };
}
