import { Global, Module } from "@nestjs/common";

import { API_CONFIG, loadApiConfig } from "./config";
import { DatabaseService } from "./database.service";

@Global()
@Module({
  exports: [API_CONFIG, DatabaseService],
  providers: [
    {
      provide: API_CONFIG,
      useFactory: loadApiConfig,
    },
    DatabaseService,
  ],
})
export class CoreModule {}
