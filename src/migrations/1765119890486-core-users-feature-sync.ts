import { MigrationInterface, QueryRunner } from 'typeorm';

export class CoreUsersFeatureSync1765119890486 implements MigrationInterface {
  name = 'CoreUsersFeatureSync1765119890486';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "core_channel_users_channel_sync" ("channel_id" uuid NOT NULL, "last_synced_at" TIMESTAMP NOT NULL, CONSTRAINT "PK_41494b555ab182fcc6e02d0df1c" PRIMARY KEY ("channel_id"))`,
    );
    await queryRunner.query(
      `ALTER TABLE "channels" ADD "username" character varying(255)`,
    );
    await queryRunner.query(
      `ALTER TABLE "core_channel_users_comments" ADD "telegram_comment_id" bigint NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "core_channel_users_comments" ADD "author_type" character varying(16) NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "channels" DROP CONSTRAINT "UQ_7597393cf08dada8010f93b6c86"`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "core_comments_post_comment_unique" ON "core_channel_users_comments" ("post_id", "telegram_comment_id") `,
    );
    await queryRunner.query(
      `ALTER TABLE "core_channel_users_channel_sync" ADD CONSTRAINT "FK_41494b555ab182fcc6e02d0df1c" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "core_channel_users_channel_sync" DROP CONSTRAINT "FK_41494b555ab182fcc6e02d0df1c"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."core_comments_post_comment_unique"`,
    );
    await queryRunner.query(
      `ALTER TABLE "channels" ADD CONSTRAINT "UQ_7597393cf08dada8010f93b6c86" UNIQUE ("telegram_chat_id")`,
    );
    await queryRunner.query(
      `ALTER TABLE "core_channel_users_comments" DROP COLUMN "author_type"`,
    );
    await queryRunner.query(
      `ALTER TABLE "core_channel_users_comments" DROP COLUMN "telegram_comment_id"`,
    );
    await queryRunner.query(`ALTER TABLE "channels" DROP COLUMN "username"`);
    await queryRunner.query(`DROP TABLE "core_channel_users_channel_sync"`);
  }
}
