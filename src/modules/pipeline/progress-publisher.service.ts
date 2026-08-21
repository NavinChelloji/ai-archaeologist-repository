import { Inject, Injectable } from "@nestjs/common";
import type Redis from "ioredis";
import { JobProgressEventSchema, type JobProgressEvent } from "@aca/contracts";
import { REDIS_CLIENT } from "../../shared/infra.module";

function progressChannel(repoId: string): string {
  return `progress:${repoId}`;
}

/**
 * Publishes to Redis Pub/Sub on every processing_jobs state change
 * (JOB_ORCHESTRATOR_SERVICE_PLAN.md "Progress Publishing"). `api` replicas
 * subscribe and fan out over SSE — see API_GATEWAY_SERVICE_PLAN.md "SSE
 * fan-out across replicas" for why this must be Pub/Sub and not a queue job.
 */
@Injectable()
export class ProgressPublisherService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async publish(event: JobProgressEvent): Promise<void> {
    const validated = JobProgressEventSchema.parse(event);
    await this.redis.publish(progressChannel(validated.repoId), JSON.stringify(validated));
  }
}
