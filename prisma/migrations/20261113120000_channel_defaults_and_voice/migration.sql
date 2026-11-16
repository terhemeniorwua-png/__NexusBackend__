CREATE TYPE "ChannelPostPolicy" AS ENUM ('ALL_MEMBERS', 'MANAGERS_ONLY');
CREATE TYPE "MessageContentType" AS ENUM ('TEXT', 'VOICE');

ALTER TABLE "Channel"
  ADD COLUMN "isDefault" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "systemKey" TEXT,
  ADD COLUMN "postPolicy" "ChannelPostPolicy" NOT NULL DEFAULT 'ALL_MEMBERS';

ALTER TABLE "Message"
  ADD COLUMN "type" "MessageContentType" NOT NULL DEFAULT 'TEXT',
  ADD COLUMN "audioMime" TEXT,
  ADD COLUMN "audioDurationMs" INTEGER;

CREATE TABLE "MessageAudio" (
  "messageId" TEXT NOT NULL,
  "data" BYTEA NOT NULL,
  CONSTRAINT "MessageAudio_pkey" PRIMARY KEY ("messageId")
);

ALTER TABLE "MessageAudio"
  ADD CONSTRAINT "MessageAudio_messageId_fkey"
  FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "Channel_workspaceId_systemKey_key" ON "Channel"("workspaceId", "systemKey");
