import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AiQueryModule } from './ai-query/ai-query.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { AuthModule } from './auth/auth.module';
import { DocumentReviewModule } from './document-review/document-review.module';
import { EmailModule } from './integrations/email/email.module';
import { CalendarModule } from './integrations/calendar/calendar.module';
import { InventoryTransactionsModule } from './inventory-transactions/inventory-transactions.module';
import { PrismaModule } from './prisma/prisma.module';
import { ProductsModule } from './products/products.module';
import { ReservationsModule } from './reservations/reservations.module';
import { StockInsightsModule } from './stock-insights/stock-insights.module';
import { StockMovementsModule } from './stock-movements/stock-movements.module';
import { SupplierIntelligenceModule } from './suppliers/supplier-intelligence.module';
import { SuppliersModule } from './suppliers/suppliers.module';
import { UsersModule } from './users/users.module';
import { WarehouseInventoryModule } from './warehouse-inventory/warehouse-inventory.module';
import { WarehouseRoutingModule } from './warehouse-inventory/warehouse-routing.module';
import { WarehousesModule } from './warehouses/warehouses.module';

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    UsersModule,
    ProductsModule,
    WarehousesModule,
    WarehouseInventoryModule,
    WarehouseRoutingModule,
    SuppliersModule,
    SupplierIntelligenceModule,
    AnalyticsModule,
    StockMovementsModule,
    ReservationsModule,
    InventoryTransactionsModule,
    DocumentReviewModule,
    StockInsightsModule,
    EmailModule,
    CalendarModule,
    AiQueryModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
