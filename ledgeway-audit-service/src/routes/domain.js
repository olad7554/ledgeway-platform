import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const eventSchema = z.object({
  actor: z.string().min(2),
  action: z.string().min(2),
  entityType: z.string().min(2),
  entityId: z.string().min(2),
  metadata: z.record(z.any()).optional(),
});

const featureFlagSchema = z.object({
  key: z.string().min(2).max(80).regex(/^[a-z0-9_]+$/),
  enabled: z.boolean(),
  description: z.string().max(240).optional(),
  audience: z.enum(['all', 'ops', 'members']).optional(),
});

async function fetchJson(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(Number(process.env.UPSTREAM_TIMEOUT_MS || 5000)),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`request_failed:${response.status}:${text}`);
  }

  return response.json();
}

function toAgeMinutes(isoDate) {
  if (!isoDate) return null;
  const timestamp = new Date(isoDate).getTime();
  if (Number.isNaN(timestamp)) return null;
  return Math.floor((Date.now() - timestamp) / 60_000);
}

export async function registerDomainRoutes(app, { store }) {
  if (!store) {
    throw new Error('operations_store_missing');
  }

  app.post('/v1/audit/events', async (request, reply) => {
    const parsed = eventSchema.safeParse(request.body || {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation_error', details: parsed.error.flatten() });
    }

    const event = await store.createAuditEvent(parsed.data);
    return reply.code(201).send({ event });
  });

  app.get('/v1/audit/events', async (request) => {
    const { entityId, action, limit } = request.query || {};
    return {
      events: await store.listAuditEvents({ entityId, action, limit }),
    };
  });

  app.get('/v1/feature-flags', async () => ({
    flags: await store.listFeatureFlags(),
  }));

  app.post('/v1/feature-flags', async (request, reply) => {
    const parsed = featureFlagSchema.safeParse(request.body || {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation_error', details: parsed.error.flatten() });
    }

    const updatedBy = String(
      request.headers['x-auth-user-email']
        || request.headers['x-auth-user-id']
        || 'system'
    );

    const flag = await store.upsertFeatureFlag({
      ...parsed.data,
      updatedBy,
    });

    return reply.code(201).send({ flag });
  });

  app.post('/v1/reconciliation/runs', async (request, reply) => {
    const transferUrl = process.env.TRANSFER_SERVICE_URL || 'http://transfers-service:4060';
    const notificationsUrl = process.env.NOTIFICATIONS_SERVICE_URL || 'http://notifications-service:4100';
    const staleTransferMinutes = Number(process.env.STALE_TRANSFER_MINUTES || 5);
    const staleNotificationMinutes = Number(process.env.STALE_NOTIFICATION_MINUTES || 5);
    const discrepancies = [];

    let transfers = [];
    let notifications = [];

    try {
      transfers = (await fetchJson(`${transferUrl}/internal/transfers`)).transfers || [];
    } catch (error) {
      discrepancies.push({ type: 'transfer_service_unavailable', detail: String(error) });
    }

    try {
      notifications = (await fetchJson(`${notificationsUrl}/internal/notifications`)).notifications || [];
    } catch (error) {
      discrepancies.push({ type: 'notifications_service_unavailable', detail: String(error) });
    }

    for (const transfer of transfers) {
      if (transfer.status !== 'processing') continue;
      const ageMinutes = toAgeMinutes(transfer.updatedAt || transfer.createdAt);
      if (ageMinutes !== null && ageMinutes >= staleTransferMinutes) {
        discrepancies.push({
          type: 'stale_processing_transfer',
          transferId: transfer.transferId,
          status: transfer.status,
          ageMinutes,
        });
      }
    }

    for (const notification of notifications) {
      if (!['queued', 'pending'].includes(notification.status)) continue;
      const ageMinutes = toAgeMinutes(notification.createdAt);
      if (ageMinutes !== null && ageMinutes >= staleNotificationMinutes) {
        discrepancies.push({
          type: 'stale_notification',
          notificationId: notification.notificationId,
          channel: notification.channel,
          ageMinutes,
        });
      }
    }

    const run = {
      runId: `ops_${randomUUID()}`,
      createdAt: new Date().toISOString(),
      transferCount: transfers.length,
      notificationCount: notifications.length,
      discrepancyCount: discrepancies.length,
      discrepancies,
      status: discrepancies.length === 0 ? 'completed_clean' : 'completed_with_findings',
    };

    return reply.code(201).send({ run: await store.createReconciliationRun(run) });
  });

  app.get('/v1/reconciliation/runs/:runId', async (request, reply) => {
    const run = await store.getReconciliationRun(request.params.runId);
    if (!run) return reply.code(404).send({ error: 'run_not_found' });
    return { run };
  });
}
