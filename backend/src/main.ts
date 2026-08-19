import 'dotenv/config';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // FRONTEND_URL is the only allowed origin once configured — this is an
  // authenticated app (JWT), so CORS is never opened with `*`. With no
  // FRONTEND_URL set (e.g. a fresh local checkout before the frontend's
  // dev-server URL is known/configured), fall back to any localhost port so
  // local development keeps working without requiring env setup first.
  const frontendUrl = process.env.FRONTEND_URL;
  app.enableCors({
    origin: frontendUrl ?? /^http:\/\/localhost:\d+$/,
    credentials: true,
  });

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
