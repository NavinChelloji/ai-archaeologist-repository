import { Module } from "@nestjs/common";
import { ConfigModule } from "./config/config.module";
import { InfraModule } from "./shared/infra.module";
import { HealthModule } from "./shared/health/health.module";
import { InternalModule } from "./internal/internal.module";
import { SystemModule } from "./modules/system/system.module";

@Module({
  imports: [ConfigModule, InfraModule, HealthModule, InternalModule, SystemModule],
})
export class AppModule {}
