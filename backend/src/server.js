import { createServer } from './app.js';

const server = createServer();
const { host, port } = server.config;

server.httpServer.listen(port, host, () => {
  console.log(`API listening on http://${host}:${port}/api/v1`);
});

const shutdown = async () => {
  await server.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
