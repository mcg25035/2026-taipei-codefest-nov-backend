import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import { io } from 'socket.io-client';
import { openDatabase } from '../src/db.js';
import { TAIPEI, startTestServer } from './helpers.js';

let t;
before(async () => { t = await startTestServer(); });
after(async () => { await t.stop(); });

const ask = async (user, overrides) => {
  const res = await t.call('POST', '/questions', { token: user.token, body: t.question(overrides) });
  assert.equal(res.status, 201, res.raw);
  return res.body.data;
};
const answer = async (user, questionId, body = '這是繳費通知') => {
  const res = await t.call('POST', '/questions/{question_id}/answers', {
    token: user.token, params: { question_id: questionId }, body: { body },
  });
  assert.equal(res.status, 201, res.raw);
  return res.body.data;
};
const beat = (user, location) => t.call('POST', '/me/heartbeat', { token: user.token, body: { app_state: 'background', location } });
const setLevel = (user, level) => t.call('PATCH', '/me', { token: user.token, body: { location_sharing: level } });
// 舊問題會由 heartbeat 觸發通知並佔用頻率限制，附近通知相關的測試要先清掉。
const clearNearbyState = () => t.server.db.exec(`
  DELETE FROM notifications;
  UPDATE questions SET status = 'resolved';
  UPDATE users SET location_updated_at = NULL, last_lat = NULL, last_lng = NULL, last_nearby_notified_at = NULL;
`);
const trustOf = (id) => t.server.db.prepare('SELECT trust_score FROM users WHERE id = ?').get(id).trust_score;

describe('基本與登入', () => {
  test('健康檢查與 meta 不需要 token', async () => {
    assert.equal((await t.call('GET', '/healthz')).status, 200);
    assert.equal((await t.call('GET', '/meta')).status, 200);
  });

  test('同一位城市通使用者登入兩次，對應同一帳號', async () => {
    const first = await t.call('POST', '/sessions', { body: { townpass_user_id: 'same-user', nickname: '小明' } });
    const second = await t.call('POST', '/sessions', { body: { townpass_user_id: 'same-user', nickname: '改名' } });
    assert.equal(first.body.data.user.id, second.body.data.user.id);
    assert.equal(second.body.data.user.nickname, '小明');
  });

  test('沒有或錯誤的 token 回 401', async () => {
    assert.equal((await t.call('GET', '/me')).status, 401);
    assert.equal((await t.call('GET', '/me', { token: 'bad' })).status, 401);
  });

  test('任何回應都不含可信度評分', async () => {
    const user = await t.login();
    const me = await t.call('GET', '/me', { token: user.token });
    assert.doesNotMatch(me.raw, /trust/);
  });
});

describe('發問', () => {
  test('body 和媒體都沒有時回 400', async () => {
    const user = await t.login();
    const res = await t.call('POST', '/questions', { token: user.token, body: t.question({ body: '  ' }) });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  });

  test('未填標題時由內容前 30 字產生', async () => {
    const user = await t.login();
    const q = await ask(user, { body: '字'.repeat(40) });
    assert.equal(q.title, '字'.repeat(30));
  });

  test('重送相同 client_request_id 回傳原問題，不會重複建立', async () => {
    const user = await t.login();
    const body = t.question();
    const first = await t.call('POST', '/questions', { token: user.token, body });
    const second = await t.call('POST', '/questions', { token: user.token, body });
    assert.equal(first.status, 201);
    assert.equal(second.status, 200);
    assert.equal(first.body.data.id, second.body.data.id);
  });

  test('帶入情境時移除 query string', async () => {
    const user = await t.login();
    const q = await ask(user, {
      context: { service_id: 'fee-payment', service_name: '繳費服務', page_route: '/fee-payment/detail/:id?idNo=A123456789' },
    });
    assert.equal(q.context.page_route, '/fee-payment/detail/:id');
    const found = await t.call('GET', '/questions', { token: user.token, query: { service_id: 'fee-payment', author: 'me' } });
    assert.equal(found.body.data.length, 1);
  });

  test('超過頻率限制回 429', async () => {
    const limited = await startTestServer({ rateLimit: { windowMs: 60_000, questions: 1, answers: 1 } });
    try {
      const user = await limited.login();
      const body = () => limited.question();
      assert.equal((await limited.call('POST', '/questions', { token: user.token, body: body() })).status, 201);
      const res = await limited.call('POST', '/questions', { token: user.token, body: body() });
      assert.equal(res.status, 429);
      assert.equal(res.body.error.code, 'RATE_LIMITED');
    } finally {
      await limited.stop();
    }
  });

  test('分頁可以取完所有問題，且不重複', async () => {
    const user = await t.login();
    for (let i = 0; i < 5; i++) await ask(user);
    const seen = new Set();
    let cursor;
    do {
      const res = await t.call('GET', '/questions', {
        token: user.token, query: { author: 'me', limit: '2', ...(cursor && { cursor }) },
      });
      res.body.data.forEach((q) => seen.add(q.id));
      cursor = res.body.next_cursor;
    } while (cursor);
    assert.equal(seen.size, 5);
  });
});

describe('位置分享等級', () => {
  const exactMatcher = new RegExp(String(TAIPEI.lat).replace('.', '\\.'));

  test('off 不可帶位置，也不能申請現場協助', async () => {
    const user = await t.login();
    const withLocation = await t.call('POST', '/questions', { token: user.token, body: t.question({ location: TAIPEI }) });
    assert.equal(withLocation.status, 400);
    const onsite = await t.call('POST', '/questions', { token: user.token, body: t.question({ assistance_mode: 'onsite' }) });
    assert.equal(onsite.status, 400);
  });

  test('未填等級時採用使用者預設值，且必須帶位置', async () => {
    const user = await t.login();
    const body = t.question();
    delete body.location_sharing;
    const res = await t.call('POST', '/questions', { token: user.token, body });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.details.field, 'location');
  });

  test('approximate 線上問題不保存精確座標，公開內容只有網格點', async () => {
    const user = await t.login();
    const q = await ask(user, { location_sharing: 'approximate', location: TAIPEI });
    assert.deepEqual([q.area.approx_lat, q.area.approx_lng], [25.035, 121.565]);
    const row = t.server.db.prepare('SELECT exact_lat FROM questions WHERE id = ?').get(q.id);
    assert.equal(row.exact_lat, null);
  });

  test('approximate 現場問題會私下保存精確座標，但公開內容和通知都不會出現', async () => {
    clearNearbyState();
    const helper = await t.login();
    await beat(helper, TAIPEI);
    const asker = await t.login();
    const q = await ask(asker, { location_sharing: 'approximate', assistance_mode: 'onsite', location: TAIPEI });
    const detail = await t.call('GET', '/questions/{question_id}', { token: helper.token, params: { question_id: q.id } });
    assert.doesNotMatch(detail.raw, exactMatcher);
    assert.equal(t.server.db.prepare('SELECT exact_lat FROM questions WHERE id = ?').get(q.id).exact_lat, TAIPEI.lat);
    const notified = await beat(helper, TAIPEI);
    const note = notified.body.data.notifications.find((n) => n.question_id === q.id);
    assert.equal(note.exact_location, null);
    assert.doesNotMatch(notified.raw, exactMatcher);
  });

  test('exact 問題的公開內容仍只有網格點，精確座標只在附近通知', async () => {
    clearNearbyState();
    const helper = await t.login();
    await beat(helper, TAIPEI);
    const asker = await t.login();
    const q = await ask(asker, { location_sharing: 'exact', location: TAIPEI });
    assert.doesNotMatch(JSON.stringify(q), exactMatcher);
    const notified = await beat(helper, TAIPEI);
    const note = notified.body.data.notifications.find((n) => n.question_id === q.id);
    assert.deepEqual(note.exact_location, TAIPEI);
  });

  test('改成 off 時立即刪除已保存的位置，heartbeat 也不再保存', async () => {
    const user = await t.login();
    await setLevel(user, 'exact');
    await beat(user, TAIPEI);
    const select = t.server.db.prepare('SELECT last_lat FROM users WHERE id = ?');
    assert.equal(select.get(user.user.id).last_lat, TAIPEI.lat);
    await setLevel(user, 'off');
    assert.equal(select.get(user.user.id).last_lat, null);
    await beat(user, TAIPEI);
    assert.equal(select.get(user.user.id).last_lat, null);
  });

  test('從 exact 改成 approximate 時，已保存的座標換成網格點', async () => {
    const user = await t.login();
    await setLevel(user, 'exact');
    await beat(user, TAIPEI);
    await setLevel(user, 'approximate');
    assert.equal(t.server.db.prepare('SELECT last_lat FROM users WHERE id = ?').get(user.user.id).last_lat, 25.035);
  });

  test('附近列表只回傳範圍內的問題，距離取到百公尺', async () => {
    const user = await t.login();
    const near = await ask(user, { location_sharing: 'approximate', location: TAIPEI });
    const far = await ask(user, { location_sharing: 'approximate', location: { lat: 24.15, lng: 120.67 } });
    const res = await t.call('GET', '/questions', {
      token: user.token, query: { scope: 'nearby', lat: String(TAIPEI.lat), lng: String(TAIPEI.lng), radius_m: '1000', author: 'me' },
    });
    const ids = res.body.data.map((q) => q.id);
    assert.ok(ids.includes(near.id));
    assert.ok(!ids.includes(far.id));
    assert.equal(res.body.data[0].area.distance_m % 100, 0);
  });

  test('附近列表缺少座標時回 400', async () => {
    const user = await t.login();
    assert.equal((await t.call('GET', '/questions', { token: user.token, query: { scope: 'nearby' } })).status, 400);
  });
});

describe('回答、投票與採納', () => {
  test('完整流程：回答、採納、加分、清除精確座標', async () => {
    clearNearbyState();
    const asker = await t.login();
    const helper = await t.login();
    await beat(helper, TAIPEI);
    const q = await ask(asker, { location_sharing: 'exact', location: TAIPEI });
    const a = await answer(helper, q.id);

    const accepted = await t.call('POST', '/answers/{answer_id}/accept', { token: asker.token, params: { answer_id: a.id } });
    assert.equal(accepted.status, 200, accepted.raw);
    assert.equal(accepted.body.data.is_accepted, true);

    const detail = await t.call('GET', '/questions/{question_id}', { token: asker.token, params: { question_id: q.id } });
    assert.equal(detail.body.data.status, 'resolved');
    assert.equal(detail.body.data.accepted_answer_id, a.id);
    assert.equal(detail.body.data.answer_count, 1);

    const me = await t.call('GET', '/me', { token: helper.token });
    assert.equal(me.body.data.points, 10);
    assert.equal(trustOf(helper.user.id), 5);
    const db = t.server.db;
    assert.equal(db.prepare('SELECT exact_lat FROM questions WHERE id = ?').get(q.id).exact_lat, null);
    assert.equal(db.prepare('SELECT amount, reason FROM point_transactions WHERE user_id = ?').get(helper.user.id).reason, 'answer_accepted');

    const list = await t.call('GET', '/notifications', { token: helper.token });
    assert.ok(list.body.data.some((n) => n.type === 'answer_accepted'));
    assert.ok(list.body.data.every((n) => n.exact_location === null), '問題解決後通知也要清除精確座標');
  });

  test('權限：非發問者、已採納、自己的回答都不能採納', async () => {
    const asker = await t.login();
    const helper = await t.login();
    const q = await ask(asker);
    const own = await answer(asker, q.id, '補充說明');
    const a = await answer(helper, q.id);
    const accept = (user, id) => t.call('POST', '/answers/{answer_id}/accept', { token: user.token, params: { answer_id: id } });

    assert.equal((await accept(helper, a.id)).status, 403);
    assert.equal((await accept(asker, own.id)).body.error.code, 'SELF_ACTION_NOT_ALLOWED');
    assert.equal((await accept(asker, a.id)).status, 200);
    assert.equal((await accept(asker, a.id)).body.error.code, 'ALREADY_ACCEPTED');
    const points = (await t.call('GET', '/me', { token: helper.token })).body.data.points;
    assert.equal(points, 10, '不可重複加分');
  });

  test('倒讚不回傳，但會影響排序和可信度；改票與收回都會正確回算', async () => {
    const asker = await t.login();
    const bad = await t.login();
    const good = await t.login();
    const voter = await t.login();
    const q = await ask(asker);
    const badAnswer = await answer(bad, q.id, '亂答');
    const goodAnswer = await answer(good, q.id, '好答案');
    const vote = (id, value) => t.call('PUT', '/answers/{answer_id}/vote', { token: voter.token, params: { answer_id: id }, body: { value } });

    const down = await vote(badAnswer.id, -1);
    assert.deepEqual(down.body.data, { upvotes: 0, my_vote: -1 });
    assert.doesNotMatch(down.raw, /downvote/);
    assert.equal(trustOf(bad.user.id), -2);

    const list = await t.call('GET', '/questions/{question_id}/answers', { token: asker.token, params: { question_id: q.id } });
    assert.deepEqual(list.body.data.map((a) => a.id), [goodAnswer.id, badAnswer.id]);
    assert.doesNotMatch(list.raw, /downvote|trust/);

    assert.deepEqual((await vote(badAnswer.id, -1)).body.data.my_vote, -1);
    assert.equal(trustOf(bad.user.id), -2, '重複投票不可重複扣分');
    assert.deepEqual((await vote(badAnswer.id, 1)).body.data, { upvotes: 1, my_vote: 1 });
    assert.equal(trustOf(bad.user.id), 1);
    const removed = await t.call('DELETE', '/answers/{answer_id}/vote', { token: voter.token, params: { answer_id: badAnswer.id } });
    assert.deepEqual(removed.body.data, { upvotes: 0, my_vote: null });
    assert.equal(trustOf(bad.user.id), 0);
  });

  test('可對自己的回答投正讚但不加可信度，不能投倒讚；值不正確回 400', async () => {
    const asker = await t.login();
    const helper = await t.login();
    const q = await ask(asker);
    const a = await answer(helper, q.id);
    const selfVote = (value) => t.call('PUT', '/answers/{answer_id}/vote', { token: helper.token, params: { answer_id: a.id }, body: { value } });
    assert.deepEqual((await selfVote(1)).body.data, { upvotes: 1, my_vote: 1 });
    assert.equal(trustOf(helper.user.id), 0);
    const down = await selfVote(-1);
    assert.equal(down.status, 403);
    assert.equal(down.body.error.code, 'SELF_ACTION_NOT_ALLOWED');
    const undo = await t.call('DELETE', '/answers/{answer_id}/vote', { token: helper.token, params: { answer_id: a.id } });
    assert.deepEqual(undo.body.data, { upvotes: 0, my_vote: null });
    assert.equal(trustOf(helper.user.id), 0);
    const invalid = await t.call('PUT', '/answers/{answer_id}/vote', { token: asker.token, params: { answer_id: a.id }, body: { value: 2 } });
    assert.equal(invalid.status, 400);
  });

  test('低可信度回答者排在後面', async () => {
    const asker = await t.login();
    const low = await t.login();
    const normal = await t.login();
    const q = await ask(asker);
    const lowAnswer = await answer(low, q.id, '先回答');
    const normalAnswer = await answer(normal, q.id, '後回答');
    t.server.db.prepare('UPDATE users SET trust_score = -11 WHERE id = ?').run(low.user.id);
    const list = await t.call('GET', '/questions/{question_id}/answers', { token: asker.token, params: { question_id: q.id } });
    assert.deepEqual(list.body.data.map((a) => a.id), [normalAnswer.id, lowAnswer.id]);
  });
});

