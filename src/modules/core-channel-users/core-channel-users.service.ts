import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Channel } from '../channel/channel.entity';
import { ChannelPost } from '../channel-posts/channel-post.entity';
import {
  CoreChannelUsersComment,
  CoreCommentAuthorType,
} from './core-channel-users-comment.entity';
import { CoreChannelUsersPostCommentsSync } from './core-channel-users-post-comments-sync.entity';
import { CoreChannelUsersChannelSync } from './core-channel-users-channel-sync.entity';
import { User } from '../user/user.entity';
import { TelegramCoreService } from '../../telegram-core/telegram-core.service';
import { Api } from 'telegram';

const SYNC_WINDOW_DAYS = 90;
const SYNC_COOLDOWN_DAYS = 1;
const TOP_USERS_AMOUNT = 10;

// Гибридная логика по возрасту постов
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const FRESH_POST_DAYS = 3; // 0–3 дня - всегда ресинк при синке канала
const MEDIUM_POST_DAYS = 10; // 3–10 дней - периодический ресинк
const MEDIUM_RESYNC_INTERVAL_HOURS = 48;
const MEDIUM_RESYNC_INTERVAL_MS = MEDIUM_RESYNC_INTERVAL_HOURS * 60 * 60 * 1000; // интервал для пересинхронизации постов средней давности в миллисекундах

export interface CoreUserReportItem {
  telegramUserId: number;
  commentsCount: number;
  postsCount: number;
  avgCommentsPerActivePost: number;
}

export type CoreChannelUsersReportResult = {
  type: 'ok' | 'no-data';
  syncedWithTelegram: boolean;
  items: CoreUserReportItem[];
  windowFrom: Date;
  windowTo: Date;
};

@Injectable()
export class CoreChannelUsersService {
  private readonly logger = new Logger(CoreChannelUsersService.name);

  constructor(
    @InjectRepository(Channel)
    private readonly channelRepo: Repository<Channel>,
    @InjectRepository(ChannelPost)
    private readonly channelPostRepo: Repository<ChannelPost>,
    @InjectRepository(CoreChannelUsersComment)
    private readonly commentRepo: Repository<CoreChannelUsersComment>,
    @InjectRepository(CoreChannelUsersPostCommentsSync)
    private readonly postSyncRepo: Repository<CoreChannelUsersPostCommentsSync>,
    @InjectRepository(CoreChannelUsersChannelSync)
    private readonly channelSyncRepo: Repository<CoreChannelUsersChannelSync>,
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    private readonly telegramCoreService: TelegramCoreService,
  ) {}

  /**
   * Строит отчёт по ядру комментаторов для канала:
   * - Проверяет cooldown (не чаще 1 раза в день);
   * - При необходимости синхронизирует посты и комментарии (гибридная схема 0–3 / 3–10 / >10 дней);
   * - Чистит комментарии, вышедшие за окно;
   * - Считает топ N пользователей по числу комментариев за окно.
   */
  async buildCoreUsersReportForChannel(
    telegramChatId: number,
  ): Promise<CoreChannelUsersReportResult> {
    const now = new Date();
    const windowTo = now;
    const windowFrom = new Date(now.getTime() - SYNC_WINDOW_DAYS * MS_PER_DAY);

    // 1. Находим канал по telegram_chat_id
    const channel = await this.channelRepo.findOne({
      where: { telegram_chat_id: telegramChatId },
    });

    if (!channel) {
      this.logger.warn(
        `buildCoreUsersReportForChannel: channel with telegram_chat_id=${telegramChatId} not found`,
      );
      return {
        type: 'no-data',
        syncedWithTelegram: false,
        items: [],
        windowFrom,
        windowTo,
      };
    }

    // 2. Проверяем лимиты и при необходимости синкаем
    const { synced } = await this.syncChannel(channel, windowFrom);

    // 3. Чистим устаревшие комментарии за пределами окна
    await this.cleanupOldComments(windowFrom);

    // 4. Считаем топ пользователей
    const items = await this.loadTopUsersForChannel(
      channel,
      windowFrom,
      windowTo,
    );

    if (!items.length) {
      return {
        type: 'no-data',
        syncedWithTelegram: synced,
        items: [],
        windowFrom,
        windowTo,
      };
    }

    return {
      type: 'ok',
      syncedWithTelegram: synced,
      items,
      windowFrom,
      windowTo,
    };
  }

