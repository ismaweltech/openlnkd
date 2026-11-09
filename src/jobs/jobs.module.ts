import { Module } from '@nestjs/common';
import { SessionModule } from '../session/session.module';
import { VoyagerModule } from '../common/voyager/voyager.module';
import { LocationsModule } from '../locations/locations.module';
import { JobsController } from './jobs.controller';
import { JobsService } from './jobs.service';

@Module({
  imports: [SessionModule, VoyagerModule, LocationsModule],
  controllers: [JobsController],
  providers: [JobsService],
  exports: [JobsService],
})
export class JobsModule {}
