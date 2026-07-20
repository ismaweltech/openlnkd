import { Module } from '@nestjs/common';
import { WebhookService } from './webhook.service';
import { WebhookController } from './webhook.controller';
import { OutreachModule } from '../outreach/outreach.module';
import { SessionModule } from '../session/session.module';

@Module({
  imports: [OutreachModule, SessionModule],
  providers: [WebhookService],
  controllers: [WebhookController],
})
export class WebhookModule {}
