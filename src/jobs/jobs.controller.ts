import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { JobsService } from './jobs.service';
import { JobSearchDto } from './dto/job-search.dto';

@ApiTags('jobs')
@Controller('jobs')
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  @Post('search')
  @ApiOperation({ summary: 'Search LinkedIn jobs and save results to DB' })
  async search(@Body() params: JobSearchDto) {
    return this.jobs.search(params);
  }

  @Get()
  @ApiOperation({ summary: 'List saved jobs with optional filters' })
  @ApiQuery({ name: 'applied', required: false, type: Boolean, description: 'Filter by applied status' })
  @ApiQuery({ name: 'saved', required: false, type: Boolean, description: 'Filter by saved status' })
  @ApiQuery({ name: 'easyApply', required: false, type: Boolean, description: 'Only Easy Apply jobs' })
  @ApiQuery({ name: 'company', required: false, type: String, description: 'Filter by company name (partial match)' })
  @ApiQuery({ name: 'keyword', required: false, type: String, description: 'Search in title and description' })
  @ApiQuery({ name: 'hasDescription', required: false, type: Boolean, description: 'Only jobs with/without cached description' })
  @ApiQuery({ name: 'notApplied', required: false, type: Boolean, description: 'Only jobs not yet applied to' })
  findAll(
    @Query('applied') applied?: string,
    @Query('saved') saved?: string,
    @Query('easyApply') easyApply?: string,
    @Query('company') company?: string,
    @Query('keyword') keyword?: string,
    @Query('hasDescription') hasDescription?: string,
    @Query('notApplied') notApplied?: string,
  ) {
    return this.jobs.findAll({
      applied: applied !== undefined ? applied === 'true' : undefined,
      saved: saved !== undefined ? saved === 'true' : undefined,
      easyApply: easyApply !== undefined ? easyApply === 'true' : undefined,
      company: company || undefined,
      keyword: keyword || undefined,
      hasDescription: hasDescription !== undefined ? hasDescription === 'true' : undefined,
      notApplied: notApplied === 'true',
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single job by ID' })
  findOne(@Param('id') id: string) {
    return this.jobs.findOne(id);
  }

  @Get(':id/description')
  @ApiOperation({ summary: 'Get full job description (scrapes if not cached)' })
  async getDescription(@Param('id') id: string) {
    return this.jobs.getDescription(id);
  }

  @Patch(':id/applied')
  @ApiOperation({ summary: 'Mark a job as applied' })
  markApplied(@Param('id') id: string) {
    return this.jobs.markApplied(id);
  }

  @Patch(':id/saved')
  @ApiOperation({ summary: 'Mark a job as saved' })
  markSaved(@Param('id') id: string) {
    return this.jobs.markSaved(id);
  }
}
