import { Global, Module } from "@nestjs/common";
import {
  createHttpMetrics,
  createMetricsRegistry,
  createQueueMetrics,
  createStageMetrics,
  type HttpMetrics,
  type QueueMetrics,
  type Registry,
  type StageMetrics,
} from "@aca/metrics";
import { MetricsController } from "./metrics.controller";
import { HTTP_METRICS, METRICS_REGISTRY, QUEUE_METRICS, STAGE_METRICS } from "./metrics.tokens";

export { HTTP_METRICS, METRICS_REGISTRY, QUEUE_METRICS, STAGE_METRICS };

/**
 * `GET /metrics` and the metric objects every other module observes into
 * (RULES.md #15 "Metrics for HTTP latency ... queue depth, job age, stage
 * duration"). Global, like `InfraModule`, so any module can inject a metric
 * set without adding an explicit import.
 */
@Global()
@Module({
  controllers: [MetricsController],
  providers: [
    { provide: METRICS_REGISTRY, useFactory: (): Registry => createMetricsRegistry("indexer") },
    { provide: HTTP_METRICS, inject: [METRICS_REGISTRY], useFactory: (r: Registry): HttpMetrics => createHttpMetrics(r) },
    { provide: QUEUE_METRICS, inject: [METRICS_REGISTRY], useFactory: (r: Registry): QueueMetrics => createQueueMetrics(r) },
    { provide: STAGE_METRICS, inject: [METRICS_REGISTRY], useFactory: (r: Registry): StageMetrics => createStageMetrics(r) },
  ],
  exports: [METRICS_REGISTRY, HTTP_METRICS, QUEUE_METRICS, STAGE_METRICS],
})
export class MetricsModule {}
