import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { WebhookService } from './webhook.service';

@ApiTags('Webhooks')
@Controller('webhooks')
export class WebhookController {
  constructor(private readonly svc: WebhookService) {}

  @Post()
  @ApiOperation({ summary: 'Register a new webhook' })
  create(@Body() dto: { name?: string; url: string; secret?: string; events?: string[]; interval_sec?: number }) {
    return this.svc.create(dto);
  }

  @Get()
  @ApiOperation({ summary: 'List all webhooks' })
  findAll() {
    return this.svc.findAll();
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.svc.findOne(id);
  }

  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.svc.remove(id);
  }

  @Post(':id/enable')
  @ApiOperation({ summary: 'Enable a webhook' })
  enable(@Param('id', ParseIntPipe) id: number) {
    return this.svc.setActive(id, true);
  }

  @Post(':id/disable')
  @ApiOperation({ summary: 'Disable a webhook without deleting it' })
  disable(@Param('id', ParseIntPipe) id: number) {
    return this.svc.setActive(id, false);
  }

  @Post(':id/test')
  @ApiOperation({ summary: 'Fire a test payload to the webhook URL' })
  test(@Param('id', ParseIntPipe) id: number) {
    return this.svc.test(id);
  }
}
