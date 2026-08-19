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
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { DocumentReviewService } from './document-review.service';
import { ApproveDocumentReviewDto } from './dto/approve-document-review.dto';
import { RejectDocumentReviewDto } from './dto/reject-document-review.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { UserRole } from '../../generated/prisma/enums';

@Controller('document-review')
@UseGuards(JwtAuthGuard)
export class DocumentReviewController {
  constructor(private readonly documentReviewService: DocumentReviewService) {}

  /**
   * Browser -> NestJS -> S3 -> presigned URL -> extraction provider, all
   * handled by DocumentReviewService.upload() (see that method's doc
   * comment). `FileInterceptor` with no storage option defaults to
   * multer's in-memory storage, so `file.buffer` is what gets forwarded as
   * `content` — never written to disk, never sent anywhere but S3. Any
   * authenticated user can submit a document for review — approving it is
   * the sensitive step, gated separately below.
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

  /**
   * Regenerates a fresh, short-lived presigned URL for an already-uploaded
   * document so the frontend/admin can view it — same authentication level
   * as getReview() above, since this is read access to a review already
   * visible there, not a decision. Nothing here is persisted.
   */
  @Get(':id/presigned-url')
  getDocumentPresignedUrl(@Param('id', ParseIntPipe) id: number) {
    return this.documentReviewService.getDocumentPresignedUrl(id);
  }

  /**
   * ADMIN-only. `reviewedById` comes from the authenticated JWT user, never
   * the request body — a client cannot claim a different reviewer identity.
   */
  @Post(':id/approve')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  approve(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ApproveDocumentReviewDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.documentReviewService.approve(id, {
      ...dto,
      reviewedById: user.id,
    });
  }

  /** ADMIN-only. `reviewedById` comes from the authenticated JWT user — see approve(). */
  @Post(':id/reject')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  reject(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RejectDocumentReviewDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.documentReviewService.reject(id, {
      ...dto,
      reviewedById: user.id,
    });
  }
}
