import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import cors from 'cors';
import express from 'express';
import { createAuth } from './auth.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db.js';
import { errorMiddleware, notFound } from './errors.js';
import { createNotifier, serializeNotification } from './notifications.js';
import { createFcmTransport, createPush } from './push.js';
import { createRealtime } from './realtime.js';
import { meRoutes, publicSessionRoutes } from './routes/account.js';
import { answerRoutes } from './routes/answers.js';
import { mediaRoutes, publicMediaRoutes, startMediaCleanup } from './routes/media.js';
import { metaRoutes } from './routes/meta.js';
import { notificationRoutes } from './routes/notifications.js';
import { assistRoutes } from './routes/assists.js';
import { piiRoutes } from './routes/pii.js';
import { pushRoutes } from './routes/push.js';
import { questionRoutes } from './routes/questions.js';
import { publicRewardRoutes, publicRewardApiRoutes, rewardRoutes } from './routes/rewards.js';
import { createRewards } from './rewards.js';
import { createSignatures } from './signatures.js';
import { createSerializers } from './serialize.js';
import { createRateLimiter } from './util.js';

export function createServer(overrides = {}) {
  const config = loadConfig(overrides);
  const db = openDatabase(config.dataDir);
  const auth = createAuth(db);
  const app = express();
  const httpServer = http.createServer(app);

  let realtime;
  const getRealtime = () => realtime;
  realtime = createRealtime({ httpServer, db, auth, config, serializeNotification });

  const signatures = createSignatures({ db, config });
  const push = createPush({
    db,
    config,
    transport: config.pushTransport ?? (config.push.serviceAccount && createFcmTransport(config.push.serviceAccount)),
  });
  const notifier = createNotifier({ db, config, getRealtime, push });
  const deps = {
    db, config, getRealtime, notifier, signatures, push,
    serializers: createSerializers({ db, config, signatures }),
    rewards: createRewards({ db, config, notifier }),
    limiter: createRateLimiter(config.rateLimit.windowMs),
    hourlyLimiter: createRateLimiter(60 * 60_000),
    removeMediaFiles: (rows) => Promise.all(
      rows.map((row) => fs.rm(path.join(config.dataDir, 'media', row.filename), { force: true })),
    ),
  };

  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use(cors({ origin: config.corsOrigin }));
  app.use(express.json({ limit: '256kb' }));

  app.use(publicMediaRoutes(deps));
  app.use(publicRewardRoutes(deps));

  const api = express.Router();
  api.use(metaRoutes(deps));
  api.use(publicSessionRoutes(deps));
  api.use(publicRewardApiRoutes(deps));
  api.use(auth.requireAuth);
  api.use(meRoutes(deps));
  api.use(mediaRoutes(deps));
  api.use(questionRoutes(deps));
  api.use(answerRoutes(deps));
  api.use(assistRoutes(deps));
  api.use(piiRoutes(deps));
  api.use(rewardRoutes(deps));
  api.use(notificationRoutes(deps));
  api.use(pushRoutes(deps));
  app.use('/api/v1', api);

  app.use(() => { throw notFound('找不到這個路徑'); });
  app.use(errorMiddleware);

  const cleanup = startMediaCleanup(deps);

  return {
    httpServer,
    db,
    config,
    push,
    async close() {
      clearInterval(cleanup);
      await push.close();
      await realtime.close();
      await new Promise((resolve) => httpServer.close(resolve));
      db.close();
    },
  };
}
