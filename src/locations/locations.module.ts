import { Module } from '@nestjs/common';
import { BrowserModule } from '../common/browser/browser.module';
import { DatabaseModule } from '../common/database/database.module';
import { SessionModule } from '../session/session.module';
import { VoyagerModule } from '../common/voyager/voyager.module';
import { LocationsController } from './locations.controller';
import { LocationsService } from './locations.service';

@Module({
  imports: [BrowserModule, DatabaseModule, SessionModule, VoyagerModule],
  controllers: [LocationsController],
  providers: [LocationsService],
  exports: [LocationsService],
})
export class LocationsModule {}
