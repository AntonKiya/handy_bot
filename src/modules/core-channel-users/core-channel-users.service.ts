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
   * Проверяет лимиты (не чаще 1 раза в 1 день),
   * при необходимости синкает свежие посты и их комментарии,
   * чистит комментарии, вышедшие из окна,
   * считает топ N пользователей по числу комментариев за окно.
   */
  async buildCoreUsersReportForChannel(
    telegramChatId: number,
  ): Promise<CoreChannelUsersReportResult> {
    const now = new Date();
    const windowTo = now;
    const windowFrom = new Date(
      now.getTime() - SYNC_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    );

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
   * Note:
   * - Если лимит по времени ещё не вышел, синхронизации с Telegram не происходит,
   *   Возвращяется synced = false (данные берём из БД как есть).
   * - Если синк разрешён, мы всегда обновляем last_synced_at для канала,
   *   даже если новых постов не оказалось, чтобы пользователь не нагружал API Telegram.
   */
  private async syncChannel(
    channel: Channel,
    windowFrom: Date,
  ): Promise<{ synced: boolean }> {
    const now = new Date();
    const cooldownMs = SYNC_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;

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

    // Синк разрешён - обновляем данные по новым постам.
    await this.syncNewPostsForChannel(channel, windowFrom, now);

    // Обновляем / создаём запись о синке канала
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
   * TODO:
   * MVP: Синхронизируем только НОВЫЕ посты канала (те, которых ещё нет в channel_posts),
   * забираем по ним комментарии и сохраняем всё в БД.
   *
   * ВАЖНО:
   * - Не пересинхронизируем старые посты (поэтому late-комменты к старым постам MVP не увидит).
   * - Берём посты только "сверху" — с ID больше максимального, который у нас уже есть.
   * - Запросы к Telegram делаем с лимитом и оставляем TODO для полноценной пагинации.
   */
  private async syncNewPostsForChannel(
    channel: Channel,
    windowFrom: Date,
    now: Date,
  ): Promise<void> {
    if (!channel.username) {
      this.logger.warn(
        `syncNewPostsForChannel: channel ${channel.id} has no username, cannot resolve via Core API`,
      );
      return;
    }

    const client = await this.telegramCoreService.getClient();
    const username = channel.username;

    this.logger.debug(
      `syncNewPostsForChannel: fetching new posts for @${username}`,
    );

    const tgChannel = await client.getEntity(username);

    // Находим максимальный telegram_post_id, который у нас уже есть для этого канала
    const lastPost = await this.channelPostRepo
      .createQueryBuilder('p')
      .where('p.channel_id = :channelId', { channelId: channel.id })
      .orderBy('p.telegram_post_id', 'DESC')
      .getOne();

    const minId = lastPost ? Number(lastPost.telegram_post_id) : 0;

    // Берём новые посты с ID > minId
    // TODO: добавить полноценную пагинацию (offsetId / addOffset), если постов очень много.
    const posts = await client.getMessages(tgChannel, {
      limit: 100,
      minId,
    });

    this.logger.debug(
      `syncNewPostsForChannel: fetched ${posts.length} new posts for @${username} (minId=${minId})`,
    );

    for (const msg of posts) {
      const post = msg as Api.Message;

      if (!post || typeof post.id !== 'number') {
        continue;
      }

      const postId = post.id;
      const rawPostDate: any = (post as any).date;
      const publishedAt =
        rawPostDate instanceof Date
          ? rawPostDate
          : new Date(rawPostDate * 1000);

      // Ищем и создаём  запись поста
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

      // Пропускаем, если у поста нет комментариев
      if (
        !post.replies ||
        !post.replies.replies ||
        post.replies.replies === 0
      ) {
        continue;
      }

      // Получаем комментарии к этому посту
      // TODO: добавить пагинацию по комментариям (если их > 100).
      const replies = await client.getMessages(tgChannel, {
        replyTo: postId,
        limit: 100,
      });

      for (const reply of replies) {
        const r = reply as Api.Message;
        if (!r) continue;

        // Дата комментария
        const rawCommentDate: any = (r as any).date;
        const commentedAt =
          rawCommentDate instanceof Date
            ? rawCommentDate
            : new Date(rawCommentDate * 1000);

        // Отсекаем комментарии, которые уже вышли за окно
        if (commentedAt < windowFrom) {
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
            `syncNewPostsForChannel: skip comment without resolvable author (messageId=${telegramCommentId})`,
          );
          continue;
        }

        if (!authorTelegramId) {
          this.logger.debug(
            `syncNewPostsForChannel: skip comment without authorTelegramId (messageId=${telegramCommentId})`,
          );
          continue;
        }

        // Апсертим автора в users по telegram_user_id.
        await this.userRepo.upsert(
          { telegram_user_id: authorTelegramId },
          { conflictPaths: ['telegram_user_id'] },
        );

        const user = await this.userRepo.findOne({
          where: { telegram_user_id: authorTelegramId },
        });

        if (!user) {
          this.logger.warn(
            `syncNewPostsForChannel: failed to find user after upsert, telegram_user_id=${authorTelegramId}`,
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

      // Отмечаем, что по этому посту мы синкались
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
   * и среднее число комментариев на пост для этого пользователя.
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
