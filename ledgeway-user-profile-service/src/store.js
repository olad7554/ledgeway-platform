import { randomUUID } from 'node:crypto';

function createStoreError(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function defaultProfile(userId) {
  return {
    userId,
    fullName: 'Ledgeway User',
    riskTier: 'standard',
    verificationStatus: 'not_started',
  };
}

function buildProfileRecord(row) {
  if (!row) return null;
  return {
    userId: row.user_id ?? row.userId,
    fullName: row.full_name ?? row.fullName,
    riskTier: row.risk_tier ?? row.riskTier,
    verificationStatus: row.verification_status ?? row.verificationStatus,
    createdAt: row.created_at ?? row.createdAt,
    updatedAt: row.updated_at ?? row.updatedAt,
  };
}

function buildKycRecord(row) {
  if (!row) return null;
  return {
    userId: row.user_id ?? row.userId,
    country: row.country,
    documentType: row.document_type ?? row.documentType,
    status: row.status,
    riskTier: row.risk_tier ?? row.riskTier,
    decisionReason: row.decision_reason ?? row.decisionReason ?? undefined,
    reviewerNote: row.reviewer_note ?? row.reviewerNote ?? undefined,
    reviewedBy: row.reviewed_by ?? row.reviewedBy ?? undefined,
    reviewedAt: row.reviewed_at ?? row.reviewedAt ?? undefined,
    artifactKey: row.artifact_key ?? row.artifactKey ?? undefined,
    evidenceStore: row.evidence_store ?? row.evidenceStore ?? undefined,
    providerName: row.provider_name ?? row.providerName ?? undefined,
    providerReference: row.provider_reference ?? row.providerReference ?? undefined,
    providerStatus: row.provider_status ?? row.providerStatus ?? undefined,
    verificationUrl: row.verification_url ?? row.verificationUrl ?? undefined,
    checkedAt: row.checked_at ?? row.checkedAt,
  };
}

function buildBeneficiaryRecord(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id ?? row.userId,
    fullName: row.full_name ?? row.fullName,
    country: row.country,
    payoutMethod: row.payout_method ?? row.payoutMethod,
    accountNumber: row.account_number ?? row.accountNumber,
    bankCode: row.bank_code ?? row.bankCode ?? undefined,
    currency: row.currency,
    createdAt: row.created_at ?? row.createdAt,
  };
}

