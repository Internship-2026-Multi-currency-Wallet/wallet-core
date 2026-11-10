// CommonJS @nestjs/throttler requires the ESM Nest packages, which Jest rejects as a require cycle unless they are already loaded.
await import('@nestjs/common');
await import('@nestjs/core');

export {};
