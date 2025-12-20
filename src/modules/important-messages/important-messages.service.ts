import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ImportantMessage } from './important-message.entity';
import { Channel } from '../channel/channel.entity';
import { CategorizationService } from './categorization.service';
import { GroupMessageData } from '../../telegram-bot/utils/types';
import { getWordCount } from './utils/text-normalizer.util';
import { MIN_WORD_COUNT } from './important-messages.constants';

@Injectable()
export class ImportantMessagesService {
  private readonly logger = new Logger(ImportantMessagesService.name);

  constructor(
    @InjectRepository(ImportantMessage)
    private readonly importantMessageRepository: Repository<ImportantMessage>,
    @InjectRepository(Channel)
    private readonly channelRepository: Repository<Channel>,
    private readonly categorizationService: CategorizationService,
  ) {}

  /**
   * Обработка входящего сообщения из группы
   * Возвращает категории если сообщение важное, иначе null
   *
   * Вызывается из Router
   */
  async processGroupMessage(
    messageData: GroupMessageData,
  ): Promise<string[] | null> {
    const { text, messageId, chatId } = messageData;

    // Проверка наличия текста
    if (!text || text.trim().length === 0) {
      this.logger.debug(`No text in message ${messageId}, skipping`);
      return null;
    }

    // Проверка минимальной длины
    const wordCount = getWordCount(text);
    if (wordCount < MIN_WORD_COUNT) {
      this.logger.debug(
        `Message ${messageId} too short (${wordCount} words), skipping`,
      );
      return null;
    }

    // Получаем канал из БД
    const channel = await this.getChannelByTelegramChatId(chatId);

    if (!channel) {
      this.logger.debug(
        `Channel not found for chat_id ${chatId}, skipping message`,
      );
      return null;
    }

    // Категоризация сообщения
    const result = await this.categorizationService.categorizeMessage({
      text,
      channelId: channel.id,
    });

    // Если нет категорий - сообщение не важное
    if (result.categories.length === 0) {
      this.logger.debug(
        `Message ${messageId} in chat ${chatId} is not important`,
      );
      return null;
    }

    this.logger.log(
      `Important message detected: ${messageId} in chat ${chatId}, categories: ${result.categories.join(', ')}`,
    );

    return result.categories;
  }

  /**
   * Сохранение важного сообщения в БД
   *
   * Вызывается из Flow
   */
  async saveImportantMessage(params: {
    channelId: string;
    telegramMessageId: number;
    telegramUserId: number;
    text: string | null;
  }): Promise<ImportantMessage> {
    const { channelId, telegramMessageId, telegramUserId, text } = params;

    const importantMessage = this.importantMessageRepository.create({
      channel: { id: channelId },
      telegram_message_id: telegramMessageId,
      telegram_user_id: telegramUserId,
      text,
      notified_at: null,
    });

    const saved = await this.importantMessageRepository.save(importantMessage);

    this.logger.debug(`Saved important message: id=${saved.id}`);

    return saved;
  }

  /**
   * Обновление времени отправки уведомления
   *
   * Вызывается из Flow
   */
  async updateNotifiedAt(messageId: string): Promise<void> {
    await this.importantMessageRepository.update(
      { id: messageId },
      { notified_at: new Date() },
    );
  }

  /**
   * Получение канала по telegram_chat_id
   */
  async getChannelByTelegramChatId(
    telegramChatId: number,
  ): Promise<Channel | null> {
    return this.channelRepository.findOne({
      where: { telegram_chat_id: telegramChatId },
    });
  }
}
