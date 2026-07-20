import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ConnectionsService } from './connections.service';
import { SendInviteDto, SendMessageDto } from './dto/send-connection.dto';

@ApiTags('connections')
@Controller('connections')
export class ConnectionsController {
  constructor(private readonly connections: ConnectionsService) {}

  @Post('invite')
  @ApiOperation({
    summary: 'Send a connection invite to a LinkedIn profile',
    description: 'Optional message (max 300 chars). Saved in DB regardless of result.',
  })
  sendInvite(@Body() body: SendInviteDto) {
    return this.connections.sendInvite(body);
  }

  @Post('message')
  @ApiOperation({
    summary: 'Send a direct message to an existing connection',
  })
  sendMessage(@Body() body: SendMessageDto) {
    return this.connections.sendMessage(body);
  }

  @Get()
  @ApiOperation({ summary: 'List all tracked connections' })
  findAll() {
    return this.connections.findAll();
  }
}
