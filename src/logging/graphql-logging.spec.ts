import { Writable } from 'node:stream';
import { GraphQLError } from 'graphql';
import { pino } from 'pino';
import { type GraphqlLoggingOptions, graphqlLoggingPlugin } from './graphql-logging.js';

type Plugin = ReturnType<typeof graphqlLoggingPlugin>;
type StartContext = Parameters<NonNullable<Plugin['requestDidStart']>>[0];
type Listener = Exclude<Awaited<ReturnType<NonNullable<Plugin['requestDidStart']>>>, void>;
type ErrorsContext = Parameters<NonNullable<Listener['didEncounterErrors']>>[0];

interface LogLine {
  level: string;
  msg: string;
  code?: string;
  err?: { message: string; stack: string };
}

/** Runs the plugin's error hook on one error and returns the JSON line it logged. */
async function logError(error: GraphQLError, options?: GraphqlLoggingOptions): Promise<LogLine> {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      lines.push(chunk.toString());
      done();
    },
  });
  const log = pino({ formatters: { level: (label) => ({ level: label }) } }, stream);

  const listener = await graphqlLoggingPlugin(options).requestDidStart?.({} as StartContext);
  await listener?.didEncounterErrors?.({
    contextValue: { req: { log } },
    errors: [error],
    operationName: 'Login',
  } as unknown as ErrorsContext);

  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]) as LogLine;
}

const withCode = (code: string) =>
  new GraphQLError('Invalid email or password', { extensions: { code } });

describe('graphqlLoggingPlugin', () => {
  it('logs a built-in client code as warn, without err', async () => {
    const line = await logError(withCode('UNAUTHENTICATED'));
    expect(line).toMatchObject({ level: 'warn', code: 'UNAUTHENTICATED' });
    expect(line.err).toBeUndefined();
  });

  it('logs a passed business code as warn, without err', async () => {
    const line = await logError(withCode('INVALID_CREDENTIALS'), {
      clientErrorCodes: ['INVALID_CREDENTIALS'],
    });
    expect(line).toMatchObject({
      level: 'warn',
      code: 'INVALID_CREDENTIALS',
      msg: 'GraphQL error: Invalid email or password',
    });
    expect(line.err).toBeUndefined();
  });

  it('logs a business code as error when the service did not pass it', async () => {
    const line = await logError(withCode('INVALID_CREDENTIALS'));
    expect(line).toMatchObject({ level: 'error', code: 'INVALID_CREDENTIALS' });
    expect(line.err?.stack).toEqual(expect.any(String));
  });

  it('logs an unknown code as error with the stack', async () => {
    const line = await logError(withCode('SOMETHING_BROKE'), {
      clientErrorCodes: ['INVALID_CREDENTIALS'],
    });
    expect(line).toMatchObject({ level: 'error', code: 'SOMETHING_BROKE' });
    expect(line.err?.stack).toEqual(expect.any(String));
  });

  it('logs an error without a code as INTERNAL_SERVER_ERROR with the stack', async () => {
    const original = new Error('connect ECONNREFUSED');
    const line = await logError(
      new GraphQLError('connect ECONNREFUSED', { originalError: original }),
      {
        clientErrorCodes: ['INVALID_CREDENTIALS'],
      },
    );
    expect(line).toMatchObject({ level: 'error', code: 'INTERNAL_SERVER_ERROR' });
    expect(line.err).toMatchObject({ message: 'connect ECONNREFUSED', stack: original.stack });
  });
});
