import crypto from 'node:crypto';
import { Router } from 'express';
import { ApiError, validationError } from '../errors.js';
import { snap } from '../geo.js';
import { RESERVED_ID_PREFIX } from '../semanticCache.js';
import { serializeNotification } from '../notifications.js';
import { meUser } from '../serialize.js';
import {
  LOCATION_LEVELS, newId, nowIso, optionalString, parseCoordinates, parseLanguage,
  requireBodyObject, requireEnum, requireString, sha256,
} from '../util.js';

export function publicSessionRoutes({ db, config }) {
  const setRole = db.prepare('UPDATE users SET role = ? WHERE id = ?');
  const router = Router();
  const findUser = db.prepare('SELECT * FROM users WHERE townpass_user_id = ?');
  const insertUser = db.prepare(`
    INSERT INTO users (id, townpass_user_id, nickname, languages, created_at) VALUES (?, ?, ?, ?, ?)
  `);
  const insertSession = db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)');

  router.post('/sessions', (req, res) => {
    const body = requireBodyObject(req.body);
    const townpassUserId = requireString(body, 'townpass_user_id', { max: 128 });
    if (townpassUserId.startsWith(RESERVED_ID_PREFIX)) throw validationError('這個 ID 保留給系統使用', { field: 'townpass_user_id' });
    const nickname = optionalString(body, 'nickname', { min: 1, max: 30 });
    const language = body.language === undefined ? 'zh-TW' : parseLanguage(body.language);

    let user = findUser.get(townpassUserId);
    if (!user) {
      const id = newId('u');
      insertUser.run(id, townpassUserId, nickname ?? `市民${id.slice(-4)}`, JSON.stringify([language]), nowIso());
      user = findUser.get(townpassUserId);
    }
    if (user.banned_at) throw new ApiError(403, 'ACCOUNT_BANNED', '這個帳號已被停權');
    const listedRole = config.adminTownpassIds.includes(townpassUserId) ? 'admin'
      : config.botTownpassIds.includes(townpassUserId) ? 'bot' : null;
    if (listedRole && user.role !== listedRole) {
      setRole.run(listedRole, user.id);
      user = findUser.get(townpassUserId);
    }

    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + config.sessionTtlDays * 86_400_000).toISOString();
    insertSession.run(sha256(token), user.id, expiresAt);
    res.status(201).json({ data: { token, expires_at: expiresAt, user: meUser(user) } });
  });

  return router;
}

export function meRoutes({ db, config, notifier }) {
  const router = Router();
  const getUser = db.prepare('SELECT * FROM users WHERE id = ?');
  const clearLocation = db.prepare('UPDATE users SET last_lat = NULL, last_lng = NULL, location_updated_at = NULL WHERE id = ?');
  const saveLocation = db.prepare('UPDATE users SET last_lat = ?, last_lng = ?, location_updated_at = ? WHERE id = ?');
  const pending = db.prepare(`
    SELECT * FROM notifications WHERE user_id = ? AND delivered_at IS NULL ORDER BY created_at, id LIMIT 50
  `);
  const markDelivered = db.prepare('UPDATE notifications SET delivered_at = ? WHERE id = ?');

  router.get('/me', (req, res) => res.json({ data: meUser(req.user) }));

  router.patch('/me', (req, res) => {
    const body = requireBodyObject(req.body);
    const updates = {};
    if (body.nickname !== undefined) updates.nickname = requireString(body, 'nickname', { max: 30 });
    if (body.languages !== undefined) {
      if (!Array.isArray(body.languages)) throw validationError('languages 必須是陣列', { field: 'languages' });
      updates.languages = JSON.stringify(body.languages.map((l) => parseLanguage(l, 'languages')));
    }
    if (body.nearby_notifications_enabled !== undefined) {
      if (typeof body.nearby_notifications_enabled !== 'boolean') {
        throw validationError('nearby_notifications_enabled 必須是布林值', { field: 'nearby_notifications_enabled' });
      }
      updates.nearby_notifications_enabled = Number(body.nearby_notifications_enabled);
    }
    if (body.nearby_radius_m !== undefined) {
      const r = body.nearby_radius_m;
      if (!Number.isInteger(r) || r < 100 || r > 5000) throw validationError('nearby_radius_m 必須介於 100 到 5000', { field: 'nearby_radius_m' });
      updates.nearby_radius_m = r;
    }
    if (body.location_sharing !== undefined) {
      updates.location_sharing = requireEnum(body.location_sharing, LOCATION_LEVELS, 'location_sharing');
    }
    const fields = Object.keys(updates);
    if (!fields.length) throw validationError('至少要更新一個欄位');

    const apply = db.transaction(() => {
      db.prepare(`UPDATE users SET ${fields.map((f) => `${f} = @${f}`).join(', ')} WHERE id = @id`).run({ ...updates, id: req.user.id });
      const level = updates.location_sharing;
      if (level === 'off') clearLocation.run(req.user.id);
      // 從具體位置降為模糊位置時，已保存的精確座標也要換成網格點。
      if (level === 'approximate' && req.user.last_lat !== null) {
        const p = snap({ lat: req.user.last_lat, lng: req.user.last_lng });
        saveLocation.run(p.lat, p.lng, req.user.location_updated_at, req.user.id);
      }
    });
    apply();
    res.json({ data: meUser(getUser.get(req.user.id)) });
  });

  router.post('/me/heartbeat', (req, res) => {
    const body = requireBodyObject(req.body);
    requireEnum(body.app_state, ['foreground', 'background'], 'app_state');
    const location = body.location === undefined || body.location === null ? null : parseCoordinates(body.location);

    if (location && req.user.location_sharing !== 'off') {
      const stored = req.user.location_sharing === 'exact' ? location : snap(location);
      saveLocation.run(stored.lat, stored.lng, nowIso(), req.user.id);
      notifier.notifyQuestionNearUser(getUser.get(req.user.id));
    }

    const rows = pending.all(req.user.id);
    const deliveredAt = nowIso();
    for (const row of rows) markDelivered.run(deliveredAt, row.id);
    res.json({ data: { notifications: rows.map(serializeNotification), next_heartbeat_seconds: config.heartbeatSeconds } });
  });

  return router;
}
