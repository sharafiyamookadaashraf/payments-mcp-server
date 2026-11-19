/**
 * In-memory payment store.
 *
 * Amounts are integers in minor units (cents / öre), never floats.
 * A real implementation would sit on PostgreSQL or MongoDB; the interface
 * is kept small so it can be swapped without touching the MCP layer.
 */

export type Currency = 'SEK' | 'EUR' | 'USD';
export type PaymentStatus = 'pending' | 'settled' | 'failed' | 'refunded' | 'partially_refunded';

export interface Payment {
  id: string;
  clientId: string;
  beneficiary: string;
  amountMinor: number;
  refundedMinor: number;
  currency: Currency;
  status: PaymentStatus;
  failureReason?: string;
  createdAt: string; // ISO 8601
}

export interface Refund {
  id: string;
  paymentId: string;
  amountMinor: number;
  currency: Currency;
  reason: string;
  createdAt: string;
}

export interface PaymentFilter {
  status?: PaymentStatus;
  clientId?: string;
  currency?: Currency;
  since?: string;
  limit?: number;
}

export class DomainError extends Error {
  constructor(
    public readonly code: 'NOT_FOUND' | 'INVALID_STATE' | 'AMOUNT_EXCEEDS_REMAINING' | 'IDEMPOTENCY_CONFLICT',
    message: string,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

interface IdempotencyRecord {
  /** Fingerprint of the original request, so a reused key with different input is rejected. */
  fingerprint: string;
  refund: Refund;
}

export class PaymentStore {
  private payments = new Map<string, Payment>();
  private refunds: Refund[] = [];
  private idempotency = new Map<string, IdempotencyRecord>();
  private refundSeq = 0;

  constructor(seed: Payment[] = []) {
    for (const p of seed) this.payments.set(p.id, { ...p });
  }

  get(id: string): Payment | undefined {
    const p = this.payments.get(id);
    return p ? { ...p } : undefined;
  }

  search(filter: PaymentFilter = {}): Payment[] {
    const limit = filter.limit ?? 20;
    return [...this.payments.values()]
      .filter((p) => !filter.status || p.status === filter.status)
      .filter((p) => !filter.clientId || p.clientId === filter.clientId)
      .filter((p) => !filter.currency || p.currency === filter.currency)
      .filter((p) => !filter.since || p.createdAt >= filter.since)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map((p) => ({ ...p }));
  }

  /** Totals per currency and counts per status. Amounts are never summed across currencies. */
  stats(since?: string) {
    const rows = [...this.payments.values()].filter((p) => !since || p.createdAt >= since);
    const byStatus: Record<string, number> = {};
    const volumeByCurrency: Record<string, { count: number; amountMinor: number }> = {};
    for (const p of rows) {
      byStatus[p.status] = (byStatus[p.status] ?? 0) + 1;
      const v = (volumeByCurrency[p.currency] ??= { count: 0, amountMinor: 0 });
      v.count += 1;
      v.amountMinor += p.amountMinor;
    }
    const failed = byStatus.failed ?? 0;
    return {
      total: rows.length,
      byStatus,
      volumeByCurrency,
      failureRate: rows.length ? Number((failed / rows.length).toFixed(4)) : 0,
    };
  }

  refundsFor(paymentId: string): Refund[] {
    return this.refunds.filter((r) => r.paymentId === paymentId).map((r) => ({ ...r }));
  }

  /**
   * Idempotent refund.
   *
   * - Same key + same request  -> returns the original refund, no second refund.
   * - Same key + different request -> IDEMPOTENCY_CONFLICT (almost always a client bug).
   *
   * The check and the write happen in one synchronous block, so two concurrent
   * calls in this process cannot both pass. With a real database the same
   * guarantee comes from a unique index on the key inside one transaction.
   */
  refund(input: { paymentId: string; amountMinor: number; reason: string; idempotencyKey: string }): {
    refund: Refund;
    replayed: boolean;
  } {
    const fingerprint = `${input.paymentId}:${input.amountMinor}`;
    const existing = this.idempotency.get(input.idempotencyKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new DomainError(
          'IDEMPOTENCY_CONFLICT',
          `Idempotency key "${input.idempotencyKey}" was already used for a different refund.`,
        );
      }
      return { refund: { ...existing.refund }, replayed: true };
    }

    const payment = this.payments.get(input.paymentId);
    if (!payment) throw new DomainError('NOT_FOUND', `Payment ${input.paymentId} not found.`);
    if (payment.status !== 'settled' && payment.status !== 'partially_refunded') {
      throw new DomainError('INVALID_STATE', `Payment ${payment.id} is ${payment.status}; only settled payments can be refunded.`);
    }
    const remaining = payment.amountMinor - payment.refundedMinor;
    if (input.amountMinor > remaining) {
      throw new DomainError(
        'AMOUNT_EXCEEDS_REMAINING',
        `Refund of ${input.amountMinor} exceeds the refundable amount ${remaining} ${payment.currency}.`,
      );
    }

    const refund: Refund = {
      id: `ref_${String(++this.refundSeq).padStart(4, '0')}`,
      paymentId: payment.id,
      amountMinor: input.amountMinor,
      currency: payment.currency,
      reason: input.reason,
      createdAt: new Date().toISOString(),
    };
    payment.refundedMinor += input.amountMinor;
    payment.status = payment.refundedMinor === payment.amountMinor ? 'refunded' : 'partially_refunded';
    this.refunds.push(refund);
    this.idempotency.set(input.idempotencyKey, { fingerprint, refund });
    return { refund: { ...refund }, replayed: false };
  }
}

export function seedPayments(): Payment[] {
  const base = (i: number, p: Partial<Payment>): Payment => ({
    id: `pay_${String(i).padStart(4, '0')}`,
    clientId: 'client_acme',
    beneficiary: 'Nordic Supplies AB',
    amountMinor: 125_000,
    refundedMinor: 0,
    currency: 'SEK',
    status: 'settled',
    createdAt: `2026-11-${String(10 + (i % 9)).padStart(2, '0')}T09:${String(i % 60).padStart(2, '0')}:00.000Z`,
    ...p,
  });
  return [
    base(1, {}),
    base(2, { amountMinor: 89_900, currency: 'EUR', beneficiary: 'Berlin Logistics GmbH' }),
    base(3, { status: 'failed', failureReason: 'issuer_declined', amountMinor: 450_000 }),
    base(4, { status: 'pending', clientId: 'client_globex', amountMinor: 32_500 }),
    base(5, { status: 'failed', failureReason: 'card_limit_exceeded', clientId: 'client_globex', currency: 'USD', amountMinor: 1_200_000 }),
    base(6, { clientId: 'client_globex', currency: 'USD', amountMinor: 76_000, beneficiary: 'Acme Cloud Inc' }),
    base(7, { amountMinor: 15_000, beneficiary: 'Kontorsmaterial AB' }),
    base(8, { status: 'failed', failureReason: 'timeout_at_provider', amountMinor: 220_000 }),
  ];
}
