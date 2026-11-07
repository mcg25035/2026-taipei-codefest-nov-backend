import { validationError } from './errors.js';

const MAX_TAGS = 5;
const MAX_LENGTH = 20;
const MIN_SCORE = 0.6;
const ALLOWED = /^[\p{L}\p{N}\p{M} _\-·]+$/u;

// 比對用的 key：全半形、大小寫、臺/台和分隔符號都視為相同。
export const tagKey = (text) => String(text)
  .normalize('NFKC')
  .toLowerCase()
  .replaceAll('臺', '台')
  .replace(/[\s_\-·#]+/g, '');

export function parseTags(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_TAGS) {
    throw validationError(`tags 必須是最多 ${MAX_TAGS} 個標籤的陣列`, { field: 'tags' });
  }
  const byKey = new Map();
  for (const raw of value) {
    const invalid = () => validationError(`標籤必須是 1 到 ${MAX_LENGTH} 字的文字或數字`, { field: 'tags' });
    if (typeof raw !== 'string') throw invalid();
    const tag = raw.normalize('NFKC').replace(/^#+/, '').trim().replace(/\s+/g, ' ');
    const key = tagKey(tag);
    if (!key || [...tag].length > MAX_LENGTH || !ALLOWED.test(tag)) throw invalid();
    if (!byKey.has(key)) byKey.set(key, tag);
  }
  return [...byKey].map(([key, tag]) => ({ key, tag }));
}

const bigrams = (chars) => chars.slice(0, -1).map((c, i) => c + chars[i + 1]);

function dice(a, b) {
  const x = bigrams(a);
  const y = bigrams(b);
  if (!x.length || !y.length) return 0;
  const counts = new Map();
  for (const g of x) counts.set(g, (counts.get(g) ?? 0) + 1);
  let hits = 0;
  for (const g of y) {
    if (counts.get(g) > 0) { hits++; counts.set(g, counts.get(g) - 1); }
  }
  return (2 * hits) / (x.length + y.length);
}

function editSimilarity(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length);
}

// 0 到 1 的相似度：完全相同 > 互相包含 > 詞序不同或打錯字。
export function tagSimilarity(queryKey, key) {
  if (queryKey === key) return 1;
  const q = [...queryKey];
  const k = [...key];
  if (key.includes(queryKey)) return 0.7 + 0.3 * (q.length / k.length);
  if (k.length >= 2 && queryKey.includes(key)) return 0.6 + 0.3 * (k.length / q.length);
  if (q.length < 2 || k.length < 2) return 0;
  const score = Math.max(dice(q, k), editSimilarity(q, k));
  return score >= MIN_SCORE ? score : 0;
}

export function matchTagKeys(query, keys) {
  const queryKey = tagKey(query);
  if (!queryKey) return new Map();
  const scores = new Map();
  for (const key of keys) {
    const score = tagSimilarity(queryKey, key);
    if (score > 0) scores.set(key, score);
  }
  return scores;
}
