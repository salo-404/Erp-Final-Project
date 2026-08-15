import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ProductsModule } from './products/products.module';
import { PrismaModule } from './prisma/prisma.module';
import { WarehousesModule } from './warehouses/warehouses.module';
import { SuppliersModule } from './suppliers/suppliers.module';

@Module({
  imports: [ProductsModule, PrismaModule, WarehousesModule, SuppliersModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
