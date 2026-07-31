import { Module } from "@nestjs/common";

import { IdentityModule } from "../identity/identity.module";
import { CatalogController } from "./catalog.controller";
import { CatalogRepository } from "./catalog.repository";
import { CatalogService } from "./catalog.service";

@Module({
  controllers: [CatalogController],
  imports: [IdentityModule],
  providers: [CatalogRepository, CatalogService],
})
export class CatalogModule {}
