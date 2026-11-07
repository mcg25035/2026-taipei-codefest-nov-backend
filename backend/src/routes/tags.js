import { Router } from 'express';
import { validationError } from '../errors.js';
import { matchTagKeys, tagKey } from '../tags.js';
import { parseLimit } from '../util.js';

export function tagRoutes({ db }) {
  const router = Router();
  // 同一個 key 可能有不同寫法，顯示最多人用的那個。
  const summary = db.prepare(`
    SELECT tag_key, COUNT(*) AS question_count,
      (SELECT t.tag FROM question_tags t WHERE t.tag_key = o.tag_key GROUP BY t.tag ORDER BY COUNT(*) DESC, t.tag LIMIT 1) AS tag
    FROM question_tags o GROUP BY tag_key
  `);

  router.get('/tags', (req, res) => {
    const limit = parseLimit(req.query);
    const { q } = req.query;
    const rows = summary.all();
    if (q === undefined) {
      const data = rows
        .sort((a, b) => b.question_count - a.question_count || a.tag.localeCompare(b.tag))
        .slice(0, limit)
        .map(({ tag, question_count }) => ({ tag, question_count, score: 1 }));
      return res.json({ data });
    }
    if (typeof q !== 'string' || !tagKey(q) || [...q].length > 50) {
      throw validationError('q 必須是 1 到 50 字的文字', { field: 'q' });
    }
    const scores = matchTagKeys(q, rows.map((r) => r.tag_key));
    const data = rows
      .filter((r) => scores.has(r.tag_key))
      .map(({ tag, question_count, tag_key }) => ({ tag, question_count, score: Number(scores.get(tag_key).toFixed(3)) }))
      .sort((a, b) => b.score - a.score || b.question_count - a.question_count)
      .slice(0, limit);
    res.json({ data });
  });

  return router;
}
