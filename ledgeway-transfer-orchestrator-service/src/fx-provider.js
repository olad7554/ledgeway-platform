const DEFAULT_SUPPORTED_CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD'];
const MANAGED_SOURCES = new Set(['bootstrap_default', 'frankfurter_live', 'identity_rate']);

function parseSupportedCurrencies() {
  const configured = String(process.env.FX_PROVIDER_SUPPORTED_CURRENCIES || '')
    .split(',')
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean);

  return configured.length ? configured : DEFAULT_SUPPORTED_CURRENCIES;
}

function providerMode() {
  return String(process.env.FX_PROVIDER_MODE || 'frankfurter').trim().toLowerCase();
}

function shouldManageExistingRate(existingRate) {
  if (!existingRate) return true;
  return MANAGED_SOURCES.has(String(existingRate.source || '').toLowerCase());
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

function extractRates(baseCurrency, payload) {
  if (Array.isArray(payload)) {
    return payload.reduce((accumulator, item) => {
      if (!item?.quote || item?.rate == null) return accumulator;
      accumulator[String(item.quote).toUpperCase()] = Number(item.rate);
      return accumulator;
    }, {});
  }

  if (payload?.rates && typeof payload.rates === 'object') {
    return Object.entries(payload.rates).reduce((accumulator, [quote, rate]) => {
      if (rate == null) return accumulator;
      accumulator[String(quote).toUpperCase()] = Number(rate);
      return accumulator;
    }, {});
  }

  if (payload?.quote && payload?.rate != null) {
    return {
      [String(payload.quote).toUpperCase()]: Number(payload.rate),
    };
  }

  throw new Error(`unsupported_fx_provider_payload:${baseCurrency}`);
}

async function fetchBaseRates(baseUrl, baseCurrency, quoteCurrencies) {
  if (!quoteCurrencies.length) return {};

  const url = new URL(baseUrl);
  url.searchParams.set('base', baseCurrency);
  url.searchParams.set('quotes', quoteCurrencies.join(','));

  const response = await fetch(url, {
    signal: AbortSignal.timeout(Number(process.env.FX_PROVIDER_TIMEOUT_MS || 5000)),
  });
  const payload = await readJson(response);

  if (!response.ok) {
    const error = new Error(`fx_provider_failed:${response.status}`);
    error.context = {
      status: response.status,
      payload,
      url: url.toString(),
    };
    throw error;
  }

  return extractRates(baseCurrency, payload);
}

export function createFxProvider({ store, logger }) {
  const mode = providerMode();
  const supportedCurrencies = parseSupportedCurrencies();
  const refreshIntervalMs = Number(process.env.FX_PROVIDER_REFRESH_INTERVAL_MS || 3_600_000);
  const baseUrl = process.env.FX_PROVIDER_BASE_URL || 'https://api.frankfurter.dev/v2/rates';
  let refreshTimer;

  async function refreshRates() {
    if (mode === 'disabled' || mode === 'manual') {
      return {
        provider: mode,
        refreshed: 0,
        skipped: 0,
        enabled: false,
      };
    }

    if (mode !== 'frankfurter') {
      throw new Error(`unsupported_fx_provider_mode:${mode}`);
    }

    const existingRates = await store.listFxRates();
    const existingByPair = new Map(existingRates.map((rate) => [`${rate.fromCurrency}:${rate.toCurrency}`, rate]));

    let refreshed = 0;
    let skipped = 0;

    for (const baseCurrency of supportedCurrencies) {
      const quoteCurrencies = supportedCurrencies.filter((currency) => currency !== baseCurrency);
      const providerRates = await fetchBaseRates(baseUrl, baseCurrency, quoteCurrencies);

      for (const targetCurrency of supportedCurrencies) {
        const rateValue = targetCurrency === baseCurrency ? 1 : providerRates[targetCurrency];
        if (!Number.isFinite(rateValue) || rateValue <= 0) {
          continue;
        }

        const pairKey = `${baseCurrency}:${targetCurrency}`;
        const existingRate = existingByPair.get(pairKey);
        if (!shouldManageExistingRate(existingRate)) {
          skipped += 1;
          continue;
        }

        const nextRate = await store.upsertFxRate({
          fromCurrency: baseCurrency,
          toCurrency: targetCurrency,
          rate: Number(rateValue),
          source: targetCurrency === baseCurrency ? 'identity_rate' : 'frankfurter_live',
        });
        existingByPair.set(pairKey, nextRate);
        refreshed += 1;
      }
    }

    return {
      provider: 'frankfurter',
      refreshed,
      skipped,
      enabled: true,
      updatedAt: new Date().toISOString(),
    };
  }

  return {
    mode,
    supportedCurrencies,
    isEnabled() {
      return !['disabled', 'manual'].includes(mode);
    },
    async start() {
      if (!this.isEnabled()) {
        return;
      }

      try {
        const result = await refreshRates();
        logger?.info?.({ result }, 'fx provider refreshed rates');
      } catch (error) {
        logger?.warn?.({ error, providerMode: mode }, 'fx provider refresh failed, continuing with stored rates');
      }

      if (refreshIntervalMs > 0) {
        refreshTimer = setInterval(() => {
          refreshRates()
            .then((result) => {
              logger?.info?.({ result }, 'fx provider refreshed rates');
            })
            .catch((error) => {
              logger?.warn?.({ error, providerMode: mode }, 'scheduled fx provider refresh failed');
            });
        }, refreshIntervalMs);
      }
    },
    async refreshRates() {
      return refreshRates();
    },
    stop() {
      if (refreshTimer) {
        clearInterval(refreshTimer);
      }
    },
  };
}
