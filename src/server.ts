import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { DomainError, type PaymentStore } from './store.js';

const currency = z.enum(['SEK', 'EUR', 'USD']);
const status = z.enum(['pending', 'settled', 'failed', 'refunded', 'partially_refunded']);
const paymentId = z.string().regex(/^pay_\d{4}$/, 'Payment IDs look like pay_0001');

/** Formats minor units for humans: 125000 SEK -> "1,250.00 SEK". */
export function formatAmount(amountMinor: number, cur: string): string {
  return `${(amountMinor / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${cur}`;
}

/** Tool results carry both text (for the model) and structured JSON (for clients that read it). */
function ok(text: string, data: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text }], structuredContent: data };
}

/**
 * Domain errors are returned as tool results with isError, not thrown.
 * That way the model sees the reason and can correct itself
 * (for example, ask for a smaller refund) instead of the call just failing.
 */
function toolError(err: unknown): CallToolResult {
  if (err instanceof DomainError) {
    return { isError: true, content: [{ type: 'text', text: `${err.code}: ${err.message}` }] };
  }
  throw err; // programmer errors should surface, not be hidden from the logs
}

export function createServer(store: PaymentStore): McpServer {
  const server = new McpServer({ name: 'payments-mcp-server', version: '1.0.0' });

  server.registerTool(
    'search_payments',
    {
      title: 'Search payments',
      description:
        'Find payments by status, client, currency or date. Returns newest first. Amounts are in minor units (cents/öre).',
      inputSchema: {
        status: status.optional(),
        clientId: z.string().optional().describe('For example client_acme'),
        currency: currency.optional(),
        since: z.string().datetime().optional().describe('ISO 8601 timestamp, inclusive'),
        limit: z.number().int().min(1).max(100).default(20),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      const payments = store.search(args);
      const lines = payments.map(
        (p) =>
          `${p.id} | ${p.status}${p.failureReason ? ` (${p.failureReason})` : ''} | ${formatAmount(p.amountMinor, p.currency)} | ${p.clientId} -> ${p.beneficiary} | ${p.createdAt}`,
      );
      return ok(payments.length ? lines.join('\n') : 'No payments match those filters.', { payments });
    },
  );

  server.registerTool(
    'get_payment',
    {
      title: 'Get payment details',
      description: 'Full details of one payment, including any refunds.',
      inputSchema: { paymentId },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ paymentId: id }) => {
      const payment = store.get(id);
      if (!payment) return toolError(new DomainError('NOT_FOUND', `Payment ${id} not found.`));
      const refunds = store.refundsFor(id);
      return ok(JSON.stringify({ payment, refunds }, null, 2), { payment, refunds });
    },
  );

  server.registerTool(
    'payment_stats',
    {
      title: 'Payment statistics',
      description: 'Counts by status, volume per currency and failure rate. Volumes are never summed across currencies.',
      inputSchema: { since: z.string().datetime().optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ since }) => {
      const stats = store.stats(since);
      const volume = Object.entries(stats.volumeByCurrency)
        .map(([cur, v]) => `${cur}: ${v.count} payments, ${formatAmount(v.amountMinor, cur)}`)
        .join('\n');
      const text = `Total: ${stats.total}\nFailure rate: ${(stats.failureRate * 100).toFixed(1)}%\nBy status: ${JSON.stringify(stats.byStatus)}\n${volume}`;
      return ok(text, stats);
    },
  );

  server.registerTool(
    'refund_payment',
    {
      title: 'Refund a payment',
      description:
        'Refund all or part of a settled payment. This moves money: confirm amount and payment with the user first. ' +
        'Always pass a new unique idempotencyKey per refund; retrying with the same key is safe and will not refund twice.',
      inputSchema: {
        paymentId,
        amountMinor: z.number().int().positive().describe('Amount in minor units, for example 5000 = 50.00'),
        reason: z.string().min(3).max(200),
        idempotencyKey: z.string().min(8).max(100).describe('Unique per refund, for example a UUID'),
      },
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const { refund, replayed } = store.refund(args);
        const text = replayed
          ? `Already processed: refund ${refund.id} of ${formatAmount(refund.amountMinor, refund.currency)} (same idempotency key). No new refund was made.`
          : `Refunded ${formatAmount(refund.amountMinor, refund.currency)} on ${refund.paymentId} as ${refund.id}.`;
        return ok(text, { refund, replayed });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerResource(
    'payment',
    new ResourceTemplate('payments://{paymentId}', {
      list: async () => ({
        resources: store.search({ limit: 100 }).map((p) => ({
          uri: `payments://${p.id}`,
          name: `${p.id} (${p.status})`,
          mimeType: 'application/json',
        })),
      }),
    }),
    { title: 'Payment', description: 'A single payment as JSON', mimeType: 'application/json' },
    async (uri, { paymentId: id }) => {
      const payment = store.get(String(id));
      if (!payment) throw new Error(`Payment ${id} not found`);
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(payment, null, 2) }] };
    },
  );

  server.registerPrompt(
    'investigate_failures',
    {
      title: 'Investigate failed payments',
      description: 'Guides the model through a failure investigation using the tools above.',
      argsSchema: { clientId: z.string().optional() },
    },
    ({ clientId }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `Investigate failed payments${clientId ? ` for ${clientId}` : ''}. ` +
              'Use search_payments with status "failed", group them by failureReason, ' +
              'check payment_stats for the overall failure rate, and suggest which failures are retryable ' +
              '(timeouts, provider errors) versus terminal (declines, limits). Do not issue refunds.',
          },
        },
      ],
    }),
  );

  return server;
}