describe('附近通知', () => {
  test('只通知範圍內、位置夠新、未關閉通知且可信度足夠的人', async () => {
    clearNearbyState();
    const asker = await t.login();
    const near = await t.login();
    const far = await t.login();
    const disabled = await t.login();
    const off = await t.login();
    const low = await t.login();
    const stale = await t.login();
    await beat(near, TAIPEI);
    await beat(far, { lat: 24.15, lng: 120.67 });
    await beat(disabled, TAIPEI);
    await t.call('PATCH', '/me', { token: disabled.token, body: { nearby_notifications_enabled: false } });
    await setLevel(off, 'off');
    await beat(low, TAIPEI);
    t.server.db.prepare('UPDATE users SET trust_score = -11 WHERE id = ?').run(low.user.id);
    await beat(stale, TAIPEI);
    t.server.db.prepare("UPDATE users SET location_updated_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(stale.user.id);

    const q = await ask(asker, { location_sharing: 'approximate', location: TAIPEI });
    const recipients = t.server.db.prepare("SELECT user_id FROM notifications WHERE question_id = ? AND type = 'nearby_question'").all(q.id).map((r) => r.user_id);
    assert.deepEqual(recipients, [near.user.id]);
  });

  test('每題最多通知最近的 20 人', async () => {
    clearNearbyState();
    const asker = await t.login();
    const users = [];
    for (let i = 0; i < 25; i++) {
      const u = await t.login();
      await beat(u, TAIPEI);
      users.push(u);
    }
    const q = await ask(asker, { location_sharing: 'approximate', location: TAIPEI });
    const { n } = t.server.db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE question_id = ?').get(q.id);
    assert.equal(n, 20);
  });

  test('每人 10 分鐘最多收到 1 則附近通知', async () => {
    clearNearbyState();
    const asker = await t.login();
    const helper = await t.login();
    await beat(helper, TAIPEI);
    await ask(asker, { location_sharing: 'approximate', location: TAIPEI });
    await ask(asker, { location_sharing: 'approximate', location: TAIPEI });
    const { n } = t.server.db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND type = 'nearby_question'").get(helper.user.id);
    assert.equal(n, 1);
  });

  test('走進問題範圍時由 heartbeat 收到通知，且同一題只通知一次', async () => {
    clearNearbyState();
    const asker = await t.login();
    const walker = await t.login();
    const q = await ask(asker, { location_sharing: 'approximate', location: TAIPEI });
    const away = await beat(walker, { lat: 24.15, lng: 120.67 });
    assert.equal(away.body.data.notifications.length, 0);
    const arrived = await beat(walker, TAIPEI);
    assert.deepEqual(arrived.body.data.notifications.map((n) => n.question_id), [q.id]);
    assert.match(arrived.body.data.notifications[0].body, /^問題：/);
    t.server.db.prepare('UPDATE users SET last_nearby_notified_at = NULL WHERE id = ?').run(walker.user.id);
    const again = await beat(walker, TAIPEI);
    assert.equal(again.body.data.notifications.length, 0);
  });
});

describe('通知列表', () => {
  test('未讀數、標記已讀與參數檢查', async () => {
    const asker = await t.login();
    const helper = await t.login();
    const q = await ask(asker);
    await answer(helper, q.id);
    await answer(helper, q.id, '第二則');
    const list = await t.call('GET', '/notifications', { token: asker.token, query: { unread_only: 'true', limit: '1' } });
    assert.equal(list.body.unread_count, 2);
    assert.equal(list.body.data.length, 1);
    assert.ok(list.body.next_cursor);
    const page2 = await t.call('GET', '/notifications', { token: asker.token, query: { unread_only: 'true', limit: '1', cursor: list.body.next_cursor } });
    assert.notEqual(page2.body.data[0].id, list.body.data[0].id);

    assert.equal((await t.call('POST', '/notifications/read', { token: asker.token, body: {} })).status, 400);
    assert.equal((await t.call('POST', '/notifications/read', { token: asker.token, body: { ids: [list.body.data[0].id] } })).status, 204);
    assert.equal((await t.call('GET', '/notifications', { token: asker.token })).body.unread_count, 1);
    assert.equal((await t.call('POST', '/notifications/read', { token: asker.token, body: { all: true } })).status, 204);
    assert.equal((await t.call('GET', '/notifications', { token: asker.token })).body.unread_count, 0);
  });

  test('不能把別人的通知標成已讀', async () => {
    const asker = await t.login();
    const helper = await t.login();
    const other = await t.login();
    const q = await ask(asker);
    await answer(helper, q.id);
    const id = (await t.call('GET', '/notifications', { token: asker.token })).body.data[0].id;
    await t.call('POST', '/notifications/read', { token: other.token, body: { ids: [id] } });
    assert.equal((await t.call('GET', '/notifications', { token: asker.token })).body.unread_count, 1);
  });
});

describe('媒體', () => {
  const upload = async (user, kind, bytes, type, extra = {}) => {
    const form = new FormData();
    form.set('kind', kind);
    for (const [k, v] of Object.entries(extra)) form.set(k, v);
    form.set('file', new Blob([bytes], { type }), 'upload.bin');
    return t.call('POST', '/media', { token: user.token, form });
  };
  const jpegWithExif = () => sharp({ create: { width: 40, height: 20, channels: 3, background: 'red' } })
    .withExif({ IFD0: { Copyright: 'secret-owner' } }).jpeg().toBuffer();

  test('上傳圖片時移除 EXIF，可公開下載', async () => {
    const user = await t.login();
    const input = await jpegWithExif();
    assert.ok((await sharp(input).metadata()).exif, '測試圖片本身要含 EXIF');
    const res = await upload(user, 'image', input, 'image/jpeg');
    assert.equal(res.status, 201, res.raw);
    const file = await fetch(res.body.data.url);
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('x-content-type-options'), 'nosniff');
    const output = Buffer.from(await file.arrayBuffer());
    assert.equal((await sharp(output).metadata()).exif, undefined);
    assert.equal(output.includes('secret-owner'), false);
  });

  test('假圖片、錯誤格式回 415，太大的檔案回 413', async () => {
    const user = await t.login();
    assert.equal((await upload(user, 'image', Buffer.from('not an image'), 'image/jpeg')).status, 415);
    assert.equal((await upload(user, 'image', Buffer.from('x'), 'text/html')).status, 415);
    assert.equal((await upload(user, 'audio', Buffer.from('x'), 'text/html', { duration_seconds: '3' })).status, 415);
    assert.equal((await upload(user, 'image', Buffer.alloc(11 * 1024 * 1024), 'image/jpeg')).status, 413);
    assert.equal((await upload(user, 'audio', Buffer.alloc(21 * 1024 * 1024), 'audio/mpeg', { duration_seconds: '3' })).status, 413);
  });

  test('語音要有合理長度', async () => {
    const user = await t.login();
    assert.equal((await upload(user, 'audio', Buffer.from('x'), 'audio/mpeg')).status, 400);
    assert.equal((await upload(user, 'audio', Buffer.from('x'), 'audio/mpeg', { duration_seconds: '181' })).status, 400);
    const ok = await upload(user, 'audio', Buffer.from('x'), 'audio/webm;codecs=opus', { duration_seconds: '3' });
    assert.equal(ok.status, 201, ok.raw);
    assert.equal(ok.body.data.duration_seconds, 3);
  });

  test('問題可附媒體；別人的或已使用的檔案不能再用，失敗時不留下問題', async () => {
    const owner = await t.login();
    const other = await t.login();
    const image = (await upload(owner, 'image', await jpegWithExif(), 'image/jpeg')).body.data;
    const audio = (await upload(owner, 'audio', Buffer.from('x'), 'audio/mpeg', { duration_seconds: '3' })).body.data;

    const stolen = await t.call('POST', '/questions', { token: other.token, body: t.question({ media_ids: [image.id] }) });
    assert.equal(stolen.status, 400);
    assert.equal((await t.call('GET', '/questions', { token: other.token, query: { author: 'me' } })).body.data.length, 0);

    const q = await ask(owner, { body: undefined, media_ids: [image.id, audio.id] });
    assert.equal(q.title, '圖片或語音問題');
    assert.equal(q.has_audio, true);
    assert.equal(q.thumbnail_url, image.url);
    assert.deepEqual(q.media.map((m) => m.id), [image.id, audio.id]);

    const reused = await t.call('POST', '/questions', { token: owner.token, body: t.question({ media_ids: [image.id] }) });
    assert.equal(reused.status, 400);
  });

  test('不存在的媒體回 404', async () => {
    const res = await fetch(`${t.baseUrl}/media/m_missing`);
    assert.equal(res.status, 404);
  });
});

describe('即時更新', () => {
  const connect = (token) => new Promise((resolve, reject) => {
    const socket = io(t.baseUrl, { auth: { token }, transports: ['websocket'], reconnection: false });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
  const emitAck = (socket, ...args) => new Promise((resolve) => socket.emit(...args, resolve));
  const waitFor = (socket, event) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等不到 ${event}`)), 2000);
    socket.once(event, (data) => { clearTimeout(timer); resolve(data ?? null); });
  });

  test('Socket.IO 沒有有效 token 會被拒絕', async () => {
    await assert.rejects(connect('bad-token'));
  });

  test('訊號只帶 ID，不帶內容，且只送給有訂閱的人', async () => {
    const asker = await t.login();
    const helper = await t.login();
    const watcher = await connect(helper.token);
    const bystander = await connect((await t.login()).token);
    try {
      await emitAck(watcher, 'feed:subscribe');
      const feed = waitFor(watcher, 'feed.changed');
      const q = await ask(asker, { body: '機密內容' });
      assert.equal(await feed, null);

      await emitAck(watcher, 'question:subscribe', { question_id: q.id });
      let bystanderGot = false;
      bystander.on('answers.changed', () => { bystanderGot = true; });
      const answers = waitFor(watcher, 'answers.changed');
      const changed = waitFor(watcher, 'question.changed');
      await answer(helper, q.id, '機密回答');
      assert.deepEqual(await answers, { question_id: q.id });
      assert.deepEqual(await changed, { question_id: q.id });
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(bystanderGot, false);

      await emitAck(watcher, 'question:unsubscribe', { question_id: q.id });
      let afterLeave = false;
      watcher.on('answers.changed', () => { afterLeave = true; });
      await answer(helper, q.id, '再一則');
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(afterLeave, false);
    } finally {
      watcher.disconnect();
      bystander.disconnect();
    }
  });

  async function openStream(token) {
    const controller = new AbortController();
    const res = await fetch(`${t.baseUrl}/api/v1/notifications/stream`, {
      headers: { Authorization: `Bearer ${token}` }, signal: controller.signal,
    });
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    return {
      res,
      async nextEvent() {
        const deadline = Date.now() + 2000;
        while (!buffer.includes('event: notification.created')) {
          const { value, done } = await Promise.race([
            reader.read(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('等不到 SSE 事件')), Math.max(deadline - Date.now(), 1))),
          ]);
          if (done) throw new Error('串流已結束');
          buffer += value;
        }
        const start = buffer.indexOf('event: notification.created');
        const end = buffer.indexOf('\n\n', start);
        const data = buffer.slice(start, end).split('\n').find((l) => l.startsWith('data: ')).slice(6);
        buffer = buffer.slice(end + 2);
        return JSON.parse(data);
      },
      close: () => controller.abort(),
    };
  }

  test('SSE 需要 token，並即時送出通知；已送達的通知 heartbeat 不重複回傳', async () => {
    const asker = await t.login();
    const helper = await t.login();
    assert.equal((await fetch(`${t.baseUrl}/api/v1/notifications/stream`)).status, 401);

    const stream = await openStream(asker.token);
    try {
      assert.equal(stream.res.headers.get('content-type'), 'text/event-stream');
      const q = await ask(asker);
      await answer(helper, q.id);
      const event = await stream.nextEvent();
      assert.equal(event.type, 'new_answer');
      assert.equal(event.question_id, q.id);
      const hb = await beat(asker);
      assert.equal(hb.body.data.notifications.length, 0);
    } finally {
      stream.close();
    }
  });

  test('未連線時的通知，重新連上 SSE 會補送，heartbeat 也只送一次', async () => {
    const asker = await t.login();
    const helper = await t.login();
    const q = await ask(asker);
    await answer(helper, q.id);
    const stream = await openStream(asker.token);
    try {
      assert.equal((await stream.nextEvent()).type, 'new_answer');
    } finally {
      stream.close();
    }

    const other = await t.login();
    const q2 = await ask(other);
    await answer(helper, q2.id);
    const first = await beat(other);
    assert.equal(first.body.data.notifications.length, 1);
    assert.equal((await beat(other)).body.data.notifications.length, 0);
  });

  test('SSE 連線中斷後，通知改由 heartbeat 取得', async () => {
    const asker = await t.login();
    const helper = await t.login();
    const stream = await openStream(asker.token);
    stream.close();
    await new Promise((r) => setTimeout(r, 100));
    const q = await ask(asker);
    await answer(helper, q.id);
    assert.equal((await beat(asker)).body.data.notifications.length, 1);
  });
});

describe('錯誤處理', () => {
  test('不存在的資源與格式錯誤的 JSON', async () => {
    const user = await t.login();
    assert.equal((await t.call('GET', '/questions/{question_id}', { token: user.token, params: { question_id: 'q_none' } })).status, 404);
    const res = await fetch(`${t.baseUrl}/api/v1/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'VALIDATION_ERROR');
    assert.equal((await t.call('GET', '/questions', { token: user.token, query: { cursor: '!!!' } })).status, 400);
  });
});

