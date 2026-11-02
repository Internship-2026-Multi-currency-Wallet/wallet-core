import { NotImplementedException } from '@nestjs/common';
import { Args, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import { GraphQLJSON } from 'graphql-scalars';
import { Public } from '../auth/public.decorator.js';
import { RequirePermission } from '../permissions/require-permission.decorator.js';
import { PublicSetting, Setting, SettingChange } from './settings.model.js';

/**
 * GraphQL contract for client settings. Contract-first: the bodies are stubs until the
 * settings store is implemented. Errors are reported as `extensions.code`.
 */
@Resolver(() => Setting)
export class SettingsResolver {
  @Public()
  @Query(() => [PublicSetting], {
    description: 'Effective public settings of this client. Does not require authentication.',
  })
  publicSettings(): PublicSetting[] {
    throw new NotImplementedException();
  }

  @RequirePermission('bo:settings')
  @Query(() => [Setting], {
    description:
      'All settings with defaults and overrides. Requires bo:settings. Errors: UNAUTHENTICATED, FORBIDDEN.',
  })
  staffSettings(): Setting[] {
    throw new NotImplementedException();
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
