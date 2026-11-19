# payments-mcp-server

A [Model Context Protocol](https://modelcontextprotocol.io) server, written in TypeScript, that lets an AI assistant like Claude look up payments, analyze failures and issue refunds safely.

The interesting part is not the lookups. It's making a tool that **moves money** safe to hand to an LLM, which retries, repeats itself and occasionally gets arguments wrong.

## What it exposes

| Type | Name | What it does |
| --- | --- | --- |
| Tool | `search_payments` | Filter by status, client, currency, date. Read-only. |
| Tool | `get_payment` | One payment plus its refunds. Read-only. |
| Tool | `payment_stats` | Counts by status, volume per currency, failure rate. Read-only. |
| Tool | `refund_payment` | Full or partial refund. **Destructive, idempotent.** |
| Resource | `payments://{paymentId}` | A payment as JSON, listable. |
| Prompt | `investigate_failures` | Guides the model through a failure investigation without refunding. |

## Design decisions

- **Idempotency keys on refunds.** The model must send a unique `idempotencyKey`. Retrying with the same key returns the original refund instead of refunding twice. Reusing a key with a *different* amount is rejected as `IDEMPOTENCY_CONFLICT`, because that's almost always a bug.
- **Atomic check-and-write.** The key lookup, the remaining-amount check and the write happen in one synchronous block, so ten concurrent duplicate calls produce exactly one refund (there's a test for it). In a real database the same guarantee comes from a unique index on the key inside one transaction.
- **Validation at the boundary.** Every tool input is a Zod schema, so malformed IDs or negative amounts never reach business logic. Model-generated arguments are treated like user input.
- **Business errors are tool results, not exceptions.** `NOT_FOUND`, `INVALID_STATE` and `AMOUNT_EXCEEDS_REMAINING` come back with `isError: true` and a clear message, so the model can read the reason and correct itself. Unexpected errors are rethrown so they aren't hidden.
- **Tool annotations.** Read-only tools are marked `readOnlyHint`; the refund is marked `destructiveHint` and `idempotentHint`, so clients can ask the user for confirmation.
- **Money as integers.** Amounts are minor units (öre, cents) with a currency code. Volumes are never summed across currencies.
- **Logs go to stderr.** On the stdio transport, stdout is the protocol channel; writing logs there corrupts messages.

## Run it

```bash
npm install
npm test          # 15 tests through a real MCP client, in memory
npm run build
npm run inspect   # opens the MCP Inspector to try tools in a browser
```

### Use it from Claude Desktop

Build first, then add this to `claude_desktop_config.json` (Settings → Developer → Edit Config) and restart:

```json
{
  "mcpServers": {
    "payments": {
      "command": "node",
      "args": ["/absolute/path/to/payments-mcp-server/dist/src/index.js"]
    }
  }
}
```

Then try: *"Which payments failed this month, and which of them are worth retrying?"* or *"Refund 500 SEK on pay_0001 for a duplicate invoice."*

## Project layout

```
src/
  store.ts    in-memory store: payments, refunds, idempotency records
  server.ts   MCP tools, resource and prompt
  index.ts    stdio entry point
test/
  server.test.ts   end-to-end tests through an MCP client
```

## What I'd add for production

- PostgreSQL behind the store, with a unique index on the idempotency key and the refund in one transaction.
- The Streamable HTTP transport with OAuth, so it can run as a remote server with per-user permissions.
- Per-user authorization on every tool (a user only sees their company's payments).
- Audit logging of every tool call, with the calling user and the arguments.
- Rate limits and an amount cap above which refunds need human approval.
