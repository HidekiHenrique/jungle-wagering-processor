import { describe, expect, it } from 'bun:test';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Greeter } from './fixtures/greeter';
import { GreetingConsumer } from './fixtures/greeting-consumer';

/**
 * Guards the biggest stack risk: NestJS DI depends on the `design:paramtypes` metadata that
 * the Bun transpiler must emit (tsconfig `emitDecoratorMetadata`). If it stops doing so,
 * constructor injection breaks everywhere, so this fails fast with a clear message.
 */
describe('decorator metadata under Bun', () => {
  it('emits constructor parameter types for classes imported from another file', () => {
    expect(Reflect.getMetadata('design:paramtypes', GreetingConsumer)).toEqual([Greeter]);
  });

  it('lets Nest resolve constructor dependencies by type', async () => {
    @Module({ providers: [Greeter, GreetingConsumer] })
    class FixtureModule {}

    const app = await NestFactory.createApplicationContext(FixtureModule, { logger: false });
    try {
      expect(app.get(GreetingConsumer).greeter.greet('bun')).toBe('hello bun');
    } finally {
      await app.close();
    }
  });
});
