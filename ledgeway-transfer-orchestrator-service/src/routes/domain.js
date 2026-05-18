import { randomUUID } from 'node:crypto';
import { createClient } from 'redis';
import { z } from 'zod';
import { createFxProvider } from '../fx-provider.js';

const simulationModeEnum = z.enum(['success', 'failed', 'duplicate_callback', 'no_callback']);
const transferScheduleCadenceEnum = z.enum(['once', 'daily', 'weekly', 'monthly']);

const quoteSchema = z.object({
  fromCurrency: z.enum(['USD', 'EUR', 'GBP', 'CAD']),
  toCurrency: z.enum(['USD', 'EUR', 'GBP', 'CAD']),
  amount: z.number().positive(),
});

const upsertRateSchema = z.object({
  fromCurrency: z.enum(['USD', 'EUR', 'GBP', 'CAD']),
  toCurrency: z.enum(['USD', 'EUR', 'GBP', 'CAD']),
  rate: z.number().positive(),
  source: z.string().min(2).optional(),
});

const createTransferSchema = z.object({
  userId: z.string().min(3),
  walletId: z.string().min(3),
  beneficiaryId: z.string().min(3),
  sourceAmount: z.number().positive(),
  sourceCurrency: z.enum(['USD', 'EUR', 'GBP', 'CAD']),
  destinationCurrency: z.enum(['USD', 'EUR', 'GBP', 'CAD']),
  simulationMode: simulationModeEnum.optional(),
  callbackDelayMs: z.number().int().min(0).max(60_000).optional(),
});

const createTransferScheduleSchema = z.object({
  userId: z.string().min(3),
  walletId: z.string().min(3),
  beneficiaryId: z.string().min(3),
  sourceAmount: z.number().positive(),
  sourceCurrency: z.enum(['USD', 'EUR', 'GBP', 'CAD']),
  destinationCurrency: z.enum(['USD', 'EUR', 'GBP', 'CAD']),
  label: z.string().min(2).max(80).optional(),
  cadence: transferScheduleCadenceEnum.default('once'),
  startAt: z.string().datetime(),
  occurrenceLimit: z.number().int().positive().max(365).optional(),
  simulationMode: simulationModeEnum.optional(),
  callbackDelayMs: z.number().int().min(0).max(60_000).optional(),
});

function authContext(request) {
  return {
    userId: request.headers['x-auth-user-id'] ? String(request.headers['x-auth-user-id']) : '',
    role: String(request.headers['x-auth-user-role'] || '').toLowerCase(),
  };
}

function isPrivileged(role) {
  return ['admin', 'ops'].includes(String(role || '').toLowerCase());
}

function ensureAuthenticatedUser(reply, auth) {
  if (!auth.userId) {
    reply.code(401).send({ error: 'unauthorized' });
    return false;
  }
  return true;
}

function ensureTransferAccess(reply, auth, transfer) {
  if (!transfer) {
    reply.code(404).send({ error: 'transfer_not_found' });
    return null;
  }

  if (!ensureAuthenticatedUser(reply, auth)) return null;
  if (transfer.userId !== auth.userId && !isPrivileged(auth.role)) {
    reply.code(403).send({ error: 'forbidden' });
    return null;
  }

  return transfer;
}

function ensureScheduleAccess(reply, auth, schedule) {
  if (!schedule) {
    reply.code(404).send({ error: 'transfer_schedule_not_found' });
    return null;
  }

  if (!ensureAuthenticatedUser(reply, auth)) return null;
  if (schedule.userId !== auth.userId && !isPrivileged(auth.role)) {
    reply.code(403).send({ error: 'forbidden' });
    return null;
  }

  return schedule;
}

async function postJson(url, payload, headers = {}) {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(Number(process.env.UPSTREAM_TIMEOUT_MS || 5000)),
    });

    const text = await response.text();
    let data = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }
    }

    if (!response.ok) {
      const error = new Error(`request_failed:${response.status}`);
      error.context = { status: response.status, data, url };
      throw error;
    }
    return data;
  } catch (error) {
    if (!error?.context) {
      error.context = {
        status: 504,
        data: { error: 'upstream_timeout_or_network_error' },
        url,
      };
    }
    throw error;
  }
}

function toTwoDp(amount) {
  return Number(Number(amount || 0).toFixed(2));
}

function buildQuote({ fromCurrency, toCurrency, amount, rate }) {
  const fee = fromCurrency === toCurrency ? 0 : toTwoDp(Math.max(1, amount * 0.006));
  const destinationAmount = toTwoDp(Math.max(0, (amount - fee) * rate));
  return {
    quoteId: `qte_${randomUUID()}`,
    fromCurrency,
    toCurrency,
    sourceAmount: toTwoDp(amount),
    feeAmount: fee,
    rate,
    destinationAmount,
    expiresAt: new Date(Date.now() + Number(process.env.QUOTE_TTL_MS || 300_000)).toISOString(),
    createdAt: new Date().toISOString(),
  };
}

