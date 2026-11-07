import { ApiError, forbidden } from './errors.js';
import { nowIso, sha256 } from './util.js';

export function createAuth(db) {
  const findSession = db.prepare(`
    SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?
  `);
  const sessionUser = (token) => (token ? findSession.get(sha256(token), nowIso()) ?? null : null);
  const userFromToken = (token) => {
    const user = sessionUser(token);
    return user && !user.banned_at ? user : null;
  };

  const requireAuth = (req, res, next) => {
    const match = /^Bearer (.+)$/.exec(req.get('authorization') ?? '');
    const user = sessionUser(match?.[1]);
    if (!user) throw new ApiError(401, 'UNAUTHORIZED', 'token 缺少或已失效');
    if (user.banned_at) throw new ApiError(403, 'ACCOUNT_BANNED', '這個帳號已被停權');
    req.user = user;
    next();
  };

  const requireAdmin = (req, res, next) => {
    if (req.user.role !== 'admin') throw forbidden('只有管理員可以操作');
    next();
  };

  return { requireAuth, requireAdmin, userFromToken };
}
