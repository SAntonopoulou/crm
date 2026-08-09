import { Controller, Get } from '@nestjs/common';
import { Public } from './shared/auth/auth.guard';

@Controller('health')
export class HealthController {
  @Public()
  @Get()
  health(): { status: string } {
    return { status: 'ok' };
  }
}
