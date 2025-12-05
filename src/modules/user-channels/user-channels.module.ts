import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserChannel } from './user-channel.entity';
import { User } from '../user/user.entity';
import { Channel } from '../channel/channel.entity';
import { UserChannelsService } from './user-channels.service';
import { UserChannelsFlowService } from './user-channels-flow.service';

@Module({
  imports: [TypeOrmModule.forFeature([UserChannel, User, Channel])],
  providers: [UserChannelsService, UserChannelsFlowService],
  exports: [UserChannelsService, UserChannelsFlowService],
})
export class UserChannelsModule {}
