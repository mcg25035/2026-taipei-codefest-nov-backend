import { newId, nowIso } from './util.js';

// 管理員操作一律留紀錄，刪除和修改會保留原內容，方便事後追查和還原。
export function createAudit(db) {
  const insert = db.prepare(`
    INSERT INTO admin_actions (id, admin_id, action, target_type, target_id, detail, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  return {
    record(adminId, action, targetType, targetId, detail = {}) {
      insert.run(newId('ad'), adminId, action, targetType, targetId, JSON.stringify(detail), nowIso());
    },
  };
}
