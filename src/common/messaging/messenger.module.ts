import { Global, Module } from '@nestjs/common';
import { MessengerService } from './messenger.service';

@Global()
@Module({
  providers: [MessengerService],
  exports: [MessengerService],
})
export class MessengerModule {}
