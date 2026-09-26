// The MCP adapter (r_mcp_adapter): streamable-HTTP JSON-RPC at POST /mcp, a
// thin layer over the node's own verbs. Every tool call runs as the CALLER —
// an identity proven by an RFC 9421 signature, the operator by bearer token,
// or nobody — through the same access rules and the same admission as the
// HTTP surface. Nothing here decides access.
//
// Stateless: no Mcp-Session-Id is issued, so there is no session to keep and
// nothing to evict (r_session_eviction holds vacuously). Responses are plain
// JSON (the transport allows it); no SSE stream is offered, and GET is 405.
import { checkFact, Refusal } from './facts.ts';
import type { RoflenoxNode } from './node.ts';

export const MCP_PROTOCOL = '2025-03-26';

type Json = Record<string, unknown>;
interface Rpc { jsonrpc?: string; id?: string | number | null; method?: string; params?: Json }

const FACT_SCHEMA = {
  type: 'object',
  required: ['source', 'relation', 'target', 'perspective', 'confidence'],
  properties: {
    source: { type: 'string' }, relation: { type: 'string' }, target: { type: 'string' },
    perspective: { type: 'string' }, confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
};

export const TOOLS = [
  { name: 'ask', description: 'Ask one ROFL literal, e.g. edge(F, S, R, T). Optional perspective restricts to facts asserted under it.',
    inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, perspective: { type: 'string' } } } },
  { name: 'why', description: 'Explain why a ground literal holds, in the books you may read whole.',
    inputSchema: { type: 'object', required: ['literal'], properties: { literal: { type: 'string' } } } },
  { name: 'whynot', description: 'Explain why a ground literal does not hold, in the books you may read whole.',
    inputSchema: { type: 'object', required: ['literal'], properties: { literal: { type: 'string' } } } },
  { name: 'assert', description: 'Publish facts as this node\'s own identity (operator only): a signed batch through normal admission.',
    inputSchema: { type: 'object', required: ['facts'], properties: { facts: { type: 'array', items: FACT_SCHEMA } } } },
];

function ok(id: Rpc['id'], result: unknown): Json {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function err(id: Rpc['id'], code: number, message: string, data?: unknown): Json {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

function text(v: unknown, isError = false): Json {
  return { content: [{ type: 'text', text: JSON.stringify(v) }], ...(isError ? { isError: true } : {}) };
}

/** One JSON-RPC message → its response, or null for a notification. */
export async function handleRpc(node: RoflenoxNode, msg: Rpc, caller: string | null): Promise<Json | null> {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return err(msg?.id, -32600, 'invalid request');
  const isNotification = msg.id === undefined;
  switch (msg.method) {
    case 'initialize': {
      const asked = (msg.params?.protocolVersion as string | undefined) ?? MCP_PROTOCOL;
      return ok(msg.id, {
        protocolVersion: asked,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'roflenox', version: '0.1.0' },
        instructions: 'Facts are signed assertions in per-identity books. ask/why/whynot answer within your access; assert publishes as this node.',
      });
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;
    case 'ping':
      return ok(msg.id, {});
    case 'tools/list':
      return ok(msg.id, { tools: TOOLS });
    case 'tools/call': {
      const name = msg.params?.name as string;
      const a = (msg.params?.arguments ?? {}) as Json;
      try {
        switch (name) {
          case 'ask':
            if (typeof a.query !== 'string') return err(msg.id, -32602, 'ask needs {query}');
            return ok(msg.id, text(await node.ask(a.query, caller, typeof a.perspective === 'string' ? a.perspective : null)));
          case 'why':
          case 'whynot':
            if (typeof a.literal !== 'string') return err(msg.id, -32602, `${name} needs {literal}`);
            return ok(msg.id, text(await (name === 'why' ? node.why(a.literal, caller) : node.whynot(a.literal, caller))));
          case 'assert': {
            if (caller === null || caller !== node.identity?.name) {
              throw new Refusal(403, 'not_operator', 'only the node\'s own identity asserts through this node; publish your own signed batches instead');
            }
            if (!Array.isArray(a.facts) || a.facts.length === 0) return err(msg.id, -32602, 'assert needs {facts: [...]}');
            const facts = a.facts.map((f, i) => checkFact(f, i + 1));
            const r = await node.assertAsSelf(facts);
            return ok(msg.id, text({ admitted: true, identity: r.identity, facts: facts.length }));
          }
          default:
            return err(msg.id, -32602, `unknown tool: ${name}`);
        }
      } catch (e) {
        if (e instanceof Refusal) return ok(msg.id, text({ error: e.reason, message: e.message, ...e.detail }, true));
        throw e;
      }
    }
    default:
      return isNotification ? null : err(msg.id, -32601, `method not found: ${msg.method}`);
  }
}
