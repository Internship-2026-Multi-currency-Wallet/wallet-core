import { z } from 'zod';
import { UserKind } from './user-kind.js';

export const TOKEN_AUDIENCES = ['wallet', 'backoffice'] as const;
export type TokenAudience = (typeof TOKEN_AUDIENCES)[number];

/** The only place that turns `aud` into a kind, so every strategy agrees. */
export const KIND_BY_AUDIENCE: Record<TokenAudience, UserKind> = {
  wallet: UserKind.CLIENT,
  backoffice: UserKind.STAFF,
};

export interface AccessTokenPayload {
  sub: string;
  aud: TokenAudience;
  permissions: string[];
  iss: string;
  iat: number;
  exp: number;
}

export const accessTokenPayloadSchema = z.object({
  sub: z.uuid(),
  aud: z.enum(TOKEN_AUDIENCES),
  permissions: z.array(z.string().min(1)),
  iss: z.string().min(1),
  iat: z.int(),
  exp: z.int(),
}) satisfies z.ZodType<AccessTokenPayload>;
