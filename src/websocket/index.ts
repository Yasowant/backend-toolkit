import type WebSocket from 'ws';
import type { ClientOptions, RawData } from 'ws';
/** Observable connection lifecycle. */
export type SocketState =
  'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';
/** Reliability policy for a Node.js ws client. Hooks are called once per connection attempt. */
export interface ReliableSocketOptions {
  url: string;
  reconnect?: boolean;
  maxRetries?: number;
  delayMs?: number;
  maxDelayMs?: number;
  jitter?: boolean;
  heartbeatInterval?: number;
  heartbeatTimeout?: number;
  connectionTimeout?: number;
  stableConnectionMs?: number;
  maxBufferedBytes?: number;
  maxPayloadBytes?: number;
  authenticate?: (
    signal: AbortSignal,
  ) => Promise<{ headers?: Record<string, string> }>;
  onConnect?: () => void | Promise<void>;
  onDisconnect?: (code: number) => void | Promise<void>;
  onReconnect?: (attempt: number, delayMs: number) => void | Promise<void>;
  onError?: (error: Error) => void;
  onMessage?: (data: RawData, isBinary: boolean) => void | Promise<void>;
  onStateChange?: (state: SocketState) => void | Promise<void>;
}
/** Managed socket. Subscription factories are evaluated on every successful connection. */
export interface ReliableSocket {
  readonly state: SocketState;
  connect(): Promise<void>;
  send(data: string | Buffer): Promise<void>;
  subscribe(key: string, message: () => string | Buffer): Promise<void>;
  unsubscribe(key: string, message?: string | Buffer): Promise<void>;
  close(): Promise<void>;
}
/** Create a lazy-starting, reconnecting WebSocket client. Install the optional ws peer to connect. */
export function createReliableSocket(
  options: ReliableSocketOptions,
): ReliableSocket {
  const parsed = new URL(options.url);
  if (
    !['ws:', 'wss:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password
  )
    throw new TypeError('url must use ws or wss without embedded credentials');
  const {
    reconnect = true,
    maxRetries = 10,
    delayMs = 250,
    maxDelayMs = 30000,
    jitter = true,
    heartbeatInterval = 30000,
    heartbeatTimeout = 10000,
    connectionTimeout = 10000,
    stableConnectionMs = 10000,
    maxBufferedBytes = 1048576,
    maxPayloadBytes = 1048576,
  } = options;
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0)
    throw new RangeError('maxRetries must be a non-negative safe integer');
  for (const [key, value] of Object.entries({
    delayMs,
    maxDelayMs,
    heartbeatInterval,
    heartbeatTimeout,
    connectionTimeout,
    stableConnectionMs,
    maxBufferedBytes,
    maxPayloadBytes,
  }))
    if (!Number.isSafeInteger(value) || value < 0 || value > 2147483647)
      throw new RangeError(`${key} must be a non-negative 32-bit integer`);
  if (
    connectionTimeout === 0 ||
    heartbeatTimeout === 0 ||
    maxPayloadBytes === 0
  )
    throw new RangeError(
      'connectionTimeout, heartbeatTimeout and maxPayloadBytes must be positive',
    );
  let state: SocketState = 'idle';
  let socket: WebSocket | undefined;
  let stopped = false;
  let generation = 0;
  let attempts = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let connectTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let pongTimer: ReturnType<typeof setTimeout> | undefined;
  let stableTimer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let initial: Promise<void> | undefined;
  let resolveInitial: (() => void) | undefined;
  let rejectInitial: ((error: Error) => void) | undefined;
  let closing: Promise<void> | undefined;
  const subscriptions = new Map<string, () => string | Buffer>();
  function report(error: unknown) {
    const safe =
      error instanceof Error
        ? error
        : new Error('WebSocket hook failed', { cause: error });
    if (options.onError) {
      try {
        options.onError(safe);
      } catch {
        process.emitWarning('WebSocket onError callback threw');
      }
    } else
      process.emitWarning(
        'WebSocket operation failed; provide onError for diagnostics',
      );
  }
  function notify(callback: (() => void | Promise<void>) | undefined) {
    if (callback) void Promise.resolve().then(callback).catch(report);
  }
  function setState(next: SocketState) {
    state = next;
    notify(
      options.onStateChange ? () => options.onStateChange!(next) : undefined,
    );
  }
  function clearConnectionTimers() {
    clearTimeout(connectTimer);
    clearInterval(heartbeat);
    clearTimeout(pongTimer);
    clearTimeout(stableTimer);
    pongTimer = undefined;
  }
  function failPending(error: Error) {
    rejectInitial?.(error);
    resolveInitial = undefined;
    rejectInitial = undefined;
    initial = undefined;
  }
  function finishAttempt(id: number, error?: Error, code = 1006) {
    if (id !== generation || stopped) return;
    if (state === 'open')
      notify(
        options.onDisconnect ? () => options.onDisconnect!(code) : undefined,
      );
    generation++;
    clearConnectionTimers();
    controller?.abort();
    socket?.terminate();
    socket = undefined;
    if (error) report(error);
    if (!reconnect || attempts >= maxRetries) {
      stopped = true;
      setState('closed');
      failPending(error ?? new Error('WebSocket reconnect attempts exhausted'));
      return;
    }
    const base = Math.min(maxDelayMs, delayMs * 2 ** Math.min(attempts, 30));
    const delay = jitter ? Math.random() * base : base;
    attempts++;
    setState('reconnecting');
    notify(
      options.onReconnect
        ? () => options.onReconnect!(attempts, delay)
        : undefined,
    );
    retryTimer = setTimeout(() => {
      void open();
    }, delay);
  }
  async function open() {
    if (stopped) return;
    const id = ++generation;
    setState('connecting');
    controller = new AbortController();
    connectTimer = setTimeout(
      () => finishAttempt(id, new Error('WebSocket connection timed out')),
      connectionTimeout,
    );
    try {
      const auth = await options.authenticate?.(controller.signal);
      if (id !== generation || stopped) return;
      const { default: Transport } = await import('ws');
      if (id !== generation || stopped) return;
      const config: ClientOptions = {
        headers: auth?.headers,
        handshakeTimeout: connectionTimeout,
        maxPayload: maxPayloadBytes,
        followRedirects: false,
      };
      const current = new Transport(options.url, config);
      socket = current;
      current.on('error', (error) => {
        finishAttempt(id, error);
      });
      current.on('close', (code) => {
        if (id !== generation || stopped) return;
        finishAttempt(id, undefined, code);
      });
      current.on('message', (data, binary) => {
        if (id === generation && !stopped)
          notify(
            options.onMessage
              ? () => options.onMessage!(data, binary)
              : undefined,
          );
      });
      current.on('pong', () => {
        clearTimeout(pongTimer);
        pongTimer = undefined;
      });
      current.on('open', () => {
        void (async () => {
          if (id !== generation || stopped) {
            current.terminate();
            return;
          }
          clearTimeout(connectTimer);
          setState('open');
          stableTimer = setTimeout(() => {
            attempts = 0;
          }, stableConnectionMs);
          if (heartbeatInterval > 0)
            heartbeat = setInterval(() => {
              if (pongTimer || current.readyState !== 1) return;
              pongTimer = setTimeout(
                () =>
                  finishAttempt(id, new Error('WebSocket heartbeat timed out')),
                heartbeatTimeout,
              );
              current.ping(undefined, undefined, (error) => {
                if (error) finishAttempt(id, error);
              });
            }, heartbeatInterval);
          for (const factory of subscriptions.values()) {
            if (id !== generation || stopped) return;
            await send(factory());
          }
          if (id !== generation || stopped) return;
          resolveInitial?.();
          resolveInitial = undefined;
          rejectInitial = undefined;
          initial = undefined;
          notify(options.onConnect);
        })().catch((error) =>
          finishAttempt(
            id,
            error instanceof Error
              ? error
              : new Error('Subscription failed', { cause: error }),
          ),
        );
      });
    } catch (error) {
      finishAttempt(
        id,
        error instanceof Error
          ? error
          : new Error('WebSocket connection failed', { cause: error }),
      );
    }
  }
  async function send(data: string | Buffer) {
    const current = socket;
    if (state !== 'open' || !current || current.readyState !== 1)
      throw new Error('WebSocket is not open');
    if (current.bufferedAmount + Buffer.byteLength(data) > maxBufferedBytes)
      throw new Error('WebSocket outbound buffer limit exceeded');
    await new Promise<void>((resolve, reject) =>
      current.send(data, (error) => (error ? reject(error) : resolve())),
    );
  }
  return {
    get state() {
      return state;
    },
    connect() {
      if (stopped)
        return Promise.reject(new Error('WebSocket client is closed'));
      if (state === 'open') return Promise.resolve();
      if (initial) return initial;
      initial = new Promise<void>((resolve, reject) => {
        resolveInitial = resolve;
        rejectInitial = reject;
      });
      if (state === 'idle') void open();
      return initial;
    },
    send,
    async subscribe(key, message) {
      subscriptions.set(key, message);
      if (state === 'open') await send(message());
    },
    async unsubscribe(key, message) {
      subscriptions.delete(key);
      if (message !== undefined && state === 'open') await send(message);
    },
    close() {
      if (closing) return closing;
      stopped = true;
      generation++;
      controller?.abort();
      clearTimeout(retryTimer);
      clearConnectionTimers();
      subscriptions.clear();
      setState('closed');
      failPending(new Error('WebSocket closed before connection completed'));
      const current = socket;
      socket = undefined;
      closing = new Promise<void>((resolve) => {
        if (!current || current.readyState === 3) {
          resolve();
          return;
        }
        const timer = setTimeout(() => {
          current.terminate();
          resolve();
        }, 1000);
        current.once('close', () => {
          clearTimeout(timer);
          resolve();
        });
        if (current.readyState === 1) current.close(1000, 'Client shutdown');
        else current.terminate();
      });
      return closing;
    },
  };
}
