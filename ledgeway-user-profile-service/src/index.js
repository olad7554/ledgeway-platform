import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { registerDomainRoutes } from './routes/domain.js';
import { createArtifactStore } from './artifact-store.js';
import { createCustomerStore } from './store.js';

const serviceName = process.env.SERVICE_NAME || 'customer-service';
const port = Number(process.env.PORT || 4020);

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || 'info',
    ...(process.env.NODE_ENV !== 'production'
      ? { transport: { target: 'pino-pretty', options: { translateTime: 'SYS:standard' } } }
      : {}),
  },
});

const artifactStore = createArtifactStore(app.log);

await app.register(cors, { origin: true });

app.get('/health', async () => ({
  ok: true,
  service: serviceName,
  timestamp: new Date().toISOString(),
}));

app.get('/ready', async () => ({
  ok: true,
  service: serviceName,
  ready: true,
}));

app.get('/info', async () => ({
  service: serviceName,
  version: '0.1.0',
  environment: process.env.NODE_ENV || 'development',
}));

const store = await createCustomerStore();
await registerDomainRoutes(app, { store, artifactStore });

try {
  await app.listen({ host: '0.0.0.0', port });
  app.log.info({ service: serviceName, port, store: store.kind }, 'service started');
} catch (error) {
  app.log.error({ error }, 'failed to start service');
  process.exit(1);
}
