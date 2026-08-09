import { Module } from '@nestjs/common';
import { ContactsService } from './contacts.service';
import { MeController } from './contacts.controller';

@Module({
  providers: [ContactsService],
  controllers: [MeController],
  exports: [ContactsService],
})
export class ContactsModule {}
