import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { createClient } from 'redis';
import { z } from 'zod';

let sqsClient;

const notifySchema = z.object({
  userId: z.string().min(3),
  channel: z.enum(['email', 'sms', 'in_app']).default('in_app'),
  template: z.string().min(2),
  payload: z.record(z.unknown()).default({}),
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

function requireUserAccess(reply, auth, targetUserId) {
  if (!auth.userId) {
    reply.code(401).send({ error: 'unauthorized' });
    return false;
  }

  if (auth.userId !== targetUserId && !isPrivileged(auth.role)) {
    reply.code(403).send({ error: 'forbidden' });
    return false;
  }

  return true;
}

function buildSqsClient() {
  const endpoint = process.env.AWS_ENDPOINT_URL_SQS || process.env.AWS_ENDPOINT_URL;
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID || 'test';
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY || 'test';

  return new SQSClient({
    region: process.env.AWS_REGION || 'eu-west-2',
    ...(endpoint ? { endpoint } : {}),
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });
}

function getSqsClient() {
  if (!sqsClient) {
    sqsClient = buildSqsClient();
  }
  return sqsClient;
}

async function dispatchNotification(notification, deliveryMode) {
  if (deliveryMode !== 'sqs') {
    return {
      deliveryMode,
      queueMessageId: null,
    };
  }

  const queueUrl = process.env.NOTIFICATIONS_QUEUE_URL;
  if (!queueUrl) {
    throw new Error('missing_notifications_queue_url');
  }

  const result = await getSqsClient().send(new SendMessageCommand({
    QueueUrl: queueUrl,
    MessageBody: JSON.stringify({
      notificationId: notification.notificationId,
      userId: notification.userId,
      channel: notification.channel,
      template: notification.template,
      payload: notification.payload,
      createdAt: notification.createdAt,
    }),
    MessageAttributes: {
      channel: {
        DataType: 'String',
        StringValue: notification.channel,
      },
      template: {
        DataType: 'String',
        StringValue: notification.template,
      },
    },
  }));

  return {
    deliveryMode: 'sqs',
    queueMessageId: result.MessageId || null,
  };
}

export async function registerDomainRoutes(app, { store }) {
  if (!store) {
    throw new Error('notifications_store_missing');
  }

  const configuredDeliveryMode = process.env.NOTIFICATIONS_DELIVERY_MODE || 'redis';
  const redisUrl = process.env.NOTIFICATIONS_QUEUE_REDIS_URL || process.env.REDIS_URL || '';
  const notificationQueueKey = process.env.NOTIFICATIONS_QUEUE_KEY || 'ledgeway:notifications:queue';
  const notificationQueuePollMs = Number(process.env.NOTIFICATIONS_QUEUE_POLL_MS || 250);
  let resolvedDeliveryMode = configuredDeliveryMode;
  let notificationQueueClient;
  let notificationQueueWorker;

  async function processNotificationById(notificationId) {
    const item = await store.getNotification(notificationId);
    if (!item || item.status === 'sent') {
      return item;
    }

    try {
      const dispatch = await dispatchNotification(item, resolvedDeliveryMode);
      return store.updateNotification(item.notificationId, {
        status: 'sent',
        sentAt: new Date().toISOString(),
        deliveryMode: dispatch.deliveryMode,
        queueMessageId: dispatch.queueMessageId,
        error: null,
      });
    } catch (error) {
      return store.updateNotification(item.notificationId, {
        status: 'failed',
        failedAt: new Date().toISOString(),
        error: String(error),
      });
    }
  }

  async function drainNotificationQueue() {
    if (resolvedDeliveryMode !== 'redis' || !notificationQueueClient) {
      return;
    }

    for (let count = 0; count < 20; count += 1) {
      const notificationId = await notificationQueueClient.lPop(notificationQueueKey);
      if (!notificationId) break;
      await processNotificationById(notificationId);
    }
  }

  async function configureNotificationQueue() {
    if (configuredDeliveryMode !== 'redis' || !redisUrl) {
      return;
    }

    try {
      notificationQueueClient = createClient({ url: redisUrl });
      notificationQueueClient.on('error', (error) => {
        app.log.error({ error }, 'notification queue redis client error');
      });
      await notificationQueueClient.connect();
      notificationQueueWorker = setInterval(() => {
        drainNotificationQueue().catch((error) => {
          app.log.error({ error }, 'failed to drain notification queue');
        });
      }, notificationQueuePollMs);
    } catch (error) {
      app.log.warn({ error, redisUrl }, 'redis notification queue unavailable, falling back to direct delivery');
      resolvedDeliveryMode = 'memory';
      notificationQueueClient = undefined;
    }
  }

  await configureNotificationQueue();

  app.post('/v1/notifications/send', async (request, reply) => {
    const auth = authContext(request);
    const parsed = notifySchema.safeParse({
      ...(request.body || {}),
      userId: request.body?.userId || auth.userId,
    });
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation_error', details: parsed.error.flatten() });
    }
    if (!requireUserAccess(reply, auth, parsed.data.userId)) return;

    const item = await store.createNotification(parsed.data);

    if (resolvedDeliveryMode === 'redis' && notificationQueueClient) {
      try {
        const queued = await store.updateNotification(item.notificationId, {
          deliveryMode: 'redis',
          error: null,
        });
        await notificationQueueClient.rPush(notificationQueueKey, item.notificationId);
        return reply.code(202).send({ notification: queued });
      } catch (error) {
        const notification = await store.updateNotification(item.notificationId, {
          status: 'failed',
          failedAt: new Date().toISOString(),
          error: String(error),
        });

        return reply.code(502).send({
          error: 'notification_delivery_failed',
          notification,
        });
      }
    }

    try {
      const dispatch = await dispatchNotification(item, resolvedDeliveryMode);
      const notification = await store.updateNotification(item.notificationId, {
        status: 'sent',
        sentAt: new Date().toISOString(),
        deliveryMode: dispatch.deliveryMode,
        queueMessageId: dispatch.queueMessageId,
        error: null,
      });
      return reply.code(201).send({ notification });
    } catch (error) {
      const notification = await store.updateNotification(item.notificationId, {
        status: 'failed',
        failedAt: new Date().toISOString(),
        error: String(error),
      });

      return reply.code(502).send({
        error: 'notification_delivery_failed',
        notification,
      });
    }
  });

  app.get('/v1/notifications/:notificationId', async (request, reply) => {
    const auth = authContext(request);
    if (!auth.userId) {
      return reply.code(401).send({ error: 'unauthorized' });
    }

    const notification = await store.getNotification(request.params.notificationId);
    if (!notification) {
      return reply.code(404).send({ error: 'notification_not_found' });
    }

    if (!requireUserAccess(reply, auth, notification.userId)) return;
    return { notification };
  });

  app.post('/v1/notifications/:notificationId/read', async (request, reply) => {
    const auth = authContext(request);
    if (!auth.userId) {
      return reply.code(401).send({ error: 'unauthorized' });
    }

    const notification = await store.getNotification(request.params.notificationId);
    if (!notification) {
      return reply.code(404).send({ error: 'notification_not_found' });
    }

    if (!requireUserAccess(reply, auth, notification.userId)) return;

    if (notification.readAt) {
      return { notification };
    }

    const updated = await store.updateNotification(notification.notificationId, {
      readAt: new Date().toISOString(),
    });

    return { notification: updated || notification };
  });

  app.get('/v1/notifications', async (request, reply) => {
    const auth = authContext(request);
    const requestedUserId = request.query?.userId ? String(request.query.userId) : auth.userId;
    if (!requireUserAccess(reply, auth, requestedUserId)) return;
    return { notifications: await store.listNotifications({ userId: requestedUserId }) };
  });

  app.get('/internal/notifications', async () => ({ notifications: await store.listNotifications() }));

  app.addHook('onClose', async () => {
    if (notificationQueueWorker) {
      clearInterval(notificationQueueWorker);
    }
    if (notificationQueueClient?.isOpen) {
      await notificationQueueClient.quit();
    }
  });
}
