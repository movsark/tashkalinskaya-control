import "reflect-metadata";

import { ConsoleLogger, ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import helmet from "helmet";

import { AppModule } from "./app.module";
import { loadApiConfig } from "./config";

async function bootstrap(): Promise<void> {
  const config = loadApiConfig();
  const app = await NestFactory.create(AppModule, {
    logger: new ConsoleLogger({ json: true, prefix: "api" }),
  });

  app.enableShutdownHooks();
  app.enableCors({
    credentials: true,
    origin: config.corsOrigins,
  });
  app.setGlobalPrefix("api/v1");
  app.use(helmet());
  app.useGlobalPipes(
    new ValidationPipe({
      forbidNonWhitelisted: true,
      transform: true,
      whitelist: true,
    }),
  );

  const swaggerConfig = new DocumentBuilder()
    .setTitle("Ташкалинская — внутренний контроль")
    .setDescription("Версионируемый API внутренней системы фабрики")
    .setVersion(config.appVersion)
    .build();
  SwaggerModule.setup("api/docs", app, SwaggerModule.createDocument(app, swaggerConfig));

  await app.listen(config.port, "0.0.0.0");
}

void bootstrap();
