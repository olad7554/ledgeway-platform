import { randomUUID } from 'node:crypto';

function toTwoDp(amount) {
  return Number(Number(amount || 0).toFixed(2));
}

function toNumber(value) {
  return toTwoDp(Number(value || 0));
}

function startOfDayKey() {
  return new Date().toISOString().slice(0, 10);
}

function cardPanLast4() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

function createStoreError(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function buildWalletRecord(row) {
  if (!row) return null;
  return {
    walletId: row.wallet_id ?? row.walletId,
    userId: row.user_id ?? row.userId,
    walletName: row.wallet_name ?? row.walletName,
    currency: row.currency,
    availableBalance: toNumber(row.available_balance ?? row.availableBalance),
    reservedBalance: toNumber(row.reserved_balance ?? row.reservedBalance),
    createdAt: row.created_at ?? row.createdAt,
    updatedAt: row.updated_at ?? row.updatedAt,
  };
}

function buildPotRecord(row) {
  if (!row) return null;
  return {
    potId: row.pot_id ?? row.potId,
    walletId: row.wallet_id ?? row.walletId,
    name: row.name,
    targetAmount: row.target_amount == null && row.targetAmount == null
      ? null
      : toNumber(row.target_amount ?? row.targetAmount),
    savedAmount: toNumber(row.saved_amount ?? row.savedAmount),
    createdAt: row.created_at ?? row.createdAt,
    updatedAt: row.updated_at ?? row.updatedAt,
  };
}

function buildCardRecord(row) {
  if (!row) return null;
  return {
    cardId: row.card_id ?? row.cardId,
    walletId: row.wallet_id ?? row.walletId,
    label: row.label,
    network: row.network,
    maskedPan: row.masked_pan ?? row.maskedPan,
    last4: row.last4,
    status: row.status,
    dailyLimit: toNumber(row.daily_limit ?? row.dailyLimit),
    spentToday: toNumber(row.spent_today ?? row.spentToday),
    spendDate: row.spend_date ?? row.spendDate,
    createdAt: row.created_at ?? row.createdAt,
    updatedAt: row.updated_at ?? row.updatedAt,
  };
}

function buildInternalPaymentRecord(row) {
  if (!row) return null;
  return {
    paymentId: row.payment_id ?? row.paymentId,
    fromWalletId: row.from_wallet_id ?? row.fromWalletId,
    toWalletId: row.to_wallet_id ?? row.toWalletId,
    amount: toNumber(row.amount),
    currency: row.currency,
    narration: row.narration,
    status: row.status,
    createdAt: row.created_at ?? row.createdAt,
  };
}

function buildLedgerEntryRecord(row) {
  if (!row) return null;
  const metadata = row.metadata || {};
  const entry = {
    id: row.id,
    walletId: row.wallet_id ?? row.walletId,
    type: row.type,
    amount: toNumber(row.amount),
    createdAt: row.created_at ?? row.createdAt,
  };

  if (row.reference != null) entry.reference = row.reference;
  if (row.merchant != null) entry.merchant = row.merchant;

  return { ...metadata, ...entry };
}

function appendMemoryEntry(entries, entry) {
  const record = buildLedgerEntryRecord({
    id: `led_${randomUUID()}`,
    createdAt: new Date().toISOString(),
    metadata: entry.metadata || {},
    ...entry,
  });
  entries.push(record);
  return record;
}

function createInMemoryWalletStore() {
  const wallets = new Map();
  const pots = new Map();
  const cards = new Map();
  const internalPayments = [];
  const ledgerEntries = [];

  return {
    kind: 'memory',
    async createWallet({ walletId, userId, walletName, currency, startingBalance }) {
      const id = walletId || `wal_${randomUUID()}`;
      if (wallets.has(id)) {
        throw createStoreError('wallet_exists');
      }

      const wallet = {
        walletId: id,
        userId,
        walletName,
        currency,
        availableBalance: toTwoDp(startingBalance),
        reservedBalance: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      wallets.set(id, wallet);
      appendMemoryEntry(ledgerEntries, {
        walletId: id,
        type: 'wallet_created',
        amount: startingBalance,
        reference: 'wallet_init',
      });

      return buildWalletRecord(wallet);
    },
    async listWallets({ userId } = {}) {
      return Array.from(wallets.values())
        .filter((wallet) => !userId || wallet.userId === userId)
        .map((wallet) => buildWalletRecord(wallet));
    },
    async getWallet(walletId) {
      return buildWalletRecord(wallets.get(walletId));
    },
    async topupWallet({ walletId, amount, reference }) {
      const wallet = wallets.get(walletId);
      if (!wallet) throw createStoreError('wallet_not_found');

      wallet.availableBalance = toTwoDp(wallet.availableBalance + amount);
      wallet.updatedAt = new Date().toISOString();
      appendMemoryEntry(ledgerEntries, {
        walletId,
        type: 'wallet_topup',
        amount,
        reference,
      });

      return buildWalletRecord(wallet);
    },
    async createPot({ walletId, name, targetAmount, initialDeposit }) {
      const wallet = wallets.get(walletId);
      if (!wallet) throw createStoreError('wallet_not_found');
      if (wallet.availableBalance < initialDeposit) throw createStoreError('insufficient_balance');

      const pot = {
        potId: `pot_${randomUUID()}`,
        walletId,
        name,
        targetAmount: typeof targetAmount === 'number' ? toTwoDp(targetAmount) : null,
        savedAmount: toTwoDp(initialDeposit),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      if (initialDeposit > 0) {
        wallet.availableBalance = toTwoDp(wallet.availableBalance - initialDeposit);
        wallet.updatedAt = new Date().toISOString();
        appendMemoryEntry(ledgerEntries, {
          walletId,
          type: 'pot_initial_deposit',
          amount: initialDeposit,
          reference: pot.potId,
        });
      }

      pots.set(pot.potId, pot);
      return { pot: buildPotRecord(pot), wallet: buildWalletRecord(wallet) };
    },
    async listPots({ walletId, walletIds } = {}) {
      return Array.from(pots.values())
        .filter((pot) => {
          if (walletId) return pot.walletId === walletId;
          if (walletIds) return walletIds.includes(pot.walletId);
          return true;
        })
        .map((pot) => buildPotRecord(pot));
    },
    async getPot(potId) {
      return buildPotRecord(pots.get(potId));
    },
    async depositToPot({ potId, amount, reference }) {
      const pot = pots.get(potId);
      if (!pot) throw createStoreError('pot_not_found');

      const wallet = wallets.get(pot.walletId);
      if (!wallet) throw createStoreError('wallet_not_found');
      if (wallet.availableBalance < amount) throw createStoreError('insufficient_balance');

      wallet.availableBalance = toTwoDp(wallet.availableBalance - amount);
      wallet.updatedAt = new Date().toISOString();
      pot.savedAmount = toTwoDp(pot.savedAmount + amount);
      pot.updatedAt = new Date().toISOString();

      appendMemoryEntry(ledgerEntries, {
        walletId: wallet.walletId,
        type: 'pot_deposit',
        amount,
        reference,
      });

      return { pot: buildPotRecord(pot), wallet: buildWalletRecord(wallet) };
    },
    async withdrawFromPot({ potId, amount, reference }) {
      const pot = pots.get(potId);
      if (!pot) throw createStoreError('pot_not_found');

      const wallet = wallets.get(pot.walletId);
      if (!wallet) throw createStoreError('wallet_not_found');
      if (pot.savedAmount < amount) throw createStoreError('insufficient_pot_balance');

      pot.savedAmount = toTwoDp(pot.savedAmount - amount);
      pot.updatedAt = new Date().toISOString();
      wallet.availableBalance = toTwoDp(wallet.availableBalance + amount);
      wallet.updatedAt = new Date().toISOString();

      appendMemoryEntry(ledgerEntries, {
        walletId: wallet.walletId,
        type: 'pot_withdraw',
        amount,
        reference,
      });

      return { pot: buildPotRecord(pot), wallet: buildWalletRecord(wallet) };
    },
    async transferBetweenPots({ fromPotId, toPotId, amount, reference }) {
      const fromPot = pots.get(fromPotId);
      const toPot = pots.get(toPotId);
      if (!fromPot || !toPot) throw createStoreError('pot_not_found');
      if (fromPot.walletId !== toPot.walletId) throw createStoreError('cross_wallet_pot_transfer_not_allowed');
      if (fromPot.savedAmount < amount) throw createStoreError('insufficient_pot_balance');

      fromPot.savedAmount = toTwoDp(fromPot.savedAmount - amount);
      fromPot.updatedAt = new Date().toISOString();
      toPot.savedAmount = toTwoDp(toPot.savedAmount + amount);
      toPot.updatedAt = new Date().toISOString();

      appendMemoryEntry(ledgerEntries, {
        walletId: fromPot.walletId,
        type: 'pot_transfer',
        amount,
        reference,
      });

      return { fromPot: buildPotRecord(fromPot), toPot: buildPotRecord(toPot) };
    },
    async createCard({ walletId, label, dailyLimit }) {
      const wallet = wallets.get(walletId);
      if (!wallet) throw createStoreError('wallet_not_found');

      const last4 = cardPanLast4();
      const card = {
        cardId: `crd_${randomUUID()}`,
        walletId,
        label,
        network: 'VISA',
        maskedPan: `4539 **** **** ${last4}`,
        last4,
        status: 'active',
        dailyLimit: toTwoDp(dailyLimit),
        spentToday: 0,
        spendDate: startOfDayKey(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      cards.set(card.cardId, card);
      appendMemoryEntry(ledgerEntries, {
        walletId,
        type: 'virtual_card_created',
        amount: 0,
        reference: card.cardId,
      });

      return buildCardRecord(card);
    },
    async listCards({ walletId, walletIds } = {}) {
      return Array.from(cards.values())
        .filter((card) => {
          if (walletId) return card.walletId === walletId;
          if (walletIds) return walletIds.includes(card.walletId);
          return true;
        })
        .map((card) => buildCardRecord(card));
    },
    async getCard(cardId) {
      return buildCardRecord(cards.get(cardId));
    },
    async updateCardStatus({ cardId, status, entryType }) {
      const card = cards.get(cardId);
      if (!card) throw createStoreError('card_not_found');

      card.status = status;
      card.updatedAt = new Date().toISOString();
      appendMemoryEntry(ledgerEntries, {
        walletId: card.walletId,
        type: entryType,
        amount: 0,
        reference: card.cardId,
      });

      return buildCardRecord(card);
    },
    async chargeCard({ cardId, amount, merchant, reference }) {
      const card = cards.get(cardId);
      if (!card) throw createStoreError('card_not_found');

      const wallet = wallets.get(card.walletId);
      if (!wallet) throw createStoreError('wallet_not_found');
      if (card.status !== 'active') throw createStoreError('card_not_active');

      if (card.spendDate !== startOfDayKey()) {
        card.spentToday = 0;
        card.spendDate = startOfDayKey();
      }

      if (wallet.availableBalance < amount) throw createStoreError('insufficient_balance');
      if (card.spentToday + amount > card.dailyLimit) throw createStoreError('daily_limit_exceeded');

      wallet.availableBalance = toTwoDp(wallet.availableBalance - amount);
      wallet.updatedAt = new Date().toISOString();
      card.spentToday = toTwoDp(card.spentToday + amount);
      card.updatedAt = new Date().toISOString();

      const charge = {
        chargeId: `chg_${randomUUID()}`,
        cardId: card.cardId,
        walletId: card.walletId,
        amount: toTwoDp(amount),
        merchant,
        createdAt: new Date().toISOString(),
        reference,
      };

      appendMemoryEntry(ledgerEntries, {
        walletId: wallet.walletId,
        type: 'card_charge',
        amount,
        reference,
        merchant,
      });

      return { charge, card: buildCardRecord(card), wallet: buildWalletRecord(wallet) };
    },
    async createInternalPayment({ fromWalletId, toWalletId, amount, narration }) {
      const fromWallet = wallets.get(fromWalletId);
      const toWallet = wallets.get(toWalletId);
      if (!fromWallet || !toWallet) throw createStoreError('wallet_not_found');
      if (fromWallet.currency !== toWallet.currency) throw createStoreError('currency_mismatch');
      if (fromWallet.availableBalance < amount) throw createStoreError('insufficient_balance');

      fromWallet.availableBalance = toTwoDp(fromWallet.availableBalance - amount);
      fromWallet.updatedAt = new Date().toISOString();
      toWallet.availableBalance = toTwoDp(toWallet.availableBalance + amount);
      toWallet.updatedAt = new Date().toISOString();

      const payment = {
        paymentId: `pay_${randomUUID()}`,
        fromWalletId,
        toWalletId,
        amount: toTwoDp(amount),
        currency: fromWallet.currency,
        narration,
        status: 'completed',
        createdAt: new Date().toISOString(),
      };

      internalPayments.push(payment);
      appendMemoryEntry(ledgerEntries, {
        walletId: fromWalletId,
        type: 'internal_transfer_out',
        amount,
        reference: payment.paymentId,
      });
      appendMemoryEntry(ledgerEntries, {
        walletId: toWalletId,
        type: 'internal_transfer_in',
        amount,
        reference: payment.paymentId,
      });

      return {
        payment: buildInternalPaymentRecord(payment),
        fromWallet: buildWalletRecord(fromWallet),
        toWallet: buildWalletRecord(toWallet),
      };
    },
    async listInternalPayments({ walletId, walletIds } = {}) {
      return internalPayments
        .filter((payment) => {
          if (walletId) {
            return payment.fromWalletId === walletId || payment.toWalletId === walletId;
          }
          if (walletIds) {
            return walletIds.includes(payment.fromWalletId) || walletIds.includes(payment.toWalletId);
          }
          return true;
        })
        .map((payment) => buildInternalPaymentRecord(payment));
    },
    async reserveFunds({ walletId, amount, reference }) {
      const wallet = wallets.get(walletId);
      if (!wallet) throw createStoreError('wallet_not_found');
      if (wallet.availableBalance < amount) throw createStoreError('insufficient_balance');

      wallet.availableBalance = toTwoDp(wallet.availableBalance - amount);
      wallet.reservedBalance = toTwoDp(wallet.reservedBalance + amount);
      wallet.updatedAt = new Date().toISOString();
      appendMemoryEntry(ledgerEntries, { walletId, type: 'reserve', amount, reference });

      return buildWalletRecord(wallet);
    },
    async releaseFunds({ walletId, amount, reference }) {
      const wallet = wallets.get(walletId);
      if (!wallet) throw createStoreError('wallet_not_found');
      if (wallet.reservedBalance < amount) throw createStoreError('insufficient_reserved_balance');

      wallet.reservedBalance = toTwoDp(wallet.reservedBalance - amount);
      wallet.availableBalance = toTwoDp(wallet.availableBalance + amount);
      wallet.updatedAt = new Date().toISOString();
      appendMemoryEntry(ledgerEntries, { walletId, type: 'release', amount, reference });

      return buildWalletRecord(wallet);
    },
    async settleFunds({ walletId, amount, reference }) {
      const wallet = wallets.get(walletId);
      if (!wallet) throw createStoreError('wallet_not_found');
      if (wallet.reservedBalance < amount) throw createStoreError('insufficient_reserved_balance');

      wallet.reservedBalance = toTwoDp(wallet.reservedBalance - amount);
      wallet.updatedAt = new Date().toISOString();
      appendMemoryEntry(ledgerEntries, { walletId, type: 'settle', amount, reference });

      return buildWalletRecord(wallet);
    },
    async listLedgerEntries({ walletId, walletIds } = {}) {
      return ledgerEntries
        .filter((entry) => {
          if (walletId) return entry.walletId === walletId;
          if (walletIds) return walletIds.includes(entry.walletId);
          return true;
        })
        .map((entry) => buildLedgerEntryRecord(entry));
    },
  };
}

async function createPostgresWalletStore(connectionString) {
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString });

  let initialized = false;
  let lastError;
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS ledger_wallets (
          wallet_id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          wallet_name TEXT NOT NULL,
          currency TEXT NOT NULL,
          available_balance NUMERIC(18, 2) NOT NULL,
          reserved_balance NUMERIC(18, 2) NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_ledger_wallets_user_id
        ON ledger_wallets(user_id)
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS ledger_pots (
          pot_id TEXT PRIMARY KEY,
          wallet_id TEXT NOT NULL REFERENCES ledger_wallets(wallet_id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          target_amount NUMERIC(18, 2),
          saved_amount NUMERIC(18, 2) NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_ledger_pots_wallet_id
        ON ledger_pots(wallet_id)
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS ledger_cards (
          card_id TEXT PRIMARY KEY,
          wallet_id TEXT NOT NULL REFERENCES ledger_wallets(wallet_id) ON DELETE CASCADE,
          label TEXT NOT NULL,
          network TEXT NOT NULL,
          masked_pan TEXT NOT NULL,
          last4 TEXT NOT NULL,
          status TEXT NOT NULL,
          daily_limit NUMERIC(18, 2) NOT NULL,
          spent_today NUMERIC(18, 2) NOT NULL DEFAULT 0,
          spend_date TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_ledger_cards_wallet_id
        ON ledger_cards(wallet_id)
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS ledger_internal_payments (
          payment_id TEXT PRIMARY KEY,
          from_wallet_id TEXT NOT NULL REFERENCES ledger_wallets(wallet_id) ON DELETE CASCADE,
          to_wallet_id TEXT NOT NULL REFERENCES ledger_wallets(wallet_id) ON DELETE CASCADE,
          amount NUMERIC(18, 2) NOT NULL,
          currency TEXT NOT NULL,
          narration TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_ledger_internal_payments_from_wallet_id
        ON ledger_internal_payments(from_wallet_id)
      `);

      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_ledger_internal_payments_to_wallet_id
        ON ledger_internal_payments(to_wallet_id)
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS ledger_entries (
          id TEXT PRIMARY KEY,
          wallet_id TEXT NOT NULL REFERENCES ledger_wallets(wallet_id) ON DELETE CASCADE,
          type TEXT NOT NULL,
          amount NUMERIC(18, 2) NOT NULL,
          reference TEXT,
          merchant TEXT,
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_ledger_entries_wallet_id
        ON ledger_entries(wallet_id)
      `);

      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_ledger_entries_reference
        ON ledger_entries(reference)
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

  async function queryWallet(client, walletId, { forUpdate = false } = {}) {
    const result = await client.query(
      `SELECT wallet_id, user_id, wallet_name, currency, available_balance, reserved_balance, created_at, updated_at
       FROM ledger_wallets
       WHERE wallet_id = $1
       ${forUpdate ? 'FOR UPDATE' : ''}`,
      [walletId]
    );

    return buildWalletRecord(result.rows[0]);
  }

  async function queryPot(client, potId, { forUpdate = false } = {}) {
    const result = await client.query(
      `SELECT pot_id, wallet_id, name, target_amount, saved_amount, created_at, updated_at
       FROM ledger_pots
       WHERE pot_id = $1
       ${forUpdate ? 'FOR UPDATE' : ''}`,
      [potId]
    );

    return buildPotRecord(result.rows[0]);
  }

  async function queryCard(client, cardId, { forUpdate = false } = {}) {
    const result = await client.query(
      `SELECT card_id, wallet_id, label, network, masked_pan, last4, status, daily_limit, spent_today, spend_date, created_at, updated_at
       FROM ledger_cards
       WHERE card_id = $1
       ${forUpdate ? 'FOR UPDATE' : ''}`,
      [cardId]
    );

    return buildCardRecord(result.rows[0]);
  }

  async function appendEntryTx(client, entry) {
    const id = entry.id || `led_${randomUUID()}`;
    const createdAt = entry.createdAt || new Date().toISOString();
    const metadata = entry.metadata || {};

    await client.query(
      `INSERT INTO ledger_entries (id, wallet_id, type, amount, reference, merchant, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
      [
        id,
        entry.walletId,
        entry.type,
        toTwoDp(entry.amount),
        entry.reference || null,
        entry.merchant || null,
        JSON.stringify(metadata),
        createdAt,
      ]
    );

    return buildLedgerEntryRecord({
      id,
      walletId: entry.walletId,
      type: entry.type,
      amount: toTwoDp(entry.amount),
      reference: entry.reference || null,
      merchant: entry.merchant || null,
      metadata,
      createdAt,
    });
  }

  async function queryMultipleWalletsForUpdate(client, walletIds) {
    const sorted = [...new Set(walletIds)].sort();
    const result = await client.query(
      `SELECT wallet_id, user_id, wallet_name, currency, available_balance, reserved_balance, created_at, updated_at
       FROM ledger_wallets
       WHERE wallet_id = ANY($1::text[])
       ORDER BY wallet_id
       FOR UPDATE`,
      [sorted]
    );

    return new Map(result.rows.map((row) => {
      const wallet = buildWalletRecord(row);
      return [wallet.walletId, wallet];
    }));
  }

  async function queryMultiplePotsForUpdate(client, potIds) {
    const sorted = [...new Set(potIds)].sort();
    const result = await client.query(
      `SELECT pot_id, wallet_id, name, target_amount, saved_amount, created_at, updated_at
       FROM ledger_pots
       WHERE pot_id = ANY($1::text[])
       ORDER BY pot_id
       FOR UPDATE`,
      [sorted]
    );

    return new Map(result.rows.map((row) => {
      const pot = buildPotRecord(row);
      return [pot.potId, pot];
    }));
  }

  return {
    kind: 'postgres',
    async createWallet({ walletId, userId, walletName, currency, startingBalance }) {
      return withTransaction(async (client) => {
        const id = walletId || `wal_${randomUUID()}`;
        try {
          await client.query(
            `INSERT INTO ledger_wallets (wallet_id, user_id, wallet_name, currency, available_balance, reserved_balance, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, 0, NOW(), NOW())`,
            [id, userId, walletName, currency, toTwoDp(startingBalance)]
          );
        } catch (error) {
          if (error?.code === '23505') {
            throw createStoreError('wallet_exists');
          }
          throw error;
        }

        await appendEntryTx(client, {
          walletId: id,
          type: 'wallet_created',
          amount: startingBalance,
          reference: 'wallet_init',
        });

        const wallet = await queryWallet(client, id);
        return wallet;
      });
    },
    async listWallets({ userId } = {}) {
      const result = userId
        ? await pool.query(
          `SELECT wallet_id, user_id, wallet_name, currency, available_balance, reserved_balance, created_at, updated_at
           FROM ledger_wallets
           WHERE user_id = $1
           ORDER BY created_at ASC`,
          [userId]
        )
        : await pool.query(
          `SELECT wallet_id, user_id, wallet_name, currency, available_balance, reserved_balance, created_at, updated_at
           FROM ledger_wallets
           ORDER BY created_at ASC`
        );

      return result.rows.map((row) => buildWalletRecord(row));
    },
    async getWallet(walletId) {
      const result = await pool.query(
        `SELECT wallet_id, user_id, wallet_name, currency, available_balance, reserved_balance, created_at, updated_at
         FROM ledger_wallets
         WHERE wallet_id = $1
         LIMIT 1`,
        [walletId]
      );

      return buildWalletRecord(result.rows[0]);
    },
    async topupWallet({ walletId, amount, reference }) {
      return withTransaction(async (client) => {
        const wallet = await queryWallet(client, walletId, { forUpdate: true });
        if (!wallet) throw createStoreError('wallet_not_found');

        await client.query(
          `UPDATE ledger_wallets
           SET available_balance = $2, updated_at = NOW()
           WHERE wallet_id = $1`,
          [walletId, toTwoDp(wallet.availableBalance + amount)]
        );

        await appendEntryTx(client, {
          walletId,
          type: 'wallet_topup',
          amount,
          reference,
        });

        return queryWallet(client, walletId);
      });
    },
    async createPot({ walletId, name, targetAmount, initialDeposit }) {
      return withTransaction(async (client) => {
        const wallet = await queryWallet(client, walletId, { forUpdate: true });
        if (!wallet) throw createStoreError('wallet_not_found');
        if (wallet.availableBalance < initialDeposit) throw createStoreError('insufficient_balance');

        const potId = `pot_${randomUUID()}`;
        await client.query(
          `INSERT INTO ledger_pots (pot_id, wallet_id, name, target_amount, saved_amount, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, NOW(), NOW())`,
          [
            potId,
            walletId,
            name,
            typeof targetAmount === 'number' ? toTwoDp(targetAmount) : null,
            toTwoDp(initialDeposit),
          ]
        );

        if (initialDeposit > 0) {
          await client.query(
            `UPDATE ledger_wallets
             SET available_balance = $2, updated_at = NOW()
             WHERE wallet_id = $1`,
            [walletId, toTwoDp(wallet.availableBalance - initialDeposit)]
          );

          await appendEntryTx(client, {
            walletId,
            type: 'pot_initial_deposit',
            amount: initialDeposit,
            reference: potId,
          });
        }

        return {
          pot: await queryPot(client, potId),
          wallet: await queryWallet(client, walletId),
        };
      });
    },
    async listPots({ walletId, walletIds } = {}) {
      if (walletId) {
        const result = await pool.query(
          `SELECT pot_id, wallet_id, name, target_amount, saved_amount, created_at, updated_at
           FROM ledger_pots
           WHERE wallet_id = $1
           ORDER BY created_at ASC`,
          [walletId]
        );
        return result.rows.map((row) => buildPotRecord(row));
      }

      if (walletIds) {
        if (walletIds.length === 0) return [];
        const result = await pool.query(
          `SELECT pot_id, wallet_id, name, target_amount, saved_amount, created_at, updated_at
           FROM ledger_pots
           WHERE wallet_id = ANY($1::text[])
           ORDER BY created_at ASC`,
          [walletIds]
        );
        return result.rows.map((row) => buildPotRecord(row));
      }

      const result = await pool.query(
        `SELECT pot_id, wallet_id, name, target_amount, saved_amount, created_at, updated_at
         FROM ledger_pots
         ORDER BY created_at ASC`
      );

      return result.rows.map((row) => buildPotRecord(row));
    },
    async getPot(potId) {
      const result = await pool.query(
        `SELECT pot_id, wallet_id, name, target_amount, saved_amount, created_at, updated_at
         FROM ledger_pots
         WHERE pot_id = $1
         LIMIT 1`,
        [potId]
      );

      return buildPotRecord(result.rows[0]);
    },
    async depositToPot({ potId, amount, reference }) {
      return withTransaction(async (client) => {
        const pot = await queryPot(client, potId, { forUpdate: true });
        if (!pot) throw createStoreError('pot_not_found');

        const wallet = await queryWallet(client, pot.walletId, { forUpdate: true });
        if (!wallet) throw createStoreError('wallet_not_found');
        if (wallet.availableBalance < amount) throw createStoreError('insufficient_balance');

        await client.query(
          `UPDATE ledger_wallets
           SET available_balance = $2, updated_at = NOW()
           WHERE wallet_id = $1`,
          [wallet.walletId, toTwoDp(wallet.availableBalance - amount)]
        );

        await client.query(
          `UPDATE ledger_pots
           SET saved_amount = $2, updated_at = NOW()
           WHERE pot_id = $1`,
          [potId, toTwoDp(pot.savedAmount + amount)]
        );

        await appendEntryTx(client, {
          walletId: wallet.walletId,
          type: 'pot_deposit',
          amount,
          reference,
        });

        return {
          pot: await queryPot(client, potId),
          wallet: await queryWallet(client, wallet.walletId),
        };
      });
    },
    async withdrawFromPot({ potId, amount, reference }) {
      return withTransaction(async (client) => {
        const pot = await queryPot(client, potId, { forUpdate: true });
        if (!pot) throw createStoreError('pot_not_found');
        if (pot.savedAmount < amount) throw createStoreError('insufficient_pot_balance');

        const wallet = await queryWallet(client, pot.walletId, { forUpdate: true });
        if (!wallet) throw createStoreError('wallet_not_found');

        await client.query(
          `UPDATE ledger_pots
           SET saved_amount = $2, updated_at = NOW()
           WHERE pot_id = $1`,
          [potId, toTwoDp(pot.savedAmount - amount)]
        );

        await client.query(
          `UPDATE ledger_wallets
           SET available_balance = $2, updated_at = NOW()
           WHERE wallet_id = $1`,
          [wallet.walletId, toTwoDp(wallet.availableBalance + amount)]
        );

        await appendEntryTx(client, {
          walletId: wallet.walletId,
          type: 'pot_withdraw',
          amount,
          reference,
        });

        return {
          pot: await queryPot(client, potId),
          wallet: await queryWallet(client, wallet.walletId),
        };
      });
    },
    async transferBetweenPots({ fromPotId, toPotId, amount, reference }) {
      return withTransaction(async (client) => {
        const potsById = await queryMultiplePotsForUpdate(client, [fromPotId, toPotId]);
        const fromPot = potsById.get(fromPotId);
        const toPot = potsById.get(toPotId);
        if (!fromPot || !toPot) throw createStoreError('pot_not_found');
        if (fromPot.walletId !== toPot.walletId) throw createStoreError('cross_wallet_pot_transfer_not_allowed');
        if (fromPot.savedAmount < amount) throw createStoreError('insufficient_pot_balance');

        await client.query(
          `UPDATE ledger_pots
           SET saved_amount = CASE
             WHEN pot_id = $1 THEN $3
             WHEN pot_id = $2 THEN $4
             ELSE saved_amount
           END,
           updated_at = NOW()
           WHERE pot_id IN ($1, $2)`,
          [
            fromPotId,
            toPotId,
            toTwoDp(fromPot.savedAmount - amount),
            toTwoDp(toPot.savedAmount + amount),
          ]
        );

        await appendEntryTx(client, {
          walletId: fromPot.walletId,
          type: 'pot_transfer',
          amount,
          reference,
        });

        return {
          fromPot: await queryPot(client, fromPotId),
          toPot: await queryPot(client, toPotId),
        };
      });
    },
    async createCard({ walletId, label, dailyLimit }) {
      return withTransaction(async (client) => {
        const wallet = await queryWallet(client, walletId, { forUpdate: true });
        if (!wallet) throw createStoreError('wallet_not_found');

        const last4 = cardPanLast4();
        const cardId = `crd_${randomUUID()}`;
        await client.query(
          `INSERT INTO ledger_cards (card_id, wallet_id, label, network, masked_pan, last4, status, daily_limit, spent_today, spend_date, created_at, updated_at)
           VALUES ($1, $2, $3, 'VISA', $4, $5, 'active', $6, 0, $7, NOW(), NOW())`,
          [cardId, walletId, label, `4539 **** **** ${last4}`, last4, toTwoDp(dailyLimit), startOfDayKey()]
        );

        await appendEntryTx(client, {
          walletId,
          type: 'virtual_card_created',
          amount: 0,
          reference: cardId,
        });

        return queryCard(client, cardId);
      });
    },
    async listCards({ walletId, walletIds } = {}) {
      if (walletId) {
        const result = await pool.query(
          `SELECT card_id, wallet_id, label, network, masked_pan, last4, status, daily_limit, spent_today, spend_date, created_at, updated_at
           FROM ledger_cards
           WHERE wallet_id = $1
           ORDER BY created_at ASC`,
          [walletId]
        );
        return result.rows.map((row) => buildCardRecord(row));
      }

      if (walletIds) {
        if (walletIds.length === 0) return [];
        const result = await pool.query(
          `SELECT card_id, wallet_id, label, network, masked_pan, last4, status, daily_limit, spent_today, spend_date, created_at, updated_at
           FROM ledger_cards
           WHERE wallet_id = ANY($1::text[])
           ORDER BY created_at ASC`,
          [walletIds]
        );
        return result.rows.map((row) => buildCardRecord(row));
      }

      const result = await pool.query(
        `SELECT card_id, wallet_id, label, network, masked_pan, last4, status, daily_limit, spent_today, spend_date, created_at, updated_at
         FROM ledger_cards
         ORDER BY created_at ASC`
      );

      return result.rows.map((row) => buildCardRecord(row));
    },
    async getCard(cardId) {
      const result = await pool.query(
        `SELECT card_id, wallet_id, label, network, masked_pan, last4, status, daily_limit, spent_today, spend_date, created_at, updated_at
         FROM ledger_cards
         WHERE card_id = $1
         LIMIT 1`,
        [cardId]
      );

      return buildCardRecord(result.rows[0]);
    },
    async updateCardStatus({ cardId, status, entryType }) {
      return withTransaction(async (client) => {
        const card = await queryCard(client, cardId, { forUpdate: true });
        if (!card) throw createStoreError('card_not_found');

        await client.query(
          `UPDATE ledger_cards
           SET status = $2, updated_at = NOW()
           WHERE card_id = $1`,
          [cardId, status]
        );

        await appendEntryTx(client, {
          walletId: card.walletId,
          type: entryType,
          amount: 0,
          reference: card.cardId,
        });

        return queryCard(client, cardId);
      });
    },
    async chargeCard({ cardId, amount, merchant, reference }) {
      return withTransaction(async (client) => {
        const card = await queryCard(client, cardId, { forUpdate: true });
        if (!card) throw createStoreError('card_not_found');
        if (card.status !== 'active') throw createStoreError('card_not_active');

        const wallet = await queryWallet(client, card.walletId, { forUpdate: true });
        if (!wallet) throw createStoreError('wallet_not_found');

        const spendDate = card.spendDate === startOfDayKey() ? card.spendDate : startOfDayKey();
        const spentToday = card.spendDate === startOfDayKey() ? card.spentToday : 0;
        if (wallet.availableBalance < amount) throw createStoreError('insufficient_balance');
        if (spentToday + amount > card.dailyLimit) throw createStoreError('daily_limit_exceeded');

        await client.query(
          `UPDATE ledger_wallets
           SET available_balance = $2, updated_at = NOW()
           WHERE wallet_id = $1`,
          [wallet.walletId, toTwoDp(wallet.availableBalance - amount)]
        );

        await client.query(
          `UPDATE ledger_cards
           SET spent_today = $2, spend_date = $3, updated_at = NOW()
           WHERE card_id = $1`,
          [cardId, toTwoDp(spentToday + amount), spendDate]
        );

        const charge = {
          chargeId: `chg_${randomUUID()}`,
          cardId: card.cardId,
          walletId: wallet.walletId,
          amount: toTwoDp(amount),
          merchant,
          createdAt: new Date().toISOString(),
          reference,
        };

        await appendEntryTx(client, {
          walletId: wallet.walletId,
          type: 'card_charge',
          amount,
          reference,
          merchant,
        });

        return {
          charge,
          card: await queryCard(client, cardId),
          wallet: await queryWallet(client, wallet.walletId),
        };
      });
    },
    async createInternalPayment({ fromWalletId, toWalletId, amount, narration }) {
      return withTransaction(async (client) => {
        const walletsById = await queryMultipleWalletsForUpdate(client, [fromWalletId, toWalletId]);
        const fromWallet = walletsById.get(fromWalletId);
        const toWallet = walletsById.get(toWalletId);
        if (!fromWallet || !toWallet) throw createStoreError('wallet_not_found');
        if (fromWallet.currency !== toWallet.currency) throw createStoreError('currency_mismatch');
        if (fromWallet.availableBalance < amount) throw createStoreError('insufficient_balance');

        await client.query(
          `UPDATE ledger_wallets
           SET available_balance = CASE
             WHEN wallet_id = $1 THEN $3
             WHEN wallet_id = $2 THEN $4
             ELSE available_balance
           END,
           updated_at = NOW()
           WHERE wallet_id IN ($1, $2)`,
          [
            fromWalletId,
            toWalletId,
            toTwoDp(fromWallet.availableBalance - amount),
            toTwoDp(toWallet.availableBalance + amount),
          ]
        );

        const paymentId = `pay_${randomUUID()}`;
        await client.query(
          `INSERT INTO ledger_internal_payments (payment_id, from_wallet_id, to_wallet_id, amount, currency, narration, status, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'completed', NOW())`,
          [paymentId, fromWalletId, toWalletId, toTwoDp(amount), fromWallet.currency, narration]
        );

        await appendEntryTx(client, {
          walletId: fromWalletId,
          type: 'internal_transfer_out',
          amount,
          reference: paymentId,
        });
        await appendEntryTx(client, {
          walletId: toWalletId,
          type: 'internal_transfer_in',
          amount,
          reference: paymentId,
        });

        const paymentResult = await client.query(
          `SELECT payment_id, from_wallet_id, to_wallet_id, amount, currency, narration, status, created_at
           FROM ledger_internal_payments
           WHERE payment_id = $1`,
          [paymentId]
        );

        return {
          payment: buildInternalPaymentRecord(paymentResult.rows[0]),
          fromWallet: await queryWallet(client, fromWalletId),
          toWallet: await queryWallet(client, toWalletId),
        };
      });
    },
    async listInternalPayments({ walletId, walletIds } = {}) {
      if (walletId) {
        const result = await pool.query(
          `SELECT payment_id, from_wallet_id, to_wallet_id, amount, currency, narration, status, created_at
           FROM ledger_internal_payments
           WHERE from_wallet_id = $1 OR to_wallet_id = $1
           ORDER BY created_at DESC`,
          [walletId]
        );
        return result.rows.map((row) => buildInternalPaymentRecord(row));
      }

      if (walletIds) {
        if (walletIds.length === 0) return [];
        const result = await pool.query(
          `SELECT payment_id, from_wallet_id, to_wallet_id, amount, currency, narration, status, created_at
           FROM ledger_internal_payments
           WHERE from_wallet_id = ANY($1::text[]) OR to_wallet_id = ANY($1::text[])
           ORDER BY created_at DESC`,
          [walletIds]
        );
        return result.rows.map((row) => buildInternalPaymentRecord(row));
      }

      const result = await pool.query(
        `SELECT payment_id, from_wallet_id, to_wallet_id, amount, currency, narration, status, created_at
         FROM ledger_internal_payments
         ORDER BY created_at DESC`
      );

      return result.rows.map((row) => buildInternalPaymentRecord(row));
    },
    async reserveFunds({ walletId, amount, reference }) {
      return withTransaction(async (client) => {
        const wallet = await queryWallet(client, walletId, { forUpdate: true });
        if (!wallet) throw createStoreError('wallet_not_found');
        if (wallet.availableBalance < amount) throw createStoreError('insufficient_balance');

        await client.query(
          `UPDATE ledger_wallets
           SET available_balance = $2, reserved_balance = $3, updated_at = NOW()
           WHERE wallet_id = $1`,
          [
            walletId,
            toTwoDp(wallet.availableBalance - amount),
            toTwoDp(wallet.reservedBalance + amount),
          ]
        );

        await appendEntryTx(client, { walletId, type: 'reserve', amount, reference });
        return queryWallet(client, walletId);
      });
    },
    async releaseFunds({ walletId, amount, reference }) {
      return withTransaction(async (client) => {
        const wallet = await queryWallet(client, walletId, { forUpdate: true });
        if (!wallet) throw createStoreError('wallet_not_found');
        if (wallet.reservedBalance < amount) throw createStoreError('insufficient_reserved_balance');

        await client.query(
          `UPDATE ledger_wallets
           SET reserved_balance = $2, available_balance = $3, updated_at = NOW()
           WHERE wallet_id = $1`,
          [
            walletId,
            toTwoDp(wallet.reservedBalance - amount),
            toTwoDp(wallet.availableBalance + amount),
          ]
        );

        await appendEntryTx(client, { walletId, type: 'release', amount, reference });
        return queryWallet(client, walletId);
      });
    },
    async settleFunds({ walletId, amount, reference }) {
      return withTransaction(async (client) => {
        const wallet = await queryWallet(client, walletId, { forUpdate: true });
        if (!wallet) throw createStoreError('wallet_not_found');
        if (wallet.reservedBalance < amount) throw createStoreError('insufficient_reserved_balance');

        await client.query(
          `UPDATE ledger_wallets
           SET reserved_balance = $2, updated_at = NOW()
           WHERE wallet_id = $1`,
          [walletId, toTwoDp(wallet.reservedBalance - amount)]
        );

        await appendEntryTx(client, { walletId, type: 'settle', amount, reference });
        return queryWallet(client, walletId);
      });
    },
    async listLedgerEntries({ walletId, walletIds } = {}) {
      if (walletId) {
        const result = await pool.query(
          `SELECT id, wallet_id, type, amount, reference, merchant, metadata, created_at
           FROM ledger_entries
           WHERE wallet_id = $1
           ORDER BY created_at DESC`,
          [walletId]
        );
        return result.rows.map((row) => buildLedgerEntryRecord(row));
      }

      if (walletIds) {
        if (walletIds.length === 0) return [];
        const result = await pool.query(
          `SELECT id, wallet_id, type, amount, reference, merchant, metadata, created_at
           FROM ledger_entries
           WHERE wallet_id = ANY($1::text[])
           ORDER BY created_at DESC`,
          [walletIds]
        );
        return result.rows.map((row) => buildLedgerEntryRecord(row));
      }

      const result = await pool.query(
        `SELECT id, wallet_id, type, amount, reference, merchant, metadata, created_at
         FROM ledger_entries
         ORDER BY created_at DESC`
      );

      return result.rows.map((row) => buildLedgerEntryRecord(row));
    },
  };
}

export async function createWalletStore() {
  const connectionString = process.env.WALLET_DATABASE_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    return createInMemoryWalletStore();
  }

  return createPostgresWalletStore(connectionString);
}
