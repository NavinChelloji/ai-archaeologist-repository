import "fastify";

declare module "fastify" {
  interface FastifyRequest {
    /** Set by the onRequest hook in main.ts — read by the exception filter and logging. */
    correlationId: string;
  }
}
