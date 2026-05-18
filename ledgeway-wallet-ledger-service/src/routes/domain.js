import PDFDocument from 'pdfkit';
import { z } from 'zod';

const walletSchema = z.object({
  walletId: z.string().optional(),
  userId: z.string().min(3),
  walletName: z.string().min(2).max(60).optional(),
  currency: z.enum(['USD', 'EUR', 'GBP', 'CAD']),
  startingBalance: z.number().nonnegative().default(0),
});

const topupSchema = z.object({
  amount: z.number().positive(),
  reference: z.string().min(3).max(120).optional(),
});

const reserveSchema = z.object({
  walletId: z.string().min(3),
  amount: z.number().positive(),
  reference: z.string().min(3),
});

const releaseSchema = reserveSchema;
const settleSchema = reserveSchema;

const potCreateSchema = z.object({
  walletId: z.string().min(3),
  name: z.string().min(2).max(50),
  targetAmount: z.number().nonnegative().optional(),
  initialDeposit: z.number().nonnegative().default(0),
});

const potMoveSchema = z.object({
  amount: z.number().positive(),
  reference: z.string().min(3).max(120).optional(),
});

const potTransferSchema = z.object({
  fromPotId: z.string().min(3),
  toPotId: z.string().min(3),
  amount: z.number().positive(),
  reference: z.string().min(3).max(120).optional(),
});

const cardCreateSchema = z.object({
  walletId: z.string().min(3),
  label: z.string().min(2).max(60),
  dailyLimit: z.number().positive().max(100000).default(2500),
});

const cardChargeSchema = z.object({
  amount: z.number().positive(),
  merchant: z.string().min(2).max(80),
  reference: z.string().min(3).max(120).optional(),
});

const internalPaymentSchema = z.object({
  fromWalletId: z.string().min(3),
  toWalletId: z.string().min(3),
  amount: z.number().positive(),
  narration: z.string().min(2).max(120).optional(),
});

const statementFormatSchema = z.enum(['json', 'csv', 'pdf']);

function authContext(request) {
  return {
    userId: request.headers['x-auth-user-id'] ? String(request.headers['x-auth-user-id']) : '',
    role: String(request.headers['x-auth-user-role'] || '').toLowerCase(),
    internalService: request.headers['x-internal-service'] ? String(request.headers['x-internal-service']) : '',
  };
}

function isPrivileged(role) {
  return ['admin', 'ops'].includes(String(role || '').toLowerCase());
}

function allowInternalService(auth, serviceName) {
  return auth.internalService === serviceName;
}

function ensureAuthenticatedUser(reply, auth) {
  if (!auth.userId) {
    reply.code(401).send({ error: 'unauthorized' });
    return false;
  }
  return true;
}

function sendStoreError(reply, error) {
  switch (error?.code) {
    case 'wallet_not_found':
      return reply.code(404).send({ error: 'wallet_not_found' });
    case 'pot_not_found':
      return reply.code(404).send({ error: 'pot_not_found' });
    case 'card_not_found':
      return reply.code(404).send({ error: 'card_not_found' });
    case 'wallet_exists':
      return reply.code(409).send({ error: 'wallet_exists' });
    case 'insufficient_balance':
      return reply.code(409).send({ error: 'insufficient_balance' });
    case 'insufficient_pot_balance':
      return reply.code(409).send({ error: 'insufficient_pot_balance' });
    case 'insufficient_reserved_balance':
      return reply.code(409).send({ error: 'insufficient_reserved_balance' });
    case 'same_wallet_transfer_not_allowed':
      return reply.code(409).send({ error: 'same_wallet_transfer_not_allowed' });
    case 'same_pot_transfer_not_allowed':
      return reply.code(409).send({ error: 'same_pot_transfer_not_allowed' });
    case 'card_not_active':
      return reply.code(409).send({ error: 'card_not_active' });
    case 'daily_limit_exceeded':
      return reply.code(409).send({ error: 'daily_limit_exceeded' });
    case 'currency_mismatch':
      return reply.code(422).send({ error: 'currency_mismatch' });
    case 'cross_wallet_pot_transfer_not_allowed':
      return reply.code(422).send({ error: 'cross_wallet_pot_transfer_not_allowed' });
    default:
      throw error;
  }
}

