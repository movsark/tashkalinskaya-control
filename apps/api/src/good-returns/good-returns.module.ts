import { Module } from "@nestjs/common";
import { CoreModule } from "../core.module";
import { IdentityModule } from "../identity/identity.module";
import { GoodReturnsController } from "./good-returns.controller";
import { GoodReturnsRepository } from "./good-returns.repository";
import { GoodReturnsService } from "./good-returns.service";

@Module({
  imports: [CoreModule, IdentityModule],
  controllers: [GoodReturnsController],
  providers: [GoodReturnsRepository, GoodReturnsService],
})
export class GoodReturnsModule {}
