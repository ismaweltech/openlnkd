import { Module } from '@nestjs/common';
import { SessionModule } from '../session/session.module';
import { VoyagerModule } from '../common/voyager/voyager.module';
import { PeopleController } from './people.controller';
import { PeopleService } from './people.service';

@Module({
  imports: [SessionModule, VoyagerModule],
  controllers: [PeopleController],
  providers: [PeopleService],
  exports: [PeopleService],
})
export class PeopleModule {}
