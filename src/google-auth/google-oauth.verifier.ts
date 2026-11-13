import { OAuth2Client } from 'google-auth-library';
import {
  type GoogleAuthCode,
  type GoogleIdentity,
  type GoogleIdentityVerifier,
  InvalidGoogleCodeError,
} from './google-identity.js';

const GOOGLE_TIMEOUT_MS = 10_000;

export class GoogleOAuthVerifier implements GoogleIdentityVerifier {
  constructor(
    private readonly clientId: string,
    private readonly client: OAuth2Client,
  ) {}

  static create(clientId: string, clientSecret: string): GoogleOAuthVerifier {
    return new GoogleOAuthVerifier(
      clientId,
      new OAuth2Client({
        clientId,
        clientSecret,
        transporterOptions: { timeout: GOOGLE_TIMEOUT_MS },
      }),
    );
  }

  async verify({ code, redirectUri, codeVerifier }: GoogleAuthCode): Promise<GoogleIdentity> {
    let idToken: string | null | undefined;
    try {
      const { tokens } = await this.client.getToken({
        code,
        redirect_uri: redirectUri,
        codeVerifier,
      });
      idToken = tokens.id_token;
    } catch (error) {
      // Only 400 is a bad code; 401 (our secret) or a timeout must not be blamed on the user.
      if (httpStatusOf(error) === 400) throw new InvalidGoogleCodeError('code exchange refused');
      throw error;
    }
    if (!idToken) {
      throw new InvalidGoogleCodeError('no ID token: the openid scope was not requested');
    }

    // Fetched apart, so that Google being unreachable is not mistaken for a bad token.
    await this.client.getFederatedSignonCertsAsync();
    let payload;
    try {
      payload = (
        await this.client.verifyIdToken({ idToken, audience: this.clientId })
      ).getPayload();
    } catch {
      throw new InvalidGoogleCodeError('ID token rejected');
    }
    if (!payload?.sub || !payload.email) {
      throw new InvalidGoogleCodeError('no sub or email: the email scope was not requested');
    }
    return {
      sub: payload.sub,
      email: payload.email.toLowerCase(),
      emailVerified: payload.email_verified === true,
      nonce: payload.nonce,
    };
  }
}

function httpStatusOf(error: unknown): number | undefined {
  const status = (error as { response?: { status?: unknown } } | null)?.response?.status;
  return typeof status === 'number' ? status : undefined;
}
