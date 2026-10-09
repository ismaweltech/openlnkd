import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { PeopleSearchParams } from './people.service';
import { PeopleService } from './people.service';

@ApiTags('people')
@Controller('people')
export class PeopleController {
  constructor(private readonly people: PeopleService) {}

  @Post('search')
  @ApiOperation({
    summary: 'Search LinkedIn profiles and save to DB',
    description: 'Search by title, role, name. Filter by company or connection degree.',
  })
  search(@Body() params: PeopleSearchParams) {
    return this.people.search(params);
  }

  @Get()
  @ApiOperation({ summary: 'List saved people profiles with optional filters' })
  @ApiQuery({ name: 'keyword', required: false, description: 'Search in name or headline' })
  @ApiQuery({ name: 'company', required: false, description: 'Filter by company (partial match)' })
  @ApiQuery({ name: 'connectionDegree', required: false, description: '1st, 2nd or 3rd' })
  @ApiQuery({ name: 'location', required: false, description: 'Filter by location (partial match, e.g. "Sevilla" matches "Sevilla y alrededores")' })
  findAll(
    @Query('keyword') keyword?: string,
    @Query('company') company?: string,
    @Query('connectionDegree') connectionDegree?: string,
    @Query('location') location?: string,
  ) {
    return this.people.findAll({ keyword, company, connectionDegree, location });
  }

  @Get(':slug/activity')
  @ApiOperation({
    summary: "Scrape a person's recent posts and reposts",
    description:
      'Reads the profile\'s recent-activity feed for audience research — each item has ' +
      'text, body, type (post/repost), age and engagement. `slug` is the LinkedIn ' +
      'public identifier (the part after /in/). Use ?limit=N (default 10).',
  })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Max posts (default 10)' })
  getActivity(@Param('slug') slug: string, @Query('limit') limit?: string) {
    return this.people.getActivity(slug, limit ? parseInt(limit, 10) : 10);
  }
}
