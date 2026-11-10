import type { NestExpressApplication } from '@nestjs/platform-express';

// Exactly one reverse proxy (Traefik) sits in front, so trust only the last X-Forwarded-For entry; `true` would let a client spoof its IP.
const TRUSTED_PROXY_HOPS = 1;

/** App setup shared by `main.ts` and the e2e `createApp`, so tests see the same behaviour as production. */
export function configureApp(app: NestExpressApplication): void {
  app.set('trust proxy', TRUSTED_PROXY_HOPS);
}
