import { Args, ID, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import { GraphQLJSON } from 'graphql-scalars';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
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
      'Change history, newest first, optionally for one key. `before` alone returns only changes strictly older than this time. Next page: pass `before` = last row `changedAt` and `beforeId` = last row `id` (changes with the same time are not skipped). `limit` is at most 200. Requires bo:settings. Errors: UNAUTHENTICATED, FORBIDDEN, UNKNOWN_KEY, INVALID_VALUE.',
  })
  settingHistory(
    // GraphQL passes an explicit `null` for these; the service treats only `undefined` as "not set".
    @Args('key', { type: () => String, nullable: true }) key: string | null | undefined,
    @Args('limit', { type: () => Int, defaultValue: 50 }) limit: number,
    @Args('before', { type: () => Date, nullable: true }) before: Date | null | undefined,
    @Args('beforeId', { type: () => ID, nullable: true }) beforeId?: string | null,
  ): Promise<SettingChange[]> {
    return this.settings.history({
      key: key ?? undefined,
      limit,
      before: before ?? undefined,
      beforeId: beforeId ?? undefined,
    });
  }

  @RequirePermission('bo:settings:modify')
  @Mutation(() => Setting, {
    description:
      'Sets an override. Requires bo:settings:modify. Errors: UNAUTHENTICATED, FORBIDDEN, UNKNOWN_KEY, INVALID_VALUE.',
  })
  async updateSetting(
    @CurrentUser() user: AuthUser,
    @Args('key') key: string,
    @Args('value', { type: () => GraphQLJSON }) value: unknown,
  ): Promise<Setting> {
    return toSetting(await this.settings.update(key, value, user.id));
  }

  @RequirePermission('bo:settings:modify')
  @Mutation(() => Setting, {
    description:
      'Removes the override so the default applies again; recorded in history. Requires bo:settings:modify. Errors: UNAUTHENTICATED, FORBIDDEN, UNKNOWN_KEY.',
  })
  async resetSetting(@CurrentUser() user: AuthUser, @Args('key') key: string): Promise<Setting> {
    return toSetting(await this.settings.reset(key, user.id));
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
