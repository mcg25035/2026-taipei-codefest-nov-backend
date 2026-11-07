import crypto from 'node:crypto';

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

// FCM HTTP v1 用服務帳戶自簽 JWT 換 OAuth access token，不需要 firebase-admin。
// send() 不丟例外，一律回傳 { ok, status, code, message, retryAfterMs }。
export function createFcmTransport(serviceAccount, { fetchImpl = fetch } = {}) {
  const tokenUrl = serviceAccount.token_uri || GOOGLE_TOKEN_URL;
  const sendUrl = `https://fcm.googleapis.com/v1/projects/${serviceAccount.project_id}/messages:send`;
  let cached = null;

  const accessToken = async (signal) => {
    if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;
    const now = Math.floor(Date.now() / 1000);
    const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
      iss: serviceAccount.client_email, scope: FCM_SCOPE, aud: tokenUrl, iat: now, exp: now + 3600,
    })}`;
    const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), serviceAccount.private_key).toString('base64url');
    const res = await fetchImpl(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }),
      signal,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.access_token) {
      const error = new Error(`取得 FCM access token 失敗：${json.error_description ?? json.error ?? res.status}`);
      error.status = res.status;
      throw error;
    }
    cached = { token: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 };
    return cached.token;
  };

  return {
    async send(message, { signal } = {}) {
      try {
        const res = await fetchImpl(sendUrl, {
          method: 'POST',
          headers: { Authorization: `Bearer ${await accessToken(signal)}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ message }),
          signal,
        });
        if (res.ok) return { ok: true, status: res.status };
        if (res.status === 401) cached = null;
        const json = await res.json().catch(() => ({}));
        const fcmError = json.error?.details?.find((d) => d['@type']?.endsWith('google.firebase.fcm.v1.FcmError'));
        const retryAfter = Number(res.headers.get('retry-after'));
        return {
          ok: false,
          status: res.status,
          code: fcmError?.errorCode ?? json.error?.status ?? null,
          message: json.error?.message ?? '',
          retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null,
        };
      } catch (err) {
        // OAuth 帳號設定錯誤保留原狀態碼；其他視為網路錯誤，可重試。
        return { ok: false, status: err.status ?? 0, code: null, message: err.message };
      }
    },
  };
}

const isDeadToken = ({ status, code, message }) => (
  code === 'UNREGISTERED' ||
  code === 'SENDER_ID_MISMATCH' ||
  status === 404 ||
  (status === 400 && code === 'INVALID_ARGUMENT' && /registration token/i.test(message ?? ''))
);
const isRetryable = ({ status }) => status === 0 || status === 429 || status >= 500;

export function createPush({ db, config, transport }) {
  const { channelId, questionUrl, maxTokensPerUser, maxAttempts, retryBaseMs } = config.push;
  const upsert = db.prepare(`
    INSERT INTO push_tokens (token, user_id, platform, updated_at) VALUES (@token, @user, @platform, @now)
    ON CONFLICT (token) DO UPDATE SET user_id = excluded.user_id, platform = excluded.platform, updated_at = excluded.updated_at
  `);
  const trim = db.prepare(`
    DELETE FROM push_tokens WHERE user_id = @user AND token NOT IN (
      SELECT token FROM push_tokens WHERE user_id = @user ORDER BY updated_at DESC, token LIMIT @keep
    )
  `);
  const removeOwn = db.prepare('DELETE FROM push_tokens WHERE token = ? AND user_id = ?');
  const removeDead = db.prepare('DELETE FROM push_tokens WHERE token = ?');
  const tokensOf = db.prepare('SELECT token FROM push_tokens WHERE user_id = ?');
  const getNotification = db.prepare('SELECT * FROM notifications WHERE id = ?');

  const inFlight = new Set();
  const stopping = new AbortController();
  const sleep = (ms) => new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    stopping.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });

  const buildMessage = (token, row) => {
    const data = { notification_id: row.id, type: row.type };
    if (row.question_id) {
      data.question_id = row.question_id;
      if (questionUrl) data.url = questionUrl.replaceAll('{question_id}', encodeURIComponent(row.question_id));
    }
    return {
      token,
      notification: { title: row.title, body: row.body },
      data,
      android: { priority: 'HIGH', notification: { channel_id: channelId } },
    };
  };

  const deliver = async (token, row) => {
    for (let attempt = 1; ; attempt++) {
      const result = await transport.send(buildMessage(token, row), { signal: stopping.signal });
      if (result.ok || stopping.signal.aborted) return;
      if (isDeadToken(result)) {
        removeDead.run(token);
        return;
      }
      if (!isRetryable(result) || attempt >= maxAttempts) {
        console.warn(`FCM 推播失敗（${result.status} ${result.code ?? ''}）：${result.message}`);
        return;
      }
      const backoff = retryBaseMs * 2 ** (attempt - 1);
      await sleep(Math.max(result.retryAfterMs ?? 0, backoff + Math.random() * backoff));
    }
  };

  const pushNotification = async (notificationId) => {
    // 建立通知的交易可能已回滾，所以重新讀取；內容也可能因個資標記改成通用文字。
    const row = getNotification.get(notificationId);
    if (!row) return;
    await Promise.all(tokensOf.all(row.user_id).map(({ token }) => deliver(token, row)));
  };

  const track = (promise) => {
    const p = promise.catch((err) => console.error('FCM 推播發生錯誤', err)).finally(() => inFlight.delete(p));
    inFlight.add(p);
  };

  return {
    enabled: Boolean(transport),

    register(userId, token, platform) {
      db.transaction(() => {
        upsert.run({ token, user: userId, platform, now: new Date().toISOString() });
        trim.run({ user: userId, keep: maxTokensPerUser });
      })();
    },

    unregister(userId, token) {
      removeOwn.run(token, userId);
    },

    // 在目前的同步流程（通常是 DB 交易）結束後才發送，不阻塞 API 回應。
    notificationCreated(row) {
      if (!transport || stopping.signal.aborted) return;
      track(new Promise((resolve) => setImmediate(resolve)).then(() => pushNotification(row.id)));
    },

    async idle() {
      while (inFlight.size) await Promise.allSettled([...inFlight]);
    },

    async close() {
      stopping.abort();
      await this.idle();
    },
  };
}
