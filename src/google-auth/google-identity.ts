export const GOOGLE_IDENTITY_VERIFIER = Symbol('GOOGLE_IDENTITY_VERIFIER');

export interface GoogleAuthCode {
  code: string;
  redirectUri: string;
  codeVerifier?: string;
}

export interface GoogleIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
  nonce: string | undefined;
}

export interface GoogleIdentityVerifier {
  /** Throws `InvalidGoogleCodeError` only when Google refuses the code; other errors are outages. */
  verify(code: GoogleAuthCode): Promise<GoogleIdentity>;
}

export class InvalidGoogleCodeError extends Error {
  override readonly name = 'InvalidGoogleCodeError';
}
