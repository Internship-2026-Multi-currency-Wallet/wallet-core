import { NotImplementedException } from '@nestjs/common';
import { Args, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import { GraphQLJSON } from 'graphql-scalars';
import { Public } from '../auth/public.decorator.js';
import { RequirePermission } from '../permissions/require-permission.decorator.js';
import { ClientSettingsService, type EffectiveSetting } from './client-settings.service.js';
import { PublicSetting, Setting, SettingChange } from './settings.model.js';
import { settingsCatalog, settingTypeOf } from './settings.schema.js';

/**
 * GraphQL API of client settings. Values come from `ClientSettingsService` (override, else the
 * catalog default); whether a setting is public is decided by the catalog only.
 * Errors are reported as `extensions.code`.
 */
@Resolver(() => Setting)
export class SettingsResolver {
  constructor(private readonly settings: ClientSettingsService) {}

  @Public()
  @Query(() => [PublicSetting], {
    description: 'Effective public settings of this client. Does not require authentication.',
  })
  async publicSettings(): Promise<PublicSetting[]> {
    return (await this.settings.getAll())
      .filter(({ key }) => settingsCatalog[key].public)
      .map(({ key, value }) => ({ key, value }));
  }

  @RequirePermission('bo:settings')
  @Query(() => [Setting], {
    description:
      'All settings with defaults and overrides. Requires bo:settings. Errors: UNAUTHENTICATED, FORBIDDEN.',
  })
  async staffSettings(): Promise<Setting[]> {
    return (await this.settings.getAll()).map(toSetting);
  }

  @RequirePermission('bo:settings')
  @Query(() => [SettingChange], {
    description:
      'Change history, newest first, optionally for one key. Cursor: `before` returns only changes strictly older than this time. `limit` is at most 200. Requires bo:settings. Errors: UNAUTHENTICATED, FORBIDDEN, UNKNOWN_KEY, INVALID_VALUE.',
  })
  settingHistory(
    @Args('key', { nullable: true }) _key?: string,
    @Args('limit', { type: () => Int, defaultValue: 50 }) _limit?: number,
    @Args('before', { type: () => Date, nullable: true }) _before?: Date,
  ): SettingChange[] {
    throw new NotImplementedException();
  }

  @RequirePermission('bo:settings:modify')
  @Mutation(() => Setting, {
    description:
      'Sets an override. Requires bo:settings:modify. Errors: UNAUTHENTICATED, FORBIDDEN, UNKNOWN_KEY, INVALID_VALUE.',
  })
  updateSetting(
    @Args('key') _key: string,
    @Args('value', { type: () => GraphQLJSON }) _value: unknown,
  ): Setting {
    throw new NotImplementedException();
  }

  @RequirePermission('bo:settings:modify')
  @Mutation(() => Setting, {
    description:
      'Removes the override so the default applies again; recorded in history. Requires bo:settings:modify. Errors: UNAUTHENTICATED, FORBIDDEN, UNKNOWN_KEY.',
  })
  resetSetting(@Args('key') _key: string): Setting {
    throw new NotImplementedException();
  }
}

/** Staff view of one setting: its effective value plus the catalog metadata. */
function toSetting({ key, value, overridden }: EffectiveSetting): Setting {
  const { schema, default: defaultValue, public: isPublic } = settingsCatalog[key];
  return {
    key,
    ...settingTypeOf(schema),
    public: isPublic,
    value,
    defaultValue: structuredClone(defaultValue),
    overridden,
  };
}
