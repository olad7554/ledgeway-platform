function toTwoDp(amount) {
  return Number(Number(amount || 0).toFixed(2));
}

const DEFAULT_FX_RATES = [
  { fromCurrency: 'USD', toCurrency: 'USD', rate: 1 },
  { fromCurrency: 'USD', toCurrency: 'EUR', rate: 0.92 },
  { fromCurrency: 'USD', toCurrency: 'GBP', rate: 0.79 },
  { fromCurrency: 'USD', toCurrency: 'CAD', rate: 1.36 },
  { fromCurrency: 'EUR', toCurrency: 'USD', rate: 1.09 },
  { fromCurrency: 'EUR', toCurrency: 'EUR', rate: 1 },
  { fromCurrency: 'EUR', toCurrency: 'GBP', rate: 0.86 },
  { fromCurrency: 'EUR', toCurrency: 'CAD', rate: 1.47 },
  { fromCurrency: 'GBP', toCurrency: 'USD', rate: 1.27 },
  { fromCurrency: 'GBP', toCurrency: 'EUR', rate: 1.16 },
  { fromCurrency: 'GBP', toCurrency: 'GBP', rate: 1 },
  { fromCurrency: 'GBP', toCurrency: 'CAD', rate: 1.71 },
  { fromCurrency: 'CAD', toCurrency: 'USD', rate: 0.74 },
  { fromCurrency: 'CAD', toCurrency: 'EUR', rate: 0.68 },
  { fromCurrency: 'CAD', toCurrency: 'GBP', rate: 0.58 },
  { fromCurrency: 'CAD', toCurrency: 'CAD', rate: 1 },
];