function parseStatementDate(value, fallback, { endOfDay = false } = {}) {
  if (!value) return fallback;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    const normalized = endOfDay
      ? `${value}T23:59:59.999Z`
      : `${value}T00:00:00.000Z`;
    const parsedDate = new Date(normalized);
    return Number.isNaN(parsedDate.getTime()) ? null : parsedDate;
  }
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function statementDateWindow(query = {}) {
  const now = new Date();
  const defaultFrom = new Date(now.getTime() - (30 * 24 * 60 * 60 * 1000));
  const from = parseStatementDate(query.from, defaultFrom);
  const to = parseStatementDate(query.to, now, { endOfDay: true });

  if (!from || !to || from.getTime() > to.getTime()) {
    return null;
  }

  return { from, to };
}

function entrySignedAmount(entry) {
  const type = String(entry.type || '').toLowerCase();
  const amount = Number(entry.amount || 0);

  if (['wallet_created', 'wallet_topup', 'pot_withdraw', 'internal_transfer_in'].includes(type)) {
    return amount;
  }

  if (['card_charge', 'internal_transfer_out', 'settle'].includes(type)) {
    return -amount;
  }

  return 0;
}

function buildStatement(wallet, entries, from, to) {
  const normalizedEntries = [...entries]
    .filter((entry) => {
      const createdAt = new Date(entry.createdAt || 0).getTime();
      return !Number.isNaN(createdAt)
        && createdAt >= from.getTime()
        && createdAt <= to.getTime();
    })
    .sort((left, right) => new Date(right.createdAt || 0).getTime() - new Date(left.createdAt || 0).getTime());

  const totals = normalizedEntries.reduce((acc, entry) => {
    const signedAmount = entrySignedAmount(entry);
    if (signedAmount > 0) acc.moneyIn += signedAmount;
    if (signedAmount < 0) acc.moneyOut += Math.abs(signedAmount);
    if (entry.type === 'reserve') acc.reservedEvents += 1;
    if (entry.type === 'release') acc.releaseEvents += 1;
    return acc;
  }, {
    moneyIn: 0,
    moneyOut: 0,
    reservedEvents: 0,
    releaseEvents: 0,
  });

  return {
    wallet: {
      walletId: wallet.walletId,
      walletName: wallet.walletName,
      currency: wallet.currency,
      availableBalance: wallet.availableBalance,
      reservedBalance: wallet.reservedBalance,
    },
    period: {
      from: from.toISOString(),
      to: to.toISOString(),
    },
    summary: {
      transactionCount: normalizedEntries.length,
      moneyIn: Number(totals.moneyIn.toFixed(2)),
      moneyOut: Number(totals.moneyOut.toFixed(2)),
      reserveEvents: totals.reservedEvents,
      releaseEvents: totals.releaseEvents,
      closingAvailableBalance: wallet.availableBalance,
      closingReservedBalance: wallet.reservedBalance,
    },
    entries: normalizedEntries,
  };
}

function buildStatementCsv(statement) {
  const rows = [
    ['walletId', 'walletName', 'currency', 'createdAt', 'type', 'reference', 'merchant', 'amount'],
    ...statement.entries.map((entry) => ([
      statement.wallet.walletId,
      statement.wallet.walletName,
      statement.wallet.currency,
      entry.createdAt || '',
      entry.type || '',
      entry.reference || '',
      entry.merchant || '',
      Number(entry.amount || 0).toFixed(2),
    ])),
  ];

  return rows
    .map((row) => row
      .map((value) => `"${String(value ?? '').replaceAll('"', '""')}"`)
      .join(','))
    .join('\n');
}

function statementFilename(walletId, from, to, extension) {
  return `${walletId}-${from.toISOString().slice(0, 10)}-${to.toISOString().slice(0, 10)}.${extension}`;
}

function formatStatementAmount(amount, currency) {
  return `${currency} ${Number(amount || 0).toFixed(2)}`;
}

