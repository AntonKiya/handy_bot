import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity('channels')
export class Channel {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * Идентификатор чата (-1042...).
   */
  @Column({ type: 'bigint', unique: true })
  telegram_chat_id: number;

  /**
   * Username канала (без @)
   */
  @Column({ type: 'varchar', length: 255, nullable: true, unique: true })
  username: string | null;
}
