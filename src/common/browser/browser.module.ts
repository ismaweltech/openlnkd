import { Global, Module } from '@nestjs/common';
import { BrowserService } from './browser.service';

@Global()
@Module({
  providers: [BrowserService],
  exports: [BrowserService],
})
export class BrowserModule {}
