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
  // On SIGTERM/SIGINT: run onModuleDestroy (closes Chromium), then exit.
  app.enableShutdownHooks();

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
    .setVersion('0.7.3')
    .build();

  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config));

  const port = process.env.PORT ?? 3000;
  // The API has no authentication and acts as your LinkedIn account, so by
  // default it only accepts connections from this machine. Anything else on
  // the same network (a café, a coworking Wi-Fi) could otherwise drive it.
  // Docker sets HOST=0.0.0.0 inside the container and publishes the port on
  // 127.0.0.1 only (docker-compose.yml).
  const host = process.env.HOST ?? '127.0.0.1';
  await app.listen(port, host);
  console.log(`OpenLnkd running on http://localhost:${port}`);
  // Inside the official image 0.0.0.0 is expected: exposure is set by the port mapping.
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !process.env.OPENLNKD_CONTAINER) {
    console.warn(
      `WARNING: listening on ${host} — anyone who can reach this port can use your LinkedIn account. ` +
      'Keep HOST=127.0.0.1 unless it runs inside a container or behind your own authentication.',
    );
  }
  if (fs.existsSync(publicDir)) {
    console.log(`Dashboard:    http://localhost:${port}/`);
  }
  console.log(`Swagger docs: http://localhost:${port}/docs`);
}

bootstrap();
