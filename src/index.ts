#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';
import { PaymentStore, seedPayments } from './store.js';

const server = createServer(new PaymentStore(seedPayments()));
await server.connect(new StdioServerTransport());

// stdout is the protocol channel, so all logging must go to stderr.
console.error('payments-mcp-server running on stdio');
