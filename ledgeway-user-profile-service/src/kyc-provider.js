import { createHmac } from 'node:crypto';

function normalizeMode() {
  return String(process.env.KYC_PROVIDER_MODE || 'policy').trim().toLowerCase();
}

function buildBaseUrl() {
  return String(process.env.KYC_PROVIDER_BASE_URL || '').trim().replace(/\/+$/, '');
}

function buildProviderError(code, context = {}) {
  const error = new Error(code);
  error.code = code;
  error.context = context;
  return error;
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function mapDocumentType(documentType) {
  if (documentType === 'passport') return 'PASSPORT';
  if (documentType === 'drivers_license') return 'DRIVERS_LICENSE';
  return 'ID_CARD';
}

function normalizeVerificationPayload(payload) {
  return payload?.verification || payload?.session || payload?.data?.verification || payload?.data || payload || {};
}

function mapProviderDecision(rawStatus) {
  const normalized = String(rawStatus || '').trim().toLowerCase();

  if (!normalized) {
    return {
      localStatus: 'pending',
      riskTier: 'enhanced',
      providerStatus: 'pending',
      finalized: false,
    };
  }

  if (['approved', 'success', 'verified'].includes(normalized)) {
    return {
      localStatus: 'approved',
      riskTier: 'standard',
      providerStatus: normalized,
      finalized: true,
    };
  }

  if (['review', 'review_required', 'resubmission_requested', 'needs_review'].includes(normalized)) {
    return {
      localStatus: 'review_required',
      riskTier: 'enhanced',
      providerStatus: normalized,
      finalized: true,
    };
  }

  if (['declined', 'rejected', 'failed', 'abandoned', 'expired'].includes(normalized)) {
    return {
      localStatus: 'rejected',
      riskTier: 'restricted',
      providerStatus: normalized,
      finalized: true,
    };
  }

  return {
    localStatus: 'pending',
    riskTier: 'enhanced',
    providerStatus: normalized,
    finalized: false,
  };
}

function cleanupPayload(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => cleanupPayload(item))
      .filter((item) => item !== undefined);
  }

  if (value && typeof value === 'object') {
    const next = {};
    for (const [key, entry] of Object.entries(value)) {
      const cleaned = cleanupPayload(entry);
      if (cleaned !== undefined) {
        next[key] = cleaned;
      }
    }
    return next;
  }

  return value === undefined ? undefined : value;
}

export function createKycProvider(logger) {
  const mode = normalizeMode();
  const baseUrl = buildBaseUrl();
  const apiKey = String(process.env.KYC_PROVIDER_API_KEY || '').trim();
  const apiSecret = String(process.env.KYC_PROVIDER_API_SECRET || '').trim();
  const timeoutMs = Number(process.env.KYC_PROVIDER_TIMEOUT_MS || 10_000);

  function isEnabled() {
    return mode === 'veriff';
  }

  function assertConfigured() {
    if (!baseUrl || !apiKey || !apiSecret) {
      throw buildProviderError('kyc_provider_not_configured', {
        mode,
        hasBaseUrl: Boolean(baseUrl),
        hasApiKey: Boolean(apiKey),
        hasApiSecret: Boolean(apiSecret),
      });
    }
  }

  async function request(url, options) {
    const response = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const payload = await readJson(response);
    if (!response.ok) {
      throw buildProviderError(`kyc_provider_request_failed:${response.status}`, {
        status: response.status,
        payload,
        url,
      });
    }
    return payload;
  }

  return {
    mode,
    isEnabled,
    async startVerification({ userId, country, documentType }) {
      if (!isEnabled()) {
        throw buildProviderError('kyc_provider_disabled', { mode });
      }

      assertConfigured();

      const payload = cleanupPayload({
        verification: {
          vendorData: userId,
          endUserId: userId,
          callback: process.env.KYC_PROVIDER_RETURN_URL || undefined,
          document: {
            country,
            type: mapDocumentType(documentType),
          },
        },
      });

      const providerPayload = await request(`${baseUrl}/v1/sessions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-auth-client': apiKey,
        },
        body: JSON.stringify(payload),
      });

      const verification = normalizeVerificationPayload(providerPayload);
      const sessionId = verification.id || verification.sessionId;
      const verificationUrl = verification.url || verification.hostedUrl || verification.sessionUrl;
      const providerStatus = String(verification.status || 'started').toLowerCase();

      if (!sessionId || !verificationUrl) {
        throw buildProviderError('kyc_provider_invalid_session_response', {
          payload: providerPayload,
        });
      }

      logger?.info?.({ userId, provider: 'veriff', sessionId }, 'kyc provider verification started');

      return {
        providerName: 'veriff',
        providerReference: String(sessionId),
        providerStatus,
        verificationUrl: String(verificationUrl),
      };
    },
    async refreshVerification(record) {
      if (!isEnabled() || !record?.providerReference) {
        return null;
      }

      assertConfigured();

      const signature = createHmac('sha256', apiSecret)
        .update(String(record.providerReference))
        .digest('hex');

      const providerPayload = await request(`${baseUrl}/v1/sessions/${encodeURIComponent(record.providerReference)}/decision`, {
        method: 'GET',
        headers: {
          'x-auth-client': apiKey,
          'x-hmac-signature': signature,
        },
      });

      const verification = normalizeVerificationPayload(providerPayload);
      const rawStatus =
        verification.status ||
        verification.decision ||
        verification.code ||
        providerPayload?.status ||
        providerPayload?.decision;
      const mapped = mapProviderDecision(rawStatus);

      return {
        providerName: 'veriff',
        providerReference: record.providerReference,
        providerStatus: mapped.providerStatus,
        verificationUrl: record.verificationUrl,
        status: mapped.localStatus,
        riskTier: mapped.riskTier,
        decisionReason:
          verification.reason ||
          verification.code ||
          providerPayload?.reason ||
          providerPayload?.code ||
          `provider_${mapped.providerStatus}`,
        finalized: mapped.finalized,
      };
    },
  };
}
