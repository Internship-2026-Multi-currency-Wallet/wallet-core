import { Field, ObjectType, registerEnumType } from '@nestjs/graphql';

export enum DependencyStatus {
  UP = 'UP',
  DOWN = 'DOWN',
}

registerEnumType(DependencyStatus, {
  name: 'DependencyStatus',
  description: 'Whether a dependency (database, Redis) answers.',
});

@ObjectType({ description: 'Service health and identity.' })
export class Health {
  @Field({ description: 'Service name, e.g. "wallet-core".' })
  service: string;

  @Field({ description: 'Service version (package.json or APP_VERSION).' })
  version: string;

  @Field({ description: 'Environment (APP_ENV): local, staging, kvitka-uat, wisla-uat.' })
  appEnv: string;

  @Field({ description: 'Client this deployment serves (CLIENT env): demo, kvitka, wisla.' })
  client: string;

  @Field(() => DependencyStatus)
  db: DependencyStatus;

  @Field(() => DependencyStatus)
  redis: DependencyStatus;
}