  /**
   * Проверка cooldown по каналу и запуск синка.
   *
   * ВАЖНО:
   * - Если cooldown ещё не прошёл, в Telegram не идём, возвращаем synced=false.
   * - Если синк разрешён, мы ВСЕГДА обновляем lastSyncedAt для канала,
   *   даже если новых/подходящих постов не нашлось (чтобы нельзя было абузить).
   */
  private async syncChannel(
    channel: Channel,
    windowFrom: Date,
  ): Promise<{ synced: boolean }> {
    const now = new Date();
    const cooldownMs = SYNC_COOLDOWN_DAYS * MS_PER_DAY;

    let channelSync = await this.channelSyncRepo.findOne({
      where: { channel: { id: channel.id } },
      relations: ['channel'],
    });

    if (
      channelSync &&
      now.getTime() - channelSync.lastSyncedAt.getTime() < cooldownMs
    ) {
      this.logger.debug(
        `syncChannel: channel=${channel.id}, cooldown not passed, skip sync`,
      );
      return { synced: false };
    }

    // Перед синком фиксируем максимальный telegram_post_id, который уже есть в БД.
    const lastPostBefore = await this.channelPostRepo
      .createQueryBuilder('p')
      .where('p.channel_id = :channelId', { channelId: channel.id })
      .orderBy('p.telegram_post_id', 'DESC')
      .getOne();

    const maxTelegramPostIdBefore = lastPostBefore
      ? Number(lastPostBefore.telegram_post_id)
      : 0;

    await this.syncPostsAndCommentsForChannel(
      channel,
      windowFrom,
      now,
      maxTelegramPostIdBefore,
    );

    if (!channelSync) {
      channelSync = this.channelSyncRepo.create({
        channel,
        channelId: channel.id,
        lastSyncedAt: now,
      });
    } else {
      channelSync.lastSyncedAt = now;
    }

    await this.channelSyncRepo.save(channelSync);

    return { synced: true };
  }

  /**
   * Гибридная синхронизация:
   * 1) Сначала подтягиваем ВСЕ новые посты (id > maxTelegramPostIdBefore),
   *    для каждого сразу синкаем все комментарии.
   * 2) Затем для уже существующих постов внутри окна:
   *    - 0–3 дней: всегда пересинхронизируем комментарии;
   *    - 3–10 дней: пересинхронизируем, если прошло >= 48 часов с последнего синка поста;
   *    - >10 дней: больше не трогаем (используем только уже накопленные комментарии).
   */
  private async syncPostsAndCommentsForChannel(
    channel: Channel,
    windowFrom: Date,
    now: Date,
    maxTelegramPostIdBefore: number,
  ): Promise<void> {
    if (!channel.username) {
      this.logger.warn(
        `syncPostsAndCommentsForChannel: channel ${channel.id} has no username, cannot resolve via Core API`,
      );
      return;
    }

    const client = await this.telegramCoreService.getClient();
    const username = channel.username;

    this.logger.debug(
      `syncPostsAndCommentsForChannel: syncing posts & comments for @${username}`,
    );

    const tgChannel = await client.getEntity(username);

    // 1) Новые посты (id > maxTelegramPostIdBefore)
    await this.syncNewPosts(
      client,
      tgChannel,
      channel,
      windowFrom,
      now,
      maxTelegramPostIdBefore,
    );

    // 2) Ресинк уже существующих постов
    await this.syncExistingPosts(
      client,
      tgChannel,
      channel,
      windowFrom,
      now,
      maxTelegramPostIdBefore,
    );
  }

  /**
   * Синхронизируем только новые посты (id > maxTelegramPostIdBefore)
   * и все комментарии к ним (с пагинацией по комментариям).
   */
  private async syncNewPosts(
    client: any,
    tgChannel: any,
    channel: Channel,
    windowFrom: Date,
    now: Date,
    maxTelegramPostIdBefore: number,
  ): Promise<void> {
    let minId = maxTelegramPostIdBefore;
    this.logger.debug(
      `syncNewPosts: start fetching posts for channel=${channel.id} with minId=${minId}`,
    );

    while (true) {
      const messages = await client.getMessages(tgChannel, {
        limit: 100,
        minId,
      });

      if (!messages || messages.length === 0) {
        break;
      }

      let batchMaxId = minId;

      for (const msg of messages) {
        const post = msg as Api.Message;
        if (!post || typeof post.id !== 'number') continue;

        const postId = post.id;
        if (postId <= minId) {
          continue;
        }

        const rawPostDate: any = (post as any).date;
        const publishedAt =
          rawPostDate instanceof Date
            ? rawPostDate
            : new Date(rawPostDate * 1000);

        let channelPost = await this.channelPostRepo.findOne({
          where: {
            channel: { id: channel.id },
            telegram_post_id: postId,
          },
          relations: ['channel'],
        });

        if (!channelPost) {
          channelPost = this.channelPostRepo.create({
            channel,
            telegram_post_id: postId,
            published_at: publishedAt,
          });
          await this.channelPostRepo.save(channelPost);
        }

        // Если Telegram уже знает, что комментариев нет - не ходим за реплаями.
        if (post.replies && post.replies.replies && post.replies.replies > 0) {
          await this.syncCommentsForPost(
            client,
            tgChannel,
            channelPost,
            windowFrom,
            now,
          );
        } else {
          // Но сам факт синка поста фиксируем
          await this.touchPostSync(channelPost, now);
        }

        if (postId > batchMaxId) {
          batchMaxId = postId;
        }
      }

      if (batchMaxId === minId) {
        break;
      }

      minId = batchMaxId;

      if (messages.length < 100) {
        break;
      }
    }
  }

