import { Field, InputType } from '@nestjs/graphql';

@InputType({
  description:
    'wallet-core exchanges the code with Google itself; nothing the browser says about the Google user is trusted.',
})
export class GoogleAuthInput {
  @Field()
  code: string;

  @Field({ description: 'From startGoogleLink / startGoogleLogin, as Google redirected it back.' })
  state: string;

  @Field({
    description:
      'The redirect_uri the sign-in was started with, exactly: an allowed client-web origin + "/auth/google/callback".',
  })
  redirectUri: string;

  @Field(() => String, {
    nullable: true,
    description:
      'PKCE code_verifier, when the sign-in was started with a code_challenge (recommended).',
  })
  codeVerifier?: string | null;
}
