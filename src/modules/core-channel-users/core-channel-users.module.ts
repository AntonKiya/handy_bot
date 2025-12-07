import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CoreChannelUsersComment } from './core-channel-users-comment.entity';
import { CoreChannelUsersPostCommentsSync } from './core-channel-users-post-comments-sync.entity';
import { CoreChannelUsersService } from './core-channel-users.service';
import { ChannelPost } from '../channel-posts/channel-post.entity';
import { User } from '../user/user.entity';
import { CoreChannelUsersChannelSync } from './core-channel-users-channel-sync.entity';
import { CoreChannelUsersFlow } from './core-channel-users.flow';
import { MenuModule } from '../menu/menu.module';
import { UserChannelsModule } from '../user-channels/user-channels.module';
import { TelegramCoreModule } from '../../telegram-core/telegram-core.module';
import { Channel } from '../channel/channel.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      CoreChannelUsersComment,
      CoreChannelUsersPostCommentsSync,
      ChannelPost,
      User,
      CoreChannelUsersChannelSync,
      Channel,
    ]),
    MenuModule,
    UserChannelsModule,
    TelegramCoreModule,
  ],
  providers: [CoreChannelUsersService, CoreChannelUsersFlow],
  exports: [CoreChannelUsersService, CoreChannelUsersFlow],
})
export class CoreChannelUsersModule {}
