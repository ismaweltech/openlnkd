import { Body, Controller, Delete, Get, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SessionService } from './session.service';

@ApiTags('session')
@Controller('session')
export class SessionController {
  constructor(private readonly session: SessionService) {}

  @Post('login')
  @ApiOperation({ summary: 'Login with LinkedIn credentials' })
  async login(@Body() body: { email?: string; password?: string }) {
    return this.session.login(body.email, body.password);
  }

  @Get('status')
  @ApiOperation({ summary: 'Check if session is active' })
  async status() {
    const ok = await this.session.isAuthenticated();
    return { authenticated: ok };
  }

  @Delete('logout')
  @ApiOperation({ summary: 'Clear session' })
  async logout() {
    await this.session.logout();
    return { ok: true };
  }
}
