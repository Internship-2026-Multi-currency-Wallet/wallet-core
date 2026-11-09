// @nestjs/throttler is CommonJS and requires the ESM @nestjs/common and @nestjs/core; Jest rejects
// that as a require cycle unless they are already evaluated.
await import('@nestjs/common');
await import('@nestjs/core');

export {};
