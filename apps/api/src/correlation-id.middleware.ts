import { randomUUID } from "node:crypto";

import { Injectable, type NestMiddleware } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";

const correlationIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(request: Request, response: Response, next: NextFunction): void {
    const requestedId = request.header("x-correlation-id");
    const correlationId =
      requestedId !== undefined && correlationIdPattern.test(requestedId)
        ? requestedId
        : randomUUID();

    response.setHeader("x-correlation-id", correlationId);
    response.locals.correlationId = correlationId;
    next();
  }
}
