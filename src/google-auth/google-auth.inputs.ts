import { Field, InputType } from '@nestjs/graphql';

@InputType({
  description:
    'What client-web received from Google on its callback route. wallet-core exchanges the code with Google itself; nothing else about the Google user is sent or trusted.',
})
export class GoogleAuthInput {
  @Field({ description: 'The one-time `code` query parameter Google redirected back with.' })
  code: string;

  @Field({
    description:
      'The `state` query parameter Google redirected back with: the state from startGoogleLink / startGoogleLogin.',
  })
  state: string;

  @Field({
    description:
      'The redirect_uri used to start the Google sign-in, exactly: an allowed client-web origin + "/auth/google/callback".',
  })
  redirectUri: string;

  @Field(() => String, {
    nullable: true,
    description:
      'PKCE code_verifier, when the sign-in was started with a code_challenge (recommended).',
  })
  codeVerifier?: string | null;
}
