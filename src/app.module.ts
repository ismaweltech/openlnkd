import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { BrowserModule } from './common/browser/browser.module';
import { MessengerModule } from './common/messaging/messenger.module';
import { CompaniesModule } from './companies/companies.module';
import { ConnectionsModule } from './connections/connections.module';
import { DatabaseModule } from './common/database/database.module';
import { JobsModule } from './jobs/jobs.module';
import { LocationsModule } from './locations/locations.module';
import { OutreachModule } from './outreach/outreach.module';
import { PeopleModule } from './people/people.module';
import { SessionModule } from './session/session.module';
import { TemplatesModule } from './templates/templates.module';
import { UpdateModule } from './common/update/update.module';
import { WebhookModule } from './webhook/webhook.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    DatabaseModule,
    BrowserModule,
    MessengerModule,
    SessionModule,
    JobsModule,
    LocationsModule,
    CompaniesModule,
    ConnectionsModule,
    TemplatesModule,
    PeopleModule,
    OutreachModule,
    WebhookModule,
    UpdateModule,
  ],
})
export class AppModule {}
