import {
  createReliableSocket,
  createLogger,
  validateEnv,
  env,
} from '../src/index.js';
const config = validateEnv({ WS_URL: env.string });
const logger = createLogger();
const socket = createReliableSocket({
  url: config.WS_URL,
  maxRetries: 10,
  onConnect: () => logger.log('info', 'Connected'),
  onReconnect: (attempt, delayMs) =>
    logger.log('info', 'Reconnecting', { attempt, delayMs }),
  onError: () => logger.log('error', 'Socket failed'),
  onMessage: (data) =>
    logger.log('info', 'Message received', {
      bytes:
        data instanceof ArrayBuffer
          ? data.byteLength
          : Array.isArray(data)
            ? data.reduce((sum, buffer) => sum + buffer.length, 0)
            : data.length,
    }),
});
await socket.subscribe('events', () =>
  JSON.stringify({ type: 'subscribe', channel: 'events' }),
);
process.once('SIGINT', () => {
  void socket.close();
});
await socket.connect();
