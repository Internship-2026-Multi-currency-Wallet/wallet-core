import { NotImplementedException } from '@nestjs/common';
import { Args, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
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

  @RequirePermission('settings:modify')
  @Query(() => [Setting], {
    description:
      'All settings with defaults and overrides. Requires settings:modify (else FORBIDDEN).',
  })
  staffSettings(): Setting[] {
    throw new NotImplementedException();
  }

  @RequirePermission('settings:modify')
  @Query(() => [SettingChange], {
    description:
      'Change history, newest first, optionally for one key. Requires settings:modify. Errors: UNKNOWN_KEY, FORBIDDEN.',
  })
  settingHistory(
    @Args('key', { nullable: true }) _key?: string,
    @Args('limit', { type: () => Int, defaultValue: 50 }) _limit?: number,
  ): SettingChange[] {
    throw new NotImplementedException();
  }

  @RequirePermission('settings:modify')
  @Mutation(() => Setting, {
    description:
      'Sets an override; value is JSON-encoded. Requires settings:modify. Errors: UNKNOWN_KEY, INVALID_VALUE, FORBIDDEN.',
  })
  updateSetting(@Args('key') _key: string, @Args('value') _value: string): Setting {
    throw new NotImplementedException();
  }

  @RequirePermission('settings:modify')
  @Mutation(() => Setting, {
    description:
      'Removes the override so the default applies again; recorded in history. Requires settings:modify. Errors: UNKNOWN_KEY, FORBIDDEN.',
  })
  resetSetting(@Args('key') _key: string): Setting {
    throw new NotImplementedException();
  }
}
