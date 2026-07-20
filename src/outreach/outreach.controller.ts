import { Body, Controller, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CreateCampaignDto } from './dto/create-campaign.dto';
import { OutreachService } from './outreach.service';

@ApiTags('outreach')
@Controller('outreach')
export class OutreachController {
  constructor(private readonly outreach: OutreachService) {}

  // ── Campaigns ──────────────────────────────────────────────────────────

  @Post('campaigns')
  @ApiOperation({
    summary: 'Create a messaging campaign',
    description: 'Provide a templateId and list of profile URLs. Run separately with POST /outreach/campaigns/:id/run',
  })
  createCampaign(@Body() dto: CreateCampaignDto) {
    return this.outreach.createCampaign(dto);
  }

  @Post('campaigns/:id/run')
  @ApiOperation({
    summary: 'Execute a campaign — sends messages to all pending targets',
    description: 'Scrapes each profile to extract {name}, renders the template, and sends with human delays.',
  })
  runCampaign(@Param('id', ParseIntPipe) id: number) {
    return this.outreach.runCampaign(id);
  }

  @Get('campaigns')
  @ApiOperation({ summary: 'List all campaigns' })
  findAllCampaigns() {
    return this.outreach.findAllCampaigns();
  }

  @Get('campaigns/:id')
  @ApiOperation({ summary: 'Get campaign detail with all targets and their status' })
  findCampaign(@Param('id', ParseIntPipe) id: number) {
    return this.outreach.findCampaign(id);
  }

  // ── Recruiter ──────────────────────────────────────────────────────────

  @Get('jobs/:jobId/recruiter')
  @ApiOperation({ summary: 'Find the hiring manager/recruiter of a job listing' })
  findRecruiter(@Param('jobId') jobId: string) {
    return this.outreach.findJobRecruiter(jobId);
  }

  @Post('jobs/:jobId/message-recruiter')
  @ApiOperation({
    summary: 'Message the recruiter of a job using a template',
    description: 'Finds the recruiter automatically and sends a rendered template. Extra vars override template defaults.',
  })
  messageRecruiter(
    @Param('jobId') jobId: string,
    @Body() body: { templateId: number; vars?: Record<string, string> },
  ) {
    return this.outreach.messageJobRecruiter(jobId, body.templateId, body.vars ?? {});
  }

  // ── Inbox ──────────────────────────────────────────────────────────────

  @Get('inbox')
  @ApiOperation({ summary: 'Read LinkedIn inbox — returns recent conversations' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Max conversations (default 20)' })
  readInbox(@Query('limit') limit?: string) {
    return this.outreach.readInbox(limit ? parseInt(limit) : 20);
  }
}
