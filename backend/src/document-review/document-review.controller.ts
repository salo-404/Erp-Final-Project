import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { DocumentReviewService } from './document-review.service';
import { ApproveDocumentReviewDto } from './dto/approve-document-review.dto';
import { RejectDocumentReviewDto } from './dto/reject-document-review.dto';

@Controller('document-review')
export class DocumentReviewController {
  constructor(private readonly documentReviewService: DocumentReviewService) {}

  /**
   * Browser -> NestJS -> S3 -> presigned URL -> extraction provider, all
   * handled by DocumentReviewService.upload() (see that method's doc
   * comment). `FileInterceptor` with no storage option defaults to
   * multer's in-memory storage, so `file.buffer` is what gets forwarded as
   * `content` — never written to disk, never sent anywhere but S3.
   */
  @Post('upload')
  @UseInterceptors(FileInterceptor('file'))
  upload(@UploadedFile() file?: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('file is required');
    }
    return this.documentReviewService.upload({
      filename: file.originalname,
      mimeType: file.mimetype,
      content: file.buffer,
    });
  }

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
