import crypto from 'node:crypto';
import { validationError } from './errors.js';

export const nowIso = () => new Date().toISOString();
export const newId = (prefix) => `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export const CATEGORIES = {
  map_navigation: '地圖與路線',
  admin_procedure: '行政程序',
  document_contract: '公文與合約',
  scam_check: '疑似詐騙',
  app_usage: '城市通操作',
  language: '語言與文字',
  other: '其他',
  uncategorized: '未分類',
};
export const LANGUAGES = ['zh-TW', 'en', 'ja', 'ko', 'vi', 'id', 'th', 'tl'];
export const ASSISTANCE_MODES = ['online', 'onsite', 'either'];
export const QUESTION_STATUSES = ['open', 'in_progress', 'resolved'];
export const LOCATION_LEVELS = ['off', 'approximate', 'exact'];

const LANGUAGE_TAG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

export const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

export function requireBodyObject(body) {
  if (!isObject(body)) throw validationError('請求內容必須是 JSON 物件');
  return body;
}

export function optionalString(obj, field, { max, min = 0 } = {}) {
  const v = obj[field];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw validationError(`${field} 必須是字串`, { field });
  const length = [...v].length;
  if (length < min || (max && length > max)) throw validationError(`${field} 長度不符`, { field, min, max });
  return v;
}

export function requireString(obj, field, options) {
  const v = optionalString(obj, field, { min: 1, ...options });
  if (v === null) throw validationError(`缺少 ${field}`, { field });
  return v;
}

export function requireEnum(value, allowed, field) {
  if (!allowed.includes(value)) throw validationError(`${field} 的值不正確`, { field, allowed });
  return value;
}

export function parseLanguage(value, field = 'language') {
  if (typeof value !== 'string' || !LANGUAGE_TAG.test(value)) {
    throw validationError(`${field} 必須是 BCP 47 語言標籤`, { field });
  }
  return value;
}

export function parseCoordinates(value, field = 'location') {
  const valid =
    isObject(value) &&
    Number.isFinite(value.lat) && value.lat >= -90 && value.lat <= 90 &&
    Number.isFinite(value.lng) && value.lng >= -180 && value.lng <= 180;
  if (!valid) throw validationError(`${field} 必須包含有效的 lat 和 lng`, { field });
  return { lat: value.lat, lng: value.lng };
}

export function parseMediaIds(obj) {
  const ids = obj.media_ids ?? [];
  if (!Array.isArray(ids) || ids.length > 5 || ids.some((id) => typeof id !== 'string') || new Set(ids).size !== ids.length) {
    throw validationError('media_ids 必須是最多 5 個不重複的字串', { field: 'media_ids' });
  }
  return ids;
}

export function queryNumber(query, field, { min, max, integer = false, fallback } = {}) {
  const raw = query[field];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (raw === '' || !Number.isFinite(n) || (integer && !Number.isInteger(n)) || n < min || n > max) {
    throw validationError(`${field} 的值不正確`, { field, min, max });
  }
  return n;
}

export const parseLimit = (query) => queryNumber(query, 'limit', { min: 1, max: 50, integer: true, fallback: 20 });

export const encodeCursor = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

export function decodeCursor(raw) {
  if (raw === undefined) return null;
  try {
    const value = JSON.parse(Buffer.from(String(raw), 'base64url').toString());
    if (isObject(value)) return value;
  } catch { /* 下方統一回傳錯誤 */ }
  throw validationError('cursor 不正確', { field: 'cursor' });
}

export function createRateLimiter(windowMs) {
  const hits = new Map();
  return {
    allow(key, limit) {
      const now = Date.now();
      const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
      if (recent.length >= limit) {
        hits.set(key, recent);
        return false;
      }
      recent.push(now);
      hits.set(key, recent);
      return true;
    },
  };
}
