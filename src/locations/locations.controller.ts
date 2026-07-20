import { Controller, Get, OnModuleInit, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { LocationsService } from './locations.service';

@ApiTags('locations')
@Controller('locations')
export class LocationsController implements OnModuleInit {
  constructor(private readonly locations: LocationsService) {}

  async onModuleInit() {
    // Backfill label_normalized for any rows cached before the column existed
    await this.locations.backfillNormalized();
  }

  @Get('typeahead')
  @ApiOperation({
    summary: 'Autocomplete LinkedIn locations',
    description: 'Returns LinkedIn geoId + label suggestions for a given query string.',
  })
  @ApiQuery({ name: 'q', required: true, description: 'Partial location name, e.g. "sevilla"' })
  typeahead(@Query('q') q: string) {
    return this.locations.typeahead(q ?? '');
  }
}
