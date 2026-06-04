import { describe, it, expect } from 'vitest';
import { AcpSession } from '../../../../src/bridge/acp/client.js';
import { JsonRpcPeer } from '../../../../src/bridge/acp/jsonrpc.js';
import { StateAggregator, type LightState } from '../../../../src/daemon/state.js';
import type { WireEvent } from '../../../../src/bridge/acp/translate.js';

/**
 * Drive a real AcpSession against an in-memory fake ACP agent and feed the
 * translated events into a real StateAggregator, asserting the resolved
 * LightState sequence. This is the end-to-end check the plan calls for.
 */
describe('ACP session → aggregator integration', () => {
  function harness(agentOnRequest: (peer: JsonRpcPeer, method: string, params: unknown) => unknown) {
    let clock = 1000;
    const now = () => clock;

    const aggregator = new StateAggregator({ now });
    const events: WireEvent[] = [];
    const states: LightState[] = [];
    const emit = (e: WireEvent): void => {
      events.push(e);
      aggregator.apply({ event: e.event, sessionId: e.sessionId, ts: e.ts, toolName: e.toolName, cwd: e.cwd });
      states.push(aggregator.resolve());
    };

    // session.send → agent.receive ; agent.send → session.receive (synchronous).
    const peers: { agent?: JsonRpcPeer } = {};
    const session = new AcpSession({
      send: (line) => peers.agent!.receive(JSON.parse(line)),
      emit,
      cwd: '/work',
      now,
    });
    peers.agent = new JsonRpcPeer({
      send: (line) => session.receive(JSON.parse(line)),
      onRequest: (method, params) => agentOnRequest(peers.agent!, method, params),
    });

    return { session, agent: peers.agent, aggregator, events, states, advance: (ms: number) => (clock += ms), now };
  }

  it('runs a tool-using turn: ready → thinking → done → ready', async () => {
    const { session, aggregator, events, states, advance } = harness((peer, method) => {
      if (method === 'initialize') return { protocolVersion: 1 };
      if (method === 'session/new') return { sessionId: 'sess-1' };
      if (method === 'session/prompt') {
        peer.notify('session/update', {
          sessionId: 'sess-1',
          update: { sessionUpdate: 'tool_call', toolCallId: 't1', status: 'in_progress', title: 'bash' },
        });
        peer.notify('session/update', {
          sessionId: 'sess-1',
          update: { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' },
        });
        return { stopReason: 'end_turn' };
      }
      return {};
    });

    const id = await session.initialize();
    expect(id).toBe('sess-1');
    expect(aggregator.resolve()).toBe('ready'); // SessionStart only

    const stopReason = await session.prompt('do a thing');
    expect(stopReason).toBe('end_turn');

    // Authoritative event order, no leaked PreMcpToolCall, balanced tool counters.
    expect(events.map((e) => e.event)).toEqual([
      'SessionStart',
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'Stop',
    ]);

    // The light was thinking during the turn and resolved to done at Stop.
    expect(states).toContain('thinking');
    expect(states[states.length - 1]).toBe('done');

    // After the done TTL elapses it settles back to ready.
    advance(5000);
    expect(aggregator.resolve()).toBe('ready');
  });

  it('surfaces permission requests and answers via the responder', async () => {
    const clock = 1000;
    const aggregator = new StateAggregator({ now: () => clock });
    const events: WireEvent[] = [];
    const emit = (e: WireEvent): void => {
      events.push(e);
      aggregator.apply({ event: e.event, sessionId: e.sessionId, ts: e.ts, toolName: e.toolName });
    };

    const peers: { agent?: JsonRpcPeer } = {};
    let answered: unknown = null;
    const session = new AcpSession({
      send: (line) => peers.agent!.receive(JSON.parse(line)),
      emit,
      cwd: '/work',
      now: () => clock,
      permissionResponder: () => ({ outcome: 'selected', optionId: 'allow' }),
    });
    peers.agent = new JsonRpcPeer({
      send: (line) => session.receive(JSON.parse(line)),
      onRequest: (method) => {
        if (method === 'initialize') return { protocolVersion: 1 };
        if (method === 'session/new') return { sessionId: 'sess-1' };
        if (method === 'session/prompt') {
          // Ask the client (us) for permission mid-turn, then finish.
          return peers.agent!
            .request('session/request_permission', {
              sessionId: 'sess-1',
              toolCall: { title: 'shell' },
              options: [{ optionId: 'allow', name: 'Allow' }, { optionId: 'deny', name: 'Deny' }],
            })
            .then((outcome) => {
              answered = outcome;
              return { stopReason: 'end_turn' };
            });
        }
        return {};
      },
    });

    await session.initialize();
    await session.prompt('rm -rf something');

    expect(events.map((e) => e.event)).toContain('PermissionRequest');
    expect(answered).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } });
  });

  it('emits ErrorOccurred + Stop when the prompt request fails', async () => {
    const { session, events } = harness((_peer, method) => {
      if (method === 'initialize') return { protocolVersion: 1 };
      if (method === 'session/new') return { sessionId: 'sess-1' };
      if (method === 'session/prompt') throw new Error('agent exploded');
      return {};
    });

    await session.initialize();
    const stopReason = await session.prompt('boom');
    expect(stopReason).toBe('error');
    expect(events.map((e) => e.event)).toEqual(['SessionStart', 'UserPromptSubmit', 'ErrorOccurred', 'Stop']);
  });
});
