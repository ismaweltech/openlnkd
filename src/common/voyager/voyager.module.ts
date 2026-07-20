import { Module } from '@nestjs/common';
import { SessionModule } from '../../session/session.module';
import { VoyagerService } from './voyager.service';

@Module({
  imports: [SessionModule],
  providers: [VoyagerService],
  exports: [VoyagerService],
})
export class VoyagerModule {}