function fixedWidthCell(value, width, align = 'left') {
  const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();
  const clipped = normalized.length > width
    ? `${normalized.slice(0, Math.max(width - 3, 0))}...`
    : normalized;
  return align === 'right' ? clipped.padStart(width) : clipped.padEnd(width);
}

function buildStatementPdf(statement) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      margin: 40,
      size: 'A4',
      compress: true,
      info: {
        Title: `Ledgeway Statement ${statement.wallet.walletId}`,
        Author: 'Ledgeway',
        Subject: 'Wallet statement export',
      },
    });
    const chunks = [];

    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const ensureSpace = (height = 18) => {
      if (doc.y + height > doc.page.height - doc.page.margins.bottom) {
        doc.addPage();
      }
    };

    const addKeyValue = (label, value) => {
      ensureSpace(16);
      doc.font('Helvetica-Bold').fontSize(10).text(`${label}:`, { continued: true });
      doc.font('Helvetica').text(` ${value}`);
    };

    const entryRows = [
      [
        fixedWidthCell('Date', 12),
        fixedWidthCell('Type', 18),
        fixedWidthCell('Reference', 22),
        fixedWidthCell('Merchant', 16),
        fixedWidthCell('Amount', 12, 'right'),
      ].join(' '),
      ...statement.entries.map((entry) => [
        fixedWidthCell(String(entry.createdAt || '').slice(0, 10), 12),
        fixedWidthCell(entry.type || '', 18),
        fixedWidthCell(entry.reference || '', 22),
        fixedWidthCell(entry.merchant || '', 16),
        fixedWidthCell(Number(entry.amount || 0).toFixed(2), 12, 'right'),
      ].join(' ')),
    ];

    doc.font('Helvetica-Bold').fontSize(20).text('Ledgeway Statement');
    doc.moveDown(0.2);
    doc.font('Helvetica').fontSize(10).fillColor('#4b5563').text(`Exported ${new Date().toISOString()}`);
    doc.fillColor('#111827');
    doc.moveDown(0.8);

    addKeyValue('Wallet', `${statement.wallet.walletName} (${statement.wallet.walletId})`);
    addKeyValue('Currency', statement.wallet.currency);
    addKeyValue('Period', `${statement.period.from} -> ${statement.period.to}`);
    addKeyValue('Transactions', String(statement.summary.transactionCount));
    addKeyValue('Money In', formatStatementAmount(statement.summary.moneyIn, statement.wallet.currency));
    addKeyValue('Money Out', formatStatementAmount(statement.summary.moneyOut, statement.wallet.currency));
    addKeyValue('Closing Available', formatStatementAmount(statement.summary.closingAvailableBalance, statement.wallet.currency));
    addKeyValue('Closing Reserved', formatStatementAmount(statement.summary.closingReservedBalance, statement.wallet.currency));

    doc.moveDown(1);
    ensureSpace(24);
    doc.font('Helvetica-Bold').fontSize(12).text('Ledger Entries');
    doc.moveDown(0.4);
    doc.font('Courier-Bold').fontSize(8.5).text(entryRows[0]);
    doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).strokeColor('#d1d5db').stroke();
    doc.moveDown(0.3);

    if (entryRows.length === 1) {
      doc.font('Helvetica-Oblique').fontSize(10).text('No ledger entries found for the selected statement window.');
    } else {
      for (const row of entryRows.slice(1)) {
        ensureSpace(14);
        doc.font('Courier').fontSize(8.5).fillColor('#111827').text(row);
      }
    }

    doc.end();
  });
}

async function ensureWalletAccess(reply, auth, wallet, options = {}) {
  if (!wallet) {
    reply.code(404).send({ error: 'wallet_not_found' });
    return null;
  }

  if (options.allowInternal && allowInternalService(auth, options.allowInternal)) {
    return wallet;
  }

  if (!ensureAuthenticatedUser(reply, auth)) return null;

  if (wallet.userId !== auth.userId && !isPrivileged(auth.role)) {
    reply.code(403).send({ error: 'forbidden' });
    return null;
  }

  return wallet;
}

