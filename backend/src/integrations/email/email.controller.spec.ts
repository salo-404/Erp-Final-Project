import { Test, TestingModule } from '@nestjs/testing';
import { EmailController } from './email.controller';
import { EmailService } from './email.service';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { UserRole } from '../../../generated/prisma/enums';

describe('EmailController', () => {
  let controller: EmailController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [EmailController],
      providers: [{ provide: EmailService, useValue: {} }],
    }).compile();

    controller = module.get<EmailController>(EmailController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('restricts generic email sending to ADMIN', () => {
    expect(
      Reflect.getMetadata(ROLES_KEY, controller.sendEmail),
    ).toEqual([UserRole.ADMIN]);
  });
});
