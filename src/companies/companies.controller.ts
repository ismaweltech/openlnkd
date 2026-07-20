import { Controller, Post, Get, Param, Body, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { CompaniesService, Company } from './companies.service';
import { SearchCompaniesDto, SearchPeopleAtCompanyDto, COMPANY_SIZE_LABELS, COMPANY_TYPE_LABELS, COMMON_INDUSTRIES } from './dto/search-companies.dto';
import type { Person } from '../people/people.service';

@ApiTags('companies')
@Controller('companies')
export class CompaniesController {
  constructor(private readonly service: CompaniesService) {}

  /**
   * Search LinkedIn companies with all available filters.
   * Results are saved to the local database.
   */
  @Post('search')
  @ApiOperation({ summary: 'Search LinkedIn companies with filters' })
  async search(@Body() dto: SearchCompaniesDto): Promise<Company[]> {
    return this.service.search(dto);
  }

  /**
   * List saved companies with optional filters.
   */
  @Get()
  @ApiOperation({ summary: 'List saved companies' })
  @ApiQuery({ name: 'keyword', required: false, description: 'Search in name or headline' })
  @ApiQuery({ name: 'industry', required: false, description: 'Filter by industry (partial match)' })
  @ApiQuery({ name: 'size', required: false, description: 'Filter by size range (partial match)' })
  @ApiQuery({ name: 'location', required: false, description: 'Filter by headquarters location' })
  @ApiQuery({ name: 'company_type', required: false, description: 'Filter by type (Public, Private, Non-profit…)' })
  async findAll(
    @Query('keyword') keyword?: string,
    @Query('industry') industry?: string,
    @Query('size') size?: string,
    @Query('location') location?: string,
    @Query('company_type') company_type?: string,
  ): Promise<Company[]> {
    return this.service.findAll({ keyword, industry, size, location, company_type });
  }

  /**
   * Get a single saved company by its LinkedIn slug (e.g. "google", "openai").
   */
  @Get('meta/filters')
  @ApiOperation({ summary: 'Return the available filter values and their descriptions' })
  getFilterMeta() {
    return {
      companySize: COMPANY_SIZE_LABELS,
      companyType: COMPANY_TYPE_LABELS,
      commonIndustries: COMMON_INDUSTRIES,
    };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a saved company by LinkedIn slug' })
  async findOne(@Param('id') id: string): Promise<Company> {
    return this.service.findById(id);
  }

  /**
   * Search for people working at a company.
   * Navigates to /company/:id/people/ on LinkedIn and scrapes employees.
   * People are saved to the people table for use in campaigns.
   */
  @Post(':id/people')
  @ApiOperation({
    summary: 'Search people at a company',
    description:
      'Navigates to the company\'s LinkedIn People page. Use `keywords` to filter by role within the company. Results are saved to the people table.',
  })
  async searchPeople(
    @Param('id') id: string,
    @Body() dto: SearchPeopleAtCompanyDto,
  ): Promise<Person[]> {
    return this.service.searchPeopleAtCompany(id, dto);
  }
}
