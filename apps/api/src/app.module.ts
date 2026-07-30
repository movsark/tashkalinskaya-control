import { type MiddlewareConsumer, Module, type NestModule } from "@nestjs/common";

import { AppController } from "./app.controller";
import { API_CONFIG, loadApiConfig } from "./config";
import { CorrelationIdMiddleware } from "./correlation-id.middleware";
import { HealthController } from "./health.controller";
import { HealthService } from "./health.service";

@Module({
  controllers: [AppController, HealthController],
  providers: [
    {
      provide: API_CONFIG,
      useFactory: loadApiConfig,
    },
    CorrelationIdMiddleware,
    HealthService,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes("{*path}");
  }
}
