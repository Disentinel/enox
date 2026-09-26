// The MCP adapter (r_mcp_adapter): streamable-HTTP JSON-RPC at POST /mcp, a
// thin layer over the node's own verbs. Every tool call runs as the CALLER —
// an identity proven by an RFC 9421 signature, the operator by bearer token,
// or nobody — through the same access rules and the same admission as the
// HTTP surface. Nothing here decides access.
//
// Stateless: no Mcp-Session-Id is issued, so there is no session to keep and
// nothing to evict (r_session_eviction holds vacuously). Responses are plain
// JSON (the transport allows it); no SSE stream is offered, and GET is 405.
import { Refusal } from './facts.ts';
import { callOp, isLocal, OP, OPS, type Ctx } from './ops.ts';

export const MCP_PROTOCOL = '2025-03-26';

type Json = Record<string, unknown>;
interface Rpc { jsonrpc?: string; id?: string | number | null; method?: string; params?: Json }

/** The tools of a surface: the operation table, minus local-only operations
 *  when the transport is the network. Schema = the op's input schema. */
export function toolsFor(surface: 'network' | 'local') {
  return OPS.filter((o) => surface === 'local' || !isLocal(o))
    .map((o) => ({ name: o.name, description: o.description, inputSchema: o.input }));
}

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
export async function handleRpc(ctx: Ctx, msg: Rpc, surface: 'network' | 'local'): Promise<Json | null> {
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
      return ok(msg.id, { tools: toolsFor(surface) });
    case 'tools/call': {
      const name = msg.params?.name as string;
      try {
        const r = await callOp(name, msg.params?.arguments ?? {}, ctx, surface);
        const op = OP.get(name)!;
        return ok(msg.id, { content: [{ type: 'text', text: op.text ? op.text(r) : JSON.stringify(r) }] });
      } catch (e) {
        if (e instanceof Refusal) {
          if (e.detail.plain) return ok(msg.id, { content: [{ type: 'text', text: e.message }], isError: true });
          if (e.reason === 'unknown_op') return err(msg.id, -32602, `unknown tool: ${name}`);
          if (e.reason === 'bad_args') return err(msg.id, -32602, e.message);
          return ok(msg.id, text({ error: e.reason, message: e.message, ...e.detail }, true));
        }
        throw e;
      }
    }
    default:
      return isNotification ? null : err(msg.id, -32601, `method not found: ${msg.method}`);
  }
}