function createStoreError(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function cloneValue(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function buildQuoteRecord(row, prefix = '') {
  const quoteId = row[`${prefix}quote_id`] ?? row.quoteId;
  if (!quoteId) return null;

  return {
    quoteId,
    fromCurrency: row[`${prefix}from_currency`] ?? row.fromCurrency,
    toCurrency: row[`${prefix}to_currency`] ?? row.toCurrency,
    sourceAmount: toTwoDp(row[`${prefix}source_amount`] ?? row.sourceAmount),
    feeAmount: toTwoDp(row[`${prefix}fee_amount`] ?? row.feeAmount),
    rate: Number(row[`${prefix}rate`] ?? row.rate),
    destinationAmount: toTwoDp(row[`${prefix}destination_amount`] ?? row.destinationAmount),
    expiresAt: row[`${prefix}expires_at`] ?? row.expiresAt,
    createdAt: row[`${prefix}created_at`] ?? row.createdAt,
  };
}

function buildFxRateRecord(row) {
  if (!row) return null;
  return {
    fromCurrency: row.from_currency ?? row.fromCurrency,
    toCurrency: row.to_currency ?? row.toCurrency,
    rate: Number(row.rate),
    source: row.source ?? 'configured',
    updatedAt: row.updated_at ?? row.updatedAt,
  };
}

function buildTransferRecord(row, { includeInternal = false } = {}) {
  if (!row) return null;

  const transfer = {
    transferId: row.transfer_id ?? row.transferId,
    processorReference: row.processor_reference ?? row.processorReference,
    userId: row.user_id ?? row.userId,
    walletId: row.wallet_id ?? row.walletId,
    beneficiaryId: row.beneficiary_id ?? row.beneficiaryId,
    sourceAmount: toTwoDp(row.source_amount ?? row.sourceAmount),
    sourceCurrency: row.source_currency ?? row.sourceCurrency,
    destinationCurrency: row.destination_currency ?? row.destinationCurrency,
    simulationMode: row.simulation_mode ?? row.simulationMode ?? undefined,
    callbackDelayMs: row.callback_delay_ms ?? row.callbackDelayMs ?? undefined,
    status: row.status,
    createdAt: row.created_at ?? row.createdAt,
    updatedAt: row.updated_at ?? row.updatedAt,
    events: cloneValue(row.events ?? []) || [],
  };

  const screening = cloneValue(row.screening);
  if (screening) transfer.screening = screening;

  const failureReason = row.failure_reason ?? row.failureReason;
  if (failureReason) transfer.failureReason = failureReason;

  const completedAt = row.completed_at ?? row.completedAt;
  if (completedAt) transfer.completedAt = completedAt;

  const quote = buildQuoteRecord(row, 'joined_') || buildQuoteRecord(row);
  if (quote) transfer.quote = quote;

  if (includeInternal) {
    const callbackDueAt = row.callback_due_at ?? row.callbackDueAt;
    if (callbackDueAt) {
      transfer.callbackDueAt = callbackDueAt;
    }
  }

  return transfer;
}

function buildTransferScheduleRecord(row) {
  if (!row) return null;

  return {
    scheduleId: row.schedule_id ?? row.scheduleId,
    label: row.label ?? row.scheduleLabel ?? null,
    userId: row.user_id ?? row.userId,
    walletId: row.wallet_id ?? row.walletId,
    beneficiaryId: row.beneficiary_id ?? row.beneficiaryId,
    sourceAmount: toTwoDp(row.source_amount ?? row.sourceAmount),
    sourceCurrency: row.source_currency ?? row.sourceCurrency,
    destinationCurrency: row.destination_currency ?? row.destinationCurrency,
    cadence: row.cadence,
    nextRunAt: row.next_run_at ?? row.nextRunAt,
    occurrenceLimit: row.occurrence_limit ?? row.occurrenceLimit ?? null,
    executedCount: Number(row.executed_count ?? row.executedCount ?? 0),
    status: row.status,
    simulationMode: row.simulation_mode ?? row.simulationMode ?? undefined,
    callbackDelayMs: row.callback_delay_ms ?? row.callbackDelayMs ?? undefined,
    latestTransferId: row.latest_transfer_id ?? row.latestTransferId ?? null,
    lastRunAt: row.last_run_at ?? row.lastRunAt ?? null,
    lastTransferStatus: row.last_transfer_status ?? row.lastTransferStatus ?? null,
    lastFailureReason: row.last_failure_reason ?? row.lastFailureReason ?? null,
    createdAt: row.created_at ?? row.createdAt,
    updatedAt: row.updated_at ?? row.updatedAt,
  };
}

function createInMemoryTransferStore() {
  const transfers = new Map();
  const quotes = new Map();
  const fxRates = new Map();
  const schedules = new Map();
  const transferByIdempotencyKey = new Map();
  const transferByProcessorReference = new Map();
  const activeLocks = new Map();

  for (const rate of DEFAULT_FX_RATES) {
    fxRates.set(`${rate.fromCurrency}:${rate.toCurrency}`, {
      ...rate,
      source: 'bootstrap_default',
      updatedAt: new Date().toISOString(),
    });
  }

  async function withLock(key, callback) {
    while (activeLocks.has(key)) {
      await activeLocks.get(key);
    }

    let releaseLock;
    const lock = new Promise((resolve) => {
      releaseLock = resolve;
    });
    activeLocks.set(key, lock);

    try {
      return await callback();
    } finally {
      activeLocks.delete(key);
      releaseLock();
    }
  }

  return {
    kind: 'memory',
    async createQuote(quote) {
      quotes.set(quote.quoteId, cloneValue(quote));
      return cloneValue(quote);
    },
    async getQuote(quoteId) {
      return cloneValue(quotes.get(quoteId) || null);
    },
    async getFxRate(fromCurrency, toCurrency) {
      return buildFxRateRecord(fxRates.get(`${fromCurrency}:${toCurrency}`) || null);
    },
    async listFxRates() {
      return Array.from(fxRates.values())
        .sort((left, right) => `${left.fromCurrency}:${left.toCurrency}`.localeCompare(`${right.fromCurrency}:${right.toCurrency}`))
        .map((item) => buildFxRateRecord(item));
    },
    async upsertFxRate({ fromCurrency, toCurrency, rate, source }) {
      const item = {
        fromCurrency,
        toCurrency,
        rate: Number(rate),
        source: source || 'configured',
        updatedAt: new Date().toISOString(),
      };
      fxRates.set(`${fromCurrency}:${toCurrency}`, item);
      return buildFxRateRecord(item);
    },
    async getIdempotencyRecord(idempotencyKey) {
      const record = transferByIdempotencyKey.get(idempotencyKey);
      return record ? cloneValue(record) : null;
    },
    async createTransfer({ transfer, idempotencyKey, fingerprint }) {
      if (transfers.has(transfer.transferId)) {
        throw createStoreError('transfer_exists');
      }
      if (idempotencyKey && transferByIdempotencyKey.has(idempotencyKey)) {
        throw createStoreError('idempotency_key_exists');
      }

      if (transfer.quote) {
        quotes.set(transfer.quote.quoteId, cloneValue(transfer.quote));
      }

      transfers.set(transfer.transferId, cloneValue(transfer));
      transferByProcessorReference.set(transfer.processorReference, transfer.transferId);
      if (idempotencyKey) {
        transferByIdempotencyKey.set(idempotencyKey, {
          transferId: transfer.transferId,
          fingerprint,
        });
      }

      return buildTransferRecord(transfer);
    },
    async saveTransfer(transfer) {
      if (!transfers.has(transfer.transferId)) {
        throw createStoreError('transfer_not_found');
      }

      if (transfer.quote) {
        quotes.set(transfer.quote.quoteId, cloneValue(transfer.quote));
      }

      transfers.set(transfer.transferId, cloneValue(transfer));
      transferByProcessorReference.set(transfer.processorReference, transfer.transferId);
      return buildTransferRecord(transfer);
    },
    async getTransfer(transferId) {
      const transfer = transfers.get(transferId);
      if (!transfer) return null;
      return buildTransferRecord(transfer);
    },
    async listTransfers({ userId } = {}) {
      return Array.from(transfers.values())
        .filter((transfer) => !userId || transfer.userId === userId)
        .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))
        .map((transfer) => buildTransferRecord(transfer));
    },
    async findTransferByProcessorReference(processorReference) {
      const transferId = transferByProcessorReference.get(processorReference);
      return transferId ? buildTransferRecord(transfers.get(transferId), { includeInternal: true }) : null;
    },
    async listTransfersForRecovery() {
      return Array.from(transfers.values())
        .filter((transfer) => transfer.status === 'processing')
        .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))
        .map((transfer) => buildTransferRecord(transfer, { includeInternal: true }));
    },
    async createTransferSchedule(schedule) {
      if (schedules.has(schedule.scheduleId)) {
        throw createStoreError('transfer_schedule_exists');
      }

      schedules.set(schedule.scheduleId, cloneValue(schedule));
      return buildTransferScheduleRecord(schedule);
    },
    async listTransferSchedules({ userId, statuses } = {}) {
      return Array.from(schedules.values())
        .filter((schedule) => {
          if (userId && schedule.userId !== userId) return false;
          if (statuses?.length && !statuses.includes(schedule.status)) return false;
          return true;
        })
        .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))
        .map((schedule) => buildTransferScheduleRecord(schedule));
    },
    async getTransferSchedule(scheduleId) {
      return buildTransferScheduleRecord(schedules.get(scheduleId) || null);
    },
    async listDueTransferSchedules(untilIso = new Date().toISOString(), limit = 20) {
      const cutoff = new Date(untilIso).getTime();
      return Array.from(schedules.values())
        .filter((schedule) => {
          if (schedule.status !== 'active') return false;
          const nextRunAt = new Date(schedule.nextRunAt || 0).getTime();
          return !Number.isNaN(nextRunAt) && nextRunAt <= cutoff;
        })
        .sort((left, right) => String(left.nextRunAt).localeCompare(String(right.nextRunAt)))
        .slice(0, Number(limit || 20))
        .map((schedule) => buildTransferScheduleRecord(schedule));
    },
    async withTransferScheduleLock(scheduleId, callback) {
      return withLock(`schedule:${scheduleId}`, async () => {
        const currentSchedule = schedules.get(scheduleId);
        const current = currentSchedule ? buildTransferScheduleRecord(currentSchedule) : null;
        const next = await callback(current);
        if (!next) {
          return current;
        }

        schedules.set(scheduleId, cloneValue(next));
        return buildTransferScheduleRecord(next);
      });
    },
    async withTransferLock(transferId, callback) {
      return withLock(transferId, async () => {
        const currentTransfer = transfers.get(transferId);
        const current = currentTransfer ? buildTransferRecord(currentTransfer, { includeInternal: true }) : null;
        const next = await callback(current);
        if (!next) {
          return current;
        }

        if (next.quote) {
          quotes.set(next.quote.quoteId, cloneValue(next.quote));
        }

        transfers.set(transferId, cloneValue(next));
        transferByProcessorReference.set(next.processorReference, transferId);
        return buildTransferRecord(next);
      });
    },
  };
}

