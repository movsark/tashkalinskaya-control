import { Controller, Get } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";

@ApiTags("system")
@Controller()
export class AppController {
  @Get()
  @ApiOperation({ summary: "Сведения о прикладном API" })
  @ApiOkResponse({ description: "API доступен" })
  getInfo() {
    return {
      name: "Ташкалинская — внутренний контроль",
      service: "api",
      version: "0.1.0",
    } as const;
  }
}
