import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ExpectedGraphqlErrorFilter } from './expected-error.filter.js';

@Module({ providers: [{ provide: APP_FILTER, useClass: ExpectedGraphqlErrorFilter }] })
export class GraphqlErrorsModule {}
