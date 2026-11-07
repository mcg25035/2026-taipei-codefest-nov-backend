import fs from 'node:fs';

// 服務帳戶金鑰可用檔案路徑或整份 JSON 傳入；都沒有時停用 FCM 推播。
function loadServiceAccount(env) {
  const file = env.FCM_SERVICE_ACCOUNT_FILE?.trim();
  const raw = env.FCM_SERVICE_ACCOUNT_JSON?.trim() || (file && fs.readFileSync(file, 'utf8'));
  if (!raw) return null;
  const account = JSON.parse(raw);
  for (const field of ['project_id', 'client_email', 'private_key']) {
    if (!account[field]) throw new Error(`FCM 服務帳戶金鑰缺少 ${field}`);
  }
  return account;
}

const idList = (value) => (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);

export function loadConfig(overrides = {}) {
  const env = process.env;
  const corsOrigin = env.CORS_ORIGIN?.trim() || '*';
  return {
    host: env.HOST || '0.0.0.0',
    port: Number(env.PORT ?? 5121),
    dataDir: env.DATA_DIR || './data',
    publicBaseUrl: env.PUBLIC_BASE_URL?.replace(/\/$/, '') || null,
    corsOrigin: corsOrigin === '*' ? '*' : corsOrigin.split(',').map((s) => s.trim()),
    // 目前相信前端傳來的 ID；這些名單內的 ID 登入時會取得對應身份。
    adminTownpassIds: idList(env.ADMIN_TOWNPASS_IDS),
    botTownpassIds: idList(env.BOT_TOWNPASS_IDS),
    // 文字向量服務；未設定時不啟用語意快取。
    embeddingUrl: env.EMBEDDING_URL?.replace(/\/$/, '') || null,
    semanticCacheThreshold: Number(env.SEMANTIC_CACHE_THRESHOLD ?? 0.88),
    embeddingBackfillMs: 60_000,
    sessionTtlDays: 30,
    heartbeatSeconds: 60,
    push: {
      serviceAccount: loadServiceAccount(env),
      channelId: env.FCM_CHANNEL_ID?.trim() || 'TownPass android notification id',
      // 點擊通知後開啟的網址樣板，{question_id} 會被替換；設為空字串時推播不帶 url。
      questionUrl: env.PUSH_QUESTION_URL === undefined
        ? 'https://tp2026.ydtw.net/?question={question_id}'
        : env.PUSH_QUESTION_URL.trim() || null,
      maxTokensPerUser: 10,
      maxAttempts: 3,
      retryBaseMs: 1000,
    },
    // 測試用：取代 FCM 傳輸層，介面同 createFcmTransport。
    pushTransport: null,
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
      videoMaxBytes: 20 * 1024 * 1024,
      videoMaxSeconds: 60,
      unattachedTtlMs: 24 * 60 * 60_000,
    },
    ...overrides,
  };
}
