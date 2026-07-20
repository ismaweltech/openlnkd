import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import * as dotenv from 'dotenv';
import { join } from 'path';
import * as fs from 'fs';
import { AppModule } from './app.module';

// Load .env relative to the compiled file so it works regardless of CWD
dotenv.config({ path: join(__dirname, '..', '.env') });

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // Validate request bodies against DTO classes: missing/invalid fields → 400
  // (instead of crashing downstream with a 500). transform hydrates DTO classes.
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true }),
  );

  // Serve the React dashboard from public/
  const publicDir = join(__dirname, '..', 'public');
  if (fs.existsSync(publicDir)) {
    app.useStaticAssets(publicDir);
  }

  const config = new DocumentBuilder()
    .setTitle('OpenLnkd')
    .setDescription('Open Source LinkedIn API Gateway')
    .setVersion('0.1.0')
    .build();

  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config));

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  console.log(`OpenLnkd running on http://localhost:${port}`);
  if (fs.existsSync(publicDir)) {
    console.log(`Dashboard:    http://localhost:${port}/`);
  }
  console.log(`Swagger docs: http://localhost:${port}/docs`);
}

bootstrap();
