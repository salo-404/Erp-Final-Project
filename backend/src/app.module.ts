import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { InventoryTransactionsModule } from './inventory-transactions/inventory-transactions.module';
import { PathOptimizerModule } from './path-optimizer/path-optimizer.module';
import { PrismaModule } from './prisma/prisma.module';
import { ReservationsModule } from './reservations/reservations.module';
import { StockMovementsModule } from './stock-movements/stock-movements.module';
import { UsersModule } from './users/users.module';
import { WarehouseRoutingModule } from './warehouse-inventory/warehouse-routing.module';

// NOT imported here yet (would break bootstrap — see each module's own doc
// comment for the exact binding needed at merge time):
//   - SupplierIntelligenceModule (needs SUPPLIERS_HISTORY_PROVIDER bound to
//     Joseph's SuppliersService)
//   - DocumentReviewModule (needs 3 external-provider tokens bound)
//   - StockInsightsModule (depends on DocumentReviewModule, inherits the
//     same blocker — Control Tower lives inside it)

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    UsersModule,
    WarehouseRoutingModule,
    StockMovementsModule,
    ReservationsModule,
    PathOptimizerModule,
    InventoryTransactionsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
