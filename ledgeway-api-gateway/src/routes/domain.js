function passthroughHeaders(request, extraHeaders = {}) {
  const headers = { 'content-type': 'application/json' };
  const idempotencyKey = request.headers['idempotency-key'];
  if (idempotencyKey) headers['idempotency-key'] = String(idempotencyKey);
  const authorization = request.headers.authorization;
  if (authorization) headers.authorization = String(authorization);

  for (const [key, value] of Object.entries(extraHeaders)) {
    if (value === undefined || value === null || value === '') continue;
    headers[key] = String(value);
  }

  return headers;
}

function isJsonContentType(contentType) {
  return String(contentType || '').toLowerCase().includes('application/json');
}

function isTextContentType(contentType) {
  const normalized = String(contentType || '').toLowerCase();
  return normalized.startsWith('text/') || normalized.includes('charset=');
}

async function proxy(request, reply, targetUrl, extraHeaders = {}) {
  try {
    const method = request.method.toUpperCase();
    const response = await fetch(targetUrl, {
      method,
      headers: passthroughHeaders(request, extraHeaders),
      body: method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(request.body || {}),
      signal: AbortSignal.timeout(Number(process.env.UPSTREAM_TIMEOUT_MS || 5000)),
    });

    const contentType = response.headers.get('content-type') || 'application/json';
    const contentDisposition = response.headers.get('content-disposition');
    reply.code(response.status).type(contentType);
    if (contentDisposition) {
      reply.header('content-disposition', contentDisposition);
    }

    if (isJsonContentType(contentType)) {
      const text = await response.text();
      if (!text) return reply.send({});
      try {
        return reply.send(JSON.parse(text));
      } catch {
        return reply.send(text);
      }
    }

    if (isTextContentType(contentType)) {
      const text = await response.text();
      if (!text) return reply.send('');
      return reply.send(text);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    return reply.send(buffer);
  } catch {
    return reply.code(502).send({
      error: 'upstream_unavailable',
      targetUrl,
    });
  }
}

async function checkDependency(baseUrl) {
  try {
    const response = await fetch(`${baseUrl}/health`);
    return { ok: response.ok, status: response.status };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

function buildQueryString(query = {}, allowedKeys = []) {
  const params = new URLSearchParams();
  for (const key of allowedKeys) {
    const value = query?.[key];
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const serialized = params.toString();
  return serialized ? `?${serialized}` : '';
}

async function authenticate(authUrl, request) {
  const authorization = request.headers.authorization;
  if (!authorization) return null;

  try {
    const response = await fetch(`${authUrl}/v1/auth/introspect`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: String(authorization),
      },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(Number(process.env.UPSTREAM_TIMEOUT_MS || 5000)),
    });

    if (!response.ok) return null;
    const payload = await response.json();
    if (!payload?.active || !payload?.userId) return null;
    return payload;
  } catch {
    return null;
  }
}

function authHeaders(session) {
  return {
    'x-auth-user-id': session.userId,
    'x-auth-user-role': session.role,
    'x-auth-user-email': session.email,
  };
}

function withAuth(authUrl, handler, options = {}) {
  return async (request, reply) => {
    const session = await authenticate(authUrl, request);
    if (!session) {
      return reply.code(401).send({ error: 'unauthorized' });
    }

    if (options.roles?.length && !options.roles.includes(String(session.role || '').toLowerCase())) {
      return reply.code(403).send({ error: 'forbidden' });
    }

    request.auth = session;
    return handler(request, reply, session);
  };
}

export async function registerDomainRoutes(app) {
  const authUrl = process.env.AUTH_SERVICE_URL || 'http://auth-service:4010';
  const customerUrl = process.env.CUSTOMER_SERVICE_URL || 'http://customer-service:4020';
  const transferUrl = process.env.TRANSFER_SERVICE_URL || 'http://transfers-service:4060';
  const ledgerUrl = process.env.LEDGER_SERVICE_URL || 'http://wallet-ledger-service:4040';
  const operationsUrl = process.env.OPERATIONS_SERVICE_URL || 'http://operations-service:4120';
  const notificationsUrl = process.env.NOTIFICATIONS_SERVICE_URL || 'http://notifications-service:4100';

  app.get('/v1/health/dependencies', async () => {
    const [auth, customer, transfer, ledger, operations, notifications] = await Promise.all([
      checkDependency(authUrl),
      checkDependency(customerUrl),
      checkDependency(transferUrl),
      checkDependency(ledgerUrl),
      checkDependency(operationsUrl),
      checkDependency(notificationsUrl),
    ]);

    return {
      dependencies: {
        authService: auth,
        customerService: customer,
        transfersService: transfer,
        walletLedgerService: ledger,
        operationsService: operations,
        notificationsService: notifications,
      },
    };
  });

  app.post('/v1/auth/register', async (request, reply) => proxy(request, reply, `${authUrl}/v1/auth/register`));
  app.post('/v1/auth/login', async (request, reply) => proxy(request, reply, `${authUrl}/v1/auth/login`));
  app.post('/v1/auth/introspect', async (request, reply) => proxy(request, reply, `${authUrl}/v1/auth/introspect`));

  app.get('/v1/profiles/:userId', withAuth(authUrl, async (request, reply, session) => {
    return proxy(request, reply, `${customerUrl}/v1/profiles/${request.params.userId}`, authHeaders(session));
  }));
  app.post('/v1/beneficiaries', withAuth(authUrl, async (request, reply, session) => {
    return proxy(request, reply, `${customerUrl}/v1/beneficiaries`, authHeaders(session));
  }));
  app.get('/v1/beneficiaries/:userId', withAuth(authUrl, async (request, reply, session) => {
    return proxy(request, reply, `${customerUrl}/v1/beneficiaries/${request.params.userId}`, authHeaders(session));
  }));
  app.post('/v1/kyc/check', withAuth(authUrl, async (request, reply, session) => {
    return proxy(request, reply, `${customerUrl}/v1/kyc/check`, authHeaders(session));
  }));
  app.get('/v1/kyc/:userId/status', withAuth(authUrl, async (request, reply, session) => {
    return proxy(request, reply, `${customerUrl}/v1/kyc/${request.params.userId}/status`, authHeaders(session));
  }));
  app.post('/v1/kyc/:userId/decision', withAuth(authUrl, async (request, reply, session) => {
    return proxy(request, reply, `${customerUrl}/v1/kyc/${request.params.userId}/decision`, authHeaders(session));
  }, { roles: ['ops', 'admin'] }));
  app.get('/v1/rates', withAuth(authUrl, async (request, reply, session) => {
    const query = buildQueryString(request.query, ['fromCurrency', 'toCurrency']);
    return proxy(request, reply, `${transferUrl}/v1/rates${query}`, authHeaders(session));
  }));
  app.post('/v1/rates', withAuth(authUrl, async (request, reply, session) => {
    return proxy(request, reply, `${transferUrl}/v1/rates`, authHeaders(session));
  }, { roles: ['ops', 'admin'] }));
  app.post('/v1/rates/refresh', withAuth(authUrl, async (request, reply, session) => {
    return proxy(request, reply, `${transferUrl}/v1/rates/refresh`, authHeaders(session));
  }, { roles: ['ops', 'admin'] }));
  app.get('/v1/notifications/:notificationId', withAuth(authUrl, async (request, reply, session) => {
    return proxy(request, reply, `${notificationsUrl}/v1/notifications/${request.params.notificationId}`, authHeaders(session));
  }));
  app.post('/v1/notifications/:notificationId/read', withAuth(authUrl, async (request, reply, session) => {
    return proxy(request, reply, `${notificationsUrl}/v1/notifications/${request.params.notificationId}/read`, authHeaders(session));
  }));

  app.post('/v1/quotes', withAuth(authUrl, async (request, reply, session) => {
    return proxy(request, reply, `${transferUrl}/v1/quotes`, authHeaders(session));
  }));
  app.get('/v1/quotes/:quoteId', withAuth(authUrl, async (request, reply, session) => {
    return proxy(request, reply, `${transferUrl}/v1/quotes/${request.params.quoteId}`, authHeaders(session));
  }));
  app.post('/v1/transfers', withAuth(authUrl, async (request, reply, session) => {
    return proxy(request, reply, `${transferUrl}/v1/transfers`, authHeaders(session));
  }));
  app.get('/v1/transfers', withAuth(authUrl, async (request, reply, session) => {
    return proxy(request, reply, `${transferUrl}/v1/transfers`, authHeaders(session));
  }));
  app.get('/v1/transfer-schedules', withAuth(authUrl, async (request, reply, session) => {
    return proxy(request, reply, `${transferUrl}/v1/transfer-schedules`, authHeaders(session));
  }));
  app.post('/v1/transfer-schedules', withAuth(authUrl, async (request, reply, session) => {
    return proxy(request, reply, `${transferUrl}/v1/transfer-schedules`, authHeaders(session));
  }));
  app.post('/v1/transfer-schedules/:scheduleId/cancel', withAuth(authUrl, async (request, reply, session) => {
    return proxy(request, reply, `${transferUrl}/v1/transfer-schedules/${request.params.scheduleId}/cancel`, authHeaders(session));
  }));
  app.get('/v1/transfers/:transferId', withAuth(authUrl, async (request, reply, session) => {
    return proxy(request, reply, `${transferUrl}/v1/transfers/${request.params.transferId}`, authHeaders(session));
  }));
  app.post('/v1/transfers/:transferId/cancel', withAuth(authUrl, async (request, reply, session) => {
    return proxy(request, reply, `${transferUrl}/v1/transfers/${request.params.transferId}/cancel`, authHeaders(session));
  }));

  app.get('/v1/wallets', withAuth(authUrl, async (request, reply, session) => {
    const query = buildQueryString(request.query, ['userId']);
    return proxy(request, reply, `${ledgerUrl}/v1/wallets${query}`, authHeaders(session));
  }));
  app.post('/v1/wallets', withAuth(authUrl, async (request, reply, session) => {
    return proxy(request, reply, `${ledgerUrl}/v1/wallets`, authHeaders(session));
  }));
  app.post('/v1/wallets/:walletId/topup', withAuth(authUrl, async (request, reply, session) => {
    return proxy(request, reply, `${ledgerUrl}/v1/wallets/${request.params.walletId}/topup`, authHeaders(session));
  }));
  app.get('/v1/wallets/:walletId/balance', withAuth(authUrl, async (request, reply, session) => {
    return proxy(request, reply, `${ledgerUrl}/v1/wallets/${request.params.walletId}/balance`, authHeaders(session));
  }));

  app.get('/v1/pots', withAuth(authUrl, async (request, reply, session) => {
    const query = buildQueryString(request.query, ['walletId']);
    return proxy(request, reply, `${ledgerUrl}/v1/pots${query}`, authHeaders(session));
  }));
  app.post('/v1/pots', withAuth(authUrl, async (request, reply, session) => {
    return proxy(request, reply, `${ledgerUrl}/v1/pots`, authHeaders(session));
  }));
  app.post('/v1/pots/:potId/deposit', withAuth(authUrl, async (request, reply, session) => {
    return proxy(request, reply, `${ledgerUrl}/v1/pots/${request.params.potId}/deposit`, authHeaders(session));
  }));
  app.post('/v1/pots/:potId/withdraw', withAuth(authUrl, async (request, reply, session) => {
    return proxy(request, reply, `${ledgerUrl}/v1/pots/${request.params.potId}/withdraw`, authHeaders(session));
  }));
  app.post('/v1/pots/transfer', withAuth(authUrl, async (request, reply, session) => {
    return proxy(request, reply, `${ledgerUrl}/v1/pots/transfer`, authHeaders(session));
  }));

  app.get('/v1/cards', withAuth(authUrl, async (request, reply, session) => {
    const query = buildQueryString(request.query, ['walletId']);
    return proxy(request, reply, `${ledgerUrl}/v1/cards${query}`, authHeaders(session));
  }));
  app.post('/v1/cards', withAuth(authUrl, async (request, reply, session) => {
    return proxy(request, reply, `${ledgerUrl}/v1/cards`, authHeaders(session));
  }));
  app.post('/v1/cards/:cardId/freeze', withAuth(authUrl, async (request, reply, session) => {
    return proxy(request, reply, `${ledgerUrl}/v1/cards/${request.params.cardId}/freeze`, authHeaders(session));
  }));
  app.post('/v1/cards/:cardId/unfreeze', withAuth(authUrl, async (request, reply, session) => {
    return proxy(request, reply, `${ledgerUrl}/v1/cards/${request.params.cardId}/unfreeze`, authHeaders(session));
  }));
  app.post('/v1/cards/:cardId/charge', withAuth(authUrl, async (request, reply, session) => {
    return proxy(request, reply, `${ledgerUrl}/v1/cards/${request.params.cardId}/charge`, authHeaders(session));
  }));

  app.get('/v1/payments/internal', withAuth(authUrl, async (request, reply, session) => {
    const query = buildQueryString(request.query, ['walletId']);
    return proxy(request, reply, `${ledgerUrl}/v1/payments/internal${query}`, authHeaders(session));
  }));
  app.post('/v1/payments/internal', withAuth(authUrl, async (request, reply, session) => {
    return proxy(request, reply, `${ledgerUrl}/v1/payments/internal`, authHeaders(session));
  }));

  app.get('/v1/ledger/entries', withAuth(authUrl, async (request, reply, session) => {
    const walletId = request.query?.walletId;
    const target = walletId ? `${ledgerUrl}/v1/ledger/entries?walletId=${encodeURIComponent(walletId)}` : `${ledgerUrl}/v1/ledger/entries`;
    return proxy(request, reply, target, authHeaders(session));
  }));
  app.get('/v1/statements/:walletId', withAuth(authUrl, async (request, reply, session) => {
    const query = buildQueryString(request.query, ['from', 'to']);
    return proxy(request, reply, `${ledgerUrl}/v1/statements/${request.params.walletId}${query}`, authHeaders(session));
  }));
  app.get('/v1/statements/:walletId/export', withAuth(authUrl, async (request, reply, session) => {
    const query = buildQueryString(request.query, ['from', 'to', 'format']);
    return proxy(request, reply, `${ledgerUrl}/v1/statements/${request.params.walletId}/export${query}`, authHeaders(session));
  }));

  app.post('/v1/reconciliation/runs', withAuth(authUrl, async (request, reply, session) => {
    return proxy(request, reply, `${operationsUrl}/v1/reconciliation/runs`, authHeaders(session));
  }, { roles: ['ops', 'admin'] }));
  app.get('/v1/reconciliation/runs/:runId', withAuth(authUrl, async (request, reply, session) => {
    return proxy(request, reply, `${operationsUrl}/v1/reconciliation/runs/${request.params.runId}`, authHeaders(session));
  }, { roles: ['ops', 'admin'] }));
  app.get('/v1/audit/events', withAuth(authUrl, async (request, reply, session) => {
    const query = buildQueryString(request.query, ['entityId', 'action', 'limit']);
    return proxy(request, reply, `${operationsUrl}/v1/audit/events${query}`, authHeaders(session));
  }, { roles: ['ops', 'admin'] }));
  app.get('/v1/feature-flags', withAuth(authUrl, async (request, reply, session) => {
    return proxy(request, reply, `${operationsUrl}/v1/feature-flags`, authHeaders(session));
  }));
  app.post('/v1/feature-flags', withAuth(authUrl, async (request, reply, session) => {
    return proxy(request, reply, `${operationsUrl}/v1/feature-flags`, authHeaders(session));
  }, { roles: ['ops', 'admin'] }));

  app.post('/v1/notifications/send', withAuth(authUrl, async (request, reply, session) => {
    return proxy(request, reply, `${notificationsUrl}/v1/notifications/send`, authHeaders(session));
  }));
  app.get('/v1/notifications', withAuth(authUrl, async (request, reply, session) => {
    const query = buildQueryString(request.query, ['userId']);
    return proxy(request, reply, `${notificationsUrl}/v1/notifications${query}`, authHeaders(session));
  }));

  app.post('/v1/webhooks/subscriptions', withAuth(authUrl, async (request, reply) => {
    return reply.code(410).send({ error: 'feature_disabled', feature: 'webhooks' });
  }, { roles: ['ops', 'admin'] }));
  app.post('/v1/webhooks/deliveries', withAuth(authUrl, async (request, reply) => {
    return reply.code(410).send({ error: 'feature_disabled', feature: 'webhooks' });
  }, { roles: ['ops', 'admin'] }));
  app.get('/v1/webhooks/deliveries', withAuth(authUrl, async (request, reply) => {
    return reply.code(410).send({ error: 'feature_disabled', feature: 'webhooks' });
  }, { roles: ['ops', 'admin'] }));
}
