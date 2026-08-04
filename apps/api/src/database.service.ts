import {
  Inject,
  Injectable,
  OnApplicationShutdown,
  ServiceUnavailableException,
} from "@nestjs/common";
import { createDatabasePool } from "@tashkalinskaya/database";
import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";

import { API_CONFIG, type ApiConfig } from "./config";

@Injectable()
export class DatabaseService implements OnApplicationShutdown {
  private readonly pool: Pool | null;

  constructor(@Inject(API_CONFIG) config: ApiConfig) {
    this.pool =
      config.databaseUrl === undefined
        ? null
        : createDatabasePool({
            applicationName: "tashkalinskaya-api",
            connectionString: config.databaseUrl,
            maxConnections: config.databaseMaxConnections,
            sslMode: config.databaseSsl,
          });
  }

  get configured(): boolean {
    return this.pool !== null;
  }

  async query<Row extends QueryResultRow>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResult<Row>> {
    return this.requirePool().query<Row>(text, [...values]);
  }

  async transaction<Result>(operation: (client: PoolClient) => Promise<Result>): Promise<Result> {
    const client = await this.requirePool().connect();
    try {
      await client.query("begin");
      const result = await operation(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool?.end();
  }

  private requirePool(): Pool {
    if (this.pool === null) {
      throw new ServiceUnavailableException({
        code: "DATABASE_NOT_CONFIGURED",
        message: "База данных не подключена",
      });
    }
    return this.pool;
  }
}
