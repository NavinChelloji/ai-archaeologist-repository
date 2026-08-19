import { Module } from "@nestjs/common";
import { ConfigModule } from "../config/config.module";
import { InternalTokenService } from "./internal-token.service";
import { InternalAuthGuard } from "./internal-auth.guard";

@Module({
  imports: [ConfigModule],
  providers: [InternalTokenService, InternalAuthGuard],
  exports: [InternalTokenService, InternalAuthGuard],
})
export class InternalModule {}
