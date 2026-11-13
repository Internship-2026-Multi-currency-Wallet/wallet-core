import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthModule } from '../auth/auth.module.js';
import { AppConfig } from '../config/app-config.js';
import { GoogleAccountsRepository } from './google-accounts.repository.js';
import { GoogleAuthStateService } from './google-auth-state.js';
import { GoogleAuthResolver } from './google-auth.resolver.js';
import { GoogleAuthService } from './google-auth.service.js';
import { GOOGLE_IDENTITY_VERIFIER, type GoogleIdentityVerifier } from './google-identity.js';
import { GoogleOAuthVerifier } from './google-oauth.verifier.js';

@Module({
  imports: [AuthModule, JwtModule.register({})],
  providers: [
    GoogleAuthResolver,
    GoogleAuthService,
    GoogleAccountsRepository,
    GoogleAuthStateService,
    {
      provide: GOOGLE_IDENTITY_VERIFIER,
      inject: [AppConfig],
      useFactory: ({ google }: AppConfig): GoogleIdentityVerifier | null =>
        google.clientId && google.clientSecret
          ? GoogleOAuthVerifier.create(google.clientId, google.clientSecret)
          : null,
    },
  ],
})
export class GoogleAuthModule {}
