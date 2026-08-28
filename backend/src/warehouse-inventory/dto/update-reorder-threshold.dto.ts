import { IsInt, Min } from 'class-validator';

export class UpdateReorderThresholdDto {
  @IsInt()
  @Min(0)
  reorderThreshold!: number;
}
