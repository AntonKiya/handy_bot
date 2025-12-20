import { Injectable, Logger } from '@nestjs/common';
import { Context, Markup } from 'telegraf';
import { ImportantMessagesService } from './important-messages.service';
import { GroupMessageData } from '../../telegram-bot/utils/types';
import { buildMessageLink } from './utils/link-builder.util';
import {
  IMPORTANT_MESSAGES_CB,
  ImportantMessagesAction,
} from './important-messages.constants';
import { UserChannelsService } from '../user-channels/user-channels.service';

@Injectable()
export class ImportantMessagesFlow {
  private readonly logger = new Logger(ImportantMessagesFlow.name);

  constructor(
    private readonly importantMessagesService: ImportantMessagesService,
    private readonly userChannelsService: UserChannelsService,
  ) {}

  /**
   * Обработка входящего сообщения из группы
   * Вызывается из Router
   */
  async handleGroupMessage(
    ctx: Context,
    messageData: GroupMessageData,
  ): Promise<void> {
    try {
      // Service определяет важность сообщения
      const categories =
        await this.importantMessagesService.processGroupMessage(messageData);

      // Если сообщение не важное - завершаем
      if (!categories || categories.length === 0) {
        return;
      }

      // Если важное - обрабатываем
      await this.handleImportantMessage(ctx, messageData, categories);
    } catch (error) {
      this.logger.error(
        `Error in handleGroupMessage: ${error.message}`,
        error.stack,
      );
    }
  }

  /**
   * Обработка важного сообщения
   * Внутренний метод Flow
   */
  private async handleImportantMessage(
    ctx: Context,
    messageData: GroupMessageData,
    categories: string[],
  ): Promise<void> {
    const { chatId, messageId, userId, text } = messageData;

    this.logger.debug(
      `Handling important message ${messageId} from chat ${chatId}, categories: ${categories.join(', ')}`,
    );

    // Получаем канал
    const channel =
      await this.importantMessagesService.getChannelByTelegramChatId(chatId);

    if (!channel) {
      this.logger.warn(
        `Channel not found for chat_id ${chatId}, skipping save`,
      );
      return;
    }

    // Сохраняем в БД
    const savedMessage =
      await this.importantMessagesService.saveImportantMessage({
        channelId: channel.id,
        telegramMessageId: messageId,
        telegramUserId: userId,
        text,
      });

    // Отправляем уведомления админам
    await this.sendNotificationToAdmins(
      ctx,
      savedMessage.id,
      messageData,
      categories,
    );

    // Обновляем время уведомления
    await this.importantMessagesService.updateNotifiedAt(savedMessage.id);
  }

  /**
   * Отправка уведомлений админам
   */
  private async sendNotificationToAdmins(
    ctx: Context,
    messageId: string,
    messageData: GroupMessageData,
    categories: string[],
  ): Promise<void> {
    // TODO: Получить список админов через UserChannelsService.getChannelAdminsByTelegramChatId
    const adminIds =
      await this.userChannelsService.getChannelAdminsByTelegramChatId(
        messageData.chatId,
      );

    if (adminIds.length === 0) {
      this.logger.warn(
        `No admins found for channel ${messageData.chatId}, notifications not sent`,
      );
      return;
    }

    // Формируем текст и кнопки
    const text = this.buildNotificationText(messageData, categories);
    const keyboard = this.buildNotificationKeyboard(
      messageId,
      messageData.chatId,
      messageData.messageId,
      messageData.chatType,
      messageData.chatUsername,
    );

    // Отправляем каждому админу
    for (const adminId of adminIds) {
      try {
        await ctx.telegram.sendMessage(adminId, text, keyboard);

        this.logger.debug(
          `Notification sent to admin ${adminId} for message ${messageId}`,
        );
      } catch (error) {
        this.logger.warn(
          `Failed to send notification to admin ${adminId}: ${error.message}`,
        );
      }
    }
  }

  /**
   * Формирование текста уведомления
   */
  private buildNotificationText(
    messageData: GroupMessageData,
    categories: string[],
  ): string {
    const channelName = messageData.chatTitle || `ID: ${messageData.chatId}`;
    const categoriesTags = categories.map((c) => `#${c}`).join(' ');
    const preview = messageData.text
      ? messageData.text.length > 100
        ? messageData.text.substring(0, 100) + '...'
        : messageData.text
      : '(нет текста)';

    return `📩 Важное сообщение в канале "${channelName}"\n\nКатегории: ${categoriesTags}\n\n${preview}`;
  }

  /**
   * Формирование клавиатуры с кнопками
   */
  private buildNotificationKeyboard(
    messageId: string,
    chatId: number,
    telegramMessageId: number,
    chatType: string,
    username?: string | null,
  ) {
    const messageLink = buildMessageLink(
      chatId,
      telegramMessageId,
      chatType,
      username,
    );

    return Markup.inlineKeyboard([
      [
        Markup.button.url('Открыть', messageLink),
        Markup.button.callback('Готово', IMPORTANT_MESSAGES_CB.done(messageId)),
      ],
    ]);
  }

  /**
   * Обработка callback от кнопок
   */
  async handleCallback(ctx: Context, data: string): Promise<void> {
    const parts = data.split(':');
    const action = parts[1] as ImportantMessagesAction;

    switch (action) {
      case ImportantMessagesAction.Done:
        return this.handleDoneAction(ctx);

      default:
        if ('answerCbQuery' in ctx && typeof ctx.answerCbQuery === 'function') {
          await ctx.answerCbQuery();
        }
    }
  }

  /**
   * Обработка нажатия кнопки "Готово"
   */
  private async handleDoneAction(ctx: Context): Promise<void> {
    try {
      if ('deleteMessage' in ctx && typeof ctx.deleteMessage === 'function') {
        await ctx.deleteMessage();
      }

      if ('answerCbQuery' in ctx && typeof ctx.answerCbQuery === 'function') {
        await ctx.answerCbQuery('✅ Готово');
      }
    } catch (error) {
      this.logger.error(
        `Error handling done action: ${error.message}`,
        error.stack,
      );

      if ('answerCbQuery' in ctx && typeof ctx.answerCbQuery === 'function') {
        await ctx.answerCbQuery('Ошибка');
      }
    }
  }
}
