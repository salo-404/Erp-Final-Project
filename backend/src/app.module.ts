import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { PathOptimizerModule } from './path-optimizer/path-optimizer.module';
import { PrismaModule } from './prisma/prisma.module';
import { ReservationsModule } from './reservations/reservations.module';
import { StockMovementsModule } from './stock-movements/stock-movements.module';
import { UsersModule } from './users/users.module';
import { WarehouseRoutingModule } from './warehouse-inventory/warehouse-routing.module';

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    UsersModule,
    WarehouseRoutingModule,
    StockMovementsModule,
    ReservationsModule,
    PathOptimizerModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
