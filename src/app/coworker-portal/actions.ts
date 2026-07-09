"use server";

/**
 * Server actions for the Coworker Portal module (§1) — "Ask My Client".
 *
 * Owners/reviewers raise a question about a transaction; a coworker answers it.
 * Every mutating action is gated by role server-side via requirePermission —
 * never trusted from the client. Asking requires ask_coworker_questions
 * (owner_admin, reviewer); answering requires answer_coworker_questions
 * (owner_admin, coworker).
 */
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/auth/session";
import { prisma } from "@/lib/db";

export async function askQuestionAction(formData: FormData) {
  const user = await requirePermission("ask_coworker_questions");
  const subject = String(formData.get("subject") ?? "").trim();
  const body = String(formData.get("body") ?? "").trim();
  const assignedEmail = String(formData.get("assignedEmail") ?? "").trim() || null;
  const qboReference = String(formData.get("qboReference") ?? "").trim() || null;
  const relatedRowId = String(formData.get("relatedRowId") ?? "").trim() || null;

  await prisma.cwpQuestion.create({
    data: {
      subject,
      body,
      assignedEmail,
      qboReference,
      relatedRowId,
      askedByEmail: user.email,
      status: "open",
    },
  });
  revalidatePath("/coworker-portal");
}

export async function answerQuestionAction(questionId: string, formData: FormData) {
  const user = await requirePermission("answer_coworker_questions");
  const body = String(formData.get("body") ?? "").trim();

  await prisma.cwpAnswer.create({
    data: { questionId, body, answeredByEmail: user.email },
  });
  await prisma.cwpQuestion.update({
    where: { id: questionId },
    data: { status: "answered" },
  });
  revalidatePath("/coworker-portal");
  revalidatePath(`/coworker-portal/${questionId}`);
}

export async function closeQuestionAction(questionId: string) {
  await requirePermission("ask_coworker_questions");
  await prisma.cwpQuestion.update({
    where: { id: questionId },
    data: { status: "closed" },
  });
  revalidatePath("/coworker-portal");
  revalidatePath(`/coworker-portal/${questionId}`);
}

export async function reopenQuestionAction(questionId: string) {
  await requirePermission("ask_coworker_questions");
  await prisma.cwpQuestion.update({
    where: { id: questionId },
    data: { status: "open" },
  });
  revalidatePath("/coworker-portal");
  revalidatePath(`/coworker-portal/${questionId}`);
}
