import { type MiddlewareConsumer, Module, type NestModule } from "@nestjs/common";

import { AppController } from "./app.controller";
import { AttendanceModule } from "./attendance/attendance.module";
import { CatalogModule } from "./catalog/catalog.module";
import { CoreModule } from "./core.module";
import { CorrelationIdMiddleware } from "./correlation-id.middleware";
import { HealthController } from "./health.controller";
import { HealthService } from "./health.service";
import { IdentityModule } from "./identity/identity.module";
import { LogisticsModule } from "./logistics/logistics.module";
import { PlanningModule } from "./planning/planning.module";
import { ProductionModule } from "./production/production.module";
import { StoreModule } from "./store/store.module";

@Module({
  imports: [
    AttendanceModule,
    CatalogModule,
    CoreModule,
    IdentityModule,
    LogisticsModule,
    PlanningModule,
    ProductionModule,
    StoreModule,
  ],
  controllers: [AppController, HealthController],
  providers: [CorrelationIdMiddleware, HealthService],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes("{*path}");
  }
}
