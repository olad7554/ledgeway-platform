import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { registerDomainRoutes } from './routes/domain.js';

const serviceName = process.env.SERVICE_NAME || 'api-gateway';
const port = Number(process.env.PORT || 8080);

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || 'info',
    ...(process.env.NODE_ENV !== 'production'
      ? { transport: { target: 'pino-pretty', options: { translateTime: 'SYS:standard' } } }
      : {}),
  },
});

await app.register(cors, { origin: true });

app.get('/', async () => ({
  service: serviceName,
  message: 'Ledgeway API Gateway',
  docs: {
    health: '/health',
    ready: '/ready',
    info: '/info',
    dependencies: '/v1/health/dependencies',
  },
  domains: {
    auth: ['/v1/auth/register', '/v1/auth/login', '/v1/auth/introspect'],
    customer: ['/v1/profiles/:userId', '/v1/kyc/check', '/v1/kyc/:userId/status', '/v1/kyc/:userId/decision'],
    people: ['/v1/beneficiaries', '/v1/beneficiaries/:userId'],
    quotes: ['/v1/quotes', '/v1/quotes/:quoteId', '/v1/rates', '/v1/rates/refresh'],
    transfers: ['/v1/transfers', '/v1/transfers/:transferId', '/v1/transfers/:transferId/cancel'],
    wallets: ['/v1/wallets', '/v1/wallets/:walletId/topup', '/v1/wallets/:walletId/balance', '/v1/ledger/entries'],
    pots: ['/v1/pots', '/v1/pots/:potId/deposit', '/v1/pots/:potId/withdraw', '/v1/pots/transfer'],
    cards: ['/v1/cards', '/v1/cards/:cardId/freeze', '/v1/cards/:cardId/unfreeze', '/v1/cards/:cardId/charge'],
    payments: ['/v1/payments/internal'],
    operations: ['/v1/reconciliation/runs', '/v1/reconciliation/runs/:runId', '/v1/audit/events'],
    notifications: ['/v1/notifications/send', '/v1/notifications', '/v1/notifications/:notificationId', '/v1/notifications/:notificationId/read'],
  },
}));

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

await registerDomainRoutes(app);

try {
  await app.listen({ host: '0.0.0.0', port });
  app.log.info({ service: serviceName, port }, 'service started');
} catch (error) {
  app.log.error({ error }, 'failed to start service');
  process.exit(1);
}