async function ensureWalletAccessById(reply, auth, store, walletId, options = {}) {
  const wallet = await store.getWallet(walletId);
  return ensureWalletAccess(reply, auth, wallet, options);
}

async function ensurePotAccess(reply, auth, store, potId) {
  const pot = await store.getPot(potId);
  if (!pot) {
    reply.code(404).send({ error: 'pot_not_found' });
    return null;
  }

  const wallet = await ensureWalletAccessById(reply, auth, store, pot.walletId);
  if (!wallet) return null;
  return { pot, wallet };
}

async function ensureCardAccess(reply, auth, store, cardId) {
  const card = await store.getCard(cardId);
  if (!card) {
    reply.code(404).send({ error: 'card_not_found' });
    return null;
  }

  const wallet = await ensureWalletAccessById(reply, auth, store, card.walletId);
  if (!wallet) return null;
  return { card, wallet };
}

async function ownedWalletIds(store, auth) {
  const wallets = isPrivileged(auth.role)
    ? await store.listWallets()
    : await store.listWallets({ userId: auth.userId });

  return wallets.map((wallet) => wallet.walletId);
}

export async function registerDomainRoutes(app, { store }) {
  if (!store) {
    throw new Error('wallet_store_missing');
  }

  app.post('/v1/wallets', async (request, reply) => {
    const auth = authContext(request);
    if (!ensureAuthenticatedUser(reply, auth)) return;

    const parsed = walletSchema.safeParse({
      ...(request.body || {}),
      userId: request.body?.userId || auth.userId,
    });
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation_error', details: parsed.error.flatten() });
    }

    const data = parsed.data;
    if (data.userId !== auth.userId && !isPrivileged(auth.role)) {
      return reply.code(403).send({ error: 'forbidden' });
    }

    try {
      const wallet = await store.createWallet({
        walletId: data.walletId,
        userId: data.userId,
        walletName: data.walletName || `${data.currency} Main Account`,
        currency: data.currency,
        startingBalance: data.startingBalance,
      });

      return reply.code(201).send({ wallet });
    } catch (error) {
      return sendStoreError(reply, error);
    }
  });

  app.get('/v1/wallets', async (request, reply) => {
    const auth = authContext(request);
    if (!ensureAuthenticatedUser(reply, auth)) return;

    const requestedUserId = request.query?.userId ? String(request.query.userId) : auth.userId;
    if (requestedUserId !== auth.userId && !isPrivileged(auth.role)) {
      return reply.code(403).send({ error: 'forbidden' });
    }

    const wallets = await store.listWallets({ userId: requestedUserId });
    return { wallets };
  });

  app.post('/v1/wallets/:walletId/topup', async (request, reply) => {
    const auth = authContext(request);
    const wallet = await ensureWalletAccessById(reply, auth, store, request.params.walletId);
    if (!wallet) return;

    const parsed = topupSchema.safeParse(request.body || {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation_error', details: parsed.error.flatten() });
    }

    try {
      const updatedWallet = await store.topupWallet({
        walletId: wallet.walletId,
        amount: parsed.data.amount,
        reference: parsed.data.reference || `topup_${Date.now()}`,
      });

      return { ok: true, wallet: updatedWallet };
    } catch (error) {
      return sendStoreError(reply, error);
    }
  });

  app.get('/v1/wallets/:walletId/balance', async (request, reply) => {
    const auth = authContext(request);
    const wallet = await ensureWalletAccessById(reply, auth, store, request.params.walletId);
    if (!wallet) return;

    return {
      walletId: wallet.walletId,
      walletName: wallet.walletName,
      currency: wallet.currency,
      availableBalance: wallet.availableBalance,
      reservedBalance: wallet.reservedBalance,
    };
  });

  app.post('/v1/pots', async (request, reply) => {
    const auth = authContext(request);
    if (!ensureAuthenticatedUser(reply, auth)) return;

    const parsed = potCreateSchema.safeParse(request.body || {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation_error', details: parsed.error.flatten() });
    }

    const { walletId, name, targetAmount, initialDeposit } = parsed.data;
    const wallet = await ensureWalletAccessById(reply, auth, store, walletId);
    if (!wallet) return;

    try {
      const result = await store.createPot({ walletId, name, targetAmount, initialDeposit });
      return reply.code(201).send(result);
    } catch (error) {
      return sendStoreError(reply, error);
    }
  });

  app.get('/v1/pots', async (request, reply) => {
    const auth = authContext(request);
    if (!ensureAuthenticatedUser(reply, auth)) return;

    const { walletId } = request.query || {};
    if (walletId) {
      const wallet = await ensureWalletAccessById(reply, auth, store, String(walletId));
      if (!wallet) return;
      return { pots: await store.listPots({ walletId: wallet.walletId }) };
    }

    const visibleWalletIds = await ownedWalletIds(store, auth);
    return {
      pots: await store.listPots({ walletIds: visibleWalletIds }),
    };
  });

  app.post('/v1/pots/:potId/deposit', async (request, reply) => {
    const auth = authContext(request);
    const access = await ensurePotAccess(reply, auth, store, request.params.potId);
    if (!access) return;

    const parsed = potMoveSchema.safeParse(request.body || {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation_error', details: parsed.error.flatten() });
    }

    try {
      const result = await store.depositToPot({
        potId: access.pot.potId,
        amount: parsed.data.amount,
        reference: parsed.data.reference || access.pot.potId,
      });
      return { ok: true, ...result };
    } catch (error) {
      return sendStoreError(reply, error);
    }
  });

  app.post('/v1/pots/:potId/withdraw', async (request, reply) => {
    const auth = authContext(request);
    const access = await ensurePotAccess(reply, auth, store, request.params.potId);
    if (!access) return;

    const parsed = potMoveSchema.safeParse(request.body || {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation_error', details: parsed.error.flatten() });
    }

    try {
      const result = await store.withdrawFromPot({
        potId: access.pot.potId,
        amount: parsed.data.amount,
        reference: parsed.data.reference || access.pot.potId,
      });
      return { ok: true, ...result };
    } catch (error) {
      return sendStoreError(reply, error);
    }
  });

  app.post('/v1/pots/transfer', async (request, reply) => {
    const auth = authContext(request);
    if (!ensureAuthenticatedUser(reply, auth)) return;

    const parsed = potTransferSchema.safeParse(request.body || {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation_error', details: parsed.error.flatten() });
    }

    const { fromPotId, toPotId, amount, reference } = parsed.data;
    if (fromPotId === toPotId) {
      return reply.code(409).send({ error: 'same_pot_transfer_not_allowed' });
    }

    const fromPot = await store.getPot(fromPotId);
    const toPot = await store.getPot(toPotId);
    if (!fromPot || !toPot) {
      return reply.code(404).send({ error: 'pot_not_found' });
    }

    const fromWallet = await ensureWalletAccessById(reply, auth, store, fromPot.walletId);
    if (!fromWallet) return;
    const toWallet = await ensureWalletAccessById(reply, auth, store, toPot.walletId);
    if (!toWallet) return;

    if (fromPot.walletId !== toPot.walletId) {
      return reply.code(422).send({ error: 'cross_wallet_pot_transfer_not_allowed' });
    }

    try {
      const result = await store.transferBetweenPots({
        fromPotId,
        toPotId,
        amount,
        reference: reference || `${fromPotId}:${toPotId}`,
      });
      return { ok: true, ...result };
    } catch (error) {
      return sendStoreError(reply, error);
    }
  });

  app.post('/v1/cards', async (request, reply) => {
    const auth = authContext(request);
    if (!ensureAuthenticatedUser(reply, auth)) return;

    const parsed = cardCreateSchema.safeParse(request.body || {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation_error', details: parsed.error.flatten() });
    }

    const { walletId, label, dailyLimit } = parsed.data;
    const wallet = await ensureWalletAccessById(reply, auth, store, walletId);
    if (!wallet) return;

    try {
      const card = await store.createCard({ walletId, label, dailyLimit });
      return reply.code(201).send({ card });
    } catch (error) {
      return sendStoreError(reply, error);
    }
  });

  app.get('/v1/cards', async (request, reply) => {
    const auth = authContext(request);
    if (!ensureAuthenticatedUser(reply, auth)) return;

    const { walletId } = request.query || {};
    if (walletId) {
      const wallet = await ensureWalletAccessById(reply, auth, store, String(walletId));
      if (!wallet) return;
      return { cards: await store.listCards({ walletId: wallet.walletId }) };
    }

    const visibleWalletIds = await ownedWalletIds(store, auth);
    return {
      cards: await store.listCards({ walletIds: visibleWalletIds }),
    };
  });

  app.post('/v1/cards/:cardId/freeze', async (request, reply) => {
    const auth = authContext(request);
    const access = await ensureCardAccess(reply, auth, store, request.params.cardId);
    if (!access) return;

    try {
      const card = await store.updateCardStatus({
        cardId: access.card.cardId,
        status: 'frozen',
        entryType: 'card_frozen',
      });

      return { ok: true, card };
    } catch (error) {
      return sendStoreError(reply, error);
    }
  });

  app.post('/v1/cards/:cardId/unfreeze', async (request, reply) => {
    const auth = authContext(request);
    const access = await ensureCardAccess(reply, auth, store, request.params.cardId);
    if (!access) return;

    try {
      const card = await store.updateCardStatus({
        cardId: access.card.cardId,
        status: 'active',
        entryType: 'card_unfrozen',
      });

      return { ok: true, card };
    } catch (error) {
      return sendStoreError(reply, error);
    }
  });

  app.post('/v1/cards/:cardId/charge', async (request, reply) => {
    const auth = authContext(request);
    const access = await ensureCardAccess(reply, auth, store, request.params.cardId);
    if (!access) return;

    const parsed = cardChargeSchema.safeParse(request.body || {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation_error', details: parsed.error.flatten() });
    }

    try {
      const result = await store.chargeCard({
        cardId: access.card.cardId,
        amount: parsed.data.amount,
        merchant: parsed.data.merchant,
        reference: parsed.data.reference || `card_charge_${Date.now()}`,
      });

      return reply.code(201).send(result);
    } catch (error) {
      return sendStoreError(reply, error);
    }
  });

  app.post('/v1/payments/internal', async (request, reply) => {
    const auth = authContext(request);
    if (!ensureAuthenticatedUser(reply, auth)) return;

    const parsed = internalPaymentSchema.safeParse(request.body || {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation_error', details: parsed.error.flatten() });
    }

    const { fromWalletId, toWalletId, amount, narration } = parsed.data;
    if (fromWalletId === toWalletId) {
      return reply.code(409).send({ error: 'same_wallet_transfer_not_allowed' });
    }

    const fromWallet = await ensureWalletAccessById(reply, auth, store, fromWalletId);
    if (!fromWallet) return;

    const toWallet = await store.getWallet(toWalletId);
    if (!toWallet) {
      return reply.code(404).send({ error: 'wallet_not_found' });
    }

    try {
      const result = await store.createInternalPayment({
        fromWalletId,
        toWalletId,
        amount,
        narration: narration || 'Internal wallet transfer',
      });

      return reply.code(201).send(result);
    } catch (error) {
      return sendStoreError(reply, error);
    }
  });

  app.get('/v1/payments/internal', async (request, reply) => {
    const auth = authContext(request);
    if (!ensureAuthenticatedUser(reply, auth)) return;

    const { walletId } = request.query || {};
    if (walletId) {
      const wallet = await ensureWalletAccessById(reply, auth, store, String(walletId));
      if (!wallet) return;
      return { payments: await store.listInternalPayments({ walletId: wallet.walletId }) };
    }

    const visibleWalletIds = await ownedWalletIds(store, auth);
    return {
      payments: await store.listInternalPayments({ walletIds: visibleWalletIds }),
    };
  });

  app.post('/v1/ledger/reserve', async (request, reply) => {
    const auth = authContext(request);
    const parsed = reserveSchema.safeParse(request.body || {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation_error', details: parsed.error.flatten() });
    }

    const wallet = await ensureWalletAccessById(reply, auth, store, parsed.data.walletId, { allowInternal: 'transfers-service' });
    if (!wallet) return;

    try {
      const updatedWallet = await store.reserveFunds(parsed.data);
      return { ok: true, wallet: updatedWallet };
    } catch (error) {
      return sendStoreError(reply, error);
    }
  });

  app.post('/v1/ledger/release', async (request, reply) => {
    const auth = authContext(request);
    const parsed = releaseSchema.safeParse(request.body || {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation_error', details: parsed.error.flatten() });
    }

    const wallet = await ensureWalletAccessById(reply, auth, store, parsed.data.walletId, { allowInternal: 'transfers-service' });
    if (!wallet) return;

    try {
      const updatedWallet = await store.releaseFunds(parsed.data);
      return { ok: true, wallet: updatedWallet };
    } catch (error) {
      return sendStoreError(reply, error);
    }
  });

  app.post('/v1/ledger/settle', async (request, reply) => {
    const auth = authContext(request);
    const parsed = settleSchema.safeParse(request.body || {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation_error', details: parsed.error.flatten() });
    }

    const wallet = await ensureWalletAccessById(reply, auth, store, parsed.data.walletId, { allowInternal: 'transfers-service' });
    if (!wallet) return;

    try {
      const updatedWallet = await store.settleFunds(parsed.data);
      return { ok: true, wallet: updatedWallet };
    } catch (error) {
      return sendStoreError(reply, error);
    }
  });

  app.get('/v1/ledger/entries', async (request, reply) => {
    const auth = authContext(request);
    if (!ensureAuthenticatedUser(reply, auth)) return;

    const { walletId } = request.query || {};
    if (walletId) {
      const wallet = await ensureWalletAccessById(reply, auth, store, String(walletId));
      if (!wallet) return;
      return { entries: await store.listLedgerEntries({ walletId: wallet.walletId }) };
    }

    const visibleWalletIds = await ownedWalletIds(store, auth);
    return { entries: await store.listLedgerEntries({ walletIds: visibleWalletIds }) };
  });

  app.get('/v1/statements/:walletId', async (request, reply) => {
    const auth = authContext(request);
    const wallet = await ensureWalletAccessById(reply, auth, store, request.params.walletId);
    if (!wallet) return;

    const window = statementDateWindow(request.query || {});
    if (!window) {
      return reply.code(400).send({ error: 'invalid_statement_window' });
    }

    return {
      statement: buildStatement(
        wallet,
        await store.listLedgerEntries({ walletId: wallet.walletId }),
        window.from,
        window.to
      ),
    };
  });

  app.get('/v1/statements/:walletId/export', async (request, reply) => {
    const auth = authContext(request);
    const wallet = await ensureWalletAccessById(reply, auth, store, request.params.walletId);
    if (!wallet) return;

    const window = statementDateWindow(request.query || {});
    if (!window) {
      return reply.code(400).send({ error: 'invalid_statement_window' });
    }

    const formatParsed = statementFormatSchema.safeParse(request.query?.format || 'csv');
    if (!formatParsed.success) {
      return reply.code(400).send({ error: 'invalid_export_format' });
    }

    const statement = buildStatement(
      wallet,
      await store.listLedgerEntries({ walletId: wallet.walletId }),
      window.from,
      window.to
    );

    if (formatParsed.data === 'json') {
      return {
        statement,
        exportedAt: new Date().toISOString(),
        format: 'json',
      };
    }

    if (formatParsed.data === 'pdf') {
      const pdfBuffer = await buildStatementPdf(statement);
      reply
        .type('application/pdf')
        .header('content-disposition', `attachment; filename="${statementFilename(wallet.walletId, window.from, window.to, 'pdf')}"`);
      return reply.send(pdfBuffer);
    }

    reply
      .type('text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${statementFilename(wallet.walletId, window.from, window.to, 'csv')}"`);

    return reply.send(buildStatementCsv(statement));
  });
}