function createInMemoryCustomerStore() {
  const profiles = new Map();
  const beneficiariesByUser = new Map();
  const kycByUser = new Map();

  return {
    kind: 'memory',
    async ensureProfile(userId, overrides = {}) {
      if (!profiles.has(userId)) {
        profiles.set(userId, {
          ...defaultProfile(userId),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      }

      const existing = profiles.get(userId);
      const next = {
        ...existing,
        ...overrides,
        updatedAt: new Date().toISOString(),
      };
      profiles.set(userId, next);
      return buildProfileRecord(next);
    },
    async recordKycCheck({
      userId,
      country,
      documentType,
      status,
      riskTier,
      decisionReason,
      artifactKey,
      evidenceStore,
      providerName,
      providerReference,
      providerStatus,
      verificationUrl,
    }) {
      const result = {
        userId,
        country,
        documentType,
        status,
        riskTier,
        decisionReason,
        artifactKey: artifactKey || undefined,
        evidenceStore: evidenceStore || undefined,
        providerName: providerName || undefined,
        providerReference: providerReference || undefined,
        providerStatus: providerStatus || undefined,
        verificationUrl: verificationUrl || undefined,
        reviewerNote: undefined,
        reviewedBy: undefined,
        reviewedAt: undefined,
        checkedAt: new Date().toISOString(),
      };

      kycByUser.set(userId, result);
      await this.ensureProfile(userId, {
        riskTier,
        verificationStatus: status,
      });

      return buildKycRecord(result);
    },
    async getKycStatus(userId) {
      return buildKycRecord(kycByUser.get(userId));
    },
    async decideKycCheck({
      userId,
      status,
      riskTier,
      reviewerNote,
      reviewedBy,
      decisionReason,
      providerName,
      providerReference,
      providerStatus,
      verificationUrl,
    }) {
      const current = kycByUser.get(userId);
      if (!current) {
        throw createStoreError('kyc_not_found');
      }

      const next = {
        ...current,
        status,
        riskTier,
        decisionReason,
        reviewerNote,
        reviewedBy,
        reviewedAt: new Date().toISOString(),
        providerName: providerName ?? current.providerName,
        providerReference: providerReference ?? current.providerReference,
        providerStatus: providerStatus ?? current.providerStatus,
        verificationUrl: verificationUrl ?? current.verificationUrl,
      };

      kycByUser.set(userId, next);
      await this.ensureProfile(userId, {
        riskTier,
        verificationStatus: status,
      });

      return buildKycRecord(next);
    },
    async createBeneficiary(data) {
      const beneficiary = {
        id: `bnf_${randomUUID()}`,
        ...data,
        createdAt: new Date().toISOString(),
      };

      const current = beneficiariesByUser.get(data.userId) || [];
      current.push(beneficiary);
      beneficiariesByUser.set(data.userId, current);

      return buildBeneficiaryRecord(beneficiary);
    },
    async listBeneficiaries(userId) {
      return (beneficiariesByUser.get(userId) || []).map((item) => buildBeneficiaryRecord(item));
    },
  };
}

async function createPostgresCustomerStore(connectionString) {
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString });

  let initialized = false;
  let lastError;
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS customer_profiles (
          user_id TEXT PRIMARY KEY,
          full_name TEXT NOT NULL,
          risk_tier TEXT NOT NULL,
          verification_status TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS customer_kyc_checks (
          user_id TEXT PRIMARY KEY REFERENCES customer_profiles(user_id) ON DELETE CASCADE,
          country TEXT NOT NULL,
          document_type TEXT NOT NULL,
          status TEXT NOT NULL,
          risk_tier TEXT NOT NULL,
          decision_reason TEXT,
          reviewer_note TEXT,
          reviewed_by TEXT,
          reviewed_at TIMESTAMPTZ,
          artifact_key TEXT,
          evidence_store TEXT,
          provider_name TEXT,
          provider_reference TEXT,
          provider_status TEXT,
          verification_url TEXT,
          checked_at TIMESTAMPTZ NOT NULL
        )
      `);

      await pool.query(`
        ALTER TABLE customer_kyc_checks
        ADD COLUMN IF NOT EXISTS decision_reason TEXT
      `);
      await pool.query(`
        ALTER TABLE customer_kyc_checks
        ADD COLUMN IF NOT EXISTS reviewer_note TEXT
      `);
      await pool.query(`
        ALTER TABLE customer_kyc_checks
        ADD COLUMN IF NOT EXISTS reviewed_by TEXT
      `);
      await pool.query(`
        ALTER TABLE customer_kyc_checks
        ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ
      `);
      await pool.query(`
        ALTER TABLE customer_kyc_checks
        ADD COLUMN IF NOT EXISTS artifact_key TEXT
      `);
      await pool.query(`
        ALTER TABLE customer_kyc_checks
        ADD COLUMN IF NOT EXISTS evidence_store TEXT
      `);
      await pool.query(`
        ALTER TABLE customer_kyc_checks
        ADD COLUMN IF NOT EXISTS provider_name TEXT
      `);
      await pool.query(`
        ALTER TABLE customer_kyc_checks
        ADD COLUMN IF NOT EXISTS provider_reference TEXT
      `);
      await pool.query(`
        ALTER TABLE customer_kyc_checks
        ADD COLUMN IF NOT EXISTS provider_status TEXT
      `);
      await pool.query(`
        ALTER TABLE customer_kyc_checks
        ADD COLUMN IF NOT EXISTS verification_url TEXT
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS customer_beneficiaries (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES customer_profiles(user_id) ON DELETE CASCADE,
          full_name TEXT NOT NULL,
          country TEXT NOT NULL,
          payout_method TEXT NOT NULL,
          account_number TEXT NOT NULL,
          bank_code TEXT,
          currency TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_customer_beneficiaries_user_id
        ON customer_beneficiaries(user_id)
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

  async function queryProfile(executor, userId) {
    const result = await executor.query(
      `SELECT user_id, full_name, risk_tier, verification_status, created_at, updated_at
       FROM customer_profiles
       WHERE user_id = $1
       LIMIT 1`,
      [userId]
    );

    return buildProfileRecord(result.rows[0]);
  }

  async function ensureProfileTx(client, userId, overrides = {}) {
    const defaults = defaultProfile(userId);
    await client.query(
      `INSERT INTO customer_profiles (user_id, full_name, risk_tier, verification_status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW())
       ON CONFLICT (user_id) DO NOTHING`,
      [userId, defaults.fullName, defaults.riskTier, defaults.verificationStatus]
    );

    const existing = await queryProfile(client, userId);
    if (!existing) {
      throw createStoreError('profile_not_found');
    }

    const next = {
      ...existing,
      ...overrides,
    };

    await client.query(
      `UPDATE customer_profiles
       SET full_name = $2,
           risk_tier = $3,
           verification_status = $4,
           updated_at = NOW()
       WHERE user_id = $1`,
      [userId, next.fullName, next.riskTier, next.verificationStatus]
    );

    return queryProfile(client, userId);
  }

  return {
    kind: 'postgres',
    async ensureProfile(userId, overrides = {}) {
      return withTransaction(async (client) => ensureProfileTx(client, userId, overrides));
    },
    async recordKycCheck({
      userId,
      country,
      documentType,
      status,
      riskTier,
      decisionReason,
      artifactKey,
      evidenceStore,
      providerName,
      providerReference,
      providerStatus,
      verificationUrl,
    }) {
      return withTransaction(async (client) => {
        const profile = await ensureProfileTx(client, userId, {
          riskTier,
          verificationStatus: status,
        });

        const checkedAt = new Date().toISOString();
        await client.query(
          `INSERT INTO customer_kyc_checks (
             user_id,
             country,
             document_type,
             status,
             risk_tier,
             decision_reason,
             reviewer_note,
             reviewed_by,
             reviewed_at,
             artifact_key,
             evidence_store,
             provider_name,
             provider_reference,
             provider_status,
             verification_url,
             checked_at
           )
           VALUES ($1, $2, $3, $4, $5, $6, NULL, NULL, NULL, $7, $8, $9, $10, $11, $12, $13)
           ON CONFLICT (user_id) DO UPDATE SET
             country = EXCLUDED.country,
             document_type = EXCLUDED.document_type,
             status = EXCLUDED.status,
             risk_tier = EXCLUDED.risk_tier,
             decision_reason = EXCLUDED.decision_reason,
             reviewer_note = NULL,
             reviewed_by = NULL,
             reviewed_at = NULL,
             artifact_key = EXCLUDED.artifact_key,
             evidence_store = EXCLUDED.evidence_store,
             provider_name = EXCLUDED.provider_name,
             provider_reference = EXCLUDED.provider_reference,
             provider_status = EXCLUDED.provider_status,
             verification_url = EXCLUDED.verification_url,
             checked_at = EXCLUDED.checked_at`,
          [
            profile.userId,
            country,
            documentType,
            status,
            riskTier,
            decisionReason || null,
            artifactKey || null,
            evidenceStore || null,
            providerName || null,
            providerReference || null,
            providerStatus || null,
            verificationUrl || null,
            checkedAt,
          ]
        );

        const result = await client.query(
          `SELECT
             user_id,
             country,
             document_type,
             status,
             risk_tier,
             decision_reason,
             reviewer_note,
             reviewed_by,
             reviewed_at,
             artifact_key,
             evidence_store,
             provider_name,
             provider_reference,
             provider_status,
             verification_url,
             checked_at
           FROM customer_kyc_checks
           WHERE user_id = $1
           LIMIT 1`,
          [profile.userId]
        );

        return buildKycRecord(result.rows[0]);
      });
    },
    async getKycStatus(userId) {
      const result = await pool.query(
        `SELECT
           user_id,
           country,
           document_type,
           status,
           risk_tier,
           decision_reason,
           reviewer_note,
           reviewed_by,
           reviewed_at,
           artifact_key,
           evidence_store,
           provider_name,
           provider_reference,
           provider_status,
           verification_url,
           checked_at
         FROM customer_kyc_checks
         WHERE user_id = $1
         LIMIT 1`,
        [userId]
      );

      return buildKycRecord(result.rows[0]);
    },
    async decideKycCheck({
      userId,
      status,
      riskTier,
      reviewerNote,
      reviewedBy,
      decisionReason,
      providerName,
      providerReference,
      providerStatus,
      verificationUrl,
    }) {
      return withTransaction(async (client) => {
        const current = await client.query(
          `SELECT
             user_id,
             country,
             document_type,
             status,
             risk_tier,
             decision_reason,
             reviewer_note,
             reviewed_by,
             reviewed_at,
             artifact_key,
             evidence_store,
             provider_name,
             provider_reference,
             provider_status,
             verification_url,
             checked_at
           FROM customer_kyc_checks
           WHERE user_id = $1
           LIMIT 1`,
          [userId]
        );

        if (!current.rows[0]) {
          throw createStoreError('kyc_not_found');
        }

        await ensureProfileTx(client, userId, {
          riskTier,
          verificationStatus: status,
        });

        await client.query(
          `UPDATE customer_kyc_checks
           SET status = $2,
               risk_tier = $3,
               decision_reason = $4,
               reviewer_note = $5,
               reviewed_by = $6,
               reviewed_at = $7,
               provider_name = COALESCE($8, provider_name),
               provider_reference = COALESCE($9, provider_reference),
               provider_status = COALESCE($10, provider_status),
               verification_url = COALESCE($11, verification_url)
           WHERE user_id = $1`,
          [
            userId,
            status,
            riskTier,
            decisionReason || null,
            reviewerNote || null,
            reviewedBy || null,
            new Date().toISOString(),
            providerName ?? null,
            providerReference ?? null,
            providerStatus ?? null,
            verificationUrl ?? null,
          ]
        );

        const result = await client.query(
          `SELECT
             user_id,
             country,
             document_type,
             status,
             risk_tier,
             decision_reason,
             reviewer_note,
             reviewed_by,
             reviewed_at,
             artifact_key,
             evidence_store,
             provider_name,
             provider_reference,
             provider_status,
             verification_url,
             checked_at
           FROM customer_kyc_checks
           WHERE user_id = $1
           LIMIT 1`,
          [userId]
        );

        return buildKycRecord(result.rows[0]);
      });
    },
    async createBeneficiary(data) {
      return withTransaction(async (client) => {
        await ensureProfileTx(client, data.userId);

        const id = `bnf_${randomUUID()}`;
        const createdAt = new Date().toISOString();
        await client.query(
          `INSERT INTO customer_beneficiaries (
            id,
            user_id,
            full_name,
            country,
            payout_method,
            account_number,
            bank_code,
            currency,
            created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            id,
            data.userId,
            data.fullName,
            data.country,
            data.payoutMethod,
            data.accountNumber,
            data.bankCode || null,
            data.currency,
            createdAt,
          ]
        );

        return buildBeneficiaryRecord({
          id,
          ...data,
          createdAt,
        });
      });
    },
    async listBeneficiaries(userId) {
      const result = await pool.query(
        `SELECT id, user_id, full_name, country, payout_method, account_number, bank_code, currency, created_at
         FROM customer_beneficiaries
         WHERE user_id = $1
         ORDER BY created_at ASC`,
        [userId]
      );

      return result.rows.map((row) => buildBeneficiaryRecord(row));
    },
  };
}

export async function createCustomerStore() {
  const connectionString = process.env.CUSTOMER_DATABASE_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    return createInMemoryCustomerStore();
  }

  return createPostgresCustomerStore(connectionString);
}
