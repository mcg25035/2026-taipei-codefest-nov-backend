import { nowIso } from './util.js';

export const BADGES = [
  { id: 'first-accepted', name: '第一次幫上忙', description: '第一則回答被採納', color: '#2f80ed', earned: (s) => s.accepted >= 1 },
  { id: 'helper-10', name: '熱心市民', description: '累積 10 則回答被採納', color: '#27ae60', earned: (s) => s.accepted >= 10 },
  { id: 'first-onsite', name: '現場幫手', description: '完成第一次現場協助', color: '#f2994a', earned: (s) => s.assists >= 1 },
  { id: 'onsite-5', name: '城市守護者', description: '累積完成 5 次現場協助', color: '#9b51e0', earned: (s) => s.assists >= 5 },
];

export function createRewards({ db, notifier }) {
  const acceptedCount = db.prepare('SELECT COUNT(*) AS n FROM answers WHERE author_id = ? AND is_accepted = 1');
  const assistCount = db.prepare("SELECT COUNT(*) AS n FROM assists WHERE helper_id = ? AND status = 'completed'");
  const insertBadge = db.prepare('INSERT OR IGNORE INTO user_badges (user_id, badge_id, earned_at) VALUES (?, ?, ?)');

  const stats = (userId) => ({ accepted: acceptedCount.get(userId).n, assists: assistCount.get(userId).n });

  return {
    stats,
    awardBadges(userId) {
      const current = stats(userId);
      for (const badge of BADGES) {
        if (badge.earned(current) && insertBadge.run(userId, badge.id, nowIso()).changes) {
          notifier.create({ userId, type: 'badge_earned', title: '獲得新徽章', body: `恭喜獲得「${badge.name}」` });
        }
      }
    },
  };
}
