import { IsInt, IsOptional, IsPositive, Min } from 'class-validator';

export class TransactionItemDto {
  @IsInt()
  @IsPositive()
  productId: number;

  @IsInt()
  @IsPositive()
  quantity: number;

  @IsOptional()
  @Min(0)
  price?: number;
}
