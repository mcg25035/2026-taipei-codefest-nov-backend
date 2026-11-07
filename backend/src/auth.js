import { ApiError } from './errors.js';
import { nowIso, sha256 } from './util.js';

export function createAuth(db) {
  const findSession = db.prepare(`
    SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?
  `);
  const userFromToken = (token) => (token ? findSession.get(sha256(token), nowIso()) ?? null : null);

  const requireAuth = (req, res, next) => {
    const match = /^Bearer (.+)$/.exec(req.get('authorization') ?? '');
    const user = userFromToken(match?.[1]);
    if (!user) throw new ApiError(401, 'UNAUTHORIZED', 'token 缺少或已失效');
    req.user = user;
    next();
  };

  return { requireAuth, userFromToken };
}
