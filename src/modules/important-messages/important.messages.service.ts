import { Injectable, Logger } from '@nestjs/common';
import { Context } from 'telegraf';
import { CategorizationService } from './categorization.service';
import { ImportantMessagesFlow } from './important-messages.flow';
import { GroupMessageData } from '../../telegram-bot/utils/types';
import { getWordCount } from './utils/text-normalizer.util';
import { MIN_WORD_COUNT } from './important-messages.constants';

@Injectable()
export class ImportantMessagesProcessorService {
  private readonly logger = new Logger(ImportantMessagesProcessorService.name);

  constructor(
    private readonly categorizationService: CategorizationService,
    private readonly importantMessagesFlow: ImportantMessagesFlow,
  ) {}

  /**
   * Обработка входящего сообщения из группы
   * Определяет важность и отправляет уведомления через flow
   */
  async processGroupMessage(
    ctx: Context,
    messageData: GroupMessageData,
    channelId: string,
  ): Promise<void> {
    const { text, messageId, chatId } = messageData;

    // Проверка наличия текста
    if (!text || text.trim().length === 0) {
      this.logger.debug(`No text in message ${messageId}, skipping`);
      return;
    }

    // Проверка минимальной длины
    const wordCount = getWordCount(text);
    if (wordCount < MIN_WORD_COUNT) {
      this.logger.debug(
        `Message ${messageId} too short (${wordCount} words), skipping`,
      );
      return;
    }

    // Категоризация сообщения
    const result = await this.categorizationService.categorizeMessage({
      text,
      channelId,
    });

    // Если нет категорий - сообщение не важное
    if (result.categories.length === 0) {
      this.logger.debug(
        `Message ${messageId} in chat ${chatId} is not important`,
      );
      return;
    }

    this.logger.log(
      `Important message detected: ${messageId} in chat ${chatId}, categories: ${result.categories.join(', ')}`,
    );

    // Отправляем уведомления через flow
    await this.importantMessagesFlow.handleIncomingGroupMessage(
      ctx,
      messageData,
      result.categories,
    );
  }
}
