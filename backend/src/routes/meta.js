import { Router } from 'express';
import { CATEGORIES, LANGUAGES } from '../util.js';

export function metaRoutes({ config }) {
  const router = Router();
  router.get('/healthz', (req, res) => res.json({ status: 'ok' }));
  router.get('/meta', (req, res) => res.json({
    data: {
      categories: Object.entries(CATEGORIES).map(([id, label]) => ({ id, label })),
      languages: LANGUAGES,
      points: { answer_accepted: config.points.answerAccepted, assist_completed: config.points.assistCompleted },
      limits: {
        question_body_max_chars: 5000,
        media_per_post_max: 5,
        image_max_bytes: config.media.imageMaxBytes,
        audio_max_bytes: config.media.audioMaxBytes,
        audio_max_seconds: config.media.audioMaxSeconds,
      },
    },
  }));
  return router;
}
