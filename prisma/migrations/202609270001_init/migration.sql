-- CreateTable
CREATE TABLE `User` (
    `id` CHAR(36) NOT NULL,
    `email` VARCHAR(254) NOT NULL,
    `passwordHash` VARCHAR(255) NOT NULL,
    `emailVerifiedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `User_email_key`(`email`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Session` (
    `id` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `accessHash` CHAR(64) NOT NULL,
    `accessExpiresAt` DATETIME(3) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `revokedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `Session_accessHash_key`(`accessHash`),
    INDEX `Session_userId_revokedAt_idx`(`userId`, `revokedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `RefreshToken` (
    `id` CHAR(36) NOT NULL,
    `hash` CHAR(64) NOT NULL,
    `sessionId` CHAR(36) NOT NULL,
    `usedAt` DATETIME(3) NULL,

    UNIQUE INDEX `RefreshToken_hash_key`(`hash`),
    INDEX `RefreshToken_sessionId_idx`(`sessionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ActionToken` (
    `id` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `hash` CHAR(64) NOT NULL,
    `purpose` ENUM('VERIFY_EMAIL', 'RESET_PASSWORD') NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `usedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `ActionToken_hash_key`(`hash`),
    INDEX `ActionToken_userId_purpose_usedAt_idx`(`userId`, `purpose`, `usedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Node` (
    `id` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `name` VARCHAR(80) NOT NULL,
    `platform` VARCHAR(32) NOT NULL,
    `keyHash` CHAR(64) NOT NULL,
    `lastSeenAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `Node_userId_createdAt_idx`(`userId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Connection` (
    `id` CHAR(36) NOT NULL,
    `nodeId` CHAR(36) NOT NULL,
    `requesterSessionId` CHAR(36) NOT NULL,
    `status` ENUM('PENDING', 'ACCEPTED', 'REJECTED', 'CLOSED', 'EXPIRED') NOT NULL DEFAULT 'PENDING',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expiresAt` DATETIME(3) NOT NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Connection_nodeId_status_idx`(`nodeId`, `status`),
    INDEX `Connection_requesterSessionId_status_idx`(`requesterSessionId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Session` ADD CONSTRAINT `Session_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `RefreshToken` ADD CONSTRAINT `RefreshToken_sessionId_fkey` FOREIGN KEY (`sessionId`) REFERENCES `Session`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ActionToken` ADD CONSTRAINT `ActionToken_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Node` ADD CONSTRAINT `Node_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Connection` ADD CONSTRAINT `Connection_nodeId_fkey` FOREIGN KEY (`nodeId`) REFERENCES `Node`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Connection` ADD CONSTRAINT `Connection_requesterSessionId_fkey` FOREIGN KEY (`requesterSessionId`) REFERENCES `Session`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
