import { randomUUID } from 'node:crypto';

const DEFAULT_FEATURE_FLAGS = [
  {
    key: 'cards',
    enabled: false,
    description: 'Enable card management and card charge flows in the web app.',
    audience: 'all',
  },
  {
    key: 'ops_console',
    enabled: true,
    description: 'Enable the operations/admin workspace for ops and admin users.',
    audience: 'ops',
  },
  {
    key: 'debug_tools',
    enabled: false,
    description: 'Enable simulator-heavy debug and webhook testing controls.',
    audience: 'ops',
  },
  {
    key: 'scheduled_transfers',
    enabled: true,
    description: 'Enable scheduled and recurring transfer plans.',
    audience: 'all',
  },
  {
    key: 'statements',
    enabled: true,
    description: 'Enable wallet statement views.',
    audience: 'all',
  },
  {
    key: 'transaction_exports',
    enabled: true,
    description: 'Enable CSV, PDF, and JSON transaction exports.',
    audience: 'all',
  },
];

function buildAuditEventRecord(row) {
  if (!row) return null;
  return {
    eventId: row.event_id ?? row.eventId,
    timestamp: row.timestamp,
    actor: row.actor,
    action: row.action,
    entityType: row.entity_type ?? row.entityType,
    entityId: row.entity_id ?? row.entityId,
    metadata: row.metadata || {},
  };
}

function buildReconciliationRunRecord(row) {
  if (!row) return null;
  return {
    runId: row.run_id ?? row.runId,
    createdAt: row.created_at ?? row.createdAt,
    transferCount: Number(row.transfer_count ?? row.transferCount ?? 0),
    notificationCount: Number(row.notification_count ?? row.notificationCount ?? 0),
    discrepancyCount: Number(row.discrepancy_count ?? row.discrepancyCount ?? 0),
    discrepancies: row.discrepancies || [],
    status: row.status,
  };
}

function buildFeatureFlagRecord(row) {
  if (!row) return null;
  return {
    key: row.flag_key ?? row.key,
    enabled: Boolean(row.enabled),
    description: row.description ?? '',
    audience: row.audience ?? 'all',
    updatedAt: row.updated_at ?? row.updatedAt,
    updatedBy: row.updated_by ?? row.updatedBy ?? 'system',
  };
}

function createInMemoryOperationsStore() {
  const events = [];
  const reconciliationRuns = new Map();
  const featureFlags = new Map(
    DEFAULT_FEATURE_FLAGS.map((flag) => [
      flag.key,
      {
        flagKey: flag.key,
        enabled: flag.enabled,
        description: flag.description,
        audience: flag.audience,
        updatedAt: new Date().toISOString(),
        updatedBy: 'system',
      },
    ])
  );

  return {
    kind: 'memory',
    async createAuditEvent(data) {
      const event = {
        eventId: `aud_${randomUUID()}`,
        timestamp: new Date().toISOString(),
        ...data,
      };
      events.push(event);
      return buildAuditEventRecord(event);
    },
    async listAuditEvents({ entityId, action, limit } = {}) {
      let filtered = [...events];
      if (entityId) filtered = filtered.filter((item) => item.entityId === entityId);
      if (action) filtered = filtered.filter((item) => item.action === action);
      const max = Number(limit || 200);
      return filtered.slice(-max).reverse().map((item) => buildAuditEventRecord(item));
    },
    async createReconciliationRun(run) {
      reconciliationRuns.set(run.runId, run);
      await this.createAuditEvent({
        actor: 'operations-service',
        action: 'integrity_check_completed',
        entityType: 'reconciliation_run',
        entityId: run.runId,
        metadata: {
          discrepancyCount: run.discrepancyCount,
        },
      });
      return buildReconciliationRunRecord(run);
    },
    async getReconciliationRun(runId) {
      return buildReconciliationRunRecord(reconciliationRuns.get(runId));
    },
    async listFeatureFlags() {
      return Array.from(featureFlags.values())
        .sort((left, right) => String(left.flagKey).localeCompare(String(right.flagKey)))
        .map((flag) => buildFeatureFlagRecord(flag));
    },
    async upsertFeatureFlag({ key, enabled, description, audience, updatedBy }) {
      const next = {
        flagKey: key,
        enabled: Boolean(enabled),
        description: description || '',
        audience: audience || 'all',
        updatedAt: new Date().toISOString(),
        updatedBy: updatedBy || 'system',
      };
      featureFlags.set(key, next);
      return buildFeatureFlagRecord(next);
    },
  };
}