async function resolveQuote(store, { fromCurrency, toCurrency, amount }) {
  const fxRate = await store.getFxRate(fromCurrency, toCurrency);
  if (!fxRate) {
    throw new Error(`unsupported_currency_pair:${fromCurrency}:${toCurrency}`);
  }

  return buildQuote({
    fromCurrency,
    toCurrency,
    amount,
    rate: Number(fxRate.rate),
  });
}

async function writeAuditEvent(event) {
  const operationsUrl = process.env.OPERATIONS_SERVICE_URL || 'http://operations-service:4120';
  try {
    await postJson(`${operationsUrl}/v1/audit/events`, event);
  } catch {
    // Audit should not fail transfer execution path.
  }
}

function buildIdempotencyFingerprint(payload) {
  return JSON.stringify({
    userId: payload.userId,
    walletId: payload.walletId,
    beneficiaryId: payload.beneficiaryId,
    sourceAmount: payload.sourceAmount,
    sourceCurrency: payload.sourceCurrency,
    destinationCurrency: payload.destinationCurrency,
    simulationMode: payload.simulationMode || process.env.TRANSFER_DEFAULT_MODE || 'success',
    callbackDelayMs: payload.callbackDelayMs || Number(process.env.TRANSFER_PROCESSING_DELAY_MS || 1500),
  });
}

function evaluateTransfer(data) {
  const screeningEnabled = process.env.TRANSFER_SCREENING_ENABLED === 'true';
  if (!screeningEnabled) {
    return { decision: 'approve', reason: 'screening_disabled' };
  }

  if (data.sourceAmount >= Number(process.env.TRANSFER_REJECT_THRESHOLD || 10000)) {
    return { decision: 'reject', reason: 'amount_exceeds_auto_limit' };
  }

  if (data.sourceAmount >= Number(process.env.TRANSFER_REVIEW_THRESHOLD || 5000)) {
    return { decision: 'review', reason: 'manual_review_required' };
  }

  return { decision: 'approve', reason: 'screening_passed' };
}

function ledgerHeadersForTransfer(transfer) {
  return {
    'x-auth-user-id': transfer.userId,
    'x-internal-service': 'transfers-service',
  };
}

function addScheduleCadence(isoDate, cadence) {
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return null;

  if (cadence === 'daily') {
    date.setUTCDate(date.getUTCDate() + 1);
    return date.toISOString();
  }

  if (cadence === 'weekly') {
    date.setUTCDate(date.getUTCDate() + 7);
    return date.toISOString();
  }

  if (cadence === 'monthly') {
    date.setUTCMonth(date.getUTCMonth() + 1);
    return date.toISOString();
  }

  return null;
}

function clearScheduledTransfer(scheduledTransfers, transferId) {
  const timer = scheduledTransfers.get(transferId);
  if (!timer) return;
  clearTimeout(timer);
  scheduledTransfers.delete(transferId);
}

function transferProviderMode() {
  return String(process.env.TRANSFER_PROVIDER_MODE || 'simulator').trim().toLowerCase();
}

function usesExternalTransferProcessor() {
  return transferProviderMode() === 'external_callback';
}