describe('現場協助', () => {
  const claim = (user, id, location = TAIPEI) => t.call('POST', '/questions/{question_id}/assist', {
    token: user.token, params: { question_id: id }, body: { location },
  });
  const getAssist = (user, id) => t.call('GET', '/questions/{question_id}/assist', { token: user.token, params: { question_id: id } });
  const step = (user, action, id, body) => t.call('POST', `/assists/{assist_id}/${action}`, { token: user.token, params: { assist_id: id }, body });
  const onsite = (user, level = 'approximate') => ask(user, { location_sharing: level, assistance_mode: 'onsite', location: TAIPEI });
  const detail = (user, id) => t.call('GET', '/questions/{question_id}', { token: user.token, params: { question_id: id } });

  test('完整流程：精確位置只給雙方，完成後清除並加分發徽章', async () => {
    const asker = await t.login();
    const helper = await t.login();
    const bystander = await t.login();
    const q = await onsite(asker);
    assert.equal((await detail(helper, q.id)).body.data.can_claim, true);
    assert.equal(q.can_claim, false, '不能接自己的任務');

    const claimed = await claim(helper, q.id);
    assert.equal(claimed.status, 201, claimed.raw);
    assert.deepEqual(claimed.body.data.exact_location, TAIPEI);
    assert.deepEqual((await getAssist(asker, q.id)).body.data.exact_location, TAIPEI);
    assert.equal((await getAssist(bystander, q.id)).status, 403);

    const publicView = await detail(bystander, q.id);
    assert.equal(publicView.body.data.status, 'in_progress');
    assert.equal(publicView.body.data.assist_status, 'claimed');
    assert.equal(publicView.body.data.can_claim, false);
    assert.equal(publicView.raw.includes(String(TAIPEI.lat)), false);

    const id = claimed.body.data.id;
    assert.equal((await step(asker, 'arrive', id)).status, 403);
    assert.equal((await step(helper, 'arrive', id)).body.data.status, 'arrived');
    assert.equal((await step(helper, 'arrive', id)).body.error.code, 'INVALID_STATE');
    assert.equal((await step(helper, 'complete', id)).status, 403);

    const done = await step(asker, 'complete', id);
    assert.equal(done.body.data.status, 'completed');
    assert.equal(done.body.data.exact_location, null);
    assert.equal(t.server.db.prepare('SELECT exact_lat FROM questions WHERE id = ?').get(q.id).exact_lat, null);
    assert.equal((await detail(asker, q.id)).body.data.status, 'resolved');
    assert.equal((await t.call('GET', '/me', { token: helper.token })).body.data.points, 30);
    assert.equal(trustOf(helper.user.id), 10);
    assert.equal((await step(asker, 'complete', id)).status, 409, '不可重複加分');

    const types = (await t.call('GET', '/notifications', { token: helper.token })).body.data.map((n) => n.type);
    assert.ok(types.includes('assist_completed'));
    assert.ok(types.includes('badge_earned'));
    assert.equal((await getAssist(helper, q.id)).body.data.status, 'completed');
    assert.equal((await getAssist(bystander, q.id)).status, 404);
  });

  test('接案限制：自己、已被接、線上問題、太遠、位置關閉、低可信度', async () => {
    const asker = await t.login();
    const first = await t.login();
    const second = await t.login();
    const online = await ask(asker);
    assert.equal((await claim(first, online.id)).body.error.code, 'INVALID_STATE');

    const q = await onsite(asker);
    assert.equal((await claim(asker, q.id)).body.error.code, 'SELF_ACTION_NOT_ALLOWED');
    assert.equal((await claim(first, q.id, { lat: 24.15, lng: 120.67 })).body.error.code, 'TOO_FAR');
    assert.equal((await claim(first, q.id)).status, 201);
    assert.equal((await claim(second, q.id)).body.error.code, 'ASSIST_ALREADY_CLAIMED');

    const another = await onsite(asker);
    await setLevel(second, 'off');
    assert.equal((await claim(second, another.id)).body.error.code, 'LOCATION_SHARING_OFF');
    const low = await t.login();
    t.server.db.prepare('UPDATE users SET trust_score = -11 WHERE id = ?').run(low.user.id);
    const blocked = await claim(low, another.id);
    assert.equal(blocked.body.error.code, 'ASSIST_NOT_ALLOWED');
    assert.doesNotMatch(blocked.raw, /trust|評分|-11/);
    assert.equal((await detail(low, another.id)).body.data.can_claim, false);
  });

  test('取消後回到 open，舊接案者失去精確位置，其他人可接', async () => {
    const asker = await t.login();
    const helper = await t.login();
    const next = await t.login();
    const q = await onsite(asker);
    const id = (await claim(helper, q.id)).body.data.id;
    assert.equal((await step(next, 'cancel', id, {})).status, 403);
    const cancelled = await step(helper, 'cancel', id, { reason: '臨時有事' });
    assert.equal(cancelled.body.data.status, 'cancelled');
    assert.equal(cancelled.body.data.cancelled_by, 'helper');
    assert.equal(cancelled.body.data.exact_location, null);
    assert.equal((await detail(asker, q.id)).body.data.status, 'open');
    assert.equal((await detail(asker, q.id)).body.data.assist_status, null);
    assert.equal((await getAssist(helper, q.id)).body.data.exact_location, null);

    assert.equal((await claim(next, q.id)).status, 201);
    assert.equal((await getAssist(helper, q.id)).body.data.status, 'cancelled', '舊接案者只能看到自己那筆');
    assert.deepEqual((await getAssist(next, q.id)).body.data.exact_location, TAIPEI);
    const types = (await t.call('GET', '/notifications', { token: asker.token })).body.data.map((n) => n.type);
    assert.ok(types.includes('assist_cancelled'));
  });

  test('進行中不能採納回答，完成後也不能再採納', async () => {
    const asker = await t.login();
    const helper = await t.login();
    const q = await ask(asker, { location_sharing: 'approximate', assistance_mode: 'either', location: TAIPEI });
    const a = await answer(helper, q.id);
    const id = (await claim(helper, q.id)).body.data.id;
    const accept = () => t.call('POST', '/answers/{answer_id}/accept', { token: asker.token, params: { answer_id: a.id } });
    assert.equal((await accept()).body.error.code, 'ASSIST_ACTIVE');
    await step(asker, 'complete', id);
    assert.equal((await accept()).body.error.code, 'INVALID_STATE');
  });

  test('現場協助進行中不能標記已解決', async () => {
    const asker = await t.login();
    const helper = await t.login();
    const q = await onsite(asker);
    await claim(helper, q.id);
    const res = await t.call('POST', '/questions/{question_id}/resolve', { token: asker.token, params: { question_id: q.id } });
    assert.equal(res.body.error.code, 'ASSIST_ACTIVE');
  });

  test('assist.changed 訊號只送給雙方', async () => {
    const asker = await t.login();
    const helper = await t.login();
    const other = await t.login();
    const connect = (token) => new Promise((resolve, reject) => {
      const socket = io(t.baseUrl, { auth: { token }, transports: ['websocket'], reconnection: false });
      socket.once('connect', () => resolve(socket));
      socket.once('connect_error', reject);
    });
    const askerSocket = await connect(asker.token);
    const otherSocket = await connect(other.token);
    try {
      const q = await onsite(asker);
      let otherGot = false;
      otherSocket.on('assist.changed', () => { otherGot = true; });
      const signal = new Promise((resolve) => askerSocket.once('assist.changed', resolve));
      await claim(helper, q.id);
      assert.deepEqual(await signal, { question_id: q.id });
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(otherGot, false);
    } finally {
      askerSocket.disconnect();
      otherSocket.disconnect();
    }
  });
});

