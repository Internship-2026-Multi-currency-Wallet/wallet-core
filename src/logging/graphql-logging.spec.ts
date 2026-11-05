import { Writable } from 'node:stream';
import { GraphQLError, buildSchema, graphql } from 'graphql';
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
  path?: string;
  err?: { type: string; message: string; stack: string };
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

describe('graphqlLoggingPlugin, a resolver returning a wrong type', () => {
  const schema = buildSchema(
    'enum Role { CLIENT } type Query { email: String, count: Int, role: Role }',
  );
  const user = { email: 'user@example.com', passwordHash: 'secret-hash' };

  /** The error GraphQL itself raises for the field, as Apollo passes it to the plugin. */
  async function coercionError(field: string, value: unknown): Promise<GraphQLError> {
    const { errors = [] } = await graphql({
      schema,
      source: `{ ${field} }`,
      rootValue: { [field]: value },
    });
    expect(errors).toHaveLength(1);
    return errors[0];
  }

  it.each([
    ['email', user, 'secret-hash', 'String cannot represent value: [REDACTED]'],
    ['count', 1.5, '1.5', 'Int cannot represent non-integer value: [REDACTED]'],
    ['role', 'secret-role', 'secret-role', 'Enum "Role" cannot represent value: [REDACTED]'],
  ])('hides the value returned for %s', async (field, value, secret, message) => {
    const line = await logError(await coercionError(field, value));
    expect(line).toMatchObject({
      level: 'error',
      code: 'INTERNAL_SERVER_ERROR',
      path: field,
      msg: `GraphQL error: ${message}`,
      err: { type: 'GraphQLError', message },
    });
    const [firstLine, ...frames] = line.err?.stack.split('\n') ?? [];
    expect(firstLine).toBe(`GraphQLError: ${message}`);
    expect(frames[0]).toMatch(/^\s+at /);
    expect(JSON.stringify(line)).not.toContain(secret);
  });

  it('does not change the error itself, which formatError gets next', async () => {
    const error = await coercionError('email', user);
    await logError(error);
    expect(error.message).toContain('secret-hash');
    expect(error.originalError?.stack).toContain('secret-hash');
  });
});
