import { Router } from 'express';
import { validationError } from '../errors.js';
import { requireBodyObject, requireEnum } from '../util.js';

// 裝置的 FCM token 以 token 為唯一鍵；使用者一律取自登入 token，不信任前端傳的使用者 ID。
export function pushRoutes({ push }) {
  const router = Router();

  const parseToken = (raw) => {
    if (raw.length > 4096 || !/^[\x21-\x7e]+$/.test(raw)) throw validationError('push token 格式不正確', { field: 'token' });
    return raw;
  };

  router.put('/push-tokens/:token', (req, res) => {
    const token = parseToken(req.params.token);
    const body = requireBodyObject(req.body);
    const platform = requireEnum(body.platform, ['android', 'ios'], 'platform');
    push.register(req.user.id, token, platform);
    res.status(204).end();
  });

  router.delete('/push-tokens/:token', (req, res) => {
    push.unregister(req.user.id, parseToken(req.params.token));
    res.status(204).end();
  });

  return router;
}
