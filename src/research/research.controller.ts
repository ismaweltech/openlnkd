import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AudienceParams, BenchmarkParams, VoiceParams } from './research.service';
import { ResearchService } from './research.service';

@ApiTags('research')
@Controller('research')
export class ResearchController {
  constructor(private readonly research: ResearchService) {}

  @Post('audience')
  @ApiOperation({
    summary: 'Background job: what a target audience posts and comments about',
    description:
      'For each segment, searches people, keeps those whose headline matches `roleMatch`, ' +
      'then reads their recent posts and the comments they leave on others\' posts (the ' +
      'candid part). Body: { segments: [{ label, keywords, location?, roleMatch?: string[] }], ' +
      'perSegment?: 5, posts?: 5, comments?: 6 }. Returns a job — poll GET /research/jobs/:id.',
  })
  audience(@Body() body: AudienceParams) {
    return this.research.start('audience', body);
  }

  @Post('benchmark')
  @ApiOperation({
    summary: 'Background job: find and rank reference creators in a niche',
    description:
      'Discovers candidates with people search (`keywords`, filtered by the `headlineMatch` ' +
      'regex) and/or takes explicit `slugs`, visits each profile once and ranks the active ' +
      'ones by median engagement per own post. Your own profile is added for comparison. ' +
      'Body: { slugs?, keywords?, location?, headlineMatch?, maxProfiles?: 25, posts?: 8, ' +
      'activeDays?: 30, minOwnPosts?: 3, includeSelf?: true }.',
  })
  benchmark(@Body() body: BenchmarkParams) {
    return this.research.start('benchmark', body);
  }

  @Post('voice')
  @ApiOperation({
    summary: 'Background job: what already works on your own profile',
    description:
      'Reads your own recent posts (impressions included — LinkedIn only shows them to the ' +
      'author) and returns engagement rate, top posts by reach and by engagement, and style ' +
      'stats (length, lines, closing question, emoji, numbers). Body: { posts?: 15 }.',
  })
  voice(@Body() body: VoiceParams) {
    return this.research.start('voice', body ?? {});
  }

  @Get('jobs')
  @ApiOperation({ summary: 'List research jobs (without results)' })
  list() {
    return this.research.list();
  }

  @Get('jobs/:id')
  @ApiOperation({ summary: 'Research job status, progress, log and — when done — result' })
  get(@Param('id') id: string) {
    return this.research.get(id);
  }

  @Delete('jobs/:id')
  @ApiOperation({ summary: 'Cancel a queued or running research job' })
  cancel(@Param('id') id: string) {
    return this.research.cancel(id);
  }
}
