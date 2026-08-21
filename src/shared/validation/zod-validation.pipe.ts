import { BadRequestException, Injectable, type PipeTransform } from "@nestjs/common";
import type { ZodTypeAny } from "zod";

/**
 * `packages/contracts` schemas are Zod, not class-validator, so Nest's
 * built-in ValidationPipe doesn't apply — this does the same job per-route:
 * `@UsePipes(new ZodValidationPipe(SomeSchema))` (RULES.md #12: "Validate
 * every request body, query parameter, and path parameter").
 */
@Injectable()
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodTypeAny) {}

  transform(value: unknown): unknown {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        code: "VALIDATION_FAILED",
        message: "Request failed validation.",
        details: {
          issues: result.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
      });
    }
    return result.data;
  }
}