async function createPostgresOperationsStore(connectionString) {
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString });

  let initialized = false;
  let lastError;
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS operations_audit_events (
          event_id TEXT PRIMARY KEY,
          timestamp TIMESTAMPTZ NOT NULL,
          actor TEXT NOT NULL,
          action TEXT NOT NULL,
          entity_type TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb
        )
      `);

      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_operations_audit_events_entity_id
        ON operations_audit_events(entity_id)
      `);

      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_operations_audit_events_action
        ON operations_audit_events(action)
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS operations_reconciliation_runs (
          run_id TEXT PRIMARY KEY,
          created_at TIMESTAMPTZ NOT NULL,
          transfer_count INTEGER NOT NULL,
          notification_count INTEGER NOT NULL,
          discrepancy_count INTEGER NOT NULL,
          discrepancies JSONB NOT NULL DEFAULT '[]'::jsonb,
          status TEXT NOT NULL
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS operations_feature_flags (
          flag_key TEXT PRIMARY KEY,
          enabled BOOLEAN NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          audience TEXT NOT NULL DEFAULT 'all',
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_by TEXT NOT NULL DEFAULT 'system'
        )
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

  for (const flag of DEFAULT_FEATURE_FLAGS) {
    await pool.query(
      `INSERT INTO operations_feature_flags (flag_key, enabled, description, audience, updated_at, updated_by)
       VALUES ($1, $2, $3, $4, NOW(), 'system')
       ON CONFLICT (flag_key) DO NOTHING`,
      [flag.key, flag.enabled, flag.description, flag.audience]
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

  return {
    kind: 'postgres',
    async createAuditEvent(data) {
      const eventId = `aud_${randomUUID()}`;
      const timestamp = new Date().toISOString();
      const result = await pool.query(
        `INSERT INTO operations_audit_events (event_id, timestamp, actor, action, entity_type, entity_id, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
         RETURNING event_id, timestamp, actor, action, entity_type, entity_id, metadata`,
        [
          eventId,
          timestamp,
          data.actor,
          data.action,
          data.entityType,
          data.entityId,
          JSON.stringify(data.metadata || {}),
        ]
      );

      return buildAuditEventRecord(result.rows[0]);
    },
    async listAuditEvents({ entityId, action, limit } = {}) {
      const clauses = [];
      const values = [];
      let index = 1;

      if (entityId) {
        clauses.push(`entity_id = $${index}`);
        values.push(entityId);
        index += 1;
      }

      if (action) {
        clauses.push(`action = $${index}`);
        values.push(action);
        index += 1;
      }

      const max = Number(limit || 200);
      values.push(max);

      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const result = await pool.query(
        `SELECT event_id, timestamp, actor, action, entity_type, entity_id, metadata
         FROM operations_audit_events
         ${where}
         ORDER BY timestamp DESC
         LIMIT $${index}`,
        values
      );

      return result.rows.map((row) => buildAuditEventRecord(row));
    },
    async createReconciliationRun(run) {
      return withTransaction(async (client) => {
        await client.query(
          `INSERT INTO operations_reconciliation_runs (
            run_id,
            created_at,
            transfer_count,
            notification_count,
            discrepancy_count,
            discrepancies,
            status
          ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
          [
            run.runId,
            run.createdAt,
            run.transferCount,
            run.notificationCount,
            run.discrepancyCount,
            JSON.stringify(run.discrepancies || []),
            run.status,
          ]
        );

        await client.query(
          `INSERT INTO operations_audit_events (event_id, timestamp, actor, action, entity_type, entity_id, metadata)
           VALUES ($1, $2, 'operations-service', 'integrity_check_completed', 'reconciliation_run', $3, $4::jsonb)`,
          [
            `aud_${randomUUID()}`,
            new Date().toISOString(),
            run.runId,
            JSON.stringify({ discrepancyCount: run.discrepancyCount }),
          ]
        );

        return buildReconciliationRunRecord(run);
      });
    },
    async getReconciliationRun(runId) {
      const result = await pool.query(
        `SELECT run_id, created_at, transfer_count, notification_count, discrepancy_count, discrepancies, status
         FROM operations_reconciliation_runs
         WHERE run_id = $1
         LIMIT 1`,
        [runId]
      );

      return buildReconciliationRunRecord(result.rows[0]);
    },
    async listFeatureFlags() {
      const result = await pool.query(
        `SELECT flag_key, enabled, description, audience, updated_at, updated_by
         FROM operations_feature_flags
         ORDER BY flag_key ASC`
      );

      return result.rows.map((row) => buildFeatureFlagRecord(row));
    },
    async upsertFeatureFlag({ key, enabled, description, audience, updatedBy }) {
      const result = await pool.query(
        `INSERT INTO operations_feature_flags (flag_key, enabled, description, audience, updated_at, updated_by)
         VALUES ($1, $2, $3, $4, NOW(), $5)
         ON CONFLICT (flag_key) DO UPDATE SET
           enabled = EXCLUDED.enabled,
           description = EXCLUDED.description,
           audience = EXCLUDED.audience,
           updated_at = NOW(),
           updated_by = EXCLUDED.updated_by
         RETURNING flag_key, enabled, description, audience, updated_at, updated_by`,
        [key, Boolean(enabled), description || '', audience || 'all', updatedBy || 'system']
      );

      return buildFeatureFlagRecord(result.rows[0]);
    },
  };
}

export async function createOperationsStore() {
  const connectionString = process.env.OPERATIONS_DATABASE_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    return createInMemoryOperationsStore();
  }

  return createPostgresOperationsStore(connectionString);
}
