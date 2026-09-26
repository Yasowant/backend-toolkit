import { it, expect, vi, afterEach } from 'vitest';
import { WebSocketServer } from 'ws';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import {
  createReliableSocket,
  type ReliableSocket,
} from '../src/websocket/index.js';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function server(
  options: ConstructorParameters<typeof WebSocketServer>[0] = {},
) {
  const server = new WebSocketServer({
    port: 0,
    host: '127.0.0.1',
    ...options,
  });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        for (const client of server.clients) client.terminate();
        server.close(() => resolve());
      }),
  );
  return {
    server,
    url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
  };
}
function track(client: ReliableSocket) {
  cleanup.push(() => client.close());
  return client;
}
async function until(check: () => boolean, timeout = 3000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error('Condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
it('connects, sends and receives messages, and shuts down', async () => {
  const { server: ws, url } = await server();
  ws.on('connection', (socket) =>
    socket.on('message', (data) => socket.send(data)),
  );
  const onMessage = vi.fn();
  const client = track(
    createReliableSocket({ url, onMessage, heartbeatInterval: 0 }),
  );
  expect(client.state).toBe('idle');
  await expect(client.send('early')).rejects.toThrow('not open');
  await client.connect();
  await client.send('hello');
  await until(() => onMessage.mock.calls.length === 1);
  expect(onMessage.mock.calls[0]?.[0].toString()).toBe('hello');
  await client.close();
  expect(client.state).toBe('closed');
  await expect(client.connect()).rejects.toThrow('closed');
});
it('refreshes auth and re-subscribes after disconnect', async () => {
  const { server: ws, url } = await server();
  const messages: string[] = [];
  const headers: (string | undefined)[] = [];
  ws.on('connection', (socket, req) => {
    headers.push(req.headers.authorization);
    socket.on('message', (data) => messages.push(data.toString()));
  });
  const auth = vi.fn(async () => ({
    headers: { authorization: `Bearer token-${headers.length}` },
  }));
  const disconnect = vi.fn();
  const reconnect = vi.fn();
  const client = track(
    createReliableSocket({
      url,
      authenticate: auth,
      onDisconnect: disconnect,
      onReconnect: reconnect,
      delayMs: 5,
      jitter: false,
      heartbeatInterval: 0,
    }),
  );
  await client.subscribe('users', () => 'subscribe users');
  await client.connect();
  await until(() => messages.length === 1);
  for (const socket of ws.clients) socket.terminate();
  await until(() => messages.length === 2);
  expect(headers).toEqual(['Bearer token-0', 'Bearer token-1']);
  expect(auth).toHaveBeenCalledTimes(2);
  expect(disconnect).toHaveBeenCalledTimes(1);
  expect(reconnect).toHaveBeenCalledTimes(1);
  await client.unsubscribe('users', 'unsubscribe users');
  await until(() => messages.length === 3);
  for (const socket of ws.clients) socket.terminate();
  await until(() => headers.length === 3);
  await client.connect();
  expect(messages).toHaveLength(3);
});
it('bounds reconnects even when peers repeatedly accept then disconnect', async () => {
  const { server: ws, url } = await server();
  let connections = 0;
  ws.on('connection', (socket) => {
    connections++;
    setTimeout(() => socket.terminate(), 5);
  });
  const client = track(
    createReliableSocket({
      url,
      delayMs: 1,
      jitter: false,
      maxRetries: 2,
      stableConnectionMs: 10000,
      heartbeatInterval: 0,
      onError: vi.fn(),
    }),
  );
  await client.connect();
  await until(() => client.state === 'closed');
  expect(connections).toBe(3);
});
it('detects missing heartbeat pong and stops when reconnect is disabled', async () => {
  const { url } = await server({ autoPong: false });
  const error = vi.fn();
  const client = track(
    createReliableSocket({
      url,
      reconnect: false,
      heartbeatInterval: 5,
      heartbeatTimeout: 10,
      onError: error,
    }),
  );
  await client.connect();
  await until(() => client.state === 'closed');
  expect(error.mock.calls[0]?.[0].message).toContain('heartbeat');
});
it('accepts heartbeat pong and enforces outbound limits', async () => {
  const { url } = await server();
  const client = track(
    createReliableSocket({
      url,
      heartbeatInterval: 5,
      heartbeatTimeout: 50,
      maxBufferedBytes: 4,
    }),
  );
  await client.connect();
  await expect(client.send('too long')).rejects.toThrow('buffer limit');
  await new Promise((resolve) => setTimeout(resolve, 65));
  expect(client.state).toBe('open');
});
it('times out stalled authentication and cancels late completion', async () => {
  let release: (value: { headers: Record<string, string> }) => void = () => {};
  const error = vi.fn();
  const client = track(
    createReliableSocket({
      url: 'ws://127.0.0.1:1',
      connectionTimeout: 10,
      reconnect: false,
      onError: error,
      authenticate: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    }),
  );
  await expect(client.connect()).rejects.toThrow('timed out');
  release({ headers: {} });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(client.state).toBe('closed');
});
it('close aborts pending authentication and prevents opening', async () => {
  let signal: AbortSignal | undefined;
  const client = track(
    createReliableSocket({
      url: 'ws://127.0.0.1:1',
      authenticate: async (s) => {
        signal = s;
        return new Promise(() => {});
      },
    }),
  );
  const pending = client.connect();
  const assertion = expect(pending).rejects.toThrow('closed');
  await client.close();
  await assertion;
  expect(signal?.aborted).toBe(true);
});
it('reports authentication failure and bounded attempts', async () => {
  const auth = vi.fn(async () => {
    throw new Error('auth unavailable');
  });
  const client = track(
    createReliableSocket({
      url: 'ws://127.0.0.1:1',
      authenticate: auth,
      maxRetries: 1,
      delayMs: 1,
      jitter: false,
      onError: vi.fn(),
    }),
  );
  await expect(client.connect()).rejects.toThrow('auth unavailable');
  expect(auth).toHaveBeenCalledTimes(2);
});
it('times out a server that never completes handshake', async () => {
  const net = createServer();
  const sockets = new Set<import('node:net').Socket>();
  net.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => net.listen(0, '127.0.0.1', resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        net.close(() => resolve());
      }),
  );
  const client = track(
    createReliableSocket({
      url: `ws://127.0.0.1:${(net.address() as AddressInfo).port}`,
      connectionTimeout: 20,
      reconnect: false,
      onError: vi.fn(),
    }),
  );
  await expect(client.connect()).rejects.toThrow(/timed out/);
});
it('validates options', () => {
  for (const url of ['https://example.com', 'ws://user:pass@example.com'])
    expect(() => createReliableSocket({ url })).toThrow();
  expect(() =>
    createReliableSocket({ url: 'ws://example.com', maxRetries: -1 }),
  ).toThrow();
  expect(() =>
    createReliableSocket({ url: 'ws://example.com', connectionTimeout: 0 }),
  ).toThrow();
});
