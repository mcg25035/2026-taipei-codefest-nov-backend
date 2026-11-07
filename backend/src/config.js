export function loadConfig(overrides = {}) {
  const env = process.env;
  const corsOrigin = env.CORS_ORIGIN?.trim() || '*';
  return {
    host: env.HOST || '0.0.0.0',
    port: Number(env.PORT ?? 5121),
    dataDir: env.DATA_DIR || './data',
    firebaseServiceAccountFile: env.FIREBASE_SERVICE_ACCOUNT_FILE || null,
    publicBaseUrl: env.PUBLIC_BASE_URL?.replace(/\/$/, '') || null,
    corsOrigin: corsOrigin === '*' ? '*' : corsOrigin.split(',').map((s) => s.trim()),
    sessionTtlDays: 30,
    heartbeatSeconds: 60,
    ssePingMs: 25_000,
    points: { answerAccepted: 10, assistCompleted: 30 },
    trust: { answerAccepted: 5, assistCompleted: 10, upvote: 1, downvote: -2, lowThreshold: -10 },
    assistMaxDistanceM: 3000,
    mediaPreviewTtlMs: 60 * 60_000,
    nearby: {
      maxRecipients: 20,
      perUserThrottleMs: 10 * 60_000,
      locationFreshMs: 15 * 60_000,
      questionMaxAgeMs: 24 * 60 * 60_000,
    },
    rateLimit: { windowMs: 60_000, questions: 10, answers: 30 },
    piiReportsPerHour: 10,
    classifyPerMinute: 120,
    media: {
      imageMaxBytes: 10 * 1024 * 1024,
      audioMaxBytes: 20 * 1024 * 1024,
      audioMaxSeconds: 180,
      unattachedTtlMs: 24 * 60 * 60_000,
    },
    ...overrides,
  };
}