describe('個資標記', () => {
  const report = (user, body) => t.call('POST', '/pii-reports', { token: user.token, body });
  const decide = (user, action, id) => t.call('POST', `/pii-reports/{report_id}/${action}`, { token: user.token, params: { report_id: id } });
  const detail = (user, id) => t.call('GET', '/questions/{question_id}', { token: user.token, params: { question_id: id } });
  const uploadImage = async (user) => {
    const bytes = await sharp({ create: { width: 100, height: 100, channels: 3, background: '#ffffff' } }).jpeg().toBuffer();
    const form = new FormData();
    form.set('kind', 'image');
    form.set('file', new Blob([bytes], { type: 'image/jpeg' }), 'a.jpg');
    return (await t.call('POST', '/media', { token: user.token, form })).body.data;
  };
  const pixel = async (url, x, y) => {
    const buffer = Buffer.from(await (await fetch(url)).arrayBuffer());
    const { data } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
    return data[(y * 100 + x) * 3];
  };

  test('文字：待確認時對他人隱藏，通知也不留標題；deny 後恢復', async () => {
    const asker = await t.login();
    const reporter = await t.login();
    const helper = await t.login();
    const q = await ask(asker, { body: '我的電話是0912345678請幫忙' });
    await answer(helper, q.id, '第一則回答');
    const helperNotified = t.server.db.prepare("SELECT body FROM notifications WHERE user_id = ? AND question_id = ?");
    assert.match(helperNotified.get(asker.user.id, q.id).body, /0912345678/);

    const created = await report(reporter, { target_type: 'question', target_id: q.id, text_ranges: [{ start: 5, end: 15 }] });
    assert.equal(created.status, 201, created.raw);
    assert.equal(created.body.data.status, 'pending');
    assert.doesNotMatch(helperNotified.get(asker.user.id, q.id).body, /0912345678/, '舊通知也要清掉');

    const other = await detail(helper, q.id);
    assert.equal(other.body.data.body, null);
    assert.equal(other.body.data.title, null);
    assert.deepEqual(other.body.data.hidden_parts, [{ part: 'body', reason: 'pii_pending' }]);
    assert.doesNotMatch(other.raw, /0912345678/);
    const list = await t.call('GET', '/questions', { token: helper.token, query: { author: 'me' } });
    assert.doesNotMatch(list.raw, /0912345678/);
    const feed = await t.call('GET', '/questions', { token: helper.token });
    assert.doesNotMatch(feed.raw, /0912345678/);

    await answer(helper, q.id, '第二則回答');
    const newest = t.server.db.prepare("SELECT body FROM notifications WHERE user_id = ? AND question_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(asker.user.id, q.id);
    assert.doesNotMatch(newest.body, /0912345678/, '待確認期間的新通知不可帶標題');

    assert.equal((await detail(asker, q.id)).body.data.body, '我的電話是0912345678請幫忙');

    const pending = await t.call('GET', '/me/pii-reports', { token: asker.token, query: { status: 'pending' } });
    assert.equal(pending.body.data.length, 1);
    assert.equal(pending.body.data[0].original_text, '我的電話是0912345678請幫忙');
    assert.doesNotMatch(pending.raw, new RegExp(reporter.user.id), '不透露是誰標記的');
    assert.equal((await t.call('GET', '/me/pii-reports', { token: reporter.token })).body.data.length, 0);

    assert.equal((await decide(reporter, 'deny', created.body.data.id)).status, 403);
    const denied = await decide(asker, 'deny', created.body.data.id);
    assert.equal(denied.body.data.status, 'denied');
    assert.equal(denied.body.data.original_text, null);
    assert.equal((await detail(helper, q.id)).body.data.body, '我的電話是0912345678請幫忙');
    assert.equal((await decide(asker, 'accept', created.body.data.id)).status, 409);
  });

  test('文字：accept 後逐字遮蔽，兩筆標記都正確，標題同步更新', async () => {
    const asker = await t.login();
    const reporter = await t.login();
    const q = await ask(asker, { body: '姓名王小明電話0912請問' });
    const first = await report(reporter, { target_type: 'question', target_id: q.id, text_ranges: [{ start: 2, end: 5 }] });
    const second = await report(reporter, { target_type: 'question', target_id: q.id, text_ranges: [{ start: 7, end: 11 }] });
    await decide(asker, 'accept', first.body.data.id);
    assert.equal((await detail(reporter, q.id)).body.data.body, null, '還有待確認的標記，仍要隱藏');
    await decide(asker, 'accept', second.body.data.id);
    const shown = await detail(reporter, q.id);
    assert.equal(shown.body.data.body, '姓名███電話████請問');
    assert.equal(shown.body.data.title, '姓名███電話████請問');
    assert.deepEqual(shown.body.data.hidden_parts, []);
    assert.equal(shown.raw.includes('王小明'), false);
    assert.equal(t.server.db.prepare('SELECT body FROM questions WHERE id = ?').get(q.id).body.includes('王小明'), false);
    const types = (await t.call('GET', '/notifications', { token: reporter.token })).body.data.map((n) => n.type);
    assert.ok(types.includes('pii_report_resolved'));
  });

  test('自訂標題可單獨標記，發問者自己標記立即生效', async () => {
    const asker = await t.login();
    const viewer = await t.login();
    const q = await ask(asker, { title: '王小明的問題', body: '內容' });
    const res = await report(asker, { target_type: 'question', target_id: q.id, text_field: 'title', text_ranges: [{ start: 0, end: 3 }] });
    assert.equal(res.body.data.status, 'accepted');
    const shown = await detail(viewer, q.id);
    assert.equal(shown.body.data.title, '███的問題');
    assert.equal(shown.body.data.body, '內容');
  });

  test('回答的個資也由發問者決定，回答者看得到自己的內容', async () => {
    const asker = await t.login();
    const helper = await t.login();
    const reporter = await t.login();
    const q = await ask(asker);
    const a = await answer(helper, q.id, '請打給0912');
    const created = await report(reporter, { target_type: 'answer', target_id: a.id, text_ranges: [{ start: 3, end: 7 }] });
    const listFor = async (user) => (await t.call('GET', '/questions/{question_id}/answers', { token: user.token, params: { question_id: q.id } })).body.data[0];
    assert.equal((await listFor(reporter)).body, null);
    assert.equal((await listFor(helper)).body, '請打給0912');
    assert.equal((await listFor(asker)).body, '請打給0912');
    assert.equal((await decide(helper, 'accept', created.body.data.id)).status, 403);
    assert.equal((await decide(asker, 'accept', created.body.data.id)).status, 200);
    assert.equal((await listFor(reporter)).body, '請打給████');
  });

  test('圖片：待確認時公開網址失效，只有有效簽章可看；accept 後色塊寫入新檔，舊檔刪除', async () => {
    const asker = await t.login();
    const reporter = await t.login();
    const image = await uploadImage(asker);
    const q = await ask(asker, { media_ids: [image.id] });
    const created = await report(reporter, { target_type: 'question', target_id: q.id, media_id: image.id, regions: [{ x: 0, y: 0, w: 0.5, h: 0.5 }] });
    assert.equal((await fetch(image.url)).status, 404);

    const other = await detail(reporter, q.id);
    assert.deepEqual(other.body.data.media, []);
    assert.equal(other.body.data.thumbnail_url, null);
    assert.deepEqual(other.body.data.hidden_parts, [{ part: 'media', media_id: image.id, reason: 'pii_pending' }]);
    const own = await detail(asker, q.id);
    assert.equal((await fetch(own.body.data.media[0].url)).status, 200);

    const preview = (await t.call('GET', '/me/pii-reports', { token: asker.token, query: { status: 'pending' } })).body.data[0].preview_url;
    assert.equal((await fetch(preview)).status, 200);
    assert.equal((await fetch(preview.replace(/sig=.*/, 'sig=forged'))).status, 404);
    assert.equal((await fetch(preview.replace(/exp=\d+/, 'exp=9999999999999'))).status, 404, '改到期時間會讓簽章失效');

    const accepted = await decide(asker, 'accept', created.body.data.id);
    assert.equal(accepted.status, 200, accepted.raw);
    assert.equal((await fetch(image.url)).status, 404, '舊網址要失效');
    const shown = await detail(reporter, q.id);
    assert.notEqual(shown.body.data.media[0].id, image.id);
    const url = shown.body.data.media[0].url;
    assert.ok((await pixel(url, 10, 10)) < 30, '區域內應為黑色');
    assert.ok((await pixel(url, 90, 90)) > 220, '區域外應保持原樣');
    const files = fs.readdirSync(path.join(t.server.config.dataDir, 'media'));
    assert.equal(files.some((f) => f.startsWith(image.id)), false, '原檔要刪除');
  });

  test('圖片：同時同意兩筆標記，兩塊遮蔽都要留下', async () => {
    const asker = await t.login();
    const reporter = await t.login();
    const image = await uploadImage(asker);
    const q = await ask(asker, { media_ids: [image.id] });
    const a = await report(reporter, { target_type: 'question', target_id: q.id, media_id: image.id, regions: [{ x: 0, y: 0, w: 0.2, h: 0.2 }] });
    const b = await report(reporter, { target_type: 'question', target_id: q.id, media_id: image.id, regions: [{ x: 0.8, y: 0.8, w: 0.2, h: 0.2 }] });
    const results = await Promise.all([decide(asker, 'accept', a.body.data.id), decide(asker, 'accept', b.body.data.id)]);
    assert.deepEqual(results.map((r) => r.status), [200, 200], results.map((r) => r.raw).join());
    const url = (await detail(reporter, q.id)).body.data.media[0].url;
    assert.ok((await pixel(url, 5, 5)) < 30);
    assert.ok((await pixel(url, 95, 95)) < 30);
    assert.ok((await pixel(url, 50, 50)) > 220);
  });

  test('語音：accept 後整段移除', async () => {
    const asker = await t.login();
    const reporter = await t.login();
    const form = new FormData();
    form.set('kind', 'audio');
    form.set('duration_seconds', '3');
    form.set('file', new Blob([Buffer.from('x')], { type: 'audio/mpeg' }), 'a.mp3');
    const audio = (await t.call('POST', '/media', { token: asker.token, form })).body.data;
    const q = await ask(asker, { media_ids: [audio.id] });
    assert.equal(q.has_audio, true);
    const created = await report(reporter, { target_type: 'question', target_id: q.id, media_id: audio.id });
    assert.equal((await detail(reporter, q.id)).body.data.has_audio, false);
    assert.equal((await decide(asker, 'accept', created.body.data.id)).status, 200);
    assert.equal((await fetch(audio.url)).status, 404);
    assert.deepEqual((await detail(asker, q.id)).body.data.media, []);
  });

  test('參數檢查與頻率限制', async () => {
    const asker = await t.login();
    const reporter = await t.login();
    const q = await ask(asker, { body: '短' });
    const other = await uploadImage(asker);
    const base = { target_type: 'question', target_id: q.id };
    assert.equal((await report(reporter, base)).status, 400);
    assert.equal((await report(reporter, { ...base, text_ranges: [{ start: 0, end: 99 }] })).status, 400);
    assert.equal((await report(reporter, { ...base, media_id: other.id, regions: [{ x: 0, y: 0, w: 1, h: 1 }] })).status, 400);
    assert.equal((await report(reporter, { target_type: 'question', target_id: 'q_none', text_ranges: [{ start: 0, end: 1 }] })).status, 404);

    const limited = await startTestServer({ piiReportsPerHour: 1 });
    try {
      const a = await limited.login();
      const r = await limited.login();
      const created = await limited.call('POST', '/questions', { token: a.token, body: limited.question() });
      const body = { target_type: 'question', target_id: created.body.data.id, text_ranges: [{ start: 0, end: 1 }] };
      assert.equal((await limited.call('POST', '/pii-reports', { token: r.token, body })).status, 201);
      assert.equal((await limited.call('POST', '/pii-reports', { token: r.token, body })).body.error.code, 'RATE_LIMITED');
    } finally {
      await limited.stop();
    }
  });
});

describe('獎勵', () => {
  test('採納後解鎖徽章，積分紀錄、公開個人頁與分享頁都正確', async () => {
    const asker = await t.login();
    const res = await t.call('POST', '/sessions', { body: { townpass_user_id: 'badge-user', nickname: '<script>alert(1)</script>' } });
    const helper = { token: res.body.data.token, user: res.body.data.user };
    const before = await t.call('GET', '/badges', { token: helper.token });
    assert.ok(before.body.data.every((b) => !b.earned && b.share_url === null));

    const q = await ask(asker);
    const a = await answer(helper, q.id);
    await t.call('POST', '/answers/{answer_id}/accept', { token: asker.token, params: { answer_id: a.id } });

    const badge = (await t.call('GET', '/badges', { token: helper.token })).body.data.find((b) => b.earned);
    assert.equal(badge.id, 'first-accepted');
    const image = await fetch(badge.image_url);
    assert.equal(image.headers.get('content-type').split(';')[0], 'image/svg+xml');

    const share = await fetch(badge.share_url);
    assert.equal(share.status, 200);
    const html = await share.text();
    assert.equal(html.includes('<script>alert'), false, '暱稱要跳脫');
    assert.match(html, /og:title/);
    assert.equal((await fetch(badge.share_url.replace('first-accepted', 'onsite-5'))).status, 404, '沒拿到的徽章不能分享');

    const profile = await t.call('GET', '/users/{user_id}', { params: { user_id: helper.user.id } });
    assert.equal(profile.body.data.accepted_answer_count, 1);
    assert.equal(profile.body.data.badges.length, 1);
    assert.doesNotMatch(profile.raw, /trust|townpass/);
    assert.equal((await t.call('GET', '/users/{user_id}', { params: { user_id: 'u_none' } })).status, 404);

    const ledger = await t.call('GET', '/me/point-transactions', { token: helper.token });
    assert.deepEqual(ledger.body.data.map((p) => [p.amount, p.reason, p.question_id]), [[10, 'answer_accepted', q.id]]);
  });
});

describe('刪除', () => {
  const detail = (user, id) => t.call('GET', '/questions/{question_id}', { token: user.token, params: { question_id: id } });
  const uploadImage = async (user) => {
    const bytes = await sharp({ create: { width: 10, height: 10, channels: 3, background: 'red' } }).jpeg().toBuffer();
    const form = new FormData();
    form.set('kind', 'image');
    form.set('file', new Blob([bytes], { type: 'image/jpeg' }), 'a.jpg');
    return (await t.call('POST', '/media', { token: user.token, form })).body.data;
  };

  test('刪除回答：只能刪自己的、已採納不可刪、媒體一併刪除，可信度不回補', async () => {
    const asker = await t.login();
    const helper = await t.login();
    const voter = await t.login();
    const q = await ask(asker);
    const image = await uploadImage(helper);
    const res = await t.call('POST', '/questions/{question_id}/answers', {
      token: helper.token, params: { question_id: q.id }, body: { body: '亂答', media_ids: [image.id] },
    });
    const a = res.body.data;
    await t.call('PUT', '/answers/{answer_id}/vote', { token: voter.token, params: { answer_id: a.id }, body: { value: -1 } });
    const remove = (user, id) => t.call('DELETE', '/answers/{answer_id}', { token: user.token, params: { answer_id: id } });
    assert.equal((await remove(voter, a.id)).status, 403);
    assert.equal((await remove(helper, a.id)).status, 204);
    assert.equal((await remove(helper, a.id)).status, 404);
    assert.equal((await detail(asker, q.id)).body.data.answer_count, 0);
    assert.equal((await fetch(image.url)).status, 404);
    assert.equal(trustOf(helper.user.id), -2);

    const kept = await answer(helper, q.id, '好答案');
    await t.call('POST', '/answers/{answer_id}/accept', { token: asker.token, params: { answer_id: kept.id } });
    assert.equal((await remove(helper, kept.id)).body.error.code, 'ANSWER_ACCEPTED');
  });

  test('撤回問題：只有發問者可撤回，內容、媒體和座標都刪除，進行中的任務通知接案者', async () => {
    const asker = await t.login();
    const helper = await t.login();
    const image = await uploadImage(asker);
    const q = await ask(asker, { location_sharing: 'approximate', assistance_mode: 'onsite', location: TAIPEI, media_ids: [image.id] });
    await answer(helper, q.id);
    await t.call('PUT', '/answers/{answer_id}/vote', {
      token: asker.token, params: { answer_id: (await t.call('GET', '/questions/{question_id}/answers', { token: asker.token, params: { question_id: q.id } })).body.data[0].id }, body: { value: 1 },
    });
    await t.call('POST', '/questions/{question_id}/assist', { token: helper.token, params: { question_id: q.id }, body: { location: TAIPEI } });
    await t.call('POST', '/pii-reports', { token: helper.token, body: { target_type: 'question', target_id: q.id, text_ranges: [{ start: 0, end: 1 }] } });

    const remove = (user) => t.call('DELETE', '/questions/{question_id}', { token: user.token, params: { question_id: q.id } });
    assert.equal((await remove(helper)).status, 403);
    assert.equal((await remove(asker)).status, 204);
    assert.equal((await detail(asker, q.id)).status, 404);
    assert.equal((await fetch(image.url)).status, 404);
    assert.equal(t.server.db.prepare('SELECT COUNT(*) AS n FROM assists WHERE question_id = ?').get(q.id).n, 0);
    const list = (await t.call('GET', '/notifications', { token: helper.token })).body.data;
    assert.ok(list.some((n) => n.type === 'assist_cancelled'));
  });
});

describe('問題分類', () => {
  const categorize = (user, id, category) => t.call('PUT', '/questions/{question_id}/category', {
    token: user.token, params: { question_id: id }, body: { category },
  });

  test('分類器沒有把握時為 uncategorized，meta 也列出這個分類', async () => {
    const user = await t.login();
    const body = t.question({ body: '🤔🤔🤔' });
    delete body.category;
    const res = await t.call('POST', '/questions', { token: user.token, body });
    assert.equal(res.status, 201, res.raw);
    assert.equal(res.body.data.category, 'uncategorized');
    const meta = await t.call('GET', '/meta');
    assert.ok(meta.body.data.categories.some((c) => c.id === 'uncategorized'));
    assert.equal((await t.call('POST', '/questions', { token: user.token, body: t.question({ category: 'nope' }) })).status, 400);
  });

  test('志工可分類未分類的問題，但不能改已分類的；可篩選待分類問題', async () => {
    const asker = await t.login();
    const volunteer = await t.login();
    const body = t.question({ body: '🤔🤔🤔' });
    delete body.category;
    const q = (await t.call('POST', '/questions', { token: asker.token, body })).body.data;

    const listed = await t.call('GET', '/questions', { token: volunteer.token, query: { category: 'uncategorized' } });
    assert.ok(listed.body.data.some((x) => x.id === q.id));

    assert.equal((await categorize(volunteer, q.id, 'uncategorized')).status, 400);
    const done = await categorize(volunteer, q.id, 'scam_check');
    assert.equal(done.status, 200, done.raw);
    assert.equal(done.body.data.category, 'scam_check');
    assert.equal((await t.call('GET', '/me', { token: volunteer.token })).body.data.points, 0);

    const changed = await categorize(await t.login(), q.id, 'other');
    assert.equal(changed.status, 409);
    assert.equal(changed.body.error.code, 'INVALID_STATE');
    assert.equal((await categorize(asker, q.id, 'other')).body.data.category, 'other', '發問者可以修改');
    assert.equal((await categorize(volunteer, 'q_none', 'other')).status, 404);
  });

  test('低可信度帳號不能分類，且分類會發出更新訊號', async () => {
    const asker = await t.login();
    const low = await t.login();
    const volunteer = await t.login();
    const body = t.question({ body: '🤔🤔🤔' });
    delete body.category;
    const q = (await t.call('POST', '/questions', { token: asker.token, body })).body.data;
    t.server.db.prepare('UPDATE users SET trust_score = -11 WHERE id = ?').run(low.user.id);
    assert.equal((await categorize(low, q.id, 'other')).status, 403);

    const socket = await new Promise((resolve, reject) => {
      const s = io(t.baseUrl, { auth: { token: asker.token }, transports: ['websocket'], reconnection: false });
      s.once('connect', () => resolve(s));
      s.once('connect_error', reject);
    });
    try {
      await new Promise((resolve) => socket.emit('question:subscribe', { question_id: q.id }, resolve));
      const signal = new Promise((resolve) => socket.once('question.changed', resolve));
      await categorize(volunteer, q.id, 'other');
      assert.deepEqual(await signal, { question_id: q.id });
    } finally {
      socket.disconnect();
    }
  });
});

describe('已解決與回答解耦', () => {
  const resolve = (user, id) => t.call('POST', '/questions/{question_id}/resolve', { token: user.token, params: { question_id: id } });
  const detail = (user, id) => t.call('GET', '/questions/{question_id}', { token: user.token, params: { question_id: id } });

  test('發問者不留言、沒有回答也能標記已解決，且不發積分', async () => {
    const asker = await t.login();
    const other = await t.login();
    const q = await ask(asker);
    assert.equal((await resolve(other, q.id)).status, 403);
    const res = await resolve(asker, q.id);
    assert.equal(res.status, 200, res.raw);
    assert.equal(res.body.data.status, 'resolved');
    assert.equal(res.body.data.answer_count, 0);
    assert.equal(res.body.data.accepted_answer_id, null);
    assert.equal((await t.call('GET', '/me', { token: asker.token })).body.data.points, 0);
    assert.equal((await resolve(asker, q.id)).body.error.code, 'INVALID_STATE');
    assert.equal((await t.call('POST', '/questions/{question_id}/resolve', { token: asker.token, params: { question_id: 'q_none' } })).status, 404);
  });

  test('標記已解決會清除精確座標，並發出更新訊號', async () => {
    clearNearbyState();
    const helper = await t.login();
    await beat(helper, TAIPEI);
    const asker = await t.login();
    const q = await ask(asker, { location_sharing: 'exact', location: TAIPEI });
    const socket = await new Promise((done, fail) => {
      const s = io(t.baseUrl, { auth: { token: helper.token }, transports: ['websocket'], reconnection: false });
      s.once('connect', () => done(s));
      s.once('connect_error', fail);
    });
    try {
      await new Promise((done) => socket.emit('question:subscribe', { question_id: q.id }, done));
      const signal = new Promise((done) => socket.once('question.changed', done));
      await resolve(asker, q.id);
      assert.deepEqual(await signal, { question_id: q.id });
    } finally {
      socket.disconnect();
    }
    assert.equal(t.server.db.prepare('SELECT exact_lat FROM questions WHERE id = ?').get(q.id).exact_lat, null);
    const list = await t.call('GET', '/notifications', { token: helper.token });
    assert.ok(list.body.data.every((n) => n.exact_location === null));
  });

  test('未參與的人可以按讚，問題解決後仍可回答、按讚和採納', async () => {
    const asker = await t.login();
    const helper = await t.login();
    const browser = await t.login();
    const q = await ask(asker);
    const a = await answer(helper, q.id);
    await resolve(asker, q.id);

    const vote = await t.call('PUT', '/answers/{answer_id}/vote', { token: browser.token, params: { answer_id: a.id }, body: { value: 1 } });
    assert.deepEqual(vote.body.data, { upvotes: 1, my_vote: 1 });
    assert.equal(trustOf(helper.user.id), 1);
    await answer(browser, q.id, '問題解決後的補充');
    assert.equal((await detail(asker, q.id)).body.data.answer_count, 2);

    const accepted = await t.call('POST', '/answers/{answer_id}/accept', { token: asker.token, params: { answer_id: a.id } });
    assert.equal(accepted.status, 200, accepted.raw);
    assert.equal((await t.call('GET', '/me', { token: helper.token })).body.data.points, 10);
    assert.equal((await detail(asker, q.id)).body.data.status, 'resolved');
    const again = await t.call('POST', '/answers/{answer_id}/accept', { token: asker.token, params: { answer_id: a.id } });
    assert.equal(again.body.error.code, 'ALREADY_ACCEPTED');
  });
});

describe('問題分類器', () => {
  const classify = (text) => t.call('POST', '/classify', { body: { text } });

  test('明顯的問題會自動分類，且不需要 token', async () => {
    assert.equal((await classify('有人打電話說我涉及洗錢要我匯款到安全帳戶')).body.data.category, 'scam_check');
    assert.equal((await classify('我要去市政府要坐哪一路公車')).body.data.category, 'map_navigation');
    const res = await classify('敬老卡要去哪裡申請');
    assert.equal(res.body.data.category, 'admin_procedure');
    assert.equal(res.body.data.scores.length, 7);
    assert.ok(Math.abs(res.body.data.scores.reduce((a, s) => a + s.score, 0) - 1) < 0.01);
  });

  test('沒有可辨識內容時維持未分類，不會亂猜', async () => {
    const res = await classify('🤔🤔🤔');
    assert.equal(res.status, 200);
    assert.equal(res.body.data.category, 'uncategorized');
  });

  test('參數檢查與頻率限制，文字不會寫入資料庫', async () => {
    assert.equal((await classify('')).status, 400);
    assert.equal((await classify('字'.repeat(5001))).status, 400);
    assert.equal((await t.call('POST', '/classify', { body: { text: 123 } })).status, 400);
    const marker = `secret-${Date.now()}`;
    await classify(marker);
    for (const { name } of t.server.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) {
      assert.equal(JSON.stringify(t.server.db.prepare(`SELECT * FROM ${name}`).all()).includes(marker), false, name);
    }
    const limited = await startTestServer({ classifyPerMinute: 1 });
    try {
      assert.equal((await limited.call('POST', '/classify', { body: { text: '你好' } })).status, 200);
      const res = await limited.call('POST', '/classify', { body: { text: '你好' } });
      assert.equal(res.body.error.code, 'RATE_LIMITED');
    } finally {
      await limited.stop();
    }
  });

  test('發問沒帶分類時自動分類，有把握才分；帶分類時以發問者為準；測試頁可以開啟', async () => {
    const user = await t.login();
    const volunteer = await t.login();
    const create = async (extra) => {
      const body = t.question(extra);
      if (!('category' in extra)) delete body.category;
      const res = await t.call('POST', '/questions', { token: user.token, body });
      assert.equal(res.status, 201, res.raw);
      return res.body.data;
    };
    const scam = await create({ body: '有人叫我買遊戲點數給他' });
    assert.equal(scam.category, 'scam_check');
    assert.equal((await t.call('PUT', '/questions/{question_id}/category', { token: volunteer.token, params: { question_id: scam.id }, body: { category: 'other' } })).status, 409, '已自動分類的問題志工不能改');

    assert.equal((await create({ body: '🤔🤔🤔' })).category, 'uncategorized');
    assert.equal((await create({ body: '有人叫我買遊戲點數給他', category: 'other' })).category, 'other');
    assert.equal((await create({ body: '資料', title: '有人叫我買遊戲點數給他' })).category, 'scam_check', '標題也要納入判斷');

    const page = await fetch(`${t.baseUrl}/classify-test`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /問題分類測試/);
  });
});


describe('分類器失敗時', () => {
  test('仍可發問，分類維持未分類', async () => {
    const s = await startTestServer({ classifierOverride: { threshold: 0.7, classify() { throw new Error('boom'); } } });
    try {
      const user = await s.login();
      const body = s.question({ body: '有人叫我買遊戲點數給他' });
      delete body.category;
      const res = await s.call('POST', '/questions', { token: user.token, body });
      assert.equal(res.status, 201, res.raw);
      assert.equal(res.body.data.category, 'uncategorized');
    } finally {
      await s.stop();
    }
  });
});

describe('影片上傳', () => {
  const mp4 = () => Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(200, 7)]);
  const webm = () => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(200, 7)]);
  const upload = (user, bytes, type, duration = '10') => {
    const form = new FormData();
    form.set('kind', 'video');
    if (duration !== null) form.set('duration_seconds', duration);
    form.set('file', new Blob([bytes], { type }), 'clip');
    return t.call('POST', '/media', { token: user.token, form });
  };

  test('MP4 和 WebM 可上傳下載，並支援分段讀取供播放器使用', async () => {
    const user = await t.login();
    const res = await upload(user, mp4(), 'video/mp4');
    assert.equal(res.status, 201, res.raw);
    assert.equal(res.body.data.kind, 'video');
    assert.equal(res.body.data.duration_seconds, 10);
    const file = await fetch(res.body.data.url);
    assert.equal(file.headers.get('content-type'), 'video/mp4');
    assert.equal(file.headers.get('x-content-type-options'), 'nosniff');
    const part = await fetch(res.body.data.url, { headers: { Range: 'bytes=0-9' } });
    assert.equal(part.status, 206);
    assert.equal((await part.arrayBuffer()).byteLength, 10);
    assert.equal((await upload(user, webm(), 'video/webm;codecs=vp9')).status, 201);
  });

  test('假影片、不支援的格式、超過大小或長度都會被拒絕', async () => {
    const user = await t.login();
    assert.equal((await upload(user, Buffer.from('<script>alert(1)</script>xxxxxxxx'), 'video/mp4')).status, 415);
    assert.equal((await upload(user, mp4(), 'video/webm')).status, 415);
    assert.equal((await upload(user, mp4(), 'video/quicktime')).status, 415);
    assert.equal((await upload(user, Buffer.concat([mp4(), Buffer.alloc(21 * 1024 * 1024)]), 'video/mp4')).status, 413);
    assert.equal((await upload(user, mp4(), 'video/mp4', '61')).status, 400);
    assert.equal((await upload(user, mp4(), 'video/mp4', null)).status, 400);
  });

  test('問題可附影片；個資標記 accept 後整段移除，待確認時他人看不到', async () => {
    const asker = await t.login();
    const reporter = await t.login();
    const video = (await upload(asker, mp4(), 'video/mp4')).body.data;
    const q = await ask(asker, { media_ids: [video.id] });
    assert.equal(q.has_video, true);
    assert.equal(q.has_audio, false);
    assert.equal(q.thumbnail_url, null);

    const created = await t.call('POST', '/pii-reports', { token: reporter.token, body: { target_type: 'question', target_id: q.id, media_id: video.id } });
    assert.equal(created.status, 201, created.raw);
    assert.equal((await fetch(video.url)).status, 404);
    const hidden = await t.call('GET', '/questions/{question_id}', { token: reporter.token, params: { question_id: q.id } });
    assert.equal(hidden.body.data.has_video, false);
    assert.deepEqual(hidden.body.data.media, []);

    const accepted = await t.call('POST', '/pii-reports/{report_id}/accept', { token: asker.token, params: { report_id: created.body.data.id } });
    assert.equal(accepted.status, 200, accepted.raw);
    assert.equal((await fetch(video.url)).status, 404);
    const after = await t.call('GET', '/questions/{question_id}', { token: asker.token, params: { question_id: q.id } });
    assert.deepEqual(after.body.data.media, []);
    assert.equal(fs.readdirSync(path.join(t.server.config.dataDir, 'media')).some((f) => f.startsWith(video.id)), false);
  });

  test('meta 回傳影片限制', async () => {
    const { limits } = (await t.call('GET', '/meta')).body.data;
    assert.equal(limits.video_max_bytes, 20 * 1024 * 1024);
    assert.equal(limits.video_max_seconds, 60);
  });
});