  /**
   * Гибридный ресинк уже существующих постов (которые были в БД до этого синка):
   *
   * - Берём посты с telegram_post_id <= maxTelegramPostIdBefore
   *   и published_at в диапазоне последних 10 дней.
   * - Для постов 0–3 дней - всегда обновляем комментарии.
   * - Для постов 3–10 дней - обновляем, только если с последнего синка поста прошло >= 48 часов.
   * - Посты старше 10 дней не попадают в выборку и не ресинкутся вообще.
   */
  private async syncExistingPosts(
    client: any,
    tgChannel: any,
    channel: Channel,
    windowFrom: Date,
    now: Date,
    maxTelegramPostIdBefore: number,
  ): Promise<void> {
    const mediumFromDate = new Date(
      now.getTime() - MEDIUM_POST_DAYS * MS_PER_DAY,
    );

    // Берём все посты канала, которые:
    // - были созданы раньше/равно maxTelegramPostIdBefore;
    // - моложе 10 дней (т.е. published_at >= mediumFromDate).
    const posts = await this.channelPostRepo
      .createQueryBuilder('p')
      .innerJoin('p.channel', 'ch')
      .where('ch.id = :channelId', { channelId: channel.id })
      .andWhere('p.telegram_post_id <= :maxId', {
        maxId: maxTelegramPostIdBefore,
      })
      .andWhere('p.published_at >= :from', { from: mediumFromDate })
      .getMany();

    if (!posts.length) {
      return;
    }

    for (const channelPost of posts) {
      const ageMs = now.getTime() - channelPost.published_at.getTime();
      const ageDays = ageMs / MS_PER_DAY;

      let needResync = false;

      if (ageDays <= FRESH_POST_DAYS) {
        // Пост младше или равен 3 дням - всегда ресинк.
        needResync = true;
      } else if (ageDays <= MEDIUM_POST_DAYS) {
        // 3–10 дней - ресинк по интервалу 48 часов
        const postSync = await this.postSyncRepo.findOne({
          where: { post: { id: channelPost.id } },
          relations: ['post'],
        });

        if (!postSync) {
          needResync = true;
        } else {
          const diffMs = now.getTime() - postSync.last_synced_at.getTime();
          if (diffMs >= MEDIUM_RESYNC_INTERVAL_MS) {
            needResync = true;
          }
        }
      } else {
        // >10 дней - игнорируем (не пересинхронизируем совсем)
        needResync = false;
      }

      if (!needResync) {
        continue;
      }

      await this.syncCommentsForPost(
        client,
        tgChannel,
        channelPost,
        windowFrom,
        now,
      );
    }
  }

