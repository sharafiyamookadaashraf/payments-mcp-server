import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { createServer, formatAmount } from '../src/server.js';
import { PaymentStore, seedPayments } from '../src/store.js';

/** Connects a real MCP client to the server in memory: tests go through the full protocol. */
async function connect() {
  const store = new PaymentStore(seedPayments());
  const server = createServer(store);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as CallToolResult;
  return { client, store, call };
}

const text = (r: CallToolResult) => (r.content[0] as { text: string }).text;

describe('payments MCP server', () => {
  let ctx: Awaited<ReturnType<typeof connect>>;
  beforeEach(async () => {
    ctx = await connect();
  });

  it('lists tools with safety annotations', async () => {
    const { tools } = await ctx.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['get_payment', 'payment_stats', 'refund_payment', 'search_payments']);
    const refund = tools.find((t) => t.name === 'refund_payment')!;
    expect(refund.annotations).toMatchObject({ destructiveHint: true, idempotentHint: true });
    expect(tools.find((t) => t.name === 'search_payments')!.annotations?.readOnlyHint).toBe(true);
  });

  it('searches failed payments', async () => {
    const r = await ctx.call('search_payments', { status: 'failed' });
    const { payments } = r.structuredContent as { payments: { status: string }[] };
    expect(payments).toHaveLength(3);
    expect(payments.every((p) => p.status === 'failed')).toBe(true);
  });

  it('rejects invalid input through the schema', async () => {
    const r = await ctx.call('get_payment', { paymentId: 'DROP TABLE' });
    expect(r.isError).toBe(true);
  });

  it('returns NOT_FOUND as a tool error the model can read', async () => {
    const r = await ctx.call('get_payment', { paymentId: 'pay_9999' });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('NOT_FOUND');
  });

  it('never sums amounts across currencies', async () => {
    const r = await ctx.call('payment_stats');
    const stats = r.structuredContent as { volumeByCurrency: Record<string, unknown>; failureRate: number };
    expect(Object.keys(stats.volumeByCurrency).sort()).toEqual(['EUR', 'SEK', 'USD']);
    expect(stats.failureRate).toBeCloseTo(3 / 8);
  });

  describe('refund_payment', () => {
    const refund = { paymentId: 'pay_0001', amountMinor: 50_000, reason: 'Duplicate invoice', idempotencyKey: 'key-0001-abc' };

    it('refunds part of a settled payment', async () => {
      const r = await ctx.call('refund_payment', refund);
      expect(r.isError).toBeFalsy();
      expect(ctx.store.get('pay_0001')).toMatchObject({ status: 'partially_refunded', refundedMinor: 50_000 });
    });

    it('is idempotent: a retried call with the same key does not refund twice', async () => {
      const first = await ctx.call('refund_payment', refund);
      const retry = await ctx.call('refund_payment', refund);
      expect((retry.structuredContent as { replayed: boolean }).replayed).toBe(true);
      expect((retry.structuredContent as { refund: { id: string } }).refund.id).toBe(
        (first.structuredContent as { refund: { id: string } }).refund.id,
      );
      expect(ctx.store.get('pay_0001')!.refundedMinor).toBe(50_000);
      expect(ctx.store.refundsFor('pay_0001')).toHaveLength(1);
    });

    it('handles concurrent duplicate calls safely', async () => {
      await Promise.all(Array.from({ length: 10 }, () => ctx.call('refund_payment', refund)));
      expect(ctx.store.refundsFor('pay_0001')).toHaveLength(1);
    });

    it('rejects a reused key with different input', async () => {
      await ctx.call('refund_payment', refund);
      const r = await ctx.call('refund_payment', { ...refund, amountMinor: 10_000 });
      expect(r.isError).toBe(true);
      expect(text(r)).toContain('IDEMPOTENCY_CONFLICT');
    });

    it('refuses to refund more than remains', async () => {
      const r = await ctx.call('refund_payment', { ...refund, amountMinor: 200_000 });
      expect(r.isError).toBe(true);
      expect(text(r)).toContain('AMOUNT_EXCEEDS_REMAINING');
    });

    it('refuses to refund a failed payment', async () => {
      const r = await ctx.call('refund_payment', { ...refund, paymentId: 'pay_0003' });
      expect(text(r)).toContain('INVALID_STATE');
    });

    it('marks the payment refunded once fully refunded', async () => {
      await ctx.call('refund_payment', { ...refund, amountMinor: 125_000 });
      expect(ctx.store.get('pay_0001')!.status).toBe('refunded');
    });
  });

  it('exposes payments as resources', async () => {
    const { resources } = await ctx.client.listResources();
    expect(resources.length).toBe(8);
    const res = await ctx.client.readResource({ uri: 'payments://pay_0002' });
    expect(JSON.parse((res.contents[0] as { text: string }).text).currency).toBe('EUR');
  });

  it('provides an investigation prompt', async () => {
    const p = await ctx.client.getPrompt({ name: 'investigate_failures', arguments: { clientId: 'client_globex' } });
    expect((p.messages[0].content as { text: string }).text).toContain('client_globex');
  });
});

describe('formatAmount', () => {
  it('formats minor units', () => {
    expect(formatAmount(125_000, 'SEK')).toBe('1,250.00 SEK');
  });
});
