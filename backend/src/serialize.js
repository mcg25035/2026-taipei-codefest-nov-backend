import { distanceM, publicDistanceM } from './geo.js';

export const publicUser = (row) => ({ id: row.id, nickname: row.nickname, points: row.points });

// 可信度評分和倒讚數只留在後端，不可加進任何 serializer。
export const meUser = (row) => ({
  ...publicUser(row),
  languages: JSON.parse(row.languages),
  nearby_notifications_enabled: Boolean(row.nearby_notifications_enabled),
  nearby_radius_m: row.nearby_radius_m,
  location_sharing: row.location_sharing,
});

export function createSerializers({ db, config, signatures }) {
  const userById = db.prepare('SELECT * FROM users WHERE id = ?');
  const questionById = db.prepare('SELECT * FROM questions WHERE id = ?');
  const questionMedia = db.prepare('SELECT * FROM media WHERE question_id = ? ORDER BY position');
  const answerMedia = db.prepare('SELECT * FROM media WHERE answer_id = ? ORDER BY position');
  const myVote = db.prepare('SELECT value FROM votes WHERE answer_id = ? AND user_id = ?');
  const pendingReports = db.prepare(`
    SELECT media_id, text_field FROM pii_reports WHERE target_type = ? AND target_id = ? AND status = 'pending'
  `);
  const assistStatus = db.prepare(`
    SELECT status FROM assists WHERE question_id = ? AND status != 'cancelled' ORDER BY claimed_at DESC, id DESC LIMIT 1
  `);

  const origin = (req) => config.publicBaseUrl ?? `${req.protocol}://${req.get('host')}`;
  const mediaUrl = (req, id, signed = false) => `${origin(req)}/media/${id}${signed ? `?${signatures.query(id)}` : ''}`;

  const media = (req, row, signed = false) => ({
    id: row.id,
    kind: row.kind,
    url: mediaUrl(req, row.id, signed),
    ...(row.width !== null && { width: row.width, height: row.height }),
    ...(row.duration_seconds !== null && { duration_seconds: row.duration_seconds }),
  });

  // 個資待確認時，內容只給發問者和內容作者看；其他人只知道有內容被隱藏。
  const visibility = (targetType, targetId, canSeeHidden) => {
    const reports = pendingReports.all(targetType, targetId);
    const hiddenMedia = new Set(reports.filter((r) => r.media_id).map((r) => r.media_id));
    const bodyHidden = reports.some((r) => r.text_field === 'body');
    const titleHidden = reports.some((r) => r.text_field === 'title');
    const parts = [
      ...(bodyHidden || titleHidden ? [{ part: 'body', reason: 'pii_pending' }] : []),
      ...[...hiddenMedia].map((id) => ({ part: 'media', media_id: id, reason: 'pii_pending' })),
    ];
    return {
      parts,
      hideBody: bodyHidden && !canSeeHidden,
      hideTitle: titleHidden && !canSeeHidden,
      isMediaHidden: (id) => hiddenMedia.has(id) && !canSeeHidden,
      needsSignature: (id) => hiddenMedia.has(id),
    };
  };

  const questionVisibility = (req, row) => visibility('question', row.id, row.author_id === req.user?.id);

  const canClaim = (req, row, viewerPoint) => {
    const user = req.user;
    if (row.assistance_mode === 'online' || row.status !== 'open' || row.author_id === user.id) return false;
    if (user.location_sharing === 'off' || user.trust_score < config.trust.lowThreshold) return false;
    return !viewerPoint || distanceM(viewerPoint, { lat: row.approx_lat, lng: row.approx_lng }) <= config.assistMaxDistanceM;
  };

  const questionSummary = (req, row, viewerPoint = null) => {
    const seen = questionVisibility(req, row);
    const files = questionMedia.all(row.id).filter((f) => !seen.isMediaHidden(f.id));
    const firstImage = files.find((f) => f.kind === 'image');
    return {
      id: row.id,
      status: row.status,
      title: seen.hideTitle || (seen.hideBody && row.title_is_auto) ? null : row.title,
      category: row.category,
      language: row.language,
      assistance_mode: row.assistance_mode,
      location_sharing: row.location_sharing,
      author: publicUser(userById.get(row.author_id)),
      context: row.context ? JSON.parse(row.context) : null,
      area: row.approx_lat === null ? null : {
        approx_lat: row.approx_lat,
        approx_lng: row.approx_lng,
        district: null,
        distance_m: viewerPoint ? publicDistanceM(viewerPoint, { lat: row.approx_lat, lng: row.approx_lng }) : null,
      },
      thumbnail_url: firstImage ? mediaUrl(req, firstImage.id, seen.needsSignature(firstImage.id)) : null,
      has_audio: files.some((f) => f.kind === 'audio'),
      has_video: files.some((f) => f.kind === 'video'),
      answer_count: row.answer_count,
      reward_points: row.assistance_mode === 'online' ? config.points.answerAccepted : config.points.assistCompleted,
      can_claim: canClaim(req, row, viewerPoint),
      hidden_parts: seen.parts,
      created_at: row.created_at,
    };
  };

  const questionDetail = (req, row) => {
    const seen = questionVisibility(req, row);
    return {
      ...questionSummary(req, row),
      body: seen.hideBody ? null : row.body,
      media: questionMedia.all(row.id)
        .filter((f) => !seen.isMediaHidden(f.id))
        .map((f) => media(req, f, seen.needsSignature(f.id))),
      is_author: row.author_id === req.user.id,
      accepted_answer_id: row.accepted_answer_id,
      assist_status: assistStatus.get(row.id)?.status ?? null,
    };
  };

  const voteSummary = (row, userId) => ({
    upvotes: row.upvotes,
    my_vote: myVote.get(row.id, userId)?.value ?? null,
  });

  const answer = (req, row) => {
    const canSeeHidden = row.author_id === req.user.id || questionById.get(row.question_id).author_id === req.user.id;
    const seen = visibility('answer', row.id, canSeeHidden);
    return {
      id: row.id,
      question_id: row.question_id,
      author: publicUser(userById.get(row.author_id)),
      body: seen.hideBody ? null : row.body,
      media: answerMedia.all(row.id)
        .filter((f) => !seen.isMediaHidden(f.id))
        .map((f) => media(req, f, seen.needsSignature(f.id))),
      ...(row.language && { language: row.language }),
      is_accepted: Boolean(row.is_accepted),
      votes: voteSummary(row, req.user.id),
      hidden_parts: seen.parts,
      created_at: row.created_at,
    };
  };

  return { media, questionSummary, questionDetail, answer, voteSummary };
}
