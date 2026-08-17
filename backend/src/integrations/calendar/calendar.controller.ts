import { Body, Controller, Post } from '@nestjs/common';
import { CalendarService } from './calendar.service';
import { CreateCalendarEventDto } from './dto/create-calendar-event.dto';
import { CreateShipmentReminderDto } from './dto/create-shipment-reminder.dto';

@Controller('integrations/calendar')
export class CalendarController {
  constructor(private readonly calendarService: CalendarService) {}

  @Post('event')
  createCalendarEvent(@Body() dto: CreateCalendarEventDto) {
    return this.calendarService.createCalendarEvent(dto);
  }

  @Post('shipment-reminder')
  createShipmentReminder(@Body() dto: CreateShipmentReminderDto) {
    return this.calendarService.createShipmentReminder(dto.transactionId);
  }
}
