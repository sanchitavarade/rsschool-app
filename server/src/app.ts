import cors from '@koa/cors';
import Koa from 'koa';
import bodyParser from 'koa-bodyparser';
import serve from 'koa-static';
import koaJwt from 'koa-jwt';
import Router from 'koa-router';
import { v4 as uuid } from 'uuid';

import { config } from './config';
import { ILogger, loggerMiddleware, createDefaultLogger } from './logger';

import { routesMiddleware, routeLoggerMiddleware } from './routes';
import { startBackgroundJobs } from './schedule';
import { dataSourceOptions } from './dataSourceOptions';
import { createConnection } from 'typeorm';

/**
 * Middleware: Request ID
 */
const requestIdMiddleware: Koa.Middleware = async (ctx, next) => {
  ctx.state.requestId = ctx.get('X-Request-Id') || uuid();
  ctx.set('X-Request-Id', ctx.state.requestId);
  await next();
};

/**
 * Middleware: Error Handler
 */
const errorHandler: Koa.Middleware = async (ctx, next) => {
  try {
    await next();
  } catch (err: any) {
    ctx.status = err.status || 500;
    ctx.body = {
      error: err.message || 'Internal Server Error',
      requestId: ctx.state.requestId,
    };
    ctx.app.emit('error', err, ctx);
  }
};

/**
 * Health Routes
 */
function healthRoutes() {
  const router = new Router({ prefix: '/health' });

  router.get('/live', async ctx => {
    ctx.body = { status: 'ok', message: 'Service is alive' };
  });

  router.get('/ready', async ctx => {
    ctx.body = { status: 'ok', message: 'Service is ready' };
  });

  return router;
}

export class App {
  public koa = new Koa();
  private appLogger: ILogger;

  constructor(logger: ILogger = createDefaultLogger()) {
    this.appLogger = logger;

    // Order of middlewares matters
    this.koa.use(requestIdMiddleware);
    this.koa.use(errorHandler);
    this.koa.use(loggerMiddleware(this.appLogger));

    this.koa.use(bodyParser({ jsonLimit: '20mb', enableTypes: ['json', 'form', 'text'] }));

    if (process.env.NODE_ENV === 'production') {
      this.koa.use(cors({ credentials: true, allowMethods: '*', origin: config.host }));
    }

    this.koa.use(
      koaJwt({ key: 'user', cookie: 'auth-token', secret: config.sessionKey, debug: true, passthrough: true }),
    );

    process.on('unhandledRejection', reason => this.appLogger.error(reason as any));

    // Graceful shutdown signals
    ['SIGINT', 'SIGTERM'].forEach(signal => {
      process.on(signal, () => this.shutdown());
    });
  }

  public start(listen = false) {
    const routes = routesMiddleware(this.appLogger);

    // Public routes
    this.koa.use(routes.publicRouter.routes());
    this.koa.use(routes.publicRouter.allowedMethods());

    // Health routes
    this.koa.use(healthRoutes().routes());
    this.koa.use(healthRoutes().allowedMethods());

    // Route logger
    this.koa.use(routeLoggerMiddleware);

    // Static files
    this.koa.use(serve('public'));

    if (listen) {
      this.koa.listen(config.port);
      this.appLogger.info(`Service is running on ${config.port} port`);
    }
    return this.koa;
  }

  public async pgConnect(): Promise<boolean> {
    const logger = this.appLogger.child({ module: 'db' });
    const connection = await createConnection(dataSourceOptions);
    logger.info('Connected to Postgres');

    logger.info('Executing migrations...');
    await connection.runMigrations();
    logger.info('Migrations executed successfully');

    return true;
  }

  public async startBackgroundJobs() {
    if (process.env.NODE_ENV !== 'production') {
      return Promise.resolve();
    }
    return startBackgroundJobs(this.appLogger.child({ module: 'schedule' }));
  }

  private async shutdown() {
    this.appLogger.info('Shutting down gracefully...');
    process.exit(0);
  }
}
