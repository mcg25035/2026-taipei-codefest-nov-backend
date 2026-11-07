import { Router } from 'express';
import { notFound, validationError } from '../errors.js';
import { nowIso, optionalString, requireBodyObject, requireString } from '../util.js';

export function deviceRoutes({ db }) {
  const router = Router();
  const removeSameToken = db.prepare('DELETE FROM devices WHERE fcm_token = ? AND installation_id != ?');
  const upsert = db.prepare(`
    INSERT INTO devices (installation_id, user_id, fcm_token, app_version, updated_at) VALUES (@id, @user, @token, @version, @now)
    ON CONFLICT (installation_id) DO UPDATE SET
      user_id = excluded.user_id, fcm_token = excluded.fcm_token, app_version = excluded.app_version, updated_at = excluded.updated_at
  `);
  const remove = db.prepare('DELETE FROM devices WHERE installation_id = ? AND user_id = ?');

  const parseId = (req) => {
    const id = req.params.id;
    if (!id || id.length > 128) throw validationError('installation_id 不正確', { field: 'installation_id' });
    return id;
  };

  router.put('/devices/:id', (req, res) => {
    const id = parseId(req);
    const body = requireBodyObject(req.body);
    const token = requireString(body, 'fcm_token', { max: 4096 });
    const version = optionalString(body, 'app_version', { max: 64 });
    db.transaction(() => {
      // 同一支手機換帳號時，舊帳號的通知不可以再送到這支手機。
      removeSameToken.run(token, id);
      upsert.run({ id, user: req.user.id, token, version, now: nowIso() });
    })();
    res.status(204).end();
  });

  router.delete('/devices/:id', (req, res) => {
    if (!remove.run(parseId(req), req.user.id).changes) throw notFound();
    res.status(204).end();
  });

  return router;
}
