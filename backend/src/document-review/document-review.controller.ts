import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
} from '@nestjs/common';
import { DocumentReviewService } from './document-review.service';
import { ApproveDocumentReviewDto } from './dto/approve-document-review.dto';
import { RejectDocumentReviewDto } from './dto/reject-document-review.dto';

/**
 * NOTE: upload() is not exposed here yet. It needs (a) a multipart file
 * endpoint — `Express.Multer.File` typing requires `@types/multer`, not
 * currently a project dependency, and (b) a bound
 * DocumentStorageProvider/DocumentExtractionProvider (see
 * document-review.module.ts — neither is bound on this branch). Adding the
 * route now would either fail to typecheck or fail at runtime with a DI
 * error, so it's deliberately left out rather than half-implemented; see
 * the report for what's needed to add it.
 */
@Controller('document-review')
export class DocumentReviewController {
  constructor(private readonly documentReviewService: DocumentReviewService) {}

  @Get('pending')
  getPendingReviews() {
    return this.documentReviewService.getPendingReviews();
  }

  @Get('resolve-product')
  resolveProduct(@Query('query') query: string) {
    return this.documentReviewService.resolveProduct(query);
  }

  @Get('resolve-supplier')
  resolveSupplier(@Query('query') query: string) {
    return this.documentReviewService.resolveSupplier(query);
  }

  @Get(':id')
  getReview(@Param('id', ParseIntPipe) id: number) {
    return this.documentReviewService.getReview(id);
  }

  @Post(':id/approve')
  approve(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ApproveDocumentReviewDto,
  ) {
    return this.documentReviewService.approve(id, dto);
  }

  @Post(':id/reject')
  reject(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RejectDocumentReviewDto,
  ) {
    return this.documentReviewService.reject(id, dto);
  }
}
