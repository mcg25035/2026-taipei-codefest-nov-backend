// 討論串的預設排序：先處理最需要人看的貼文，避免有貼文一直沒人理。
export const TIER = {
  WAITING_LONG: 1, // 無人回覆，等很久了
  UNVERIFIED: 2, // 少數人回覆或只有機器人，還沒有人按讚，可能有誤導
  WAITING_SHORT: 3, // 無人回覆，剛發不久
  SUPPORTED: 4, // 少數人回覆，已有人按讚
  ACTIVE: 5, // 多人回覆，最近還在討論
  QUIET: 6, // 多人回覆但近期沒討論，或太舊、作者可信度低
  RESOLVED: 7, // 已解決
};

const MAX_FEW_PEOPLE = 3;

export function attentionTier(row, now, config) {
  const { recentMs, maxAgeMs, lowTrust } = config;
  if (row.status === 'resolved') return TIER.RESOLVED;
  // 太舊或作者可信度低的貼文不加權，否則會一直佔住最前面。
  if (now - Date.parse(row.created_at) > maxAgeMs || row.author_trust < lowTrust) return TIER.QUIET;
  if (row.people > MAX_FEW_PEOPLE) {
    return now - Date.parse(row.last_activity) <= recentMs ? TIER.ACTIVE : TIER.QUIET;
  }
  if (row.people === 0 && row.bots === 0) {
    return now - Date.parse(row.created_at) > recentMs ? TIER.WAITING_LONG : TIER.WAITING_SHORT;
  }
  return row.has_support ? TIER.SUPPORTED : TIER.UNVERIFIED;
}

// 同一層內的排序：等待類越久越前面；討論類最近的在前；已解決新的在前。
const compareWithinTier = {
  [TIER.WAITING_LONG]: (a, b) => a.created_at.localeCompare(b.created_at),
  [TIER.WAITING_SHORT]: (a, b) => a.created_at.localeCompare(b.created_at),
  [TIER.UNVERIFIED]: (a, b) => a.last_activity.localeCompare(b.last_activity),
  [TIER.SUPPORTED]: (a, b) => a.last_activity.localeCompare(b.last_activity),
  [TIER.ACTIVE]: (a, b) => b.last_activity.localeCompare(a.last_activity),
  [TIER.QUIET]: (a, b) => b.last_activity.localeCompare(a.last_activity),
  [TIER.RESOLVED]: (a, b) => b.created_at.localeCompare(a.created_at),
};

export function rankByAttention(rows, now, config) {
  return rows
    .map((row) => ({ row, tier: attentionTier(row, now, config) }))
    .sort((a, b) => (
      a.tier - b.tier || compareWithinTier[a.tier](a.row, b.row) || a.row.id.localeCompare(b.row.id)
    ))
    .map(({ row }) => row);
}

// 翻頁時沿用第一頁的順序，否則有人回覆就會換層，造成重複或漏掉。
export function createSnapshotStore({ ttlMs, maxEntries, newId }) {
  const snapshots = new Map();
  return {
    save(ids) {
      const now = Date.now();
      for (const [key, value] of snapshots) if (value.expires <= now) snapshots.delete(key);
      while (snapshots.size >= maxEntries) snapshots.delete(snapshots.keys().next().value);
      const id = newId('s');
      snapshots.set(id, { ids, expires: now + ttlMs });
      return id;
    },
    get(id) {
      const found = snapshots.get(id);
      return found && found.expires > Date.now() ? found.ids : null;
    },
  };
}
