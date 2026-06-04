import { describe, it, expect, vi } from 'vitest';
import {
  NdjsonDecoder,
  JsonRpcPeer,
  encodeMessage,
  isJsonRpcRequest,
  isJsonRpcNotification,
  isJsonRpcResponse,
} from '../../../../src/bridge/acp/jsonrpc.js';

describe('NdjsonDecoder', () => {
  it('parses one object per newline and buffers partial lines', () => {
    const d = new NdjsonDecoder();
    expect(d.push('{"a":1}\n{"b":')).toEqual([{ a: 1 }]);
    expect(d.push('2}\n')).toEqual([{ b: 2 }]);
  });

  it('skips blank lines and reports malformed JSON without throwing', () => {
    const onError = vi.fn();
    const d = new NdjsonDecoder(onError);
    const out = d.push('\n  \nnot-json\n{"ok":true}\n');
    expect(out).toEqual([{ ok: true }]);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('accepts Buffer chunks', () => {
    const d = new NdjsonDecoder();
    expect(d.push(Buffer.from('{"x":42}\n'))).toEqual([{ x: 42 }]);
  });
});

describe('JSON-RPC type guards', () => {
  it('classifies requests, notifications, and responses', () => {
    expect(isJsonRpcRequest({ jsonrpc: '2.0', id: 1, method: 'm' })).toBe(true);
    expect(isJsonRpcNotification({ jsonrpc: '2.0', method: 'm' })).toBe(true);
    expect(isJsonRpcResponse({ jsonrpc: '2.0', id: 1, result: 5 })).toBe(true);
    expect(isJsonRpcResponse({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'x' } })).toBe(true);
    // A request is not a notification and vice-versa.
    expect(isJsonRpcNotification({ jsonrpc: '2.0', id: 1, method: 'm' })).toBe(false);
    expect(isJsonRpcRequest({ jsonrpc: '2.0', method: 'm' })).toBe(false);
  });
});

/** Wire two peers together in-memory so each receives the other's output. */
function connectPeers(
  aOpts: ConstructorParameters<typeof JsonRpcPeer>[0] = { send: () => {} },
  bOpts: ConstructorParameters<typeof JsonRpcPeer>[0] = { send: () => {} },
): { a: JsonRpcPeer; b: JsonRpcPeer } {
  const peers: { a?: JsonRpcPeer; b?: JsonRpcPeer } = {};
  peers.a = new JsonRpcPeer({
    ...aOpts,
    send: (line) => queueMicrotask(() => peers.b!.receive(JSON.parse(line))),
  });
  peers.b = new JsonRpcPeer({
    ...bOpts,
    send: (line) => queueMicrotask(() => peers.a!.receive(JSON.parse(line))),
  });
  return { a: peers.a, b: peers.b };
}

describe('JsonRpcPeer', () => {
  it('correlates a request with its response result', async () => {
    const { a } = connectPeers(
      {},
      { onRequest: (method, params) => ({ echo: method, params }) },
    );
    const res = await a.request('ping', { n: 1 });
    expect(res).toEqual({ echo: 'ping', params: { n: 1 } });
  });

  it('rejects when the peer returns an error', async () => {
    const { a } = connectPeers(
      {},
      {
        onRequest: () => {
          throw Object.assign(new Error('nope'), { code: -32000 });
        },
      },
    );
    await expect(a.request('boom')).rejects.toMatchObject({ message: 'nope', code: -32000 });
  });

  it('delivers notifications to onNotification', async () => {
    const seen: Array<[string, unknown]> = [];
    const { a } = connectPeers({}, { onNotification: (m, p) => seen.push([m, p]) });
    a.notify('hello', { x: 1 });
    await new Promise((r) => setTimeout(r, 5));
    expect(seen).toEqual([['hello', { x: 1 }]]);
  });

  it('replies method-not-found when no request handler is registered', async () => {
    const { a } = connectPeers({}, {});
    await expect(a.request('anything')).rejects.toMatchObject({ code: -32601 });
  });

  it('times out a request and rejects', async () => {
    const peer = new JsonRpcPeer({ send: () => {}, requestTimeoutMs: 10 });
    await expect(peer.request('slow')).rejects.toThrow(/timed out/);
  });

  it('rejects in-flight requests on close', async () => {
    const peer = new JsonRpcPeer({ send: () => {} });
    const p = peer.request('x');
    peer.close('bye');
    await expect(p).rejects.toThrow(/bye/);
  });

  it('encodeMessage appends exactly one newline', () => {
    const line = encodeMessage({ jsonrpc: '2.0', method: 'm' });
    expect(line.endsWith('\n')).toBe(true);
    expect(line.indexOf('\n')).toBe(line.length - 1);
  });
});
