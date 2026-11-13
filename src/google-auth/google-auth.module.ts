import { Module } from '@nestjs/common';
import { GoogleAuthResolver } from './google-auth.resolver.js';

@Module({
  providers: [GoogleAuthResolver],
})
export class GoogleAuthModule {}
