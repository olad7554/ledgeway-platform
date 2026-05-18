import { z } from 'zod';
import { evaluateKycPolicy } from '../kyc-policy.js';
import { createKycProvider } from '../kyc-provider.js';

const beneficiarySchema = z.object({
  userId: z.string().min(3),
  fullName: z.string().min(2),
  country: z.string().length(2),
  payoutMethod: z.enum(['bank_account', 'wallet']),
  accountNumber: z.string().min(4),
  bankCode: z.string().optional(),
  currency: z.enum(['USD', 'EUR', 'GBP', 'CAD']),
});

const kycSchema = z.object({
  userId: z.string().min(3),
  country: z.string().length(2),
  documentType: z.enum(['passport', 'drivers_license', 'national_id']),
});

const kycDecisionSchema = z.object({
  status: z.enum(['approved', 'rejected']),
  riskTier: z.enum(['standard', 'enhanced', 'restricted']).optional(),
  reviewerNote: z.string().min(2).optional(),
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

export async function registerDomainRoutes(app, { store, artifactStore }) {
  if (!store) {
    throw new Error('customer_store_missing');
  }

  const kycProvider = createKycProvider(app.log);

  async function refreshProviderBackedStatus(currentRecord) {
    if (!currentRecord?.providerReference || !kycProvider.isEnabled()) {
      return currentRecord;
    }

    if (currentRecord.status !== 'pending') {
      return currentRecord;
    }

    try {
      const providerDecision = await kycProvider.refreshVerification(currentRecord);
      if (!providerDecision || !providerDecision.finalized) {
        return currentRecord;
      }

      return store.decideKycCheck({
        userId: currentRecord.userId,
        status: providerDecision.status,
        riskTier: providerDecision.riskTier,
        reviewerNote: undefined,
        reviewedBy: providerDecision.providerName,
        decisionReason: providerDecision.decisionReason,
        providerName: providerDecision.providerName,
        providerReference: providerDecision.providerReference,
        providerStatus: providerDecision.providerStatus,
        verificationUrl: providerDecision.verificationUrl,
      });
    } catch (error) {
      app.log.warn({ error, userId: currentRecord.userId }, 'failed to refresh provider-backed kyc status');
      return currentRecord;
    }
  }

  app.get('/v1/profiles/:userId', async (request, reply) => {
    const auth = authContext(request);
    const { userId } = request.params;
    if (!requireUserAccess(reply, auth, userId)) return;
    return store.ensureProfile(userId);
  });

  app.post('/v1/kyc/check', async (request, reply) => {
    const auth = authContext(request);
    const parsed = kycSchema.safeParse({
      ...(request.body || {}),
      userId: request.body?.userId || auth.userId,
    });
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation_error', details: parsed.error.flatten() });
    }

    if (!requireUserAccess(reply, auth, parsed.data.userId)) return;

    const { userId, country, documentType } = parsed.data;
    await store.ensureProfile(userId);
    const requestedAt = new Date().toISOString();

    if (kycProvider.isEnabled()) {
      try {
        const providerSession = await kycProvider.startVerification({
          userId,
          country,
          documentType,
        });

        const artifact = await artifactStore.writeKycArtifact({
          userId,
          country,
          documentType,
          provider: providerSession.providerName,
          providerReference: providerSession.providerReference,
          verificationUrl: providerSession.verificationUrl,
          requestedAt,
        });

        const result = await store.recordKycCheck({
          userId,
          country,
          documentType,
          status: 'pending',
          riskTier: 'enhanced',
          decisionReason: 'provider_session_created',
          artifactKey: artifact.artifactKey,
          evidenceStore: artifact.evidenceStore,
          providerName: providerSession.providerName,
          providerReference: providerSession.providerReference,
          providerStatus: providerSession.providerStatus,
          verificationUrl: providerSession.verificationUrl,
        });

        return { result };
      } catch (error) {
        const errorCode = String(error?.code || '');
        if (errorCode === 'kyc_provider_not_configured') {
          return reply.code(500).send({ error: 'kyc_provider_not_configured', details: error.context || {} });
        }

        if (errorCode.startsWith('kyc_provider_request_failed')) {
          return reply.code(502).send({ error: 'kyc_provider_request_failed', details: error.context || {} });
        }

        throw error;
      }
    }

    const decision = evaluateKycPolicy({ country, documentType });
    const artifact = await artifactStore.writeKycArtifact({
      userId,
      country,
      documentType,
      decision,
      requestedAt,
    });

    const result = await store.recordKycCheck({
      userId,
      country,
      documentType,
      status: decision.status,
      riskTier: decision.riskTier,
      decisionReason: decision.reason,
      artifactKey: artifact.artifactKey,
      evidenceStore: artifact.evidenceStore,
    });

    return { result };
  });

  app.get('/v1/kyc/:userId/status', async (request, reply) => {
    const auth = authContext(request);
    const { userId } = request.params;
    if (!requireUserAccess(reply, auth, userId)) return;

    const result = await store.getKycStatus(userId);
    if (!result) return reply.code(404).send({ error: 'not_found' });
    return refreshProviderBackedStatus(result);
  });

  app.post('/v1/kyc/:userId/decision', async (request, reply) => {
    const auth = authContext(request);
    if (!auth.userId) {
      return reply.code(401).send({ error: 'unauthorized' });
    }

    if (!isPrivileged(auth.role)) {
      return reply.code(403).send({ error: 'forbidden' });
    }

    const parsed = kycDecisionSchema.safeParse(request.body || {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation_error', details: parsed.error.flatten() });
    }

    try {
      const decision = await store.decideKycCheck({
        userId: request.params.userId,
        status: parsed.data.status,
        riskTier: parsed.data.riskTier || (parsed.data.status === 'approved' ? 'enhanced' : 'restricted'),
        reviewerNote: parsed.data.reviewerNote,
        reviewedBy: auth.userId,
        decisionReason: parsed.data.status === 'approved' ? 'manual_ops_approval' : 'manual_ops_rejection',
      });

      return { result: decision };
    } catch (error) {
      if (error?.code === 'kyc_not_found') {
        return reply.code(404).send({ error: 'kyc_not_found' });
      }
      throw error;
    }
  });

  app.post('/v1/beneficiaries', async (request, reply) => {
    const auth = authContext(request);
    const parsed = beneficiarySchema.safeParse({
      ...(request.body || {}),
      userId: request.body?.userId || auth.userId,
    });
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation_error', details: parsed.error.flatten() });
    }

    if (!requireUserAccess(reply, auth, parsed.data.userId)) return;

    const beneficiary = await store.createBeneficiary(parsed.data);
    return reply.code(201).send({ beneficiary });
  });

  app.get('/v1/beneficiaries/:userId', async (request, reply) => {
    const auth = authContext(request);
    const { userId } = request.params;
    if (!requireUserAccess(reply, auth, userId)) return;
    return { userId, beneficiaries: await store.listBeneficiaries(userId) };
  });
}
