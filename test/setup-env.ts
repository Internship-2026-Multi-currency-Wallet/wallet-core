// Defaults for e2e runs: the local docker-compose MySQL/Redis and dev auth on.
process.env.NODE_ENV ??= 'test';
process.env.DEV_AUTH ??= 'true';
process.env.DATABASE_URL ??= 'mysql://wallet:wallet@localhost:3306/wallet_core';
process.env.REDIS_URL ??= 'redis://localhost:6379';
// E2e files share one Redis and one IP, so the default limits would make them flaky; throttling.e2e-spec.ts sets its own.
process.env.THROTTLE_LIMIT_ANONYMOUS ??= '100000';
process.env.THROTTLE_LIMIT_USER ??= '100000';
// Never send real or SMTP email from tests.
process.env.EMAIL_TRANSPORT ??= 'fake';
// The JSON access log would flood the test output; set LOG_LEVEL=info to see it.
process.env.LOG_LEVEL ??= 'silent';
