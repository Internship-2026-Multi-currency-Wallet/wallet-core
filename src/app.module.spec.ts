import { describe, expect, it } from '@jest/globals';
import { MODULE_METADATA } from '@nestjs/common/constants.js';
import 'reflect-metadata';
import { AppModule } from './app.module.js';
import { AuthModule } from './auth/auth.module.js';
import { CustomizationsModule } from './customizations/customizations.module.js';

const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, AppModule) as unknown[];

describe('AppModule', () => {
  it('imports CustomizationsModule once, before AuthModule', () => {
    const customizations = imports.indexOf(CustomizationsModule);
    const auth = imports.indexOf(AuthModule);

    expect(imports.filter((m) => m === CustomizationsModule)).toHaveLength(1);
    expect(auth).toBeGreaterThanOrEqual(0);
    expect(customizations).toBeGreaterThanOrEqual(0);
    expect(customizations).toBeLessThan(auth);
  });
});
