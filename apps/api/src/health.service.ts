import { Inject, Injectable, type OnApplicationShutdown } from "@nestjs/common";
import type { ServiceHealth } from "@tashkalinskaya/contracts";
import { checkDatabase, createDatabasePool, isDatabaseConfigured } from "@tashkalinskaya/database";
import type { Pool } from "pg";

import { API_CONFIG, type ApiConfig } from "./config";

@Injectable()
export class HealthService implements OnApplicationShutdown {
  private readonly pool: Pool | undefined;

  constructor(@Inject(API_CONFIG) private readonly config: ApiConfig) {
    this.pool = isDatabaseConfigured(config.databaseUrl)
      ? createDatabasePool({
          applicationName: "tashkalinskaya-api",
          connectionString: config.databaseUrl,
          ...(config.databaseName === undefined ? {} : { databaseName: config.databaseName }),
          sslMode: config.databaseSsl,
        })
      : undefined;
  }

  getLiveness(): ServiceHealth {
    return {
      service: "api",
      state: "healthy",
      timestamp: new Date().toISOString(),
      version: this.config.appVersion,
    };
  }

  async getReadiness(): Promise<ServiceHealth> {
    if (this.pool === undefined) {
      return {
        checks: { database: "not_configured" },
        service: "api",
        state: this.config.databaseRequired ? "degraded" : "healthy",
        timestamp: new Date().toISOString(),
        version: this.config.appVersion,
      };
    }

    try {
      await checkDatabase(this.pool);
      return {
        checks: { database: "healthy" },
        service: "api",
        state: "healthy",
        timestamp: new Date().toISOString(),
        version: this.config.appVersion,
      };
    } catch {
      return {
        checks: { database: "unavailable" },
        service: "api",
        state: "degraded",
        timestamp: new Date().toISOString(),
        version: this.config.appVersion,
      };
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool?.end();
  }
}
