import { Body, Controller, Get, Post, Query } from '@nestjs/common';
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
}
