import { IsISO8601, IsOptional, IsString } from 'class-validator';

export class CreateCalendarEventDto {
  @IsString()
  title!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsISO8601()
  startDate!: string;

  @IsISO8601()
  endDate!: string;
}
