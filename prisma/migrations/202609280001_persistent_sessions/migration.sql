ALTER TABLE `Session` MODIFY `expiresAt` DATETIME(3) NULL;
UPDATE `Session` SET `expiresAt` = NULL WHERE `revokedAt` IS NULL AND `expiresAt` > CURRENT_TIMESTAMP(3);
ALTER TABLE `RefreshToken` ADD COLUMN `replacementHash` CHAR(64) NULL;