async function createPostgresTransferStore(connectionString) {
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString });

  let initialized = false;
  let lastError;
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS transfer_quotes (
          quote_id TEXT PRIMARY KEY,
          from_currency TEXT NOT NULL,
          to_currency TEXT NOT NULL,
          source_amount NUMERIC(18, 2) NOT NULL,
          fee_amount NUMERIC(18, 2) NOT NULL,
          rate NUMERIC(18, 8) NOT NULL,
          destination_amount NUMERIC(18, 2) NOT NULL,
          expires_at TIMESTAMPTZ NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS transfer_fx_rates (
          from_currency TEXT NOT NULL,
          to_currency TEXT NOT NULL,
          rate NUMERIC(18, 8) NOT NULL,
          source TEXT NOT NULL DEFAULT 'configured',
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (from_currency, to_currency)
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS transfer_records (
          transfer_id TEXT PRIMARY KEY,
          processor_reference TEXT NOT NULL UNIQUE,
          user_id TEXT NOT NULL,
          wallet_id TEXT NOT NULL,
          beneficiary_id TEXT NOT NULL,
          source_amount NUMERIC(18, 2) NOT NULL,
          source_currency TEXT NOT NULL,
          destination_currency TEXT NOT NULL,
          simulation_mode TEXT,
          callback_delay_ms INTEGER,
          callback_due_at TIMESTAMPTZ,
          status TEXT NOT NULL,
          failure_reason TEXT,
          screening JSONB,
          events JSONB NOT NULL DEFAULT '[]'::jsonb,
          quote_id TEXT REFERENCES transfer_quotes(quote_id) ON DELETE SET NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          completed_at TIMESTAMPTZ
        )
      `);

      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_transfer_records_user_id
        ON transfer_records(user_id)
      `);

      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_transfer_records_status
        ON transfer_records(status)
      `);

      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_transfer_records_callback_due_at
        ON transfer_records(callback_due_at)
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS transfer_idempotency (
          idempotency_key TEXT PRIMARY KEY,
          transfer_id TEXT NOT NULL REFERENCES transfer_records(transfer_id) ON DELETE CASCADE,
          fingerprint TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS transfer_schedules (
          schedule_id TEXT PRIMARY KEY,
          label TEXT,
          user_id TEXT NOT NULL,
          wallet_id TEXT NOT NULL,
          beneficiary_id TEXT NOT NULL,
          source_amount NUMERIC(18, 2) NOT NULL,
          source_currency TEXT NOT NULL,
          destination_currency TEXT NOT NULL,
          cadence TEXT NOT NULL,
          next_run_at TIMESTAMPTZ NOT NULL,
          occurrence_limit INTEGER,
          executed_count INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL,
          simulation_mode TEXT,
          callback_delay_ms INTEGER,
          latest_transfer_id TEXT REFERENCES transfer_records(transfer_id) ON DELETE SET NULL,
          last_run_at TIMESTAMPTZ,
          last_transfer_status TEXT,
          last_failure_reason TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_transfer_schedules_user_id
        ON transfer_schedules(user_id)
      `);

      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_transfer_schedules_status_next_run_at
        ON transfer_schedules(status, next_run_at)
      `);

      await pool.query(`
        ALTER TABLE transfer_schedules
        ALTER COLUMN next_run_at DROP NOT NULL
      `);

      initialized = true;
      break;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  if (!initialized) {
    throw lastError;
  }

  for (const rate of DEFAULT_FX_RATES) {
    await pool.query(
      `INSERT INTO transfer_fx_rates (from_currency, to_currency, rate, source, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (from_currency, to_currency) DO NOTHING`,
      [rate.fromCurrency, rate.toCurrency, Number(rate.rate), 'bootstrap_default']
    );
  }

  async function withTransaction(callback) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function upsertQuoteTx(client, quote) {
    if (!quote) return null;

    await client.query(
      `INSERT INTO transfer_quotes (quote_id, from_currency, to_currency, source_amount, fee_amount, rate, destination_amount, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (quote_id) DO UPDATE SET
         from_currency = EXCLUDED.from_currency,
         to_currency = EXCLUDED.to_currency,
         source_amount = EXCLUDED.source_amount,
         fee_amount = EXCLUDED.fee_amount,
         rate = EXCLUDED.rate,
         destination_amount = EXCLUDED.destination_amount,
         expires_at = EXCLUDED.expires_at`,
      [
        quote.quoteId,
        quote.fromCurrency,
        quote.toCurrency,
        toTwoDp(quote.sourceAmount),
        toTwoDp(quote.feeAmount),
        Number(quote.rate),
        toTwoDp(quote.destinationAmount),
        quote.expiresAt,
        quote.createdAt,
      ]
    );

    return quote.quoteId;
  }

  async function queryTransferById(executor, transferId, { includeInternal = false } = {}) {
    const result = await executor.query(
      `SELECT
         tr.transfer_id,
         tr.processor_reference,
         tr.user_id,
         tr.wallet_id,
         tr.beneficiary_id,
         tr.source_amount,
         tr.source_currency,
         tr.destination_currency,
         tr.simulation_mode,
         tr.callback_delay_ms,
         tr.callback_due_at,
         tr.status,
         tr.failure_reason,
         tr.screening,
         tr.events,
         tr.created_at,
         tr.updated_at,
         tr.completed_at,
         q.quote_id AS joined_quote_id,
         q.from_currency AS joined_from_currency,
         q.to_currency AS joined_to_currency,
         q.source_amount AS joined_source_amount,
         q.fee_amount AS joined_fee_amount,
         q.rate AS joined_rate,
         q.destination_amount AS joined_destination_amount,
         q.expires_at AS joined_expires_at,
         q.created_at AS joined_created_at
       FROM transfer_records tr
       LEFT JOIN transfer_quotes q ON q.quote_id = tr.quote_id
       WHERE tr.transfer_id = $1
       LIMIT 1`,
      [transferId]
    );

    return buildTransferRecord(result.rows[0], { includeInternal });
  }

  async function queryTransferScheduleById(executor, scheduleId) {
    const result = await executor.query(
      `SELECT
         schedule_id,
         label,
         user_id,
         wallet_id,
         beneficiary_id,
         source_amount,
         source_currency,
         destination_currency,
         cadence,
         next_run_at,
         occurrence_limit,
         executed_count,
         status,
         simulation_mode,
         callback_delay_ms,
         latest_transfer_id,
         last_run_at,
         last_transfer_status,
         last_failure_reason,
         created_at,
         updated_at
       FROM transfer_schedules
       WHERE schedule_id = $1
       LIMIT 1`,
      [scheduleId]
    );

    return buildTransferScheduleRecord(result.rows[0]);
  }

  async function saveTransferTx(client, transfer) {
    const quoteId = await upsertQuoteTx(client, transfer.quote);

    await client.query(
      `UPDATE transfer_records
       SET processor_reference = $2,
           user_id = $3,
           wallet_id = $4,
           beneficiary_id = $5,
           source_amount = $6,
           source_currency = $7,
           destination_currency = $8,
           simulation_mode = $9,
           callback_delay_ms = $10,
           callback_due_at = $11,
           status = $12,
           failure_reason = $13,
           screening = $14::jsonb,
           events = $15::jsonb,
           quote_id = $16,
           updated_at = $17,
           completed_at = $18
       WHERE transfer_id = $1`,
      [
        transfer.transferId,
        transfer.processorReference,
        transfer.userId,
        transfer.walletId,
        transfer.beneficiaryId,
        toTwoDp(transfer.sourceAmount),
        transfer.sourceCurrency,
        transfer.destinationCurrency,
        transfer.simulationMode || null,
        transfer.callbackDelayMs ?? null,
        transfer.callbackDueAt || null,
        transfer.status,
        transfer.failureReason || null,
        JSON.stringify(transfer.screening || null),
        JSON.stringify(transfer.events || []),
        quoteId,
        transfer.updatedAt,
        transfer.completedAt || null,
      ]
    );

    return queryTransferById(client, transfer.transferId);
  }

  async function saveTransferScheduleTx(client, schedule) {
    await client.query(
      `UPDATE transfer_schedules
       SET label = $2,
           user_id = $3,
           wallet_id = $4,
           beneficiary_id = $5,
           source_amount = $6,
           source_currency = $7,
           destination_currency = $8,
           cadence = $9,
           next_run_at = $10,
           occurrence_limit = $11,
           executed_count = $12,
           status = $13,
           simulation_mode = $14,
           callback_delay_ms = $15,
           latest_transfer_id = $16,
           last_run_at = $17,
           last_transfer_status = $18,
           last_failure_reason = $19,
           updated_at = $20
       WHERE schedule_id = $1`,
      [
        schedule.scheduleId,
        schedule.label || null,
        schedule.userId,
        schedule.walletId,
        schedule.beneficiaryId,
        toTwoDp(schedule.sourceAmount),
        schedule.sourceCurrency,
        schedule.destinationCurrency,
        schedule.cadence,
        schedule.nextRunAt,
        schedule.occurrenceLimit ?? null,
        Number(schedule.executedCount || 0),
        schedule.status,
        schedule.simulationMode || null,
        schedule.callbackDelayMs ?? null,
        schedule.latestTransferId || null,
        schedule.lastRunAt || null,
        schedule.lastTransferStatus || null,
        schedule.lastFailureReason || null,
        schedule.updatedAt,
      ]
    );

    return queryTransferScheduleById(client, schedule.scheduleId);
  }

  return {
    kind: 'postgres',
    async createQuote(quote) {
      return withTransaction(async (client) => {
        await upsertQuoteTx(client, quote);
        return buildQuoteRecord(quote);
      });
    },
    async getQuote(quoteId) {
      const result = await pool.query(
        `SELECT quote_id, from_currency, to_currency, source_amount, fee_amount, rate, destination_amount, expires_at, created_at
         FROM transfer_quotes
         WHERE quote_id = $1
         LIMIT 1`,
        [quoteId]
      );

      return buildQuoteRecord(result.rows[0]);
    },
    async getFxRate(fromCurrency, toCurrency) {
      const result = await pool.query(
        `SELECT from_currency, to_currency, rate, source, updated_at
         FROM transfer_fx_rates
         WHERE from_currency = $1 AND to_currency = $2
         LIMIT 1`,
        [fromCurrency, toCurrency]
      );

      return buildFxRateRecord(result.rows[0]);
    },
    async listFxRates() {
      const result = await pool.query(
        `SELECT from_currency, to_currency, rate, source, updated_at
         FROM transfer_fx_rates
         ORDER BY from_currency ASC, to_currency ASC`
      );

      return result.rows.map((row) => buildFxRateRecord(row));
    },
    async upsertFxRate({ fromCurrency, toCurrency, rate, source }) {
      const result = await pool.query(
        `INSERT INTO transfer_fx_rates (from_currency, to_currency, rate, source, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (from_currency, to_currency) DO UPDATE SET
           rate = EXCLUDED.rate,
           source = EXCLUDED.source,
           updated_at = NOW()
         RETURNING from_currency, to_currency, rate, source, updated_at`,
        [fromCurrency, toCurrency, Number(rate), source || 'configured']
      );

      return buildFxRateRecord(result.rows[0]);
    },
    async getIdempotencyRecord(idempotencyKey) {
      const result = await pool.query(
        `SELECT idempotency_key, transfer_id, fingerprint, created_at
         FROM transfer_idempotency
         WHERE idempotency_key = $1
         LIMIT 1`,
        [idempotencyKey]
      );

      if (!result.rows[0]) return null;
      return {
        idempotencyKey: result.rows[0].idempotency_key,
        transferId: result.rows[0].transfer_id,
        fingerprint: result.rows[0].fingerprint,
        createdAt: result.rows[0].created_at,
      };
    },
    async createTransfer({ transfer, idempotencyKey, fingerprint }) {
      return withTransaction(async (client) => {
        const quoteId = await upsertQuoteTx(client, transfer.quote);

        try {
          await client.query(
            `INSERT INTO transfer_records (
              transfer_id,
              processor_reference,
              user_id,
              wallet_id,
              beneficiary_id,
              source_amount,
              source_currency,
              destination_currency,
              simulation_mode,
              callback_delay_ms,
              callback_due_at,
              status,
              failure_reason,
              screening,
              events,
              quote_id,
              created_at,
              updated_at,
              completed_at
            ) VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15::jsonb, $16, $17, $18, $19
            )`,
            [
              transfer.transferId,
              transfer.processorReference,
              transfer.userId,
              transfer.walletId,
              transfer.beneficiaryId,
              toTwoDp(transfer.sourceAmount),
              transfer.sourceCurrency,
              transfer.destinationCurrency,
              transfer.simulationMode || null,
              transfer.callbackDelayMs ?? null,
              transfer.callbackDueAt || null,
              transfer.status,
              transfer.failureReason || null,
              JSON.stringify(transfer.screening || null),
              JSON.stringify(transfer.events || []),
              quoteId,
              transfer.createdAt,
              transfer.updatedAt,
              transfer.completedAt || null,
            ]
          );
        } catch (error) {
          if (error?.code === '23505') {
            throw createStoreError('transfer_exists');
          }
          throw error;
        }

        if (idempotencyKey) {
          try {
            await client.query(
              `INSERT INTO transfer_idempotency (idempotency_key, transfer_id, fingerprint)
               VALUES ($1, $2, $3)`,
              [idempotencyKey, transfer.transferId, fingerprint]
            );
          } catch (error) {
            if (error?.code === '23505') {
              throw createStoreError('idempotency_key_exists');
            }
            throw error;
          }
        }

        return queryTransferById(client, transfer.transferId);
      });
    },
    async saveTransfer(transfer) {
      return withTransaction(async (client) => saveTransferTx(client, transfer));
    },
    async getTransfer(transferId) {
      return queryTransferById(pool, transferId);
    },
    async listTransfers({ userId } = {}) {
      const result = userId
        ? await pool.query(
          `SELECT
             tr.transfer_id,
             tr.processor_reference,
             tr.user_id,
             tr.wallet_id,
             tr.beneficiary_id,
             tr.source_amount,
             tr.source_currency,
             tr.destination_currency,
             tr.simulation_mode,
             tr.callback_delay_ms,
             tr.callback_due_at,
             tr.status,
             tr.failure_reason,
             tr.screening,
             tr.events,
             tr.created_at,
             tr.updated_at,
             tr.completed_at,
             q.quote_id AS joined_quote_id,
             q.from_currency AS joined_from_currency,
             q.to_currency AS joined_to_currency,
             q.source_amount AS joined_source_amount,
             q.fee_amount AS joined_fee_amount,
             q.rate AS joined_rate,
             q.destination_amount AS joined_destination_amount,
             q.expires_at AS joined_expires_at,
             q.created_at AS joined_created_at
           FROM transfer_records tr
           LEFT JOIN transfer_quotes q ON q.quote_id = tr.quote_id
           WHERE tr.user_id = $1
           ORDER BY tr.created_at ASC`,
          [userId]
        )
        : await pool.query(
          `SELECT
             tr.transfer_id,
             tr.processor_reference,
             tr.user_id,
             tr.wallet_id,
             tr.beneficiary_id,
             tr.source_amount,
             tr.source_currency,
             tr.destination_currency,
             tr.simulation_mode,
             tr.callback_delay_ms,
             tr.callback_due_at,
             tr.status,
             tr.failure_reason,
             tr.screening,
             tr.events,
             tr.created_at,
             tr.updated_at,
             tr.completed_at,
             q.quote_id AS joined_quote_id,
             q.from_currency AS joined_from_currency,
             q.to_currency AS joined_to_currency,
             q.source_amount AS joined_source_amount,
             q.fee_amount AS joined_fee_amount,
             q.rate AS joined_rate,
             q.destination_amount AS joined_destination_amount,
             q.expires_at AS joined_expires_at,
             q.created_at AS joined_created_at
           FROM transfer_records tr
           LEFT JOIN transfer_quotes q ON q.quote_id = tr.quote_id
           ORDER BY tr.created_at ASC`
        );

      return result.rows.map((row) => buildTransferRecord(row));
    },
    async findTransferByProcessorReference(processorReference) {
      const result = await pool.query(
        `SELECT
           tr.transfer_id,
           tr.processor_reference,
           tr.user_id,
           tr.wallet_id,
           tr.beneficiary_id,
           tr.source_amount,
           tr.source_currency,
           tr.destination_currency,
           tr.simulation_mode,
           tr.callback_delay_ms,
           tr.callback_due_at,
           tr.status,
           tr.failure_reason,
           tr.screening,
           tr.events,
           tr.created_at,
           tr.updated_at,
           tr.completed_at,
           q.quote_id AS joined_quote_id,
           q.from_currency AS joined_from_currency,
           q.to_currency AS joined_to_currency,
           q.source_amount AS joined_source_amount,
           q.fee_amount AS joined_fee_amount,
           q.rate AS joined_rate,
           q.destination_amount AS joined_destination_amount,
           q.expires_at AS joined_expires_at,
           q.created_at AS joined_created_at
         FROM transfer_records tr
         LEFT JOIN transfer_quotes q ON q.quote_id = tr.quote_id
         WHERE tr.processor_reference = $1
         LIMIT 1`,
        [processorReference]
      );

      return buildTransferRecord(result.rows[0], { includeInternal: true });
    },
    async listTransfersForRecovery() {
      const result = await pool.query(
        `SELECT
           tr.transfer_id,
           tr.processor_reference,
           tr.user_id,
           tr.wallet_id,
           tr.beneficiary_id,
           tr.source_amount,
           tr.source_currency,
           tr.destination_currency,
           tr.simulation_mode,
           tr.callback_delay_ms,
           tr.callback_due_at,
           tr.status,
           tr.failure_reason,
           tr.screening,
           tr.events,
           tr.created_at,
           tr.updated_at,
           tr.completed_at,
           q.quote_id AS joined_quote_id,
           q.from_currency AS joined_from_currency,
           q.to_currency AS joined_to_currency,
           q.source_amount AS joined_source_amount,
           q.fee_amount AS joined_fee_amount,
           q.rate AS joined_rate,
           q.destination_amount AS joined_destination_amount,
           q.expires_at AS joined_expires_at,
           q.created_at AS joined_created_at
         FROM transfer_records tr
         LEFT JOIN transfer_quotes q ON q.quote_id = tr.quote_id
         WHERE tr.status = 'processing'
         ORDER BY tr.callback_due_at ASC NULLS LAST, tr.created_at ASC`
      );

      return result.rows.map((row) => buildTransferRecord(row, { includeInternal: true }));
    },
    async createTransferSchedule(schedule) {
      return withTransaction(async (client) => {
        try {
          await client.query(
            `INSERT INTO transfer_schedules (
              schedule_id,
              label,
              user_id,
              wallet_id,
              beneficiary_id,
              source_amount,
              source_currency,
              destination_currency,
              cadence,
              next_run_at,
              occurrence_limit,
              executed_count,
              status,
              simulation_mode,
              callback_delay_ms,
              latest_transfer_id,
              last_run_at,
              last_transfer_status,
              last_failure_reason,
              created_at,
              updated_at
            ) VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21
            )`,
            [
              schedule.scheduleId,
              schedule.label || null,
              schedule.userId,
              schedule.walletId,
              schedule.beneficiaryId,
              toTwoDp(schedule.sourceAmount),
              schedule.sourceCurrency,
              schedule.destinationCurrency,
              schedule.cadence,
              schedule.nextRunAt,
              schedule.occurrenceLimit ?? null,
              Number(schedule.executedCount || 0),
              schedule.status,
              schedule.simulationMode || null,
              schedule.callbackDelayMs ?? null,
              schedule.latestTransferId || null,
              schedule.lastRunAt || null,
              schedule.lastTransferStatus || null,
              schedule.lastFailureReason || null,
              schedule.createdAt,
              schedule.updatedAt,
            ]
          );
        } catch (error) {
          if (error?.code === '23505') {
            throw createStoreError('transfer_schedule_exists');
          }
          throw error;
        }

        return queryTransferScheduleById(client, schedule.scheduleId);
      });
    },
    async listTransferSchedules({ userId, statuses } = {}) {
      const clauses = [];
      const values = [];
      let index = 1;

      if (userId) {
        clauses.push(`user_id = $${index}`);
        values.push(userId);
        index += 1;
      }

      if (statuses?.length) {
        clauses.push(`status = ANY($${index}::text[])`);
        values.push(statuses);
        index += 1;
      }

      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const result = await pool.query(
        `SELECT
           schedule_id,
           label,
           user_id,
           wallet_id,
           beneficiary_id,
           source_amount,
           source_currency,
           destination_currency,
           cadence,
           next_run_at,
           occurrence_limit,
           executed_count,
           status,
           simulation_mode,
           callback_delay_ms,
           latest_transfer_id,
           last_run_at,
           last_transfer_status,
           last_failure_reason,
           created_at,
           updated_at
         FROM transfer_schedules
         ${where}
         ORDER BY next_run_at ASC, created_at ASC`,
        values
      );

      return result.rows.map((row) => buildTransferScheduleRecord(row));
    },
    async getTransferSchedule(scheduleId) {
      return queryTransferScheduleById(pool, scheduleId);
    },
    async listDueTransferSchedules(untilIso = new Date().toISOString(), limit = 20) {
      const result = await pool.query(
        `SELECT
           schedule_id,
           label,
           user_id,
           wallet_id,
           beneficiary_id,
           source_amount,
           source_currency,
           destination_currency,
           cadence,
           next_run_at,
           occurrence_limit,
           executed_count,
           status,
           simulation_mode,
           callback_delay_ms,
           latest_transfer_id,
           last_run_at,
           last_transfer_status,
           last_failure_reason,
           created_at,
           updated_at
         FROM transfer_schedules
         WHERE status = 'active'
           AND next_run_at <= $1
         ORDER BY next_run_at ASC
         LIMIT $2`,
        [untilIso, Number(limit || 20)]
      );

      return result.rows.map((row) => buildTransferScheduleRecord(row));
    },
    async withTransferScheduleLock(scheduleId, callback) {
      const client = await pool.connect();
      try {
        await client.query('SELECT pg_advisory_lock(hashtext($1))', [`schedule:${scheduleId}`]);
        const current = await queryTransferScheduleById(client, scheduleId);
        const next = await callback(current);
        if (!next) {
          return current;
        }

        await client.query('BEGIN');
        const saved = await saveTransferScheduleTx(client, next);
        await client.query('COMMIT');
        return saved;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // Ignore rollback failures if no transaction is active.
        }
        throw error;
      } finally {
        try {
          await client.query('SELECT pg_advisory_unlock(hashtext($1))', [`schedule:${scheduleId}`]);
        } finally {
          client.release();
        }
      }
    },
    async withTransferLock(transferId, callback) {
      const client = await pool.connect();
      try {
        await client.query('SELECT pg_advisory_lock(hashtext($1))', [transferId]);
        const current = await queryTransferById(client, transferId, { includeInternal: true });
        const next = await callback(current);
        if (!next) {
          return current;
        }

        await client.query('BEGIN');
        const saved = await saveTransferTx(client, next);
        await client.query('COMMIT');
        return saved;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // Ignore rollback failures if no transaction is active.
        }
        throw error;
      } finally {
        try {
          await client.query('SELECT pg_advisory_unlock(hashtext($1))', [transferId]);
        } finally {
          client.release();
        }
      }
    },
  };
}

export async function createTransferStore() {
  const connectionString = process.env.TRANSFERS_DATABASE_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    return createInMemoryTransferStore();
  }

  return createPostgresTransferStore(connectionString);
}
