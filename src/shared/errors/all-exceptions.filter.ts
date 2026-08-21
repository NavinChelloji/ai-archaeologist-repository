import { randomUUID } from "node:crypto";
import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Inject } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { AppError, HTTP_STATUS_BY_CODE, type ErrorCode, type ErrorEnvelope } from "@aca/contracts";
import type { Logger } from "@aca/logger";
import { APP_LOGGER } from "../infra.module";

/** Fallback mapping for HttpExceptions that don't carry an explicit `code` (API_ERROR_CODES.md "Generic" bucket). */
const STATUS_TO_GENERIC_CODE: Partial<Record<number, ErrorCode>> = {
  400: "VALIDATION_FAILED",
  401: "AUTH_REQUIRED",
  404: "NOT_FOUND",
  409: "CONFLICT",
  429: "RATE_LIMITED",
  503: "DEPENDENCY_UNAVAILABLE",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractCode(body: unknown): ErrorCode | undefined {
  if (isRecord(body) && typeof body.code === "string" && body.code in HTTP_STATUS_BY_CODE) {
    return body.code as ErrorCode;
  }
  return undefined;
}

function extractMessage(body: unknown, fallback: string): string {
  if (typeof body === "string") return body;
  if (isRecord(body) && typeof body.message === "string") return body.message;
  return fallback;
}

function extractDetails(body: unknown): Record<string, unknown> | undefined {
  if (isRecord(body) && isRecord(body.details)) {
    return body.details;
  }
  return undefined;
}

/**
 * Maps every thrown error onto the single ErrorEnvelope shape from
 * API_ERROR_CODES.md — controllers never build error responses by hand
 * (RULES.md #8). `AppError` is respected as-is; other Nest HttpExceptions
 * (validation pipe, guards) are mapped by an explicit `code` in their
 * response body when present, else by HTTP status; anything unexpected
 * becomes a logged `INTERNAL_ERROR`.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(@Inject(APP_LOGGER) private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<FastifyReply>();
    const request = ctx.getRequest<FastifyRequest>();
    const correlationId = request.correlationId ?? randomUUID();

    const { status, envelope } = this.toEnvelope(exception, correlationId);

    const logPayload = { correlationId, code: envelope.error.code, status, path: request.url };
    if (status >= 500) {
      this.logger.error({ ...logPayload, err: exception }, "request failed");
    } else {
      this.logger.warn(logPayload, "request rejected");
    }

    const retryAfterSeconds = envelope.error.details?.retryAfterSeconds;
    if (typeof retryAfterSeconds === "number") {
      response.header("retry-after", String(retryAfterSeconds));
    }

    void response.status(status).send(envelope);
  }

  private toEnvelope(exception: unknown, correlationId: string): { status: number; envelope: ErrorEnvelope } {
    if (exception instanceof AppError) {
      return { status: exception.status, envelope: exception.toEnvelope(correlationId) };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const code = extractCode(body) ?? STATUS_TO_GENERIC_CODE[status] ?? "INTERNAL_ERROR";
      const message = extractMessage(body, exception.message);
      const details = extractDetails(body);
      return {
        status,
        envelope: { error: { code, message, correlationId, details, retryable: false } },
      };
    }

    return {
      status: 500,
      envelope: {
        error: {
          code: "INTERNAL_ERROR",
          message: "Something went wrong. Please try again.",
          correlationId,
          retryable: false,
        },
      },
    };
  }
}
