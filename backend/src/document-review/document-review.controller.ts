import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Request } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  DocumentReviewService,
  MAX_DOCUMENT_SIZE_BYTES,
} from './document-review.service';
import { ApproveDocumentReviewDto } from './dto/approve-document-review.dto';
import { RejectDocumentReviewDto } from './dto/reject-document-review.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { UserRole } from '../../generated/prisma/enums';

/**
 * Re-extracts the raw bearer token JwtAuthGuard already validated for this
 * request — never trusted as authentication here (that already happened),
 * only forwarded onward so DocumentSemanticMatchProvider can act as this
 * exact human against the AI service's AgentCore /invocations endpoint.
 */
function humanBearerToken(request: Request): string {
  const [scheme, token] = request.headers.authorization?.split(' ') ?? [];
  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    // Unreachable in practice — JwtAuthGuard (applied class-wide on this
    // controller) already rejects the request before this ever runs.
    throw new UnauthorizedException('A valid Cognito access token is required');
  }
  return token;
}

@Controller('document-review')
@UseGuards(JwtAuthGuard)
export class DocumentReviewController {
  constructor(private readonly documentReviewService: DocumentReviewService) {}

  /**
   * Browser -> NestJS -> private S3 -> Textract AnalyzeExpense, all
   * handled by DocumentReviewService.upload() (see that method's doc
   * comment). `FileInterceptor` with no storage option defaults to
   * multer's in-memory storage, so `file.buffer` is what gets forwarded as
   * `content` — never written to disk, never sent anywhere but S3. Any
   * authenticated user can submit a document for review — approving it is
   * the sensitive step, gated separately below.
   */
  @Post('upload')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_DOCUMENT_SIZE_BYTES },
    }),
  )
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

  /**
   * Forwards the CURRENT reviewer's own Cognito access token and ERP user
   * id — never a service credential — so DocumentReviewService can
   * authenticate to the AI service's AgentCore /invocations "document_match"
   * mode as this exact human, the same identity/session-ownership model
   * AgentCore already enforces for chat (see
   * DocumentSemanticMatchProvider's docstring in document-review.service.ts).
   */
  @Get('resolve-product')
  resolveProduct(
    @Query('query') query: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    return this.documentReviewService.resolveProduct(
      humanBearerToken(request),
      user.id,
      query,
    );
  }

  /** Same contract as resolveProduct() above. */
  @Get('resolve-supplier')
  resolveSupplier(
    @Query('query') query: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    return this.documentReviewService.resolveSupplier(
      humanBearerToken(request),
      user.id,
      query,
    );
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
