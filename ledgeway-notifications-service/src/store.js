import { randomUUID } from 'node:crypto';

function buildNotificationRecord(row) {
  if (!row) return null;
  return {
    notificationId: row.notification_id ?? row.notificationId,
    userId: row.user_id ?? row.userId,
    channel: row.channel,
    template: row.template,
    payload: row.payload || {},
    status: row.status,
    createdAt: row.created_at ?? row.createdAt,
    updatedAt: row.updated_at ?? row.updatedAt,
    deliveryMode: row.delivery_mode ?? row.deliveryMode ?? undefined,
    queueMessageId: row.queue_message_id ?? row.queueMessageId ?? undefined,
    sentAt: row.sent_at ?? row.sentAt ?? undefined,
    failedAt: row.failed_at ?? row.failedAt ?? undefined,
    readAt: row.read_at ?? row.readAt ?? undefined,
    error: row.error ?? undefined,
  };
}

function createInMemoryNotificationsStore() {
  const notifications = [];

  return {
    kind: 'memory',
    async createNotification({ userId, channel, template, payload }) {
      const item = {
        notificationId: `ntf_${randomUUID()}`,
        userId,
        channel,
        template,
        payload,
        status: 'queued',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      notifications.push(item);
      return buildNotificationRecord(item);
    },
    async updateNotification(notificationId, patch) {
      const existing = notifications.find((item) => item.notificationId === notificationId);
      if (!existing) return null;
      Object.assign(existing, patch, { updatedAt: new Date().toISOString() });
      return buildNotificationRecord(existing);
    },
    async getNotification(notificationId) {
      return buildNotificationRecord(
        notifications.find((item) => item.notificationId === notificationId) || null
      );
    },
    async listNotifications({ userId } = {}) {
      return notifications
        .filter((item) => !userId || item.userId === userId)
        .map((item) => buildNotificationRecord(item));
    },
  };
}

async function createPostgresNotificationsStore(connectionString) {
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString });

  let initialized = false;
  let lastError;
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS notification_records (
          notification_id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          channel TEXT NOT NULL,
          template TEXT NOT NULL,
          payload JSONB NOT NULL DEFAULT '{}'::jsonb,
          status TEXT NOT NULL,
          delivery_mode TEXT,
          queue_message_id TEXT,
          error TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          sent_at TIMESTAMPTZ,
          failed_at TIMESTAMPTZ,
          read_at TIMESTAMPTZ
        )
      `);

      await pool.query(`
        ALTER TABLE notification_records
        ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ
      `);

      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_notification_records_user_id
        ON notification_records(user_id)
      `);

      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_notification_records_status
        ON notification_records(status)
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

  return {
    kind: 'postgres',
    async createNotification({ userId, channel, template, payload }) {
      const notificationId = `ntf_${randomUUID()}`;
      const result = await pool.query(
        `INSERT INTO notification_records (
          notification_id,
          user_id,
          channel,
          template,
          payload,
          status,
          created_at,
          updated_at
        ) VALUES ($1, $2, $3, $4, $5::jsonb, 'queued', NOW(), NOW())
        RETURNING notification_id, user_id, channel, template, payload, status, created_at, updated_at, delivery_mode, queue_message_id, sent_at, failed_at, read_at, error`,
        [notificationId, userId, channel, template, JSON.stringify(payload || {})]
      );

      return buildNotificationRecord(result.rows[0]);
    },
    async updateNotification(notificationId, patch) {
      const result = await pool.query(
        `UPDATE notification_records
         SET status = COALESCE($2, status),
             delivery_mode = COALESCE($3, delivery_mode),
             queue_message_id = COALESCE($4, queue_message_id),
             error = $5,
             sent_at = $6,
             failed_at = $7,
             read_at = COALESCE($8, read_at),
             updated_at = NOW()
         WHERE notification_id = $1
         RETURNING notification_id, user_id, channel, template, payload, status, created_at, updated_at, delivery_mode, queue_message_id, sent_at, failed_at, read_at, error`,
        [
          notificationId,
          patch.status ?? null,
          patch.deliveryMode ?? null,
          patch.queueMessageId ?? null,
          patch.error ?? null,
          patch.sentAt ?? null,
          patch.failedAt ?? null,
          patch.readAt ?? null,
        ]
      );

      return buildNotificationRecord(result.rows[0]);
    },
    async getNotification(notificationId) {
      const result = await pool.query(
        `SELECT notification_id, user_id, channel, template, payload, status, created_at, updated_at, delivery_mode, queue_message_id, sent_at, failed_at, read_at, error
         FROM notification_records
         WHERE notification_id = $1
         LIMIT 1`,
        [notificationId]
      );

      return buildNotificationRecord(result.rows[0]);
    },
    async listNotifications({ userId } = {}) {
      const result = userId
        ? await pool.query(
          `SELECT notification_id, user_id, channel, template, payload, status, created_at, updated_at, delivery_mode, queue_message_id, sent_at, failed_at, read_at, error
           FROM notification_records
           WHERE user_id = $1
           ORDER BY created_at DESC`,
          [userId]
        )
        : await pool.query(
          `SELECT notification_id, user_id, channel, template, payload, status, created_at, updated_at, delivery_mode, queue_message_id, sent_at, failed_at, read_at, error
           FROM notification_records
           ORDER BY created_at DESC`
        );

      return result.rows.map((row) => buildNotificationRecord(row));
    },
  };
}

export async function createNotificationsStore() {
  const connectionString = process.env.NOTIFICATIONS_DATABASE_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    return createInMemoryNotificationsStore();
  }

  return createPostgresNotificationsStore(connectionString);
}
