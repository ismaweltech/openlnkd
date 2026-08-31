import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { UpdateService, VersionInfo } from './update.service';

@ApiTags('system')
@Controller('version')
export class UpdateController {
  constructor(private readonly update: UpdateService) {}

  @Get()
  @ApiOperation({
    summary: 'Current version and whether a newer release exists on GitHub',
    description:
      'Compares the running version against the latest GitHub release. ' +
      'Only reads GitHub\'s public API — sends no user or usage data. ' +
      'Disable the check with UPDATE_CHECK=false.',
  })
  getVersion(): Promise<VersionInfo> {
    return this.update.getVersionInfo();
  }
}
