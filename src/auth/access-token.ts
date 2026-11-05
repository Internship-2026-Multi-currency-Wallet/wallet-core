import { z } from 'zod';

export interface AccessTokenPayload {
  sub: string;
  permissions: string[];
  iss: string;
  iat: number;
  exp: number;
}

export const accessTokenPayloadSchema = z.object({
  sub: z.uuid(),
  permissions: z.array(z.string().min(1)),
  iss: z.string().min(1),
  iat: z.int(),
  exp: z.int(),
}) satisfies z.ZodType<AccessTokenPayload>;