describe('自訂標籤', () => {
  // 每個測試用獨立伺服器，標籤統計才不會互相影響。
  const withServer = async (run) => {
    const s = await startTestServer();
    try { await run(s); } finally { await s.stop(); }
  };
  const create = async (s, user, tags, extra = {}) => {
    const res = await s.call('POST', '/questions', { token: user.token, body: s.question({ tags, ...extra }) });
    assert.equal(res.status, 201, res.raw);
    return res.body.data;
  };
  const searchQ = async (s, user, query) => (await s.call('GET', '/questions', { token: user.token, query })).body.data.map((q) => q.id);
  const searchTags = async (s, user, q) => (await s.call('GET', '/tags', { token: user.token, query: { q } })).body.data.map((t) => t.tag);

  test('發問可帶手動標籤，固定標籤排第一；會清理、去重並驗證', async () => withServer(async (s) => {
    const user = await s.login();
    const q = await create(s, user, ['#詐騙', ' 電話  詐騙 ', '詐騙', 'ＡＴＭ'], { category: 'scam_check' });
    assert.deepEqual(q.tags, ['疑似詐騙', '詐騙', '電話 詐騙', 'ATM']);
    assert.equal(q.system_tag, '疑似詐騙');
    assert.equal(q.category, 'scam_check');
    assert.deepEqual((await create(s, user, undefined)).tags, ['公文與合約']);
    const bad = (tags) => s.call('POST', '/questions', { token: user.token, body: s.question({ tags }) });
    assert.equal((await bad(['a', 'b', 'c', 'd', 'e', 'f'])).status, 400);
    assert.equal((await bad(['字'.repeat(21)])).status, 400);
    assert.equal((await bad(['<script>'])).status, 400);
    assert.equal((await bad(['   '])).status, 400);
    assert.equal((await bad('詐騙')).status, 400);
  }));

  test('模糊搜尋問題：部分符合、臺台、大小寫、詞序、打錯字，並依相似度排序', async () => withServer(async (s) => {
    const user = await s.login();
    const exact = await create(s, user, ['詐騙']);
    const partial = await create(s, user, ['電話詐騙手法']);
    const taipei = await create(s, user, ['臺北通']);
    const latin = await create(s, user, ['Password']);
    const order = await create(s, user, ['辦理手續']);
    const other = await create(s, user, ['公車']);

    assert.deepEqual(await searchQ(s, user, { tag_q: '詐騙' }), [exact.id, partial.id]);
    assert.deepEqual(await searchQ(s, user, { tag_q: '台北通' }), [taipei.id]);
    assert.deepEqual(await searchQ(s, user, { tag_q: 'password' }), [latin.id]);
    assert.deepEqual(await searchQ(s, user, { tag_q: 'passwrod' }), [latin.id]);
    assert.deepEqual(await searchQ(s, user, { tag_q: '手續辦理' }), [order.id]);
    assert.deepEqual(await searchQ(s, user, { tag_q: '完全無關的字' }), []);
    assert.ok(!(await searchQ(s, user, { tag_q: '詐騙' })).includes(other.id));
    assert.equal((await s.call('GET', '/questions', { token: user.token, query: { tag_q: '   ' } })).status, 400);
    assert.deepEqual(await searchQ(s, user, { tag: '台北通' }), [taipei.id]);
    assert.deepEqual(await searchQ(s, user, { tag: '台北' }), [], 'tag 是完全比對');
  }));

  test('模糊搜尋可和其他條件併用，也能分頁', async () => withServer(async (s) => {
    const user = await s.login();
    const scam = await create(s, user, ['詐騙'], { category: 'scam_check' });
    await create(s, user, ['詐騙'], { category: 'other' });
    assert.deepEqual(await searchQ(s, user, { tag_q: '詐騙', category: 'scam_check' }), [scam.id]);
    const near = await create(s, user, ['詐騙'], { location_sharing: 'approximate', location: TAIPEI });
    assert.deepEqual(await searchQ(s, user, { tag_q: '詐騙', scope: 'nearby', lat: String(TAIPEI.lat), lng: String(TAIPEI.lng) }), [near.id]);

    const seen = new Set();
    let cursor;
    do {
      const res = await s.call('GET', '/questions', { token: user.token, query: { tag_q: '詐騙', limit: '2', ...(cursor && { cursor }) } });
      res.body.data.forEach((q) => seen.add(q.id));
      cursor = res.body.next_cursor;
    } while (cursor);
    assert.equal(seen.size, 3);
  }));

  test('GET /tags 模糊比對、統計使用次數；沒有 q 時回傳熱門標籤', async () => withServer(async (s) => {
    const user = await s.login();
    await create(s, user, ['詐騙']);
    await create(s, user, ['詐騙', '公車']);
    await create(s, user, ['電話詐騙']);
    const fuzzy = await s.call('GET', '/tags', { token: user.token, query: { q: '詐騙' } });
    assert.deepEqual(fuzzy.body.data.map((t) => [t.tag, t.question_count]), [['詐騙', 2], ['電話詐騙', 1]]);
    assert.equal(fuzzy.body.data[0].score, 1);
    assert.deepEqual(await searchTags(s, user, '不存在'), []);
    const popular = await s.call('GET', '/tags', { token: user.token, query: { limit: '2' } });
    assert.deepEqual(popular.body.data, [{ tag: '公文與合約', question_count: 3, score: 1 }, { tag: '詐騙', question_count: 2, score: 1 }]);
    assert.equal((await s.call('GET', '/tags', { query: { q: '詐騙' } })).status, 401);
    assert.equal((await s.call('GET', '/tags', { token: user.token, query: { q: '  ' } })).status, 400);
  }));

  test('權限：發問者可增刪，其他人只能新增，低可信度不能改；撤回後標籤一併刪除', async () => withServer(async (s) => {
    const asker = await s.login();
    const volunteer = await s.login();
    const low = await s.login();
    const q = await create(s, asker, ['詐騙']);
    const put = (user, tags) => s.call('PUT', '/questions/{question_id}/tags', { token: user.token, params: { question_id: q.id }, body: { tags } });

    const added = await put(volunteer, ['詐騙', '假檢察官']);
    assert.equal(added.status, 200, added.raw);
    assert.deepEqual(added.body.data.tags, ['公文與合約', '詐騙', '假檢察官']);
    assert.equal((await put(volunteer, ['假檢察官'])).status, 403);
    assert.deepEqual((await put(asker, ['假檢察官'])).body.data.tags, ['公文與合約', '假檢察官']);
    assert.deepEqual((await put(asker, [])).body.data.tags, ['公文與合約']);
    s.server.db.prepare('UPDATE users SET trust_score = -11 WHERE id = ?').run(low.user.id);
    assert.equal((await put(low, ['亂標'])).status, 403);
    assert.equal((await s.call('PUT', '/questions/{question_id}/tags', { token: asker.token, params: { question_id: q.id }, body: {} })).status, 400);
    assert.equal((await s.call('PUT', '/questions/{question_id}/tags', { token: asker.token, params: { question_id: 'q_none' }, body: { tags: [] } })).status, 404);

    await put(asker, ['要刪除']);
    assert.equal((await s.call('DELETE', '/questions/{question_id}', { token: asker.token, params: { question_id: q.id } })).status, 204);
    assert.equal(s.server.db.prepare('SELECT COUNT(*) AS n FROM question_tags').get().n, 0);
    assert.deepEqual(await searchTags(s, asker, '要刪除'), []);
  }));

  test('修改標籤會發出更新訊號', async () => withServer(async (s) => {
    const user = await s.login();
    const q = await create(s, user, []);
    const socket = await new Promise((done, fail) => {
      const c = io(s.baseUrl, { auth: { token: user.token }, transports: ['websocket'], reconnection: false });
      c.once('connect', () => done(c));
      c.once('connect_error', fail);
    });
    try {
      await new Promise((done) => socket.emit('question:subscribe', { question_id: q.id }, done));
      const signal = new Promise((done) => socket.once('question.changed', done));
      await s.call('PUT', '/questions/{question_id}/tags', { token: user.token, params: { question_id: q.id }, body: { tags: ['新標籤'] } });
      assert.deepEqual(await signal, { question_id: q.id });
    } finally {
      socket.disconnect();
    }
  }));
});

