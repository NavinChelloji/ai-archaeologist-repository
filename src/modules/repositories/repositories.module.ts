import { Module } from "@nestjs/common";
import { ConfigModule } from "../../config/config.module";
import { InternalModule } from "../../internal/internal.module";
import { GithubRepoClient } from "./github-repo.client";
import { GithubTokenClient } from "./github-token.client";
import { RepositoriesInternalController } from "./repositories.internal.controller";
import { RepositoriesRepository } from "./repositories.repository";
import { RepositoriesService } from "./repositories.service";

@Module({
  imports: [ConfigModule, InternalModule],
  controllers: [RepositoriesInternalController],
  providers: [RepositoriesService, RepositoriesRepository, GithubTokenClient, GithubRepoClient],
  exports: [RepositoriesService],
})
export class RepositoriesModule {}
