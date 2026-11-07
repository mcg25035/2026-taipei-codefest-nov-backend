import { Server } from 'socket.io';
import { nowIso } from './util.js';

// Socket.IO 只發「有更新」的訊號，資料一律由前端用 REST 重抓；個人通知走 SSE。
export function createRealtime({ httpServer, db, auth, config, serializeNotification }) {
  const io = new Server(httpServer, { cors: { origin: config.corsOrigin } });

  io.use((socket, next) => {
    const user = auth.userFromToken(socket.handshake.auth?.token);
    if (!user) return next(new Error('UNAUTHORIZED'));
    socket.data.userId = user.id;
    next();
  });

  io.on('connection', (socket) => {
    socket.join(`user:${socket.data.userId}`);
    const ack = (cb) => { if (typeof cb === 'function') cb({ ok: true }); };
    socket.on('feed:subscribe', (cb) => { socket.join('feed'); ack(cb); });
    socket.on('feed:unsubscribe', (cb) => { socket.leave('feed'); ack(cb); });
    const questionRoom = (payload) => (typeof payload?.question_id === 'string' ? `question:${payload.question_id}` : null);
    socket.on('question:subscribe', (payload, cb) => {
      const room = questionRoom(payload);
      if (room) socket.join(room);
      ack(cb);
    });
    socket.on('question:unsubscribe', (payload, cb) => {
      const room = questionRoom(payload);
      if (room) socket.leave(room);
      ack(cb);
    });
  });

  const streams = new Map();
  const markDelivered = db.prepare('UPDATE notifications SET delivered_at = ? WHERE id = ?');
  const undelivered = db.prepare(`
    SELECT * FROM notifications WHERE user_id = ? AND delivered_at IS NULL ORDER BY created_at, id LIMIT 50
  `);

  const writeNotification = (res, row) => {
    res.write(`event: notification.created\ndata: ${JSON.stringify(serializeNotification(row))}\n\n`);
    markDelivered.run(nowIso(), row.id);
  };

  return {
    feedChanged: () => io.to('feed').emit('feed.changed'),
    questionChanged: (questionId) => io.to(`question:${questionId}`).emit('question.changed', { question_id: questionId }),
    answersChanged: (questionId) => io.to(`question:${questionId}`).emit('answers.changed', { question_id: questionId }),
    assistChanged: (questionId, userIds) => {
      for (const userId of userIds) io.to(`user:${userId}`).emit('assist.changed', { question_id: questionId });
    },
    piiReportsChanged: (userId) => io.to(`user:${userId}`).emit('pii_reports.changed'),

    deliverNotification(row) {
      const connections = streams.get(row.user_id);
      if (!connections?.size) return false;
      for (const res of connections) res.write(`event: notification.created\ndata: ${JSON.stringify(serializeNotification(row))}\n\n`);
      markDelivered.run(nowIso(), row.id);
      return true;
    },

    openNotificationStream(req, res) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders();
      res.write(': connected\n\n');
      for (const row of undelivered.all(req.user.id)) writeNotification(res, row);

      const connections = streams.get(req.user.id) ?? new Set();
      connections.add(res);
      streams.set(req.user.id, connections);

      const ping = setInterval(() => res.write(': ping\n\n'), config.ssePingMs);
      req.on('close', () => {
        clearInterval(ping);
        connections.delete(res);
        if (!connections.size) streams.delete(req.user.id);
      });
    },

    close() {
      for (const connections of streams.values()) for (const res of connections) res.end();
      return io.close();
    },
  };
}
