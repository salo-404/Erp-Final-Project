import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { InventoryTransactionsService } from './inventory-transactions.service';
import { CreateIncomingDto } from './dto/create-incoming.dto';
import { CreateOutgoingDto } from './dto/create-outgoing.dto';
import { CreateTransferDto } from './dto/create-transfer.dto';
import { UpdateTransactionDto } from './dto/update-transaction.dto';
import {
  InventoryTransactionStatus,
  InventoryTransactionType,
} from '../../generated/prisma/enums';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

@Controller('inventory-transactions')
@UseGuards(JwtAuthGuard)
export class InventoryTransactionsController {
  constructor(
    private readonly inventoryTransactionsService: InventoryTransactionsService,
  ) {}

  @Post('incoming')
  createIncoming(@Body() dto: CreateIncomingDto) {
    return this.inventoryTransactionsService.createIncoming(dto);
  }

  @Post('outgoing')
  createOutgoing(@Body() dto: CreateOutgoingDto) {
    return this.inventoryTransactionsService.createOutgoing(dto);
  }

  @Post('transfer')
  createTransfer(@Body() dto: CreateTransferDto) {
    return this.inventoryTransactionsService.createTransfer(dto);
  }

  // Static routes before the `:id` catch-all below, per Nest's route-matching order.
  @Get('upcoming-deliveries')
  getUpcomingDeliveries(
    @Query('windowDays', new ParseIntPipe({ optional: true }))
    windowDays?: number,
    @Query('referenceDate') referenceDate?: string,
  ) {
    return this.inventoryTransactionsService.getUpcomingDeliveries(
      windowDays,
      referenceDate ? new Date(referenceDate) : undefined,
    );
  }

  @Get('overdue')
  getOverdueTransactions(@Query('referenceDate') referenceDate?: string) {
    return this.inventoryTransactionsService.getOverdueTransactions(
      referenceDate ? new Date(referenceDate) : undefined,
    );
  }

  @Get()
  findAllTransactions(
    @Query('type') type?: InventoryTransactionType,
    @Query('status') status?: InventoryTransactionStatus,
    @Query('sourceWarehouseId', new ParseIntPipe({ optional: true }))
    sourceWarehouseId?: number,
    @Query('destinationWarehouseId', new ParseIntPipe({ optional: true }))
    destinationWarehouseId?: number,
    @Query('supplierId', new ParseIntPipe({ optional: true }))
    supplierId?: number,
    @Query('expectedDateFrom') expectedDateFrom?: string,
    @Query('expectedDateTo') expectedDateTo?: string,
  ) {
    return this.inventoryTransactionsService.findAllTransactions({
      type,
      status,
      sourceWarehouseId,
      destinationWarehouseId,
      supplierId,
      expectedDateFrom: expectedDateFrom
        ? new Date(expectedDateFrom)
        : undefined,
      expectedDateTo: expectedDateTo ? new Date(expectedDateTo) : undefined,
    });
  }

  @Get(':id')
  findOneTransaction(@Param('id', ParseIntPipe) id: number) {
    return this.inventoryTransactionsService.findOneTransaction(id);
  }

  @Get(':id/cost')
  getTransactionWithCost(@Param('id', ParseIntPipe) id: number) {
    return this.inventoryTransactionsService.getTransactionWithCost(id);
  }

  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateTransactionDto,
  ) {
    return this.inventoryTransactionsService.update(id, dto);
  }

  @Post(':id/complete')
  complete(@Param('id', ParseIntPipe) id: number) {
    return this.inventoryTransactionsService.complete(id);
  }

  @Post(':id/cancel')
  cancel(@Param('id', ParseIntPipe) id: number) {
    return this.inventoryTransactionsService.cancel(id);
  }

  /**
   * Attaches a document (e.g. a delivered customer order's invoice) to an
   * existing transaction, regardless of status — unlike update() above,
   * which only works on PENDING transactions. Same upload path/validation
   * as DocumentReviewController.upload(), no AI extraction/review step.
   */
  @Post(':id/document')
  @UseInterceptors(FileInterceptor('file'))
  attachDocument(
    @Param('id', ParseIntPipe) id: number,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException('file is required');
    }
    return this.inventoryTransactionsService.attachDocument(id, {
      filename: file.originalname,
      mimeType: file.mimetype,
      content: file.buffer,
    });
  }

  @Get(':id/document/presigned-url')
  getDocumentPresignedUrl(@Param('id', ParseIntPipe) id: number) {
    return this.inventoryTransactionsService.getDocumentPresignedUrl(id);
  }
}
