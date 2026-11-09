import type { NestExpressApplication } from '@nestjs/platform-express';

// The backends run behind exactly one reverse proxy (Traefik), so the client IP is the last
// X-Forwarded-For entry. `true` would trust the whole header and let a client spoof its IP.
const TRUSTED_PROXY_HOPS = 1;

/** App setup shared by `main.ts` and the e2e `createApp`, so tests see the same behaviour as production. */
export function configureApp(app: NestExpressApplication): void {
  app.set('trust proxy', TRUSTED_PROXY_HOPS);
}
