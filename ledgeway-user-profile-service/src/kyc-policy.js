const DEFAULT_APPROVE_COUNTRIES = ['US', 'GB', 'CA', 'IE', 'DE', 'FR', 'ES', 'NL'];
const DEFAULT_REVIEW_COUNTRIES = ['NG', 'BR', 'PK', 'TR', 'ZA'];
const DEFAULT_REJECT_COUNTRIES = ['IR', 'KP', 'SY', 'CU'];

function parseCsv(value, fallback) {
  const raw = String(value || '')
    .split(',')
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);
  return raw.length ? raw : fallback;
}

function normalizeCountry(country) {
  return String(country || '').trim().toUpperCase();
}

function autoApproveEnabled() {
  return process.env.KYC_AUTO_APPROVE !== 'false';
}

export function evaluateKycPolicy({ country, documentType }) {
  if (autoApproveEnabled()) {
    return {
      status: 'approved',
      riskTier: 'standard',
      reason: 'auto_approved_for_teaching_runtime',
      decisionSource: 'auto_approve',
    };
  }

  const normalizedCountry = normalizeCountry(country);
  const approveCountries = parseCsv(process.env.KYC_APPROVE_COUNTRIES, DEFAULT_APPROVE_COUNTRIES);
  const reviewCountries = parseCsv(process.env.KYC_REVIEW_COUNTRIES, DEFAULT_REVIEW_COUNTRIES);
  const rejectCountries = parseCsv(process.env.KYC_REJECT_COUNTRIES, DEFAULT_REJECT_COUNTRIES);

  if (rejectCountries.includes(normalizedCountry)) {
    return {
      status: 'rejected',
      riskTier: 'restricted',
      reason: 'country_restricted',
      decisionSource: 'policy_engine',
    };
  }

  if (reviewCountries.includes(normalizedCountry)) {
    return {
      status: 'review_required',
      riskTier: 'enhanced',
      reason: 'country_requires_manual_review',
      decisionSource: 'policy_engine',
    };
  }

  if (documentType === 'national_id' && !approveCountries.includes(normalizedCountry)) {
    return {
      status: 'review_required',
      riskTier: 'enhanced',
      reason: 'document_requires_manual_review',
      decisionSource: 'policy_engine',
    };
  }

  return {
    status: 'approved',
    riskTier: approveCountries.includes(normalizedCountry) ? 'standard' : 'enhanced',
    reason: approveCountries.includes(normalizedCountry)
      ? 'policy_passed_standard'
      : 'policy_passed_enhanced',
    decisionSource: 'policy_engine',
  };
}
