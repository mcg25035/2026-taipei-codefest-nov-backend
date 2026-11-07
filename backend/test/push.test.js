import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import { createFcmTransport } from '../src/push.js';
import { startTestServer } from './helpers.js';

// 假的 FCM 傳輸層：記錄送出的訊息，依 token 回傳預先排好的結果。
function fakeTransport() {
  const sent = [];
  const scripted = new Map();
  return {
    sent,
    reply(token, ...results) { scripted.set(token, results); },
    async send(message) {
      sent.push(message);
      return scripted.get(message.token)?.shift() ?? { ok: true, status: 200 };
    },
  };
}

const pushConfig = {
  serviceAccount: null,
  channelId: 'test-channel',
  questionUrl: 'https://forum.test/questions/{question_id}',
  maxTokensPerUser: 2,
  maxAttempts: 3,
  retryBaseMs: 1,
};

describe('FCM 推播', () => {
  let t;
  let fcm;
  before(async () => {
    fcm = fakeTransport();
    t = await startTestServer({ push: pushConfig, pushTransport: fcm });
  });
  after(async () => { await t.stop(); });
  beforeEach(() => { fcm.sent.length = 0; });

  const register = (user, token, platform = 'android') => t.call('PUT', '/push-tokens/{token}', {
    token: user.token, params: { token: encodeURIComponent(token) }, body: { platform },
  });
  const unregister = (user, token) => t.call('DELETE', '/push-tokens/{token}', {
    token: user.token, params: { token: encodeURIComponent(token) },
  });
  const tokensOf = (user) => t.server.db.prepare('SELECT token FROM push_tokens WHERE user_id = ? ORDER BY token').all(user.user.id).map((r) => r.token);
  // 讓提問者收到一則 new_answer 通知，並等推播送完。
  const triggerAnswer = async (asker) => {
    const helper = await t.login();
    const q = await t.call('POST', '/questions', { token: asker.token, body: t.question() });
    await t.call('POST', '/questions/{question_id}/answers', { token: helper.token, params: { question_id: q.body.data.id }, body: { body: '答案' } });
    await t.server.push.idle();
    return q.body.data;
  };

  test('註冊參數檢查與登入要求', async () => {
    const user = await t.login();
    assert.equal((await register(user, 'tok-a', 'windows')).status, 400);
    assert.equal((await t.call('PUT', '/push-tokens/{token}', { token: user.token, params: { token: 'tok-a' } })).status, 400);
    assert.equal((await t.call('PUT', '/push-tokens/{token}', { params: { token: 'tok-a' }, body: { platform: 'android' } })).status, 401);
    assert.equal((await register(user, 'has space')).status, 400);
    assert.equal((await register(user, 'abc:APA91b-_x')).status, 204);
    assert.deepEqual(tokensOf(user), ['abc:APA91b-_x']);
  });

  test('建立通知時送出推播，內容與 TownPass 規格一致', async () => {
    const asker = await t.login();
    await register(asker, 'device-1');
    await register(asker, 'device-2');
    const q = await triggerAnswer(asker);
    assert.deepEqual(fcm.sent.map((m) => m.token).sort(), ['device-1', 'device-2']);
    const message = fcm.sent[0];
    const notification = (await t.call('GET', '/notifications', { token: asker.token })).body.data[0];
    assert.deepEqual(message.notification, { title: notification.title, body: notification.body });
    assert.deepEqual(message.data, {
      notification_id: notification.id,
      type: 'new_answer',
      question_id: q.id,
      url: `https://forum.test/questions/${q.id}`,
    });
    assert.ok(Object.values(message.data).every((v) => typeof v === 'string'));
    assert.deepEqual(message.android, { priority: 'HIGH', notification: { channel_id: 'test-channel' } });
  });

  test('沒有問題的通知不帶 url；沒註冊 token 的人不會推播', async () => {
    const user = await t.login();
    await register(user, 'badge-device');
    const stranger = await t.login();
    t.server.db.prepare("INSERT INTO notifications (id, user_id, type, title, body, created_at) VALUES ('n_badge', ?, 'badge_earned', '獲得新徽章', '恭喜', ?)").run(user.user.id, new Date().toISOString());
    t.server.push.notificationCreated({ id: 'n_badge' });
    await triggerAnswer(stranger);
    assert.equal(fcm.sent.length, 1);
    assert.deepEqual(fcm.sent[0].data, { notification_id: 'n_badge', type: 'badge_earned' });
  });

  test('同一個 token 重新註冊會轉到新使用者；只能刪除自己的 token', async () => {
    const first = await t.login();
    const second = await t.login();
    await register(first, 'shared-phone');
    await register(second, 'shared-phone');
    assert.deepEqual(tokensOf(first), []);
    assert.equal((await unregister(first, 'shared-phone')).status, 204);
    assert.deepEqual(tokensOf(second), ['shared-phone']);
    assert.equal((await unregister(second, 'shared-phone')).status, 204);
    assert.deepEqual(tokensOf(second), []);
  });

  test('每人只保留最近的 token', async () => {
    const user = await t.login();
    for (const token of ['old', 'mid', 'new']) {
      await register(user, token);
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.deepEqual(tokensOf(user), ['mid', 'new']);
  });

  test('失效的 token 會刪除，暫時性錯誤會重試，其他錯誤不重試也不刪除', async () => {
    const asker = await t.login();
    await register(asker, 'dead');
    await register(asker, 'flaky');
    fcm.reply('dead', { ok: false, status: 404, code: 'UNREGISTERED', message: 'Requested entity was not found.' });
    fcm.reply('flaky', { ok: false, status: 503, code: 'UNAVAILABLE' }, { ok: false, status: 0, message: 'socket hang up' }, { ok: true, status: 200 });
    await triggerAnswer(asker);
    assert.deepEqual(tokensOf(asker), ['flaky']);
    assert.equal(fcm.sent.filter((m) => m.token === 'flaky').length, 3);

    fcm.sent.length = 0;
    const warn = console.warn;
    console.warn = () => {};
    try {
      fcm.reply('flaky', { ok: false, status: 400, code: 'INVALID_ARGUMENT', message: 'Invalid JSON payload' });
      await triggerAnswer(asker);
    } finally {
      console.warn = warn;
    }
    assert.equal(fcm.sent.length, 1);
    assert.deepEqual(tokensOf(asker), ['flaky']);
  });
});

describe('未設定 FCM', () => {
  test('仍可註冊 token，但不會推播', async () => {
    const t = await startTestServer();
    try {
      assert.equal(t.server.push.enabled, false);
      const user = await t.login();
      const res = await t.call('PUT', '/push-tokens/{token}', { token: user.token, params: { token: 'x' }, body: { platform: 'android' } });
      assert.equal(res.status, 204);
    } finally {
      await t.stop();
    }
  });
});

describe('FCM HTTP v1 傳輸層', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const account = {
    project_id: 'demo-project',
    client_email: 'push@demo-project.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  test('用服務帳戶簽 JWT 換 access token，並快取重複使用', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      if (url === 'https://oauth2.googleapis.com/token') return json(200, { access_token: 'ya29.test', expires_in: 3600 });
      return json(200, { name: 'projects/demo-project/messages/1' });
    };
    const transport = createFcmTransport(account, { fetchImpl });
    assert.deepEqual(await transport.send({ token: 'a' }), { ok: true, status: 200 });
    assert.equal((await transport.send({ token: 'b' })).ok, true);

    assert.equal(calls.filter((c) => c.url.includes('oauth2')).length, 1);
    const assertion = calls[0].init.body.get('assertion');
    const [header, payload, signature] = assertion.split('.');
    assert.ok(crypto.verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, 'base64url')));
    const claims = JSON.parse(Buffer.from(payload, 'base64url'));
    assert.equal(claims.iss, account.client_email);
    assert.equal(claims.scope, 'https://www.googleapis.com/auth/firebase.messaging');

    const send = calls[1];
    assert.equal(send.url, 'https://fcm.googleapis.com/v1/projects/demo-project/messages:send');
    assert.equal(send.init.headers.Authorization, 'Bearer ya29.test');
    assert.deepEqual(JSON.parse(send.init.body), { message: { token: 'a' } });
  });

  test('解析 FCM 錯誤代碼與 Retry-After；401 時重新取得 access token', async () => {
    let oauthCalls = 0;
    const replies = [
      json(404, { error: { status: 'NOT_FOUND', message: 'gone', details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED' }] } }),
      new Response(JSON.stringify({ error: { status: 'RESOURCE_EXHAUSTED' } }), { status: 429, headers: { 'Retry-After': '7' } }),
      json(401, { error: { status: 'UNAUTHENTICATED' } }),
      json(200, {}),
    ];
    const fetchImpl = async (url) => {
      if (url.includes('oauth2')) { oauthCalls++; return json(200, { access_token: `t${oauthCalls}`, expires_in: 3600 }); }
      return replies.shift();
    };
    const transport = createFcmTransport(account, { fetchImpl });
    assert.deepEqual(await transport.send({}), { ok: false, status: 404, code: 'UNREGISTERED', message: 'gone', retryAfterMs: null });
    const limited = await transport.send({});
    assert.equal(limited.code, 'RESOURCE_EXHAUSTED');
    assert.equal(limited.retryAfterMs, 7000);
    assert.equal((await transport.send({})).status, 401);
    assert.equal((await transport.send({})).ok, true);
    assert.equal(oauthCalls, 2);
  });

  test('OAuth 失敗與網路錯誤不丟例外', async () => {
    const denied = createFcmTransport(account, { fetchImpl: async () => json(400, { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' }) });
    const result = await denied.send({});
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.match(result.message, /Invalid JWT Signature/);

    const offline = createFcmTransport(account, { fetchImpl: async () => { throw new TypeError('fetch failed'); } });
    assert.equal((await offline.send({})).status, 0);
  });
});
