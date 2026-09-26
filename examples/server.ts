import express from 'express';
import {
  ApiResponse,
  asyncHandler,
  errorHandler,
  requestId,
  validateEnv,
  env,
  createShutdown,
  createLogger,
} from '../src/index.js';
const config = validateEnv({ PORT: env.default(env.number, 3000) });
const logger = createLogger();
const app = express();
app.use(requestId());
app.get(
  '/health',
  asyncHandler(async (_req, res) => {
    res.json(ApiResponse.success({ status: 'ok' }));
  }),
);
app.use(errorHandler());
const server = app.listen(config.PORT, () =>
  logger.log('info', 'Server listening', { port: config.PORT }),
);
createShutdown({
  server,
  onError: () => {
    logger.log('error', 'Shutdown failed');
    process.exitCode = 1;
  },
});
