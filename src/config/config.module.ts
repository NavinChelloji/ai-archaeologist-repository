import { Module } from "@nestjs/common";
import { loadIndexerEnv } from "./env";

export const APP_CONFIG = Symbol("APP_CONFIG");

/**
 * `useFactory` (not `useValue`) so env parsing runs when Nest actually
 * instantiates this provider during a real bootstrap — not merely when
 * some other module transitively imports this file, e.g. a unit test
 * importing a service for its class reference alone.
 */
@Module({
  providers: [{ provide: APP_CONFIG, useFactory: loadIndexerEnv }],
  exports: [APP_CONFIG],
})
export class ConfigModule {}
