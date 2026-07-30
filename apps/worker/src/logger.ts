interface LogContext {
  readonly [key: string]: boolean | number | string | null | undefined;
}

export function log(
  level: "error" | "info" | "warn",
  event: string,
  context: LogContext = {},
): void {
  process.stdout.write(
    `${JSON.stringify({
      event,
      level,
      service: "worker",
      timestamp: new Date().toISOString(),
      ...context,
    })}\n`,
  );
}
