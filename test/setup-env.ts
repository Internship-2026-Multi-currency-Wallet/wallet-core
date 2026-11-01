// Defaults for e2e runs: the local docker-compose MySQL/Redis and dev auth on.
process.env.NODE_ENV ??= 'test';
process.env.DEV_AUTH ??= 'true';
process.env.DATABASE_URL ??= 'mysql://wallet:wallet@localhost:3306/wallet_core';
process.env.REDIS_URL ??= 'redis://localhost:6379';
