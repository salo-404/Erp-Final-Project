import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class QueryDatabaseDto {
  // The pgvector example-retrieval query embeds a 512-dim float vector
  // literal (~10-11K characters on its own - see
  // retrieval/query_example_repository.py) plus the rest of its SQL text,
  // so this needs real headroom above a typical hand-written query, not
  // just enough for one - confirmed against a real production payload
  // that failed at 10000.
  @IsString()
  @IsNotEmpty()
  @MaxLength(20000)
  sql!: string;
}
