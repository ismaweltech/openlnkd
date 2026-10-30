import { Module } from '@nestjs/common';
import { SessionModule } from '../session/session.module';
import { VoyagerModule } from '../common/voyager/voyager.module';
import { LocationsModule } from '../locations/locations.module';
import { PeopleController } from './people.controller';
import { PeopleService } from './people.service';

@Module({
  imports: [SessionModule, VoyagerModule, LocationsModule],
  controllers: [PeopleController],
  providers: [PeopleService],
  exports: [PeopleService],
})
export class PeopleModule {}