export async function registerDomainRoutes(app, { store }) {
  if (!store) {
    throw new Error('transfer_store_missing');
  }

  const scheduledTransfers = new Map();
  const redisUrl = process.env.TRANSFER_QUEUE_REDIS_URL || process.env.REDIS_URL || '';
  const transferQueueKey = process.env.TRANSFER_QUEUE_KEY || 'ledgeway:transfers:due';
  const transferQueuePollMs = Number(process.env.TRANSFER_QUEUE_POLL_MS || 250);
  let transferQueueClient;
  let transferQueueMode = 'memory';
  let transferQueueWorker;
  const transferSchedulePollMs = Number(process.env.TRANSFER_SCHEDULE_POLL_MS || 1000);
  let transferScheduleWorker;
  const fxProvider = createFxProvider({ store, logger: app.log });

  async function dispatchTransferToExternalProcessor(transfer) {
    const submitUrl = String(process.env.TRANSFER_PROVIDER_SUBMIT_URL || '').trim();
    if (!submitUrl) {
      return transfer;
    }

    const callbackUrl = process.env.TRANSFER_PROVIDER_CALLBACK_URL || '';
    const apiToken = String(process.env.TRANSFER_PROVIDER_API_TOKEN || '').trim();
    await postJson(
      submitUrl,
      {
        transfer: {
          transferId: transfer.transferId,
          processorReference: transfer.processorReference,
          userId: transfer.userId,
          walletId: transfer.walletId,
          beneficiaryId: transfer.beneficiaryId,
          sourceAmount: transfer.sourceAmount,
          sourceCurrency: transfer.sourceCurrency,
          destinationCurrency: transfer.destinationCurrency,
        },
        callback: callbackUrl
          ? {
            url: callbackUrl,
          }
          : undefined,
      },
      apiToken
        ? {
          authorization: `Bearer ${apiToken}`,
        }
        : {}
    );

    const updatedTransfer = await store.withTransferLock(transfer.transferId, async (currentTransfer) => {
      if (!currentTransfer) {
        return currentTransfer;
      }

      return {
        ...currentTransfer,
        updatedAt: new Date().toISOString(),
        events: [...(currentTransfer.events || []), 'submitted_to_external_provider'],
      };
    });

    await writeAuditEvent({
      actor: transfer.userId,
      action: 'transfer_submitted_to_provider',
      entityType: 'transfer',
      entityId: transfer.transferId,
      metadata: {
        processorReference: transfer.processorReference,
        mode: transferProviderMode(),
      },
    });

    return updatedTransfer || transfer;
  }

  async function settleTransferById(transferId) {
    clearScheduledTransfer(scheduledTransfers, transferId);
    return store.withTransferLock(transferId, async (currentTransfer) => {
      if (!currentTransfer || currentTransfer.status !== 'processing') {
        return currentTransfer;
      }

      const ledgerUrl = process.env.LEDGER_SERVICE_URL || 'http://wallet-ledger-service:4040';
      await postJson(
        `${ledgerUrl}/v1/ledger/settle`,
        {
          walletId: currentTransfer.walletId,
          amount: currentTransfer.sourceAmount,
          reference: currentTransfer.transferId,
        },
        ledgerHeadersForTransfer(currentTransfer)
      );

      const updatedTransfer = {
        ...currentTransfer,
        status: 'completed',
        completedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        callbackDueAt: null,
        failureReason: undefined,
        events: [...(currentTransfer.events || []), 'settled'],
      };

      await writeAuditEvent({
        actor: currentTransfer.userId,
        action: 'transfer_completed',
        entityType: 'transfer',
        entityId: currentTransfer.transferId,
        metadata: {
          processorReference: currentTransfer.processorReference,
        },
      });

      return updatedTransfer;
    });
  }

  async function failTransferById(transferId, reason = 'processor_failed') {
    clearScheduledTransfer(scheduledTransfers, transferId);
    return store.withTransferLock(transferId, async (currentTransfer) => {
      if (!currentTransfer || currentTransfer.status !== 'processing') {
        return currentTransfer;
      }

      const ledgerUrl = process.env.LEDGER_SERVICE_URL || 'http://wallet-ledger-service:4040';
      await postJson(
        `${ledgerUrl}/v1/ledger/release`,
        {
          walletId: currentTransfer.walletId,
          amount: currentTransfer.sourceAmount,
          reference: currentTransfer.transferId,
        },
        ledgerHeadersForTransfer(currentTransfer)
      );

      const updatedTransfer = {
        ...currentTransfer,
        status: 'failed',
        failureReason: reason,
        updatedAt: new Date().toISOString(),
        callbackDueAt: null,
        completedAt: undefined,
        events: [...(currentTransfer.events || []), 'released', 'failed'],
      };

      await writeAuditEvent({
        actor: currentTransfer.userId,
        action: 'transfer_failed',
        entityType: 'transfer',
        entityId: currentTransfer.transferId,
        metadata: {
          processorReference: currentTransfer.processorReference,
          reason,
        },
      });

      return updatedTransfer;
    });
  }

  async function enqueueTransferJob(job, dueAtMs) {
    if (transferQueueMode !== 'redis') {
      return false;
    }

    await transferQueueClient.zAdd(transferQueueKey, [{
      score: dueAtMs,
      value: JSON.stringify(job),
    }]);
    return true;
  }

  async function processQueuedTransfer(job) {
    if (usesExternalTransferProcessor()) {
      return;
    }

    const transfer = await store.getTransfer(job.transferId);
    if (!transfer || transfer.status !== 'processing') {
      return;
    }

    const mode = transfer.simulationMode || process.env.TRANSFER_DEFAULT_MODE || 'success';

    try {
      if (mode === 'failed') {
        await failTransferById(transfer.transferId, 'processor_failed');
        return;
      }

      await settleTransferById(transfer.transferId);

      if (mode === 'duplicate_callback' && !job.duplicatePhase) {
        if (!await enqueueTransferJob(
          { transferId: transfer.transferId, duplicatePhase: true },
          Date.now() + 100
        )) {
          setTimeout(() => {
            settleTransferById(transfer.transferId).catch(() => {});
          }, 100);
        }
      }
    } catch (error) {
      await failTransferById(
        transfer.transferId,
        error?.context?.data?.error || error?.message || 'processor_failed'
      );
    }
  }

  async function drainQueuedTransfers() {
    if (transferQueueMode !== 'redis') {
      return;
    }

    const dueJobs = await transferQueueClient.zRangeByScore(transferQueueKey, 0, Date.now(), {
      LIMIT: { offset: 0, count: 20 },
    });

    for (const rawJob of dueJobs) {
      const removed = await transferQueueClient.zRem(transferQueueKey, rawJob);
      if (!removed) continue;

      try {
        await processQueuedTransfer(JSON.parse(rawJob));
      } catch (error) {
        app.log.error({ error, rawJob }, 'failed to process queued transfer');
      }
    }
  }

  async function configureTransferQueue() {
    if (!redisUrl) {
      return;
    }

    try {
      transferQueueClient = createClient({ url: redisUrl });
      transferQueueClient.on('error', (error) => {
        app.log.error({ error }, 'transfer queue redis client error');
      });
      await transferQueueClient.connect();
      transferQueueMode = 'redis';
      transferQueueWorker = setInterval(() => {
        drainQueuedTransfers().catch((error) => {
          app.log.error({ error }, 'failed to drain queued transfers');
        });
      }, transferQueuePollMs);
    } catch (error) {
      app.log.warn({ error, redisUrl }, 'redis transfer queue unavailable, falling back to in-process scheduling');
      transferQueueMode = 'memory';
      transferQueueClient = undefined;
    }
  }

  async function scheduleTransferLifecycle(transfer, options = {}) {
    if (usesExternalTransferProcessor()) {
      clearScheduledTransfer(scheduledTransfers, transfer.transferId);
      return;
    }

    const mode = transfer.simulationMode || process.env.TRANSFER_DEFAULT_MODE || 'success';
    if (mode === 'no_callback') {
      clearScheduledTransfer(scheduledTransfers, transfer.transferId);
      return;
    }

    const callbackDueAt = transfer.callbackDueAt
      ? new Date(transfer.callbackDueAt).getTime()
      : Date.now() + (transfer.callbackDelayMs || Number(process.env.TRANSFER_PROCESSING_DELAY_MS || 1500));

    if (await enqueueTransferJob(
      {
        transferId: transfer.transferId,
        duplicatePhase: Boolean(options.duplicatePhase),
      },
      callbackDueAt
    )) {
      return;
    }

    clearScheduledTransfer(scheduledTransfers, transfer.transferId);

    const delayMs = Math.max(0, callbackDueAt - Date.now());

    const timer = setTimeout(() => {
      scheduledTransfers.delete(transfer.transferId);
      (async () => {
        try {
          await processQueuedTransfer({
            transferId: transfer.transferId,
            duplicatePhase: Boolean(options.duplicatePhase),
          });
        } catch (error) {
          await failTransferById(
            transfer.transferId,
            error?.context?.data?.error || error?.message || 'processor_failed'
          );
        }
      })().catch(() => {});
    }, delayMs);

    scheduledTransfers.set(transfer.transferId, timer);
  }

  async function resolveIdempotentTransfer(auth, idempotencyKey, fingerprint) {
    if (!idempotencyKey) return { type: 'none' };

    const existingRecord = await store.getIdempotencyRecord(idempotencyKey);
    if (!existingRecord) return { type: 'none' };

    if (existingRecord.fingerprint !== fingerprint) {
      return { type: 'conflict' };
    }

    const existingTransfer = await store.getTransfer(existingRecord.transferId);
    if (!existingTransfer) {
      return { type: 'none' };
    }

    if (existingTransfer.userId !== auth.userId && !isPrivileged(auth.role)) {
      return { type: 'forbidden' };
    }

    return { type: 'replay', transfer: existingTransfer };
  }

  async function executeTransferSubmission({ data, auth, idempotencyKey = '', scheduleId = null }) {
    if (data.userId !== auth.userId && !isPrivileged(auth.role)) {
      return {
        status: 403,
        body: { error: 'forbidden' },
      };
    }

    const idempotencyFingerprint = buildIdempotencyFingerprint(data);
    const idempotencyResolution = await resolveIdempotentTransfer(auth, idempotencyKey, idempotencyFingerprint);
    if (idempotencyResolution.type === 'conflict') {
      return {
        status: 409,
        body: { error: 'idempotency_key_reused_with_different_payload' },
      };
    }
    if (idempotencyResolution.type === 'forbidden') {
      return {
        status: 403,
        body: { error: 'forbidden' },
      };
    }
    if (idempotencyResolution.type === 'replay') {
      return {
        status: 200,
        body: {
          transfer: idempotencyResolution.transfer,
          idempotentReplay: true,
        },
      };
    }

    const transfer = {
      transferId: `trf_${randomUUID()}`,
      processorReference: `psr_${randomUUID()}`,
      ...data,
      status: 'created',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      events: scheduleId ? ['created', 'scheduled_triggered'] : ['created'],
      screening: evaluateTransfer(data),
    };

    try {
      await store.createTransfer({
        transfer,
        idempotencyKey: idempotencyKey || null,
        fingerprint: idempotencyFingerprint,
      });
    } catch (error) {
      if (error?.code === 'idempotency_key_exists') {
        const resolved = await resolveIdempotentTransfer(auth, idempotencyKey, idempotencyFingerprint);
        if (resolved.type === 'replay') {
          return {
            status: 200,
            body: {
              transfer: resolved.transfer,
              idempotentReplay: true,
            },
          };
        }
        if (resolved.type === 'conflict') {
          return {
            status: 409,
            body: { error: 'idempotency_key_reused_with_different_payload' },
          };
        }
      }
      throw error;
    }

    if (transfer.screening.decision === 'reject') {
      transfer.status = 'rejected';
      transfer.updatedAt = new Date().toISOString();
      transfer.events = [...transfer.events, 'screening_rejected'];
      await store.saveTransfer(transfer);

      await writeAuditEvent({
        actor: data.userId,
        action: 'transfer_rejected',
        entityType: 'transfer',
        entityId: transfer.transferId,
        metadata: { screening: transfer.screening, scheduleId },
      });

      return {
        status: 202,
        body: { transfer },
      };
    }

    if (transfer.screening.decision === 'review') {
      transfer.status = 'review_required';
      transfer.updatedAt = new Date().toISOString();
      transfer.events = [...transfer.events, 'screening_review_required'];
      await store.saveTransfer(transfer);

      await writeAuditEvent({
        actor: data.userId,
        action: 'transfer_review_required',
        entityType: 'transfer',
        entityId: transfer.transferId,
        metadata: { screening: transfer.screening, scheduleId },
      });

      return {
        status: 202,
        body: { transfer },
      };
    }

    const ledgerUrl = process.env.LEDGER_SERVICE_URL || 'http://wallet-ledger-service:4040';

    try {
      const quote = await resolveQuote(store, {
        fromCurrency: data.sourceCurrency,
        toCurrency: data.destinationCurrency,
        amount: data.sourceAmount,
      });

      await postJson(
        `${ledgerUrl}/v1/ledger/reserve`,
        {
          walletId: data.walletId,
          amount: data.sourceAmount,
          reference: transfer.transferId,
        },
        ledgerHeadersForTransfer(transfer)
      );

      transfer.status = 'processing';
      transfer.quote = quote;
      transfer.updatedAt = new Date().toISOString();
      transfer.callbackDueAt = usesExternalTransferProcessor()
        ? null
        : new Date(
          Date.now() + (data.callbackDelayMs || Number(process.env.TRANSFER_PROCESSING_DELAY_MS || 1500))
        ).toISOString();
      transfer.events = [
        ...transfer.events,
        'funds_reserved',
        usesExternalTransferProcessor() ? 'awaiting_external_callback' : 'accepted_for_processing',
      ];

      const savedTransfer = await store.saveTransfer(transfer);

      await writeAuditEvent({
        actor: data.userId,
        action: 'transfer_processing',
        entityType: 'transfer',
        entityId: transfer.transferId,
        metadata: {
          processorReference: transfer.processorReference,
          quoteId: quote.quoteId,
          mode: transferProviderMode(),
          scheduleId,
        },
      });

      if (usesExternalTransferProcessor()) {
        const providerTransfer = await dispatchTransferToExternalProcessor(savedTransfer);
        return {
          status: 201,
          body: { transfer: providerTransfer },
        };
      }

      await scheduleTransferLifecycle({ ...savedTransfer, callbackDueAt: transfer.callbackDueAt });
      return {
        status: 201,
        body: { transfer: savedTransfer },
      };
    } catch (error) {
      const upstreamStatus = Number(error?.context?.status || 502);
      const responseStatus = upstreamStatus >= 400 && upstreamStatus < 600 ? upstreamStatus : 502;
      const upstreamErrorCode = error?.context?.data?.error || 'transfer_processing_failed';

      transfer.status = 'failed';
      transfer.failureReason = upstreamErrorCode;
      transfer.updatedAt = new Date().toISOString();
      transfer.callbackDueAt = null;
      transfer.events = [...transfer.events, 'failed_before_processing'];
      const failedTransfer = await store.saveTransfer(transfer);

      await writeAuditEvent({
        actor: data.userId,
        action: 'transfer_failed',
        entityType: 'transfer',
        entityId: transfer.transferId,
        metadata: {
          reason: upstreamErrorCode,
          upstreamStatus,
          scheduleId,
        },
      });

      return {
        status: responseStatus,
        body: {
          error: 'transfer_failed',
          transfer: failedTransfer,
          upstream: error?.context || null,
        },
      };
    }
  }

  async function runTransferSchedule(schedule) {
    const auth = {
      userId: schedule.userId,
      role: 'member',
    };
    const occurrenceNumber = Number(schedule.executedCount || 0) + 1;
    const result = await executeTransferSubmission({
      data: {
        userId: schedule.userId,
        walletId: schedule.walletId,
        beneficiaryId: schedule.beneficiaryId,
        sourceAmount: schedule.sourceAmount,
        sourceCurrency: schedule.sourceCurrency,
        destinationCurrency: schedule.destinationCurrency,
        simulationMode: schedule.simulationMode,
        callbackDelayMs: schedule.callbackDelayMs,
      },
      auth,
      idempotencyKey: `schedule:${schedule.scheduleId}:${occurrenceNumber}`,
      scheduleId: schedule.scheduleId,
    });

    const transfer = result.body?.transfer || null;
    const nowIso = new Date().toISOString();
    const nextExecutedCount = occurrenceNumber;
    const limitReached = schedule.occurrenceLimit != null && nextExecutedCount >= Number(schedule.occurrenceLimit);
    const nextRunAt = !limitReached ? addScheduleCadence(schedule.nextRunAt, schedule.cadence) : null;

    return {
      ...schedule,
      executedCount: nextExecutedCount,
      latestTransferId: transfer?.transferId || schedule.latestTransferId || null,
      lastRunAt: nowIso,
      lastTransferStatus: transfer?.status || result.body?.error || 'failed',
      lastFailureReason: transfer?.failureReason || result.body?.error || null,
      nextRunAt,
      status: nextRunAt ? 'active' : 'completed',
      updatedAt: nowIso,
    };
  }

  async function processDueTransferSchedules() {
    const dueSchedules = await store.listDueTransferSchedules(new Date().toISOString(), 20);
    for (const schedule of dueSchedules) {
      try {
        await store.withTransferScheduleLock(schedule.scheduleId, async (currentSchedule) => {
          if (!currentSchedule || currentSchedule.status !== 'active') {
            return currentSchedule;
          }

          const nextRunMs = new Date(currentSchedule.nextRunAt || 0).getTime();
          if (Number.isNaN(nextRunMs) || nextRunMs > Date.now()) {
            return currentSchedule;
          }

          return runTransferSchedule(currentSchedule);
        });
      } catch (error) {
        app.log.error({ error, scheduleId: schedule.scheduleId }, 'failed to process transfer schedule');
      }
    }
  }

  async function findTransferByCallback(payload) {
    if (payload.transferId) {
      return store.getTransfer(String(payload.transferId));
    }
    if (payload.processorReference) {
      return store.findTransferByProcessorReference(String(payload.processorReference));
    }
    return null;
  }

  await configureTransferQueue();
  await fxProvider.start();
  transferScheduleWorker = setInterval(() => {
    processDueTransferSchedules().catch((error) => {
      app.log.error({ error }, 'failed to drain transfer schedules');
    });
  }, transferSchedulePollMs);
  await processDueTransferSchedules();

  if (!usesExternalTransferProcessor()) {
    const resumableTransfers = await store.listTransfersForRecovery();
    for (const transfer of resumableTransfers) {
      await scheduleTransferLifecycle(transfer);
    }
  }

  app.post('/v1/quotes', async (request, reply) => {
    const auth = authContext(request);
    if (!ensureAuthenticatedUser(reply, auth)) return;

    const parsed = quoteSchema.safeParse(request.body || {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation_error', details: parsed.error.flatten() });
    }

    try {
      const quote = await store.createQuote(await resolveQuote(store, parsed.data));
      return reply.code(201).send({ quote });
    } catch (error) {
      return reply.code(422).send({ error: String(error.message || error) });
    }
  });

  app.get('/v1/quotes/:quoteId', async (request, reply) => {
    const auth = authContext(request);
    if (!ensureAuthenticatedUser(reply, auth)) return;

    const quote = await store.getQuote(request.params.quoteId);
    if (!quote) return reply.code(404).send({ error: 'quote_not_found' });
    return { quote };
  });

  app.get('/v1/rates', async (request, reply) => {
    const auth = authContext(request);
    if (!ensureAuthenticatedUser(reply, auth)) return;

    const { fromCurrency, toCurrency } = request.query || {};
    if (fromCurrency && toCurrency) {
      const rate = await store.getFxRate(String(fromCurrency), String(toCurrency));
      if (!rate) return reply.code(404).send({ error: 'rate_not_found' });
      return { rate };
    }

    if (!isPrivileged(auth.role)) {
      return reply.code(403).send({ error: 'forbidden' });
    }

    return { rates: await store.listFxRates() };
  });

  app.post('/v1/rates', async (request, reply) => {
    const auth = authContext(request);
    if (!ensureAuthenticatedUser(reply, auth)) return;
    if (!isPrivileged(auth.role)) {
      return reply.code(403).send({ error: 'forbidden' });
    }

    const parsed = upsertRateSchema.safeParse(request.body || {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation_error', details: parsed.error.flatten() });
    }

    const rate = await store.upsertFxRate({
      ...parsed.data,
      source: parsed.data.source || 'manual_override',
    });
    return reply.code(201).send({ rate });
  });

  app.post('/v1/rates/refresh', async (request, reply) => {
    const auth = authContext(request);
    if (!ensureAuthenticatedUser(reply, auth)) return;
    if (!isPrivileged(auth.role)) {
      return reply.code(403).send({ error: 'forbidden' });
    }

    try {
      const refresh = await fxProvider.refreshRates();
      return reply.code(200).send({ refresh });
    } catch (error) {
      return reply.code(502).send({
        error: 'fx_provider_refresh_failed',
        details: error?.context || { message: String(error?.message || error) },
      });
    }
  });

  app.get('/v1/transfers', async (request, reply) => {
    const auth = authContext(request);
    if (!ensureAuthenticatedUser(reply, auth)) return;

    const transfers = isPrivileged(auth.role)
      ? await store.listTransfers()
      : await store.listTransfers({ userId: auth.userId });

    return { transfers };
  });

  app.post('/v1/transfers', async (request, reply) => {
    const auth = authContext(request);
    if (!ensureAuthenticatedUser(reply, auth)) return;

    const parsed = createTransferSchema.safeParse({
      ...(request.body || {}),
      userId: request.body?.userId || auth.userId,
    });
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation_error', details: parsed.error.flatten() });
    }

    const idempotencyKey = request.headers['idempotency-key'] ? String(request.headers['idempotency-key']) : '';
    const data = parsed.data;
    const result = await executeTransferSubmission({ data, auth, idempotencyKey });
    return reply.code(result.status).send(result.body);
  });

  app.get('/v1/transfer-schedules', async (request, reply) => {
    const auth = authContext(request);
    if (!ensureAuthenticatedUser(reply, auth)) return;

    const schedules = isPrivileged(auth.role)
      ? await store.listTransferSchedules()
      : await store.listTransferSchedules({ userId: auth.userId });

    return { schedules };
  });

  app.post('/v1/transfer-schedules', async (request, reply) => {
    const auth = authContext(request);
    if (!ensureAuthenticatedUser(reply, auth)) return;

    const parsed = createTransferScheduleSchema.safeParse({
      ...(request.body || {}),
      userId: request.body?.userId || auth.userId,
    });
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation_error', details: parsed.error.flatten() });
    }

    const data = parsed.data;
    if (data.userId !== auth.userId && !isPrivileged(auth.role)) {
      return reply.code(403).send({ error: 'forbidden' });
    }

    const startAtMs = new Date(data.startAt).getTime();
    if (Number.isNaN(startAtMs) || startAtMs <= Date.now()) {
      return reply.code(400).send({ error: 'invalid_schedule_start_at' });
    }

    const schedule = {
      scheduleId: `sch_${randomUUID()}`,
      label: data.label || null,
      userId: data.userId,
      walletId: data.walletId,
      beneficiaryId: data.beneficiaryId,
      sourceAmount: data.sourceAmount,
      sourceCurrency: data.sourceCurrency,
      destinationCurrency: data.destinationCurrency,
      cadence: data.cadence,
      nextRunAt: data.startAt,
      occurrenceLimit: data.cadence === 'once' ? 1 : (data.occurrenceLimit ?? null),
      executedCount: 0,
      status: 'active',
      simulationMode: data.simulationMode,
      callbackDelayMs: data.callbackDelayMs,
      latestTransferId: null,
      lastRunAt: null,
      lastTransferStatus: null,
      lastFailureReason: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const createdSchedule = await store.createTransferSchedule(schedule);
    await writeAuditEvent({
      actor: data.userId,
      action: 'transfer_schedule_created',
      entityType: 'transfer_schedule',
      entityId: createdSchedule.scheduleId,
      metadata: {
        cadence: createdSchedule.cadence,
        nextRunAt: createdSchedule.nextRunAt,
        sourceAmount: createdSchedule.sourceAmount,
      },
    });

    return reply.code(201).send({ schedule: createdSchedule });
  });

  app.get('/v1/transfers/:transferId', async (request, reply) => {
    const auth = authContext(request);
    const transfer = ensureTransferAccess(reply, auth, await store.getTransfer(request.params.transferId));
    if (!transfer) return;
    return { transfer };
  });

  app.post('/v1/transfer-schedules/:scheduleId/cancel', async (request, reply) => {
    const auth = authContext(request);
    const schedule = ensureScheduleAccess(reply, auth, await store.getTransferSchedule(request.params.scheduleId));
    if (!schedule) return;

    if (!['active', 'completed'].includes(schedule.status)) {
      return reply.code(409).send({ error: 'invalid_schedule_state', status: schedule.status });
    }

    if (schedule.status === 'completed') {
      return { schedule };
    }

    const cancelledSchedule = await store.withTransferScheduleLock(schedule.scheduleId, async (currentSchedule) => {
      if (!currentSchedule) {
        return currentSchedule;
      }

      return {
        ...currentSchedule,
        status: 'cancelled',
        nextRunAt: null,
        updatedAt: new Date().toISOString(),
      };
    });

    await writeAuditEvent({
      actor: schedule.userId,
      action: 'transfer_schedule_cancelled',
      entityType: 'transfer_schedule',
      entityId: schedule.scheduleId,
      metadata: {
        latestTransferId: cancelledSchedule.latestTransferId,
      },
    });

    return { schedule: cancelledSchedule };
  });

  app.post('/v1/transfers/:transferId/cancel', async (request, reply) => {
    const auth = authContext(request);
    const existingTransfer = ensureTransferAccess(reply, auth, await store.getTransfer(request.params.transferId));
    if (!existingTransfer) return;

    if (!['processing', 'review_required', 'created'].includes(existingTransfer.status)) {
      return reply.code(409).send({ error: 'invalid_transfer_state', status: existingTransfer.status });
    }

    try {
      const cancelledTransfer = await store.withTransferLock(existingTransfer.transferId, async (currentTransfer) => {
        if (!currentTransfer) {
          return currentTransfer;
        }

        if (!['processing', 'review_required', 'created'].includes(currentTransfer.status)) {
          throw Object.assign(new Error('invalid_transfer_state'), {
            code: 'invalid_transfer_state',
            status: currentTransfer.status,
          });
        }

        const nextEvents = [...(currentTransfer.events || [])];
        if (currentTransfer.status === 'processing') {
          const ledgerUrl = process.env.LEDGER_SERVICE_URL || 'http://wallet-ledger-service:4040';
          await postJson(
            `${ledgerUrl}/v1/ledger/release`,
            {
              walletId: currentTransfer.walletId,
              amount: currentTransfer.sourceAmount,
              reference: currentTransfer.transferId,
            },
            ledgerHeadersForTransfer(currentTransfer)
          );
          nextEvents.push('released');
        }

        const updatedTransfer = {
          ...currentTransfer,
          status: 'cancelled',
          updatedAt: new Date().toISOString(),
          callbackDueAt: null,
          events: [...nextEvents, 'cancelled'],
        };

        await writeAuditEvent({
          actor: currentTransfer.userId,
          action: 'transfer_cancelled',
          entityType: 'transfer',
          entityId: currentTransfer.transferId,
          metadata: {
            processorReference: currentTransfer.processorReference,
          },
        });

        return updatedTransfer;
      });

      clearScheduledTransfer(scheduledTransfers, existingTransfer.transferId);
      return { transfer: cancelledTransfer };
    } catch (error) {
      if (error?.code === 'invalid_transfer_state') {
        return reply.code(409).send({ error: 'invalid_transfer_state', status: error.status });
      }
      throw error;
    }
  });

  app.post('/internal/provider-callback', async (request, reply) => {
    const expectedToken = String(process.env.TRANSFER_PROVIDER_CALLBACK_TOKEN || '').trim();
    if (expectedToken) {
      const headerToken = String(request.headers['x-provider-callback-token'] || '').trim();
      const authorization = String(request.headers.authorization || '').trim();
      const bearerToken = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length).trim() : '';
      if (![headerToken, bearerToken].includes(expectedToken)) {
        return reply.code(401).send({ error: 'unauthorized_provider_callback' });
      }
    }

    const { status } = request.body || {};
    if (!status) return reply.code(400).send({ error: 'invalid_callback_payload' });

    const transfer = await findTransferByCallback(request.body || {});
    if (!transfer) return reply.code(404).send({ error: 'transfer_not_found' });

    let updatedTransfer;
    if (status === 'completed') {
      updatedTransfer = await settleTransferById(transfer.transferId);
    } else if (status === 'failed') {
      updatedTransfer = await failTransferById(transfer.transferId, 'manual_processor_callback_failed');
    } else {
      return reply.code(400).send({ error: 'unsupported_callback_status' });
    }

    return reply.send({ ok: true, transfer: updatedTransfer });
  });

  app.get('/internal/transfers', async () => ({ transfers: await store.listTransfers() }));

  app.addHook('onClose', async () => {
    for (const timer of scheduledTransfers.values()) {
      clearTimeout(timer);
    }
    scheduledTransfers.clear();

    if (transferQueueWorker) {
      clearInterval(transferQueueWorker);
    }
    if (transferScheduleWorker) {
      clearInterval(transferScheduleWorker);
    }
    fxProvider.stop();
    if (transferQueueClient?.isOpen) {
      await transferQueueClient.quit();
    }
  });
}
