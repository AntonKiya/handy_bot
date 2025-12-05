import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity('channels')
export class Channel {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'bigint', unique: true })
  telegram_chat_id: number;
}
