import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitSchema1764962457880 implements MigrationInterface {
  name = 'InitSchema1764962457880';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "users" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "telegram_user_id" bigint NOT NULL, CONSTRAINT "UQ_903574be044ba37381996813b12" UNIQUE ("telegram_user_id"), CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "channels" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "telegram_chat_id" bigint NOT NULL, CONSTRAINT "UQ_7597393cf08dada8010f93b6c86" UNIQUE ("telegram_chat_id"), CONSTRAINT "PK_bc603823f3f741359c2339389f9" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "user_channels" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "is_admin" boolean NOT NULL DEFAULT false, "user_id" uuid NOT NULL, "channel_id" uuid NOT NULL, CONSTRAINT "UQ_user_channels_user_id_channel_id" UNIQUE ("user_id", "channel_id"), CONSTRAINT "PK_2a8ce798a5c5e04ac12aaeb9111" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `ALTER TABLE "user_channels" ADD CONSTRAINT "FK_edf33f6c237b06704f3d57542cd" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "user_channels" ADD CONSTRAINT "FK_16f3639f33054083eb7a458cd0f" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user_channels" DROP CONSTRAINT "FK_16f3639f33054083eb7a458cd0f"`,
    );
    await queryRunner.query(
      `ALTER TABLE "user_channels" DROP CONSTRAINT "FK_edf33f6c237b06704f3d57542cd"`,
    );
    await queryRunner.query(`DROP TABLE "user_channels"`);
    await queryRunner.query(`DROP TABLE "channels"`);
    await queryRunner.query(`DROP TABLE "users"`);
  }
}