describe('身份與管理員', () => {
  const withServer = async (run) => {
    const s = await startTestServer({ adminTownpassIds: ['root'], botTownpassIds: ['helper-bot'] });
    try {
      const session = async (id) => {
        const res = await s.call('POST', '/sessions', { body: { townpass_user_id: id, nickname: id } });
        return { token: res.body.data.token, user: res.body.data.user };
      };
      await run(s, await session('root'), session);
    } finally {
      await s.stop();
    }
  };
  const create = async (s, user, extra = {}) => (await s.call('POST', '/questions', { token: user.token, body: s.question(extra) })).body.data;
  const reply = async (s, user, id, body = '回答') => (await s.call('POST', '/questions/{question_id}/answers', { token: user.token, params: { question_id: id }, body: { body } })).body.data;
  const auditOf = async (s, admin, query = {}) => (await s.call('GET', '/admin/audit-log', { token: admin.token, query })).body.data;

  test('身份由名單決定，前端不能自己宣告；Bot 回傳身份且可正常使用', async () => withServer(async (s, admin, session) => {
    assert.equal(admin.user.role, 'admin');
    const bot = await session('helper-bot');
    assert.equal(bot.user.role, 'bot');
    const forged = await s.call('POST', '/sessions', { body: { townpass_user_id: 'attacker', nickname: 'x', role: 'admin' } });
    assert.equal(forged.body.data.user.role, 'user');

    const asker = await session('asker');
    const q = await create(s, asker);
    const a = await reply(s, bot, q.id, 'Bot 的回答');
    assert.equal(a.author.role, 'bot');
    const list = await s.call('GET', '/questions/{question_id}/answers', { token: asker.token, params: { question_id: q.id } });
    assert.equal(list.body.data[0].author.role, 'bot');
    const vote = await s.call('PUT', '/answers/{answer_id}/vote', { token: bot.token, params: { answer_id: a.id }, body: { value: 1 } });
    assert.equal(vote.status, 200);
    const accepted = await s.call('POST', '/answers/{answer_id}/accept', { token: asker.token, params: { answer_id: a.id } });
    assert.equal(accepted.status, 200);
    assert.equal((await s.call('GET', '/users/{user_id}', { params: { user_id: bot.user.id } })).body.data.role, 'bot');
  }));

  test('情境的 extra 只有發問者與管理員看得到', async () => withServer(async (s, admin, session) => {
    const asker = await session('reporter');
    const other = await session('passerby');
    const context = {
      service_id: 'townpass-app',
      service_name: 'Town Pass',
      page_route: '/main/service',
      page_title: '服務',
      extra: { deviceModel: 'SM-A236E', routeHistory: ['/', '/account'] },
    };
    const q = await create(s, asker, { context });
    const view = async (user) => (await s.call('GET', '/questions/{question_id}', { token: user.token, params: { question_id: q.id } })).body.data.context;
    const listed = async (user) => (await s.call('GET', '/questions', { token: user.token, query: { service_id: 'townpass-app' } })).body.data.find((item) => item.id === q.id).context;

    assert.deepEqual(q.context.extra, context.extra);
    assert.deepEqual((await view(asker)).extra, context.extra);
    assert.deepEqual((await view(admin)).extra, context.extra);
    for (const seen of [await view(other), await listed(other)]) {
      assert.equal(seen.extra, undefined);
      assert.equal(seen.page_route, '/main/service');
      assert.equal(seen.page_title, '服務');
    }
  }));

  test('非管理員不能用任何管理員 API，也看不到可信度評分', async () => withServer(async (s, admin, session) => {
    const user = await session('normal');
    const q = await create(s, user);
    const calls = [
      ['GET', '/admin/users', {}],
      ['GET', '/admin/audit-log', {}],
      ['GET', '/admin/pii-reports', {}],
      ['PUT', '/admin/users/{user_id}/role', { params: { user_id: admin.user.id }, body: { role: 'user' } }],
      ['POST', '/admin/users/{user_id}/ban', { params: { user_id: admin.user.id }, body: {} }],
      ['POST', '/admin/users/{user_id}/unban', { params: { user_id: admin.user.id } }],
      ['PATCH', '/admin/questions/{question_id}', { params: { question_id: q.id }, body: { title: 'x' } }],
      ['PATCH', '/admin/answers/{answer_id}', { params: { answer_id: 'a_1' }, body: { body: 'x' } }],
    ];
    for (const [method, path, options] of calls) {
      assert.equal((await s.call(method, path, { token: user.token, ...options })).status, 403, path);
      assert.equal((await s.call(method, path, options)).status, 401, path);
    }
    const bot = await session('helper-bot');
    assert.equal((await s.call('GET', '/admin/users', { token: bot.token })).status, 403);
    const me = await s.call('GET', '/me', { token: user.token });
    assert.doesNotMatch(me.raw, /trust/);
    const listed = await s.call('GET', '/admin/users', { token: admin.token, query: { q: 'normal' } });
    assert.equal(listed.body.data[0].trust_score, 0);
    assert.equal(listed.body.data[0].townpass_user_id, 'normal');
  }));

  test('刪除別人的問題：保留原內容、通知作者、內容真的消失', async () => withServer(async (s, admin, session) => {
    const asker = await session('asker');
    const helper = await session('helper');
    const q = await create(s, asker, { body: '不當內容', tags: ['標籤'] });
    await reply(s, helper, q.id, '底下的回答');
    assert.equal((await s.call('DELETE', '/questions/{question_id}', { token: admin.token, params: { question_id: q.id } })).status, 204);
    assert.equal((await s.call('GET', '/questions/{question_id}', { token: asker.token, params: { question_id: q.id } })).status, 404);
    const [entry] = await auditOf(s, admin, { action: 'question.delete' });
    assert.equal(entry.target_id, q.id);
    assert.equal(entry.admin.id, admin.user.id);
    assert.equal(entry.detail.body, '不當內容');
    assert.equal(entry.detail.answers[0].body, '底下的回答');
    const notes = (await s.call('GET', '/notifications', { token: asker.token })).body.data;
    assert.ok(notes.some((n) => n.type === 'content_moderated'));
  }));

  test('稽核不保留精確座標', async () => withServer(async (s, admin, session) => {
    const asker = await session('asker');
    const q = await create(s, asker, { location_sharing: 'exact', location: TAIPEI });
    await s.call('DELETE', '/questions/{question_id}', { token: admin.token, params: { question_id: q.id } });
    assert.equal(JSON.stringify(await auditOf(s, admin)).includes(String(TAIPEI.lat)), false);
  }));

  test('可刪除已採納的回答：不收回積分，問題維持已解決', async () => withServer(async (s, admin, session) => {
    const asker = await session('asker');
    const helper = await session('helper');
    const q = await create(s, asker);
    const a = await reply(s, helper, q.id);
    await s.call('POST', '/answers/{answer_id}/accept', { token: asker.token, params: { answer_id: a.id } });
    assert.equal((await s.call('DELETE', '/answers/{answer_id}', { token: helper.token, params: { answer_id: a.id } })).status, 409);
    assert.equal((await s.call('DELETE', '/answers/{answer_id}', { token: admin.token, params: { answer_id: a.id } })).status, 204);
    const after = (await s.call('GET', '/questions/{question_id}', { token: asker.token, params: { question_id: q.id } })).body.data;
    assert.equal(after.status, 'resolved');
    assert.equal(after.accepted_answer_id, null);
    assert.equal(after.answer_count, 0);
    assert.equal((await s.call('GET', '/me', { token: helper.token })).body.data.points, 10);
    const [entry] = await auditOf(s, admin, { action: 'answer.delete' });
    assert.equal(entry.detail.was_accepted, true);
  }));

  test('修改內容：記錄前後內容，自動標題同步；待決定的個資標記要先處理', async () => withServer(async (s, admin, session) => {
    const asker = await session('asker');
    const helper = await session('helper');
    const q = await create(s, asker, { body: '原本的內容' });
    const edit = (body) => s.call('PATCH', '/admin/questions/{question_id}', { token: admin.token, params: { question_id: q.id }, body });
    const res = await edit({ body: '修改後的內容' });
    assert.equal(res.status, 200, res.raw);
    assert.equal(res.body.data.body, '修改後的內容');
    assert.equal(res.body.data.title, '修改後的內容');
    assert.equal((await edit({})).status, 400);
    assert.equal((await edit({ title: '' })).status, 400);
    const [entry] = await auditOf(s, admin, { target_id: q.id });
    assert.deepEqual(entry.detail.before.body, '原本的內容');
    assert.deepEqual(entry.detail.after.body, '修改後的內容');

    const a = await reply(s, helper, q.id, '原回答');
    const editA = await s.call('PATCH', '/admin/answers/{answer_id}', { token: admin.token, params: { answer_id: a.id }, body: { body: '新回答' } });
    assert.equal(editA.body.data.body, '新回答');
    assert.ok((await s.call('GET', '/notifications', { token: helper.token })).body.data.some((n) => n.type === 'content_moderated'));

    await s.call('POST', '/pii-reports', { token: helper.token, body: { target_type: 'question', target_id: q.id, text_ranges: [{ start: 0, end: 1 }] } });
    assert.equal((await edit({ body: '再改一次' })).status, 409);
  }));

  test('分類、標籤、已解決、個資決定都能代為處理，也都有紀錄', async () => withServer(async (s, admin, session) => {
    const asker = await session('asker');
    const reporter = await session('reporter');
    const q = await create(s, asker, { category: 'other', tags: ['舊標籤'], body: '電話0912' });
    const id = { question_id: q.id };
    assert.equal((await s.call('PUT', '/questions/{question_id}/category', { token: admin.token, params: id, body: { category: 'uncategorized' } })).body.data.category, 'uncategorized');
    assert.deepEqual((await s.call('PUT', '/questions/{question_id}/tags', { token: admin.token, params: id, body: { tags: ['新標籤'] } })).body.data.tags, ['未分類', '新標籤']);

    const report = await s.call('POST', '/pii-reports', { token: reporter.token, body: { target_type: 'question', target_id: q.id, text_ranges: [{ start: 2, end: 6 }] } });
    const hidden = await s.call('GET', '/questions/{question_id}', { token: reporter.token, params: id });
    assert.equal(hidden.body.data.body, null);
    assert.equal((await s.call('GET', '/questions/{question_id}', { token: admin.token, params: id })).body.data.body, '電話0912', '管理員要看得到才能判斷');
    const pending = await s.call('GET', '/admin/pii-reports', { token: admin.token, query: { status: 'pending' } });
    assert.equal(pending.body.data[0].id, report.body.data.id);
    const done = await s.call('POST', '/pii-reports/{report_id}/accept', { token: admin.token, params: { report_id: report.body.data.id } });
    assert.equal(done.status, 200, done.raw);
    assert.equal((await s.call('GET', '/questions/{question_id}', { token: reporter.token, params: id })).body.data.body, '電話████');
    assert.equal((await s.call('POST', '/questions/{question_id}/resolve', { token: admin.token, params: id })).body.data.status, 'resolved');

    const actions = (await auditOf(s, admin)).map((e) => e.action);
    for (const action of ['question.category', 'question.tags', 'pii.accept', 'question.resolve']) assert.ok(actions.includes(action), action);
    assert.equal((await s.call('GET', '/admin/audit-log', { token: admin.token, query: { limit: '1' } })).body.next_cursor !== null, true);
  }));

  test('一般使用者自己的操作不會進稽核', async () => withServer(async (s, admin, session) => {
    const asker = await session('asker');
    const q = await create(s, asker);
    await s.call('DELETE', '/questions/{question_id}', { token: asker.token, params: { question_id: q.id } });
    assert.deepEqual(await auditOf(s, admin), []);
  }));

  test('設定身份：不能改自己，名單內的 ID 登入時恢復', async () => withServer(async (s, admin, session) => {
    const user = await session('future-bot');
    const set = (id, role) => s.call('PUT', '/admin/users/{user_id}/role', { token: admin.token, params: { user_id: id }, body: { role } });
    assert.equal((await set(user.user.id, 'bot')).body.data.role, 'bot');
    assert.equal((await s.call('GET', '/me', { token: user.token })).body.data.role, 'bot');
    assert.equal((await set(user.user.id, 'superuser')).status, 400);
    assert.equal((await set(admin.user.id, 'user')).status, 403);
    assert.equal((await set('u_none', 'bot')).status, 404);
    const [entry] = await auditOf(s, admin, { action: 'user.role' });
    assert.deepEqual(entry.detail, { before: 'user', after: 'bot' });
  }));

  test('停權：立即登出、不能重新登入、中斷連線、不再收附近通知；解除後恢復', async () => withServer(async (s, admin, session) => {
    const user = await session('troll');
    await s.call('POST', '/me/heartbeat', { token: user.token, body: { app_state: 'background', location: TAIPEI } });
    await s.call('PUT', '/push-tokens/{token}', { token: user.token, params: { token: 'tok-1' }, body: { platform: 'android' } });
    const socket = await new Promise((done, fail) => {
      const c = io(s.baseUrl, { auth: { token: user.token }, transports: ['websocket'], reconnection: false });
      c.once('connect', () => done(c));
      c.once('connect_error', fail);
    });
    const dropped = new Promise((done) => socket.once('disconnect', done));
    const ban = (id) => s.call('POST', '/admin/users/{user_id}/ban', { token: admin.token, params: { user_id: id }, body: { reason: '發廣告' } });
    const res = await ban(user.user.id);
    assert.equal(res.status, 200, res.raw);
    assert.equal(res.body.data.ban_reason, '發廣告');
    assert.ok(res.body.data.banned_at);
    await dropped;
    assert.equal((await s.call('GET', '/me', { token: user.token })).status, 401);
    const relogin = await s.call('POST', '/sessions', { body: { townpass_user_id: 'troll' } });
    assert.equal(relogin.status, 403);
    assert.equal(relogin.body.error.code, 'ACCOUNT_BANNED');
    assert.equal(s.server.db.prepare('SELECT COUNT(*) AS n FROM push_tokens WHERE user_id = ?').get(user.user.id).n, 0);
    assert.equal((await ban(admin.user.id)).status, 403, '不能停權自己');

    const asker = await session('asker');
    const q = await create(s, asker, { location_sharing: 'approximate', location: TAIPEI });
    assert.equal(s.server.db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE question_id = ? AND type = 'nearby_question'").get(q.id).n, 0);

    assert.equal((await s.call('POST', '/admin/users/{user_id}/unban', { token: admin.token, params: { user_id: user.user.id } })).body.data.banned_at, null);
    assert.equal((await s.call('POST', '/sessions', { body: { townpass_user_id: 'troll' } })).status, 201);
    socket.disconnect();
  }));

  test('舊資料庫升級時會補上身份欄位', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codefest-migrate-'));
    try {
      const old = new Database(path.join(dir, 'app.db'));
      old.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, townpass_user_id TEXT NOT NULL UNIQUE, nickname TEXT NOT NULL, points INTEGER NOT NULL DEFAULT 0,
        trust_score INTEGER NOT NULL DEFAULT 0, languages TEXT NOT NULL, nearby_notifications_enabled INTEGER NOT NULL DEFAULT 1, nearby_radius_m INTEGER NOT NULL DEFAULT 1000,
        location_sharing TEXT NOT NULL DEFAULT 'approximate', last_lat REAL, last_lng REAL, location_updated_at TEXT, last_nearby_notified_at TEXT, created_at TEXT NOT NULL);
        INSERT INTO users (id, townpass_user_id, nickname, languages, created_at) VALUES ('u_old', 'old', '舊使用者', '[]', '2026-01-01');`);
      old.close();
      const db = openDatabase(dir);
      const row = db.prepare("SELECT role, banned_at FROM users WHERE id = 'u_old'").get();
      assert.deepEqual({ ...row }, { role: 'user', banned_at: null });
      db.close();
      const again = openDatabase(dir);
      again.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('頁面問題統計', () => {
  test('依頁面彙整、排序、篩選，只有管理員能看', async () => {
    const s = await startTestServer({ adminTownpassIds: ['root'] });
    try {
      const login = async (id) => (await s.call('POST', '/sessions', { body: { townpass_user_id: id, nickname: id } })).body.data;
      const admin = await login('root');
      const user = await login('someone');
      const ask2 = async (route, extra = {}) => (await s.call('POST', '/questions', {
        token: user.token,
        body: s.question({ context: route && { service_id: 'townpass-app', service_name: 'Town Pass', page_route: route, page_title: '帳單' }, ...extra }),
      })).body.data;

      const a = await ask2('/fee-payment', { category: 'admin_procedure' });
      await ask2('/fee-payment+dialog', { category: 'other' });
      await ask2('/fee-payment?id=123', { category: 'other' });
      await ask2('/account', { category: 'app_usage' });
      await ask2(null);
      await s.call('POST', '/questions/{question_id}/resolve', { token: user.token, params: { question_id: a.id } });

      const get = (query = {}, token = admin.token) => s.call('GET', '/admin/analytics/pages', { token, query });
      assert.equal((await get({}, user.token)).status, 403);
      const { data } = (await get()).body;
      assert.equal(data.total_questions, 5);
      assert.equal(data.questions_with_page, 4);
      assert.equal(data.questions_without_page, 1);
      assert.deepEqual(data.pages.map((p) => [p.page_route, p.question_count]), [['/fee-payment', 3], ['/account', 1]]);
      const [top] = data.pages;
      assert.equal(top.resolved_count, 1);
      assert.equal(top.open_count, 2);
      assert.equal(top.unanswered_count, 3);
      assert.equal(top.page_title, '帳單');
      assert.deepEqual(top.categories, [{ category: 'other', count: 2 }, { category: 'admin_procedure', count: 1 }]);

      assert.equal((await get({ limit: '1' })).body.data.pages.length, 1);
      assert.equal((await get({ until: '2020-01-01T00:00:00Z' })).body.data.total_questions, 0);
      assert.equal((await get({ since: '2020-01-01T00:00:00Z' })).body.data.total_questions, 5);
      assert.equal((await get({ service_id: 'nope' })).body.data.total_questions, 0);
      assert.equal((await get({ since: 'not-a-date' })).status, 400);
    } finally {
      await s.stop();
    }
  });

  test('report_draft 常見的 extra 大小可以存，超過 8 KB 才拒絕', async () => {
    const user = await t.login();
    const body = (size) => t.question({ context: { service_id: 'townpass-app', service_name: 'Town Pass', page_route: '/x', extra: { routeHistory: 'x'.repeat(size) } } });
    assert.equal((await t.call('POST', '/questions', { token: user.token, body: body(4000) })).status, 201);
    assert.equal((await t.call('POST', '/questions', { token: user.token, body: body(9000) })).status, 400);
  });
});

describe('語意快取', () => {
  // 用固定向量代替模型，測試才穩定；內積等於相似度。
  const VECTORS = {
    敬老卡要去哪裡申請: [1, 0, 0],
    請問要怎麼辦敬老卡: [0.95, Math.sqrt(1 - 0.95 ** 2), 0],
    勉強相似: [0.8, 0.6, 0],
    完全不同: [0, 0, 1],
  };
  const embedder = () => {
    const state = { fail: false, calls: [] };
    return {
      state,
      embed: async (text) => {
        state.calls.push(text);
        if (state.fail) throw new Error('down');
        return VECTORS[text] ?? [0, 0, 1];
      },
    };
  };
  const withServer = async (run, extra = {}) => {
    const fake = embedder();
    const s = await startTestServer({ embedderOverride: fake, semanticCacheThreshold: 0.88, ...extra });
    try { await run(s, fake); } finally { await s.stop(); }
  };
  const ask3 = async (s, user, body, extra = {}) => {
    const res = await s.call('POST', '/questions', { token: user.token, body: s.question({ body, ...extra }) });
    assert.equal(res.status, 201, res.raw);
    await s.server.semanticCache.idle();
    return res.body.data;
  };
  const answersOf = async (s, user, id) => (await s.call('GET', '/questions/{question_id}/answers', { token: user.token, params: { question_id: id } })).body.data;
  const seed = async (s, asker, helper, text = '敬老卡要去哪裡申請', body = '到區公所申請') => {
    const q = await ask3(s, asker, text);
    const a = (await s.call('POST', '/questions/{question_id}/answers', { token: helper.token, params: { question_id: q.id }, body: { body } })).body.data;
    await s.call('POST', '/answers/{answer_id}/accept', { token: asker.token, params: { answer_id: a.id } });
    return { q, a };
  };

  test('相似問題由機器人貼上已採納的解答，標明來源，問題維持開啟', async () => withServer(async (s) => {
    const asker = await s.login();
    const helper = await s.login();
    const { q, a } = await seed(s, asker, helper);
    const another = await s.login();
    const q2 = await ask3(s, another, '請問要怎麼辦敬老卡');
    const [cached] = await answersOf(s, another, q2.id);
    assert.equal(cached.author.role, 'bot');
    assert.match(cached.body, /到區公所申請/);
    assert.equal(cached.cached_from.question_id, q.id);
    assert.equal(cached.cached_from.answer_id, a.id);
    assert.equal(cached.cached_from.similarity, 0.95);
    const detail = (await s.call('GET', '/questions/{question_id}', { token: another.token, params: { question_id: q2.id } })).body.data;
    assert.equal(detail.status, 'open');
    assert.equal(detail.answer_count, 1);
    const notes = (await s.call('GET', '/notifications', { token: another.token })).body.data;
    assert.ok(notes.some((n) => n.type === 'new_answer' && n.question_id === q2.id));
    const human = (await answersOf(s, asker, q.id))[0];
    assert.equal(human.cached_from, null);
    const accepted = await s.call('POST', '/answers/{answer_id}/accept', { token: another.token, params: { answer_id: cached.id } });
    assert.equal(accepted.status, 200, accepted.raw);
  }));

  test('不夠像或來源還沒被採納時不回覆', async () => withServer(async (s) => {
    const asker = await s.login();
    const helper = await s.login();
    const q = await ask3(s, asker, '敬老卡要去哪裡申請');
    await s.call('POST', '/questions/{question_id}/answers', { token: helper.token, params: { question_id: q.id }, body: { body: '未採納的回答' } });
    assert.deepEqual(await answersOf(s, asker, (await ask3(s, asker, '請問要怎麼辦敬老卡')).id), []);

    const other = await s.login();
    await s.call('POST', '/answers/{answer_id}/accept', { token: asker.token, params: { answer_id: (await answersOf(s, asker, q.id))[0].id } });
    assert.deepEqual(await answersOf(s, other, (await ask3(s, other, '勉強相似')).id), []);
    assert.deepEqual(await answersOf(s, other, (await ask3(s, other, '完全不同')).id), []);
  }));

  test('來源有待確認的個資標記時不引用，避免把隱藏內容貼出去', async () => withServer(async (s) => {
    const asker = await s.login();
    const helper = await s.login();
    const { a } = await seed(s, asker, helper, '敬老卡要去哪裡申請', '打給0912345678');
    const report = await s.call('POST', '/pii-reports', { token: helper.token, body: { target_type: 'answer', target_id: a.id, text_ranges: [{ start: 2, end: 12 }] } });
    assert.equal(report.status, 201, report.raw);
    assert.deepEqual(await answersOf(s, helper, (await ask3(s, helper, '請問要怎麼辦敬老卡')).id), []);
  }));

  test('模型服務失敗不影響發問，恢復後補算的舊問題可以被命中', async () => withServer(async (s, fake) => {
    const asker = await s.login();
    const helper = await s.login();
    fake.state.fail = true;
    const { q } = await seed(s, asker, helper);
    assert.equal(q.answer_count, 0);
    assert.equal(s.server.db.prepare('SELECT COUNT(*) AS n FROM question_embeddings').get().n, 0);
    fake.state.fail = false;
    await new Promise((r) => setTimeout(r, 120));
    await s.server.semanticCache.idle();
    assert.equal(s.server.db.prepare('SELECT COUNT(*) AS n FROM question_embeddings').get().n, 1);
    const q2 = await ask3(s, helper, '請問要怎麼辦敬老卡');
    assert.equal((await answersOf(s, helper, q2.id)).length, 1);
  }, { embeddingBackfillMs: 50 }));

  test('會發出更新訊號；撤回問題也刪除向量；沒有文字的問題不比對', async () => withServer(async (s, fake) => {
    const asker = await s.login();
    const helper = await s.login();
    await seed(s, asker, helper);
    fake.state.calls.length = 0;

    const socket = await new Promise((done, fail) => {
      const c = io(s.baseUrl, { auth: { token: helper.token }, transports: ['websocket'], reconnection: false });
      c.once('connect', () => done(c));
      c.once('connect_error', fail);
    });
    try {
      await new Promise((done) => socket.emit('feed:subscribe', done));
      let feedCount = 0;
      socket.on('feed.changed', () => { feedCount++; });
      const q2 = await ask3(s, helper, '請問要怎麼辦敬老卡');
      await new Promise((r) => setTimeout(r, 80));
      assert.ok(feedCount >= 2, '建立問題和機器人回覆都要通知');
      assert.equal((await s.call('DELETE', '/questions/{question_id}', { token: helper.token, params: { question_id: q2.id } })).status, 204);
      assert.equal(s.server.db.prepare('SELECT COUNT(*) AS n FROM question_embeddings WHERE question_id = ?').get(q2.id).n, 0);
    } finally {
      socket.disconnect();
    }
  }));

  test('沒有設定模型服務時不啟用；保留 ID 不能登入', async () => {
    const res = await t.call('POST', '/sessions', { body: { townpass_user_id: 'system:semantic-cache-bot' } });
    assert.equal(res.status, 400);
    assert.equal(t.server.semanticCache.enabled, false);
    const user = await t.login();
    const q = await ask(user);
    assert.equal(q.answer_count, 0);
  });
});

describe('語意快取評分', () => {
  const unit = (s) => [s, Math.sqrt(1 - s * s)];
  const VECTORS = { 來源問題: [1, 0], 非常相似: unit(0.95), 差一點: unit(0.87), 剛好過: unit(0.89) };
  const withServer = async (run, extra = {}) => {
    const s = await startTestServer({
      adminTownpassIds: ['root'],
      semanticCacheThreshold: 0.88,
      embedderOverride: { embed: async (text) => VECTORS[text] ?? [0, 1] },
      ...extra,
    });
    try { await run(s); } finally { await s.stop(); }
  };
  const ask4 = async (s, user, body) => {
    const res = await s.call('POST', '/questions', { token: user.token, body: s.question({ body }) });
    await s.server.semanticCache.idle();
    return res.body.data;
  };
  const answers = async (s, user, id) => (await s.call('GET', '/questions/{question_id}/answers', { token: user.token, params: { question_id: id } })).body.data;
  const setup = async (s) => {
    const asker = await s.login();
    const helper = await s.login();
    const q = await ask4(s, asker, '來源問題');
    const res = await s.call('POST', '/questions/{question_id}/answers', { token: helper.token, params: { question_id: q.id }, body: { body: '原始解答' } });
    await s.call('POST', '/answers/{answer_id}/accept', { token: asker.token, params: { answer_id: res.body.data.id } });
    return { helper, source: res.body.data };
  };
  const scoreOf = (s, id) => s.server.db.prepare('SELECT * FROM cache_scores WHERE source_answer_id = ?').get(id) ?? { score: 0, positive_count: 0, negative_count: 0 };
  // 問一題，並回傳機器人的回答。
  const hit = async (s, text = '非常相似') => {
    const user = await s.login();
    const q = await ask4(s, user, text);
    return { user, q, bot: (await answers(s, user, q.id))[0] };
  };
  const resolve = (s, user, id) => s.call('POST', '/questions/{question_id}/resolve', { token: user.token, params: { question_id: id } });
  const vote = (s, user, id, value) => s.call('PUT', '/answers/{answer_id}/vote', { token: user.token, params: { answer_id: id }, body: { value } });
  const accept = (s, user, id) => s.call('POST', '/answers/{answer_id}/accept', { token: user.token, params: { answer_id: id } });

  test('回覆後馬上標記已解決會加分，重複不會多算', async () => withServer(async (s) => {
    const { source } = await setup(s);
    const { user, q } = await hit(s);
    assert.equal((await resolve(s, user, q.id)).status, 200);
    assert.equal(scoreOf(s, source.id).score, 1);
    assert.equal(scoreOf(s, source.id).positive_count, 1);
    await s.server.semanticCache.questionResolved(q);
    assert.equal(scoreOf(s, source.id).score, 1);
  }));

  test('超過時間、有人回答過或管理員代為標記，都不加分', async () => {
    await withServer(async (s) => {
      const { source } = await setup(s);
      const { user, q } = await hit(s);
      await resolve(s, user, q.id);
      assert.equal(scoreOf(s, source.id).score, 0, '超過時間窗');
    }, { cacheResolveWindowMs: -1 });
    await withServer(async (s) => {
      const { source, helper } = await setup(s);
      const { user, q } = await hit(s);
      await s.call('POST', '/questions/{question_id}/answers', { token: helper.token, params: { question_id: q.id }, body: { body: '真人回答' } });
      await resolve(s, user, q.id);
      assert.equal(scoreOf(s, source.id).score, 0, '有人回答過');
      const root = (await s.call('POST', '/sessions', { body: { townpass_user_id: 'root' } })).body.data;
      const second = await hit(s);
      await resolve(s, root, second.q.id);
      assert.equal(scoreOf(s, source.id).score, 0, '管理員代為標記');
    });
  });

  test('採納機器人加分；採納別人的回答扣分', async () => withServer(async (s) => {
    const { source, helper } = await setup(s);
    const first = await hit(s);
    await accept(s, first.user, first.bot.id);
    assert.equal(scoreOf(s, source.id).score, 1);
    const second = await hit(s);
    const human = await s.call('POST', '/questions/{question_id}/answers', { token: helper.token, params: { question_id: second.q.id }, body: { body: '真人解答' } });
    await accept(s, second.user, human.body.data.id);
    const score = scoreOf(s, source.id);
    assert.deepEqual([score.score, score.positive_count, score.negative_count], [0, 1, 1]);
  }));

  test('只有發問者的倒讚算數；收回或改成正讚會還原', async () => withServer(async (s) => {
    const { source, helper } = await setup(s);
    const { user, bot } = await hit(s);
    await vote(s, helper, bot.id, -1);
    assert.equal(scoreOf(s, source.id).score, 0, '別人的倒讚不算');
    await vote(s, user, bot.id, -1);
    assert.equal(scoreOf(s, source.id).score, -1);
    await vote(s, user, bot.id, -1);
    assert.equal(scoreOf(s, source.id).score, -1, '重複不多扣');
    await vote(s, user, bot.id, 1);
    assert.equal(scoreOf(s, source.id).score, 0);
    await vote(s, user, bot.id, -1);
    assert.equal((await s.call('DELETE', '/answers/{answer_id}/vote', { token: user.token, params: { answer_id: bot.id } })).status, 200);
    const score = scoreOf(s, source.id);
    assert.deepEqual([score.score, score.negative_count], [0, 0]);
  }));

  test('先按倒讚再標記已解決，不會變成加分', async () => withServer(async (s) => {
    const { source } = await setup(s);
    const { user, q, bot } = await hit(s);
    await vote(s, user, bot.id, -1);
    await resolve(s, user, q.id);
    assert.equal(scoreOf(s, source.id).score, -1);
  }));

  test('分數會影響命中：加分讓差一點的命中，扣分擋掉原本會命中的，-3 分不再引用', async () => {
    await withServer(async (s) => {
      await setup(s);
      assert.equal((await hit(s, '差一點')).bot, undefined, '0.87 原本不到門檻');
      const first = await hit(s);
      await resolve(s, first.user, first.q.id);
      assert.ok((await hit(s, '差一點')).bot, '加 1 分後命中');
    });
    await withServer(async (s) => {
      await setup(s);
      assert.ok((await hit(s, '剛好過')).bot, '0.89 原本會命中');
      const first = await hit(s);
      await vote(s, first.user, first.bot.id, -1);
      assert.equal((await hit(s, '剛好過')).bot, undefined, '扣 1 分後不命中');
      const second = await hit(s);
      await vote(s, second.user, second.bot.id, -1);
      const third = await hit(s);
      await vote(s, third.user, third.bot.id, -1);
      assert.equal((await hit(s)).bot, undefined, '-3 分後連 0.95 也不引用');
    });
  });

  test('機器人的回答被採納後不會變成新來源，前綴不會疊加', async () => withServer(async (s) => {
    const { source } = await setup(s);
    s.server.db.prepare('INSERT INTO cache_scores (source_answer_id, source_question_id, score, updated_at) VALUES (?, ?, ?, ?)').run(source.id, source.question_id, -3, new Date().toISOString());
    const blocked = await hit(s);
    assert.equal(blocked.bot, undefined);
    s.server.db.prepare('UPDATE cache_scores SET score = 0').run();
    const first = await hit(s);
    await accept(s, first.user, first.bot.id);
    const second = await hit(s);
    assert.equal(second.bot.cached_from.answer_id, source.id);
    assert.equal(second.bot.body.match(/之前有人問過/g).length, 1);
  }));

  test('管理員可查看評分，一般使用者不行', async () => withServer(async (s) => {
    const { source, helper } = await setup(s);
    const { user, bot } = await hit(s);
    await vote(s, user, bot.id, -1);
    const root = (await s.call('POST', '/sessions', { body: { townpass_user_id: 'root' } })).body.data;
    const res = await s.call('GET', '/admin/analytics/cache', { token: root.token });
    assert.equal(res.status, 200, res.raw);
    assert.equal(res.body.data[0].source_answer_id, source.id);
    assert.equal(res.body.data[0].score, -1);
    assert.equal(res.body.data[0].answer_body, '原始解答');
    assert.equal(res.body.data[0].reply_count, 1);
    assert.equal(res.body.data[0].blocked, false);
    assert.equal((await s.call('GET', '/admin/analytics/cache', { token: helper.token })).status, 403);
  }));
});

describe('分類和標籤合併', () => {
  const withServer = async (run) => {
    const s = await startTestServer();
    try { await run(s); } finally { await s.stop(); }
  };
  const post = async (s, user, extra) => {
    const body = s.question(extra);
    if (!('category' in extra)) delete body.category;
    const res = await s.call('POST', '/questions', { token: user.token, body });
    assert.equal(res.status, 201, res.raw);
    return res.body.data;
  };
  const put = (s, user, id, tags) => s.call('PUT', '/questions/{question_id}/tags', { token: user.token, params: { question_id: id }, body: { tags } });

  test('後端判定固定標籤；沒把握時是未分類；列表和詳情都帶', async () => withServer(async (s) => {
    const user = await s.login();
    const scam = await post(s, user, { body: '有人打電話說我涉及洗錢要我匯款', tags: ['假檢察官'] });
    assert.deepEqual(scam.tags, ['疑似詐騙', '假檢察官']);
    assert.equal(scam.system_tag, '疑似詐騙');
    const unknown = await post(s, user, { body: '🤔🤔🤔' });
    assert.deepEqual(unknown.tags, ['未分類']);
    const listed = (await s.call('GET', '/questions', { token: user.token, query: { author: 'me' } })).body.data.find((q) => q.id === scam.id);
    assert.deepEqual(listed.tags, ['疑似詐騙', '假檢察官']);
    assert.equal(listed.system_tag, '疑似詐騙');
  }));

  test('把回傳的 tags 整包送回不會出錯，也不會多一個；固定標籤不算進上限', async () => withServer(async (s) => {
    const user = await s.login();
    const q = await post(s, user, { body: '資料', category: 'other', tags: ['甲', '乙', '丙', '丁', '戊'] });
    assert.equal(q.tags.length, 6);
    const again = await put(s, user, q.id, q.tags);
    assert.equal(again.status, 200, again.raw);
    assert.deepEqual(again.body.data.tags, q.tags);
  }));

  test('手動打固定標籤的名稱會被略過，不能改掉或移除固定標籤', async () => withServer(async (s) => {
    const user = await s.login();
    const q = await post(s, user, { body: '資料', category: 'other', tags: ['疑似詐騙', '手動'] });
    assert.deepEqual(q.tags, ['其他', '手動']);
    assert.equal(q.system_tag, '其他');
    const res = await put(s, user, q.id, []);
    assert.deepEqual(res.body.data.tags, ['其他']);
    assert.equal(res.body.data.system_tag, '其他');
  }));

  test('志工只動手動標籤時，不算移除固定標籤；舊 API 改分類會同步 tags', async () => withServer(async (s) => {
    const asker = await s.login();
    const volunteer = await s.login();
    const q = await post(s, asker, { body: '🤔🤔🤔', tags: ['原有'] });
    assert.equal((await put(s, volunteer, q.id, ['原有', '新增'])).status, 200);
    const res = await s.call('PUT', '/questions/{question_id}/category', { token: volunteer.token, params: { question_id: q.id }, body: { category: 'scam_check' } });
    assert.deepEqual(res.body.data.tags, ['疑似詐騙', '原有', '新增']);
    assert.equal(res.body.data.system_tag, '疑似詐騙');
    assert.equal(s.server.db.prepare("SELECT COUNT(*) AS n FROM question_tags WHERE question_id = ? AND is_system = 1").get(q.id).n, 1);
  }));

  test('固定標籤可以被搜尋；舊的 category 參數仍可用', async () => withServer(async (s) => {
    const user = await s.login();
    const q = await post(s, user, { body: '資料', category: 'scam_check' });
    const ids = async (query) => (await s.call('GET', '/questions', { token: user.token, query })).body.data.map((x) => x.id);
    assert.deepEqual(await ids({ tag_q: '詐騙' }), [q.id]);
    assert.deepEqual(await ids({ tag: '疑似詐騙' }), [q.id]);
    assert.deepEqual(await ids({ category: 'scam_check' }), [q.id]);
    const tags = await s.call('GET', '/tags', { token: user.token, query: { q: '詐騙' } });
    assert.deepEqual(tags.body.data.map((t) => t.tag), ['疑似詐騙']);
  }));

  test('舊資料庫升級時補上固定標籤，同名手動標籤轉成固定標籤，重開不會重複', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codefest-tags-'));
    try {
      const old = new Database(path.join(dir, 'app.db'));
      old.exec(`
        CREATE TABLE users (id TEXT PRIMARY KEY, townpass_user_id TEXT NOT NULL UNIQUE, nickname TEXT NOT NULL, points INTEGER NOT NULL DEFAULT 0,
          trust_score INTEGER NOT NULL DEFAULT 0, languages TEXT NOT NULL, nearby_notifications_enabled INTEGER NOT NULL DEFAULT 1, nearby_radius_m INTEGER NOT NULL DEFAULT 1000,
          location_sharing TEXT NOT NULL DEFAULT 'approximate', last_lat REAL, last_lng REAL, location_updated_at TEXT, last_nearby_notified_at TEXT, created_at TEXT NOT NULL);
        CREATE TABLE questions (id TEXT PRIMARY KEY, author_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', title TEXT NOT NULL, title_is_auto INTEGER NOT NULL DEFAULT 0, body TEXT,
          category TEXT NOT NULL, language TEXT NOT NULL, assistance_mode TEXT NOT NULL, location_sharing TEXT NOT NULL, context TEXT, service_id TEXT, approx_lat REAL, approx_lng REAL,
          exact_lat REAL, exact_lng REAL, answer_count INTEGER NOT NULL DEFAULT 0, accepted_answer_id TEXT, client_request_id TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE (author_id, client_request_id));
        CREATE TABLE question_tags (question_id TEXT NOT NULL, tag_key TEXT NOT NULL, tag TEXT NOT NULL, position INTEGER NOT NULL, PRIMARY KEY (question_id, tag_key));
        INSERT INTO users (id, townpass_user_id, nickname, languages, created_at) VALUES ('u', 'u', 'u', '[]', '2026-01-01');
        INSERT INTO questions (id, author_id, title, category, language, assistance_mode, location_sharing, client_request_id, created_at) VALUES
          ('q1', 'u', 't', 'scam_check', 'zh-TW', 'online', 'off', 'a', '2026-01-01'),
          ('q2', 'u', 't', 'other', 'zh-TW', 'online', 'off', 'b', '2026-01-01');
        INSERT INTO question_tags VALUES ('q1', '手動', '手動', 0), ('q2', '其他', '其他', 0);
      `);
      old.close();
      for (let i = 0; i < 2; i++) openDatabase(dir).close();
      const db = openDatabase(dir);
      const rows = db.prepare('SELECT question_id, tag, is_system FROM question_tags ORDER BY question_id, is_system DESC').all().map((r) => ({ ...r }));
      assert.deepEqual(rows, [
        { question_id: 'q1', tag: '疑似詐騙', is_system: 1 },
        { question_id: 'q1', tag: '手動', is_system: 0 },
        { question_id: 'q2', tag: '其他', is_system: 1 },
      ]);
      db.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('討論串排序', () => {
  const H = 3600e3;
  const withServer = async (run) => {
    const s = await startTestServer({ adminTownpassIds: ['root'] });
    try { await run(s); } finally { await s.stop(); }
  };
  const ago = (ms) => new Date(Date.now() - ms).toISOString();
  const age = (s, id, ms) => s.server.db.prepare('UPDATE questions SET created_at = ? WHERE id = ?').run(ago(ms), id);
  const newQ = async (s, user, createdAgo = 0) => {
    const q = (await s.call('POST', '/questions', { token: user.token, body: s.question() })).body.data;
    if (createdAgo) age(s, q.id, createdAgo);
    return q;
  };
  const reply = async (s, user, id, repliedAgo = 0) => {
    const a = (await s.call('POST', '/questions/{question_id}/answers', { token: user.token, params: { question_id: id }, body: { body: '回答' } })).body.data;
    if (repliedAgo) s.server.db.prepare('UPDATE answers SET created_at = ? WHERE id = ?').run(ago(repliedAgo), a.id);
    return a;
  };
  const up = (s, user, id) => s.call('PUT', '/answers/{answer_id}/vote', { token: user.token, params: { answer_id: id }, body: { value: 1 } });
  const feed = async (s, user, query = {}) => (await s.call('GET', '/questions', { token: user.token, query })).body;
  const logins = (s, n) => Promise.all(Array.from({ length: n }, () => s.login()));

  test('依約定的七層順序排列', async () => withServer(async (s) => {
    const [asker, r1, r2, r3, r4, viewer] = await logins(s, 6);
    const resolved = await newQ(s, asker);
    await s.call('POST', '/questions/{question_id}/resolve', { token: asker.token, params: { question_id: resolved.id } });

    const quiet = await newQ(s, asker, 5 * H);
    for (const r of [r1, r2, r3, r4]) await reply(s, r, quiet.id, 3 * H);
    const active = await newQ(s, asker, 5 * H);
    for (const r of [r1, r2, r3, r4]) await reply(s, r, active.id);
    const supported = await newQ(s, asker, 5 * H);
    await up(s, viewer, (await reply(s, r1, supported.id)).id);
    const fresh = await newQ(s, asker);
    const unverified = await newQ(s, asker, 5 * H);
    await reply(s, r1, unverified.id);
    const waiting = await newQ(s, asker, 3 * H);

    const ids = (await feed(s, viewer)).data.map((q) => q.id);
    assert.deepEqual(ids, [waiting.id, unverified.id, fresh.id, supported.id, active.id, quiet.id, resolved.id]);
  }));

  test('同層內：等越久越前面；久未回覆的少人貼文在前；多人討論最近的在前', async () => withServer(async (s) => {
    const [asker, a, b, c, d, viewer] = await logins(s, 6);
    const q3h = await newQ(s, asker, 3 * H);
    const q5h = await newQ(s, asker, 5 * H);
    assert.deepEqual((await feed(s, viewer)).data.map((q) => q.id), [q5h.id, q3h.id]);
    s.server.db.exec('DELETE FROM question_tags; DELETE FROM questions');

    const recent = await newQ(s, asker);
    await reply(s, a, recent.id, 10 * 60e3);
    const stale = await newQ(s, asker);
    await reply(s, a, stale.id, H);
    assert.deepEqual((await feed(s, viewer)).data.map((q) => q.id), [stale.id, recent.id]);

    const older = await newQ(s, asker);
    for (const r of [a, b, c, d]) await reply(s, r, older.id, H);
    const newer = await newQ(s, asker);
    for (const r of [a, b, c, d]) await reply(s, r, newer.id);
    const order = (await feed(s, viewer)).data.map((q) => q.id);
    assert.ok(order.indexOf(newer.id) < order.indexOf(older.id));
  }));

  test('回覆者不算發問者和機器人；只有機器人回覆算待確認；自己按讚不算認同', async () => withServer(async (s) => {
    const [asker, helper, viewer] = await logins(s, 3);
    const selfOnly = await newQ(s, asker, 3 * H);
    await reply(s, asker, selfOnly.id);
    const db = s.server.db;
    db.prepare("INSERT INTO users (id, townpass_user_id, nickname, languages, role, created_at) VALUES ('u_b', 'b', 'b', '[]', 'bot', ?)").run(ago(0));
    const botOnly = await newQ(s, asker);
    db.prepare("INSERT INTO answers (id, question_id, author_id, body, created_at) VALUES ('a_b', ?, 'u_b', 'x', ?)").run(botOnly.id, ago(0));
    const selfVoted = await newQ(s, asker);
    const answer = await reply(s, helper, selfVoted.id);
    await up(s, helper, answer.id);
    const freshEmpty = await newQ(s, asker);
    const ids = (await feed(s, viewer)).data.map((q) => q.id);
    assert.equal(ids[0], selfOnly.id, '只有自己回覆仍算無人回覆');
    assert.ok(ids.indexOf(botOnly.id) < ids.indexOf(freshEmpty.id), '只有機器人回覆要優先確認');
    assert.ok(ids.indexOf(selfVoted.id) < ids.indexOf(freshEmpty.id), '自己按讚不算有人認同');
  }));

  test('太舊或低可信度作者的貼文不加權，避免一直佔住最前面', async () => withServer(async (s) => {
    const [asker, low, viewer] = await logins(s, 3);
    const ancient = await newQ(s, asker, 8 * 24 * H);
    const spam = await newQ(s, low, 3 * H);
    s.server.db.prepare('UPDATE users SET trust_score = -11 WHERE id = ?').run(low.user.id);
    const fresh = await newQ(s, asker);
    const resolved = await newQ(s, asker);
    await s.call('POST', '/questions/{question_id}/resolve', { token: asker.token, params: { question_id: resolved.id } });
    const ids = (await feed(s, viewer)).data.map((q) => q.id);
    assert.equal(ids[0], fresh.id);
    assert.equal(ids.at(-1), resolved.id);
    for (const id of [ancient.id, spam.id]) assert.ok(ids.indexOf(id) < ids.indexOf(resolved.id));
  }));

  test('下滑翻頁沿用第一頁順序，途中有變動也不重複不遺漏；上滑重新排序', async () => withServer(async (s) => {
    const [asker, helper, viewer] = await logins(s, 3);
    const created = [];
    for (let i = 0; i < 6; i++) created.push(await newQ(s, asker, (i + 3) * H));
    const first = await feed(s, viewer, { limit: '2' });
    const top = first.data[0].id;
    await reply(s, helper, top);
    const extra = await newQ(s, asker, 100 * H);

    const seen = first.data.map((q) => q.id);
    let cursor = first.next_cursor;
    while (cursor) {
      const page = await feed(s, viewer, { limit: '2', cursor });
      seen.push(...page.data.map((q) => q.id));
      cursor = page.next_cursor;
    }
    assert.equal(new Set(seen).size, seen.length, '沒有重複');
    assert.deepEqual([...seen].sort(), created.map((q) => q.id).sort(), '翻頁時不插入新貼文，也不漏掉');

    const refreshed = (await feed(s, viewer, { limit: '10' })).data.map((q) => q.id);
    assert.equal(refreshed[0], extra.id, '上滑看到最新排序');
    assert.notEqual(refreshed[0], top);
  }));

  test('翻頁時已刪除的貼文會略過；快照失效時仍可繼續', async () => withServer(async (s) => {
    const [asker, viewer] = await logins(s, 2);
    const created = [];
    for (let i = 0; i < 4; i++) created.push(await newQ(s, asker, (i + 3) * H));
    const first = await feed(s, viewer, { limit: '2' });
    await s.call('DELETE', '/questions/{question_id}', { token: asker.token, params: { question_id: first.data.length ? created[0].id : '' } });
    const second = await feed(s, viewer, { limit: '2', cursor: first.next_cursor });
    assert.ok(second.data.every((q) => q.id !== created[0].id));
    const forged = Buffer.from(JSON.stringify({ s: 's_missing', o: 1 })).toString('base64url');
    const recovered = await s.call('GET', '/questions', { token: viewer.token, query: { limit: '2', cursor: forged } });
    assert.equal(recovered.status, 200, recovered.raw);
    assert.equal(recovered.body.data.length, 2);
  }));

  test('author=me 和明確指定 sort 都依原本方式；篩選條件仍生效', async () => withServer(async (s) => {
    const [asker, helper, viewer] = await logins(s, 3);
    const older = await newQ(s, asker, 5 * H);
    const newer = await newQ(s, asker);
    assert.deepEqual((await feed(s, asker, { author: 'me' })).data.map((q) => q.id), [newer.id, older.id]);
    assert.deepEqual((await feed(s, viewer, { sort: 'latest' })).data.map((q) => q.id), [newer.id, older.id]);
    assert.deepEqual((await feed(s, viewer, { sort: 'attention' })).data.map((q) => q.id), [older.id, newer.id]);
    const other = await newQ(s, helper);
    s.server.db.prepare("UPDATE questions SET category = 'scam_check' WHERE id = ?").run(other.id);
    assert.deepEqual((await feed(s, viewer, { category: 'scam_check' })).data.map((q) => q.id), [other.id]);
    assert.equal((await s.call('GET', '/questions', { token: viewer.token, query: { sort: 'nope' } })).status, 400);
    const near = (await s.call('POST', '/questions', { token: asker.token, body: s.question({ location_sharing: 'approximate', location: TAIPEI }) })).body.data;
    const nearby = await feed(s, viewer, { scope: 'nearby', lat: String(TAIPEI.lat), lng: String(TAIPEI.lng) });
    assert.deepEqual(nearby.data.map((q) => q.id), [near.id]);
  }));
});
