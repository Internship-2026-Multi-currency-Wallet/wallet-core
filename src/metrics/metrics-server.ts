import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { AppConfig } from '../config/app-config.js';
import { Metrics } from './metrics.js';

@Injectable()
export class MetricsServer implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly server = createServer((req, res) => void this.handle(req, res));

  constructor(
    @Inject(Metrics) private readonly metrics: Metrics,
    @Inject(AppConfig) private readonly config: AppConfig,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
  ) {
    logger.setContext(MetricsServer.name);
  }

  get port(): number | undefined {
    const address = this.server.address();
    return typeof address === 'object' && address ? address.port : undefined;
  }

  onApplicationBootstrap(): Promise<void> {
    return new Promise((resolve) => {
      this.server.once('error', (err) => {
        this.logger.error(
          { err, port: this.config.metricsPort },
          'Metrics server did not start; /metrics is unavailable (set another METRICS_PORT)',
        );
        resolve();
      });
      this.server.listen(this.config.metricsPort, this.config.metricsHost, () => {
        this.logger.info(
          { host: this.config.metricsHost, port: this.port },
          `Metrics on ${this.config.metricsHost}:${this.port}/metrics`,
        );
        resolve();
      });
    });
  }

  onApplicationShutdown(): Promise<void> {
    if (!this.server.listening) return Promise.resolve();
    return new Promise((resolve) => {
      this.server.close(() => resolve());
      this.server.closeAllConnections();
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'GET' || req.url?.split('?')[0] !== '/metrics') {
      res.writeHead(404).end();
      return;
    }
    try {
      const body = await this.metrics.registry.metrics();
      res.writeHead(200, { 'content-type': this.metrics.registry.contentType }).end(body);
    } catch (err) {
      this.logger.error({ err }, 'Collecting metrics failed');
      res.writeHead(500).end();
    }
  }
}
