import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { AiServiceGuard } from '../common/guards/ai-service.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AiQueryService } from './ai-query.service';
import { QueryDatabaseDto } from './dto/query-database.dto';

/**
 * Real read-only SQL execution for the AI agent's SQL-RAG pipeline
 * (ai-agent/tools/query_database.py). The agent generates and validates
 * SQL itself (embeddings, pgvector example retrieval, Bedrock SQL
 * generation, sql_guard.py) and sends the already-validated SQL text
 * here - this endpoint is the actual database access boundary and never
 * trusts that agent-side validation alone (see AiQueryService).
 *
 * Restricted to the AI service Cognito identity via AiServiceGuard, which
 * runs after JwtAuthGuard - no ordinary human user, including an ADMIN,
 * can reach this route.
 */
@Controller('ai')
@UseGuards(JwtAuthGuard)
export class AiQueryController {
  constructor(private readonly aiQueryService: AiQueryService) {}

  @Post('query-database')
  @UseGuards(AiServiceGuard)
  queryDatabase(@Body() dto: QueryDatabaseDto) {
    return this.aiQueryService.executeReadOnly(dto.sql);
  }
}
