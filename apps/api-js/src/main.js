import { createApp } from './app.js';
import { config } from './config.js';
import { prisma } from './db.js';

const server = createApp().listen(config.port, () => {
  console.log(`Godamo is running on http://localhost:${config.port}`);
  console.log(`  web app: http://localhost:${config.port}/login`);
  console.log(`  API:     http://localhost:${config.port}/api/v1`);
});

async function shutdown() {
  server.close();
  await prisma.$disconnect();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
