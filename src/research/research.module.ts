import { Module } from '@nestjs/common';
import { PeopleModule } from '../people/people.module';
import { SessionModule } from '../session/session.module';
import { ResearchController } from './research.controller';
import { ResearchService } from './research.service';

@Module({
  imports: [PeopleModule, SessionModule],
  controllers: [ResearchController],
  providers: [ResearchService],
})
export class ResearchModule {}
