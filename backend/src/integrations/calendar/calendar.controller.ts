import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { CalendarService } from './calendar.service';
import { CreateCalendarEventDto } from './dto/create-calendar-event.dto';
import { CreateShipmentReminderDto } from './dto/create-shipment-reminder.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';

@Controller('integrations/calendar')
@UseGuards(JwtAuthGuard)
export class CalendarController {
  constructor(private readonly calendarService: CalendarService) {}

  @Get('events')
  getCalendarEvents(
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return this.calendarService.getCalendarEvents(startDate, endDate);
  }

  @Post('event')
  createCalendarEvent(@Body() dto: CreateCalendarEventDto) {
    return this.calendarService.createCalendarEvent(dto);
  }

  @Post('shipment-reminder')
  createShipmentReminder(@Body() dto: CreateShipmentReminderDto) {
    return this.calendarService.createShipmentReminder(dto.transactionId);
  }
}
