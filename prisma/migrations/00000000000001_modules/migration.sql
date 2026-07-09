-- CreateTable
CREATE TABLE "proj_scenarios" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdByEmail" TEXT,
    "assumptionsJson" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "proj_scenarios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_conversations" (
    "id" TEXT NOT NULL,
    "userEmail" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT 'New conversation',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_messages" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "usageJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cwp_questions" (
    "id" TEXT NOT NULL,
    "relatedRowId" TEXT,
    "qboReference" TEXT,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "askedByEmail" TEXT NOT NULL,
    "assignedEmail" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cwp_questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cwp_answers" (
    "id" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "answeredByEmail" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cwp_answers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "proj_scenarios_active_idx" ON "proj_scenarios"("active");

-- CreateIndex
CREATE INDEX "ai_conversations_userEmail_idx" ON "ai_conversations"("userEmail");

-- CreateIndex
CREATE INDEX "ai_messages_conversationId_idx" ON "ai_messages"("conversationId");

-- CreateIndex
CREATE INDEX "cwp_questions_status_idx" ON "cwp_questions"("status");

-- CreateIndex
CREATE INDEX "cwp_questions_assignedEmail_idx" ON "cwp_questions"("assignedEmail");

-- CreateIndex
CREATE INDEX "cwp_answers_questionId_idx" ON "cwp_answers"("questionId");

-- AddForeignKey
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "ai_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cwp_answers" ADD CONSTRAINT "cwp_answers_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "cwp_questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

