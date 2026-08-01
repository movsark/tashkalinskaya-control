import type { NextFunction, Request, Response } from "express";

const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);

export function requestOriginAllowed(
  method: string,
  origin: string | undefined,
  allowedOrigins: readonly string[],
): boolean {
  return (
    safeMethods.has(method.toUpperCase()) || origin === undefined || allowedOrigins.includes(origin)
  );
}

export function originProtection(allowedOrigins: readonly string[]) {
  return (request: Request, response: Response, next: NextFunction): void => {
    const origin = request.header("origin");
    if (!requestOriginAllowed(request.method, origin, allowedOrigins)) {
      response.status(403).json({
        code: "ORIGIN_REJECTED",
        message: "Источник запроса не разрешен",
      });
      return;
    }
    next();
  };
}
