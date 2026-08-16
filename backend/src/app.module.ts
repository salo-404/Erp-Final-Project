import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { PrismaModule } from './prisma/prisma.module';
import { UsersModule } from './users/users.module';
import { WarehouseRoutingModule } from './warehouse-inventory/warehouse-routing.module';

@Module({
  imports: [PrismaModule, AuthModule, UsersModule, WarehouseRoutingModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
