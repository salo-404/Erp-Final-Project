import { Test, TestingModule } from '@nestjs/testing';
import { CalendarController } from './calendar.controller';
import { CalendarService } from './calendar.service';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { UserRole } from '../../../generated/prisma/enums';

describe('CalendarController', () => {
  let controller: CalendarController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [CalendarController],
      providers: [{ provide: CalendarService, useValue: {} }],
    }).compile();

    controller = module.get<CalendarController>(CalendarController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('keeps reads authenticated but restricts both generic writes to ADMIN', () => {
    expect(Reflect.getMetadata(ROLES_KEY, controller.getCalendarEvents)).toBeUndefined();
    expect(Reflect.getMetadata(ROLES_KEY, controller.createCalendarEvent)).toEqual([
      UserRole.ADMIN,
    ]);
    expect(Reflect.getMetadata(ROLES_KEY, controller.createShipmentReminder)).toEqual([
      UserRole.ADMIN,
    ]);
  });
});
