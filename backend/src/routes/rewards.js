import { Router } from 'express';
import { notFound } from '../errors.js';
import { BADGES } from '../rewards.js';
import { publicUser } from '../serialize.js';
import { decodeCursor, encodeCursor, parseLimit } from '../util.js';

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const originOf = (req, config) => config.publicBaseUrl ?? `${req.protocol}://${req.get('host')}`;

function createBadgeSerializer({ db, config }) {
  const earnedOf = db.prepare('SELECT badge_id, earned_at FROM user_badges WHERE user_id = ?');
  return (req, userId) => {
    const origin = originOf(req, config);
    const earned = new Map(earnedOf.all(userId).map((b) => [b.badge_id, b.earned_at]));
    return BADGES.map((badge) => ({
      id: badge.id,
      name: badge.name,
      description: badge.description,
      image_url: `${origin}/badges/${badge.id}.svg`,
      earned: earned.has(badge.id),
      earned_at: earned.get(badge.id) ?? null,
      share_url: earned.has(badge.id) ? `${origin}/share/${userId}/${badge.id}` : null,
    }));
  };
}

// 徽章圖片和分享頁是給社群平台抓取的，所以不需要 token。
export function publicRewardRoutes({ db, config }) {
  const router = Router();
  const userById = db.prepare('SELECT * FROM users WHERE id = ?');
  const earned = db.prepare('SELECT 1 FROM user_badges WHERE user_id = ? AND badge_id = ?');
  const findBadge = (id) => {
    const badge = BADGES.find((b) => b.id === id);
    if (!badge) throw notFound();
    return badge;
  };

  router.get('/badges/:file', (req, res) => {
    const badge = findBadge(req.params.file.replace(/\.svg$/, ''));
    res.type('image/svg+xml').send(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><circle cx="60" cy="60" r="56" fill="${badge.color}"/>` +
      `<path d="M36 62l16 16 32-36" fill="none" stroke="#fff" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    );
  });

  router.get('/share/:userId/:badgeId', (req, res) => {
    const badge = findBadge(req.params.badgeId);
    const user = userById.get(req.params.userId);
    if (!user || !earned.get(user.id, badge.id)) throw notFound();
    const title = escapeHtml(`${user.nickname} 獲得「${badge.name}」徽章`);
    const description = escapeHtml(badge.description);
    const image = escapeHtml(`${originOf(req, config)}/badges/${badge.id}.svg`);
    res.type('html').send(`<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<meta property="og:title" content="${title}"><meta property="og:description" content="${description}"><meta property="og:image" content="${image}">
</head><body style="font-family:sans-serif;text-align:center;padding:48px 16px"><img src="${image}" alt="" width="120" height="120">
<h1 style="font-size:22px">${title}</h1><p>${description}</p></body></html>`);
  });

  return router;
}

export function publicRewardApiRoutes({ db, config, rewards }) {
  const router = Router();
  const userById = db.prepare('SELECT * FROM users WHERE id = ?');
  const badgesOf = createBadgeSerializer({ db, config });
  router.get('/users/:id', (req, res) => {
    const user = userById.get(req.params.id);
    if (!user) throw notFound();
    const stats = rewards.stats(user.id);
    res.json({
      data: {
        ...publicUser(user),
        accepted_answer_count: stats.accepted,
        completed_assist_count: stats.assists,
        badges: badgesOf(req, user.id).filter((b) => b.earned),
      },
    });
  });
  return router;
}

export function rewardRoutes({ db, config }) {
  const router = Router();
  const badgesOf = createBadgeSerializer({ db, config });

  router.get('/badges', (req, res) => res.json({ data: badgesOf(req, req.user.id) }));

  router.get('/me/point-transactions', (req, res) => {
    const limit = parseLimit(req.query);
    const cursor = decodeCursor(req.query.cursor);
    const clauses = ['user_id = @user'];
    const params = { user: req.user.id, limit: limit + 1 };
    if (cursor) {
      clauses.push('(created_at, id) < (@cursorAt, @cursorId)');
      params.cursorAt = String(cursor.c);
      params.cursorId = String(cursor.i);
    }
    const rows = db.prepare(`SELECT * FROM point_transactions WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT @limit`).all(params);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    res.json({
      data: page.map((row) => ({
        id: row.id, amount: row.amount, reason: row.reason,
        ...(row.question_id && { question_id: row.question_id }),
        created_at: row.created_at,
      })),
      next_cursor: rows.length > limit ? encodeCursor({ c: last.created_at, i: last.id }) : null,
    });
  });

  return router;
}