  /**
   * Синхронизирует ВСЕ комментарии к конкретному посту:
   * - Полноценная пагинация по комментариям (limit=100, offsetId),
   * - Отсечение по окну по дате комментария,
   * - orIgnore по (post_id, telegram_comment_id), чтобы не плодить дубли,
   * - Обновление last_synced_at для CoreChannelUsersPostCommentsSync.
   */
  private async syncCommentsForPost(
    client: any,
    tgChannel: any,
    channelPost: ChannelPost,
    windowFrom: Date,
    now: Date,
  ): Promise<void> {
    const postId = Number(channelPost.telegram_post_id);
    let offsetId = 0;
    let stopByWindow = false;

    this.logger.debug(
      `syncCommentsForPost: syncing comments for post ${postId} (channelPost.id=${channelPost.id})`,
    );

    while (!stopByWindow) {
      const replies = await client.getMessages(tgChannel, {
        replyTo: postId,
        limit: 100,
        offsetId,
      });

      if (!replies || replies.length === 0) {
        break;
      }

      for (const reply of replies) {
        const r = reply as Api.Message;
        if (!r) continue;

        const rawCommentDate: any = (r as any).date;
        const commentedAt =
          rawCommentDate instanceof Date
            ? rawCommentDate
            : new Date(rawCommentDate * 1000);

        // Если комментарий старше окна - считаем, что дальше будут ещё старше.
        if (commentedAt < windowFrom) {
          stopByWindow = true;
          continue;
        }

        // Идентификатор комментария в рамках канала
        const telegramCommentId = Number(r.id);

        // Определяем автора комментария по fromId:
        // PeerUser - обычный пользователь или бот
        // PeerChannel - комментарий от лица канала (своего или чужого)
        // PeerChat - групповой peer (редкий / legacy кейс)
        let authorTelegramId: number | undefined;
        let authorType: CoreCommentAuthorType;

        const fromId = r.fromId;

        if (fromId instanceof Api.PeerUser) {
          authorTelegramId = Number(fromId.userId);
          authorType = 'user';
        } else if (fromId instanceof Api.PeerChannel) {
          authorTelegramId = Number(fromId.channelId);
          authorType = 'channel';
        } else if (fromId instanceof Api.PeerChat) {
          authorTelegramId = Number(fromId.chatId);
          authorType = 'chat';
        } else {
          this.logger.debug(
            `syncCommentsForPost: skip comment without resolvable author (messageId=${telegramCommentId})`,
          );
          continue;
        }

        if (!authorTelegramId) {
          this.logger.debug(
            `syncCommentsForPost: skip comment without authorTelegramId (messageId=${telegramCommentId})`,
          );
          continue;
        }

        // Апсертим автора в users по telegram_user_id (это может быть человек, канал или чат).
        await this.userRepo.upsert(
          { telegram_user_id: authorTelegramId },
          { conflictPaths: ['telegram_user_id'] },
        );

        const user = await this.userRepo.findOne({
          where: { telegram_user_id: authorTelegramId },
        });

        if (!user) {
          this.logger.warn(
            `syncCommentsForPost: failed to find user after upsert, telegram_user_id=${authorTelegramId}`,
          );
          continue;
        }

        // Сохраняем комментарий, избегая дублей по (post_id, telegram_comment_id)
        await this.commentRepo
          .createQueryBuilder()
          .insert()
          .into(CoreChannelUsersComment)
          .values({
            post: { id: channelPost.id },
            user: { id: user.id },
            telegram_comment_id: telegramCommentId,
            author_type: authorType,
            commented_at: commentedAt,
          })
          .orIgnore()
          .execute();
      }

      const last = replies[replies.length - 1] as Api.Message;
      if (!last || typeof last.id !== 'number') {
        break;
      }

      offsetId = last.id;

      if (replies.length < 100) {
        break;
      }
    }

    await this.touchPostSync(channelPost, now);
  }

  /**
   * Обновляет / создаёт запись синка по посту.
   */
  private async touchPostSync(
    channelPost: ChannelPost,
    now: Date,
  ): Promise<void> {
    let postSync = await this.postSyncRepo.findOne({
      where: { post: { id: channelPost.id } },
      relations: ['post'],
    });

    if (!postSync) {
      postSync = this.postSyncRepo.create({
        post: channelPost,
        last_synced_at: now,
      });
    } else {
      postSync.last_synced_at = now;
    }

    await this.postSyncRepo.save(postSync);
  }

  /**
   * Удаляем комментарии, которые вышли за пределы окна.
   */
  private async cleanupOldComments(windowFrom: Date): Promise<void> {
    this.logger.debug(
      `cleanupOldComments: deleting comments older than ${windowFrom.toISOString()}`,
    );

    await this.commentRepo
      .createQueryBuilder()
      .delete()
      .where('commented_at < :from', { from: windowFrom })
      .execute();
  }

  /**
   * Загружает топ N пользователей по числу комментариев за окно по конкретному каналу.
   * Считает количество постов, в которых пользователь комментировал,
   * и среднее число комментариев на активный пост для этого пользователя.
   */
  private async loadTopUsersForChannel(
    channel: Channel,
    windowFrom: Date,
    windowTo: Date,
  ): Promise<CoreUserReportItem[]> {
    const qb = this.commentRepo
      .createQueryBuilder('c')
      .innerJoin('c.post', 'p')
      .innerJoin('p.channel', 'ch')
      .innerJoin('c.user', 'u')
      .where('ch.id = :channelId', { channelId: channel.id })
      .andWhere('c.commented_at BETWEEN :from AND :to', {
        from: windowFrom,
        to: windowTo,
      })
      .select('u.telegram_user_id', 'telegram_user_id')
      .addSelect('COUNT(*)', 'comments_count')
      .addSelect('COUNT(DISTINCT c.post_id)', 'posts_count')
      .groupBy('u.telegram_user_id')
      .orderBy('comments_count', 'DESC')
      .limit(TOP_USERS_AMOUNT);

    const raw = await qb.getRawMany<{
      telegram_user_id: string;
      comments_count: string;
      posts_count: string;
    }>();

    return raw.map((row) => {
      const commentsCount = Number(row.comments_count) || 0;
      const postsCount = Number(row.posts_count) || 1;
      const avg = commentsCount / postsCount;

      return {
        telegramUserId: Number(row.telegram_user_id),
        commentsCount,
        postsCount,
        avgCommentsPerActivePost: avg,
      };
    });
  }
}
