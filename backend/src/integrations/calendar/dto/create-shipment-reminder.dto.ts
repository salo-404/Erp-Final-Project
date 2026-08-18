import { IsInt, IsPositive } from 'class-validator';

export class CreateShipmentReminderDto {
  @IsInt()
  @IsPositive()
  transactionId!: number;
}
