import { Injectable, Logger } from '@nestjs/common';
import { Context } from 'telegraf';
import {
  HandleMyChatMemberResult,
  UserChannelsService,
} from './user-channels.service';

@Injectable()
export class UserChannelsFlowService {
  private readonly logger = new Logger(UserChannelsFlowService.name);

  constructor(private readonly userChannelsService: UserChannelsService) {}

  async handleMyChatMember(ctx: Context, update: any) {
    const chat = update.chat;
    this.logger.debug(
      `my_chat_member received for chat ${chat.id} (type=${chat.type})`,
    );

    const result: HandleMyChatMemberResult =
      await this.userChannelsService.handleMyChatMember(ctx, update);

    const actorTelegramId = update.from?.id as number | undefined;

    switch (result.type) {
      case 'linked': {
        const title =
          result.data.channelTitle ?? `Канал с id ${result.data.channelId}`;

        // Отправка сообщение в ЛС пользователю,
        // если он когда-то вызывал /start и разрешил диалог
        if (actorTelegramId) {
          try {
            await ctx.telegram.sendMessage(
              actorTelegramId,
              `✅ Канал "${title}" подключён.\nТеперь он доступен в разделе "Мои каналы".`,
            );
          } catch (e) {
            this.logger.warn(
              `Failed to send DM to user ${actorTelegramId} about linked channel`,
            );
          }
        }

        break;
      }

      case 'skipped': {
        this.logger.debug(
          `handleMyChatMember skipped with reason="${result.reason}"`,
        );

        if (result.reason === 'actor-not-admin' && actorTelegramId) {
          try {
            await ctx.telegram.sendMessage(
              actorTelegramId,
              'Вы должны быть администратором или владельцем канала, чтобы подключить его к боту.',
            );
          } catch (e) {
            this.logger.warn(
              `Failed to send DM to user ${actorTelegramId} about actor-not-admin status`,
            );
          }
        }

        break;
      }
    }
  }
}
