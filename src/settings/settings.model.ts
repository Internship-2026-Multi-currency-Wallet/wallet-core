import { Field, ID, ObjectType, registerEnumType } from '@nestjs/graphql';
import { GraphQLJSON } from 'graphql-scalars';

export enum SettingType {
  BOOLEAN = 'BOOLEAN',
  ENUM = 'ENUM',
  STRING_LIST = 'STRING_LIST',
}

registerEnumType(SettingType, {
  name: 'SettingType',
  description: 'Value type of a setting; tells the client what shape the JSON value has.',
});

@ObjectType({ description: 'A setting the client apps may read (public flag set in the catalog).' })
export class PublicSetting {
  @Field({ description: 'Dotted key, e.g. "auth.googleLogin".' })
  key: string;

  @Field(() => GraphQLJSON, { description: 'Effective value, e.g. true or ["wallet"].' })
  value: unknown;
}

@ObjectType({ description: 'A setting with its catalog metadata, for staff.' })
export class Setting {
  @Field({ description: 'Dotted key, e.g. "auth.googleLogin".' })
  key: string;

  @Field(() => SettingType)
  type: SettingType;

  @Field(() => [String], {
    nullable: true,
    description: 'Allowed values; only for type ENUM.',
  })
  allowedValues?: string[];

  @Field({ description: 'Whether client apps receive this setting (publicSettings).' })
  public: boolean;

  @Field(() => GraphQLJSON, {
    description: 'Effective value (override if any, else default).',
  })
  value: unknown;

  @Field(() => GraphQLJSON, { description: 'Platform default from the catalog.' })
  defaultValue: unknown;

  @Field({ description: 'Whether the client has an override for this setting.' })
  overridden: boolean;
}

@ObjectType({ description: 'One recorded change of a setting (an update or a reset).' })
export class SettingChange {
  @Field({ description: 'Dotted key, e.g. "auth.googleLogin".' })
  key: string;

  @Field(() => GraphQLJSON, {
    description: 'Value before the change (the default if there was no override).',
  })
  oldValue: unknown;

  @Field(() => GraphQLJSON, {
    description: 'Value after the change (the default after a reset).',
  })
  newValue: unknown;

  @Field(() => ID, { description: 'Id of the staff user who made the change.' })
  changedBy: string;

  @Field({ description: 'When the change was made.' })
  changedAt: Date;
}
