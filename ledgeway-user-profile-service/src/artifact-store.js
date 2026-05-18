import { randomUUID } from 'node:crypto';
import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

function buildClientConfig() {
  const bucket = process.env.S3_BUCKET;
  if (!bucket) return null;

  return {
    bucket,
    required: process.env.KYC_ARTIFACT_STORAGE_REQUIRED === 'true',
    client: new S3Client({
      region: process.env.S3_REGION || process.env.AWS_REGION || 'us-east-1',
      ...(process.env.S3_ENDPOINT_URL ? { endpoint: process.env.S3_ENDPOINT_URL } : {}),
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID || 'minio',
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY || 'minio-secret',
      },
    }),
  };
}

export function createArtifactStore(logger) {
  const config = buildClientConfig();
  if (!config) {
    return {
      kind: 'disabled',
      async writeKycArtifact() {
        if (process.env.KYC_ARTIFACT_STORAGE_REQUIRED === 'true') {
          throw new Error('kyc_artifact_storage_not_configured');
        }

        return {
          evidenceStore: 'disabled',
          artifactKey: null,
        };
      },
    };
  }

  let bucketReadyPromise;

  async function ensureBucket() {
    if (!bucketReadyPromise) {
      bucketReadyPromise = (async () => {
        try {
          await config.client.send(new HeadBucketCommand({ Bucket: config.bucket }));
        } catch (error) {
          const status = Number(error?.$metadata?.httpStatusCode || 0);
          if (![0, 301, 403, 404].includes(status)) {
            throw error;
          }

          try {
            await config.client.send(new CreateBucketCommand({ Bucket: config.bucket }));
          } catch (createError) {
            const code = String(createError?.name || createError?.Code || '');
            if (!['BucketAlreadyOwnedByYou', 'BucketAlreadyExists'].includes(code)) {
              throw createError;
            }
          }
        }
      })();
    }

    return bucketReadyPromise;
  }

  return {
    kind: 's3',
    async writeKycArtifact(payload) {
      const key = `kyc/${payload.userId}/${Date.now()}-${randomUUID()}.json`;

      try {
        await ensureBucket();
        await config.client.send(new PutObjectCommand({
          Bucket: config.bucket,
          Key: key,
          Body: JSON.stringify(payload, null, 2),
          ContentType: 'application/json',
        }));

        return {
          evidenceStore: 's3',
          artifactKey: key,
        };
      } catch (error) {
        logger?.error?.({ error, bucket: config.bucket, key }, 'failed to write kyc artifact');
        if (config.required) {
          throw error;
        }

        return {
          evidenceStore: 'disabled',
          artifactKey: null,
        };
      }
    },
  };
}
