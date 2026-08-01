import { type MiddlewareConsumer, Module, type NestModule } from "@nestjs/common";

import { AppController } from "./app.controller";
import { AttendanceModule } from "./attendance/attendance.module";
import { CatalogModule } from "./catalog/catalog.module";
import { CoreModule } from "./core.module";
import { CorrelationIdMiddleware } from "./correlation-id.middleware";
import { HealthController } from "./health.controller";
import { HealthService } from "./health.service";
import { GoodReturnsModule } from "./good-returns/good-returns.module";
import { IdentityModule } from "./identity/identity.module";
import { InventoryModule } from "./inventory/inventory.module";
import { LogisticsModule } from "./logistics/logistics.module";
import { LoadingModule } from "./loading/loading.module";
import { NotificationsModule } from "./notifications/notifications.module";
import { PlanningModule } from "./planning/planning.module";
import { ProductionModule } from "./production/production.module";
import { ReportsModule } from "./reports/reports.module";
import { StoreModule } from "./store/store.module";
import { SpoilageModule } from "./spoilage/spoilage.module";
import { WarehouseModule } from "./warehouse/warehouse.module";

@Module({
  imports: [
    AttendanceModule,
    CatalogModule,
    CoreModule,
    GoodReturnsModule,
    IdentityModule,
    InventoryModule,
    LogisticsModule,
    LoadingModule,
    NotificationsModule,
    PlanningModule,
    ProductionModule,
    ReportsModule,
    SpoilageModule,
    StoreModule,
    WarehouseModule,
  ],
  controllers: [AppController, HealthController],
  providers: [CorrelationIdMiddleware, HealthService],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes("{*path}");
  }
}
