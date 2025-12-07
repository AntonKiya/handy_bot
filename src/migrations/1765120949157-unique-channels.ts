import { MigrationInterface, QueryRunner } from 'typeorm';

export class UniqueChannels1765120949157 implements MigrationInterface {
  name = 'UniqueChannels1765120949157';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "channels" ADD CONSTRAINT "UQ_7597393cf08dada8010f93b6c86" UNIQUE ("telegram_chat_id")`,
    );
    await queryRunner.query(
      `ALTER TABLE "channels" ADD CONSTRAINT "UQ_4d05b2b1f37b07db352912523dd" UNIQUE ("username")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "channels" DROP CONSTRAINT "UQ_4d05b2b1f37b07db352912523dd"`,
    );
    await queryRunner.query(
      `ALTER TABLE "channels" DROP CONSTRAINT "UQ_7597393cf08dada8010f93b6c86"`,
    );
  }
}
