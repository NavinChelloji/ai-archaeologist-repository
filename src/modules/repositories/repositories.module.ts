import { Module } from "@nestjs/common";
import { ConfigModule } from "../../config/config.module";
import { InternalModule } from "../../internal/internal.module";
import { GithubRepoClient } from "./github-repo.client";
import { GithubTarballClient } from "./github-tarball.client";
import { GithubTokenClient } from "./github-token.client";
import { RepositoriesInternalController } from "./repositories.internal.controller";
import { RepositoriesRepository } from "./repositories.repository";
import { RepositoriesService } from "./repositories.service";
import { SnapshotDownloadService } from "./snapshot-download.service";
import { SnapshotsRepository } from "./snapshots.repository";
import { SnapshotsService } from "./snapshots.service";
import { RepositoriesWorkersService } from "./workers/repositories-workers.service";

@Module({
  imports: [ConfigModule, InternalModule],
  controllers: [RepositoriesInternalController],
  providers: [
    RepositoriesService,
    RepositoriesRepository,
    GithubTokenClient,
    GithubRepoClient,
    GithubTarballClient,
    SnapshotsRepository,
    SnapshotsService,
    SnapshotDownloadService,
    RepositoriesWorkersService,
  ],
  exports: [RepositoriesService, SnapshotsService],
})
export class RepositoriesModule {}
