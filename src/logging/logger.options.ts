/**
 * Logger configuration shared by the HTTP logger, GraphQL hooks and tests.
 * This file is IDENTICAL in wallet-core, rates-service and treasury-service.
 *
 * Every line is one JSON object with `time`, `level` (label), `service`, `appEnv`, `client`,
 * `msg`, plus `requestId` inside a request / event handler and `context` (class name).
 */
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { pino, type LoggerOptions } from 'pino';
import type { Options as HttpLoggerOptions } from 'pino-http';

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface LoggerSettings {
  service: string;
  appEnv: string;
  client: string;
  level: LogLevel;
  /** Human-readable output (pino-pretty). Local development only. */
  pretty: boolean;
}

/** Header that carries the request id in and out (case-insensitive). */
export const REQUEST_ID_HEADER = 'x-request-id';

/** Field names whose values are never logged, at any of the first four nesting levels. */
export const SECRET_KEYS = [
  'authorization',
  'Authorization',
  'cookie',
  'Cookie',
  'set-cookie',
  'password',
  'passwd',
  'newPassword',
  'token',
  'accessToken',
  'refreshToken',
  'idToken',
  'secret',
  'clientSecret',
  'webhookSecret',
  'apiKey',
  'api_key',
  'x-api-key',
  'privateKey',
  'databaseUrl',
  'DATABASE_URL',
  'redisUrl',
  'REDIS_URL',
];

const key = (name: string): string =>
  /^[A-Za-z_$][\w$]*$/.test(name) ? `.${name}` : `["${name}"]`;

/** pino `redact` paths: `password`, `*.password`, `*.*.password`, `*.*.*.password`, … */
export const REDACT_PATHS: string[] = SECRET_KEYS.flatMap((name) =>
  ['', '*', '*.*', '*.*.*'].map((prefix) =>
    prefix ? `${prefix}${key(name)}` : key(name).replace(/^\./, ''),
  ),
);

export const REDACTED = '[REDACTED]';

/** Root pino options: base fields, level labels, ISO time, redaction, pretty output locally. */
export function loggerOptions(settings: LoggerSettings): LoggerOptions {
  return {
    level: settings.level,
    base: { service: settings.service, appEnv: settings.appEnv, client: settings.client },
    messageKey: 'msg',
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    redact: { paths: REDACT_PATHS, censor: REDACTED },
    serializers: { err: pino.stdSerializers.err },
    ...(settings.pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: { singleLine: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' },
          },
        }
      : {}),
  };
}

const VALID_REQUEST_ID = /^[\w.:-]{1,128}$/;

/** The incoming `x-request-id` when it is a sane token, otherwise a new UUID. */
export function requestIdFrom(headers: Record<string, unknown> | undefined): string {
  const raw = headers?.[REQUEST_ID_HEADER];
  const value: unknown = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && VALID_REQUEST_ID.test(value) ? value : randomUUID();
}

/** What the GraphQL plugin stores on the request for the access log line. */
export interface GraphqlOperationInfo {
  type: string;
  name: string | null;
}

type LoggedRequest = IncomingMessage & {
  id?: unknown;
  originalUrl?: string;
  graphqlOperation?: GraphqlOperationInfo;
};

function pathOf(req: LoggedRequest): string {
  return (req.originalUrl ?? req.url ?? '').split('?')[0];
}

function operationOf(req: LoggedRequest): string | undefined {
  const op = req.graphqlOperation;
  return op ? `${op.type} ${op.name ?? '(anonymous)'}` : undefined;
}

/** Health probes run every few seconds; log them only at `debug` unless they fail. */
const QUIET_PATHS = new Set(['/health']);

/**
 * pino-http options: request id in/out, one access line per request without bodies or headers:
 * `{ method, path, operation?, status, durationMs }`.
 */
export function httpLoggerOptions(settings: LoggerSettings): HttpLoggerOptions {
  return {
    ...loggerOptions(settings),
    genReqId: (req: IncomingMessage, res: ServerResponse) => {
      const r = req as LoggedRequest;
      const id = typeof r.id === 'string' ? r.id : requestIdFrom(req.headers);
      res.setHeader(REQUEST_ID_HEADER, id);
      return id;
    },
    // Request-scoped loggers carry only `requestId` (no serialized request on every line).
    quietReqLogger: true,
    quietResLogger: true,
    customAttributeKeys: { reqId: 'requestId', responseTime: 'durationMs' },
    customLogLevel: (req, res, err) => {
      if (err || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return QUIET_PATHS.has(pathOf(req)) ? 'debug' : 'info';
    },
    customSuccessObject: (req, res, val: { durationMs?: number }) => ({
      method: req.method,
      path: pathOf(req),
      operation: operationOf(req),
      status: res.statusCode,
      durationMs: val.durationMs,
    }),
    customErrorObject: (req, res, err, val: { durationMs?: number }) => ({
      method: req.method,
      path: pathOf(req),
      operation: operationOf(req),
      status: res.statusCode,
      durationMs: val.durationMs,
      err,
    }),
    customSuccessMessage: (req, res, responseTime) =>
      [req.method, pathOf(req as LoggedRequest), operationOf(req as LoggedRequest), res.statusCode]
        .filter(Boolean)
        .join(' ') + ` ${responseTime}ms`,
    customErrorMessage: (req, res) =>
      [req.method, pathOf(req as LoggedRequest), operationOf(req as LoggedRequest), res.statusCode]
        .filter(Boolean)
        .join(' ') + ' failed',
  };
}
