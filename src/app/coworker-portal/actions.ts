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
import { redirect } from "next/navigation";
import { requirePermission } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { importAskMyClient } from "@/lib/coworker/import-service";
import { sendEmail } from "@/lib/email/sendgrid";

/**
 * Best-effort "you've been assigned a question" email. Never throws — a mail
 * failure must not abort creating the question (mirrors §17). Only fires when the
 * question is directed at a specific coworker (not the general pool).
 */
async function notifyAssignee(opts: {
  to: string;
  subject: string;
  askedByEmail: string;
  body: string;
}): Promise<void> {
  const base = (process.env.NEXTAUTH_URL || "").replace(/\/$/, "");
  const link = base ? `${base}/coworker-portal` : "the GCD QBO Hub coworker portal";
  const text =
    `${opts.askedByEmail} assigned you a question in the GCD QBO Hub.\n\n` +
    `Subject: ${opts.subject}\n\n${opts.body}\n\n` +
    `Answer it here: ${link}`;
  try {
    await sendEmail({ to: opts.to, subject: `GCD QBO Hub — question for you: ${opts.subject}`, text });
  } catch {
    // swallow — the question is already saved; delivery is best-effort
  }
}

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

  // Let the assigned coworker know (general-pool questions email no one).
  if (assignedEmail) {
    await notifyAssignee({ to: assignedEmail, subject, askedByEmail: user.email, body });
  }

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

/**
 * Pull the "Ask My Client" transactions in from QBO (read-only) and mirror them
 * as questions. Gated to owners/reviewers. Redirects back with a short status so
 * the page can show the outcome. Never writes to QBO.
 */
export async function importAskMyClientAction() {
  const user = await requirePermission("import_coworker_questions");
  const result = await importAskMyClient(user.email, new Date());
  revalidatePath("/coworker-portal");

  const status = result.ok
    ? `ok:${result.created}:${result.updated}:${result.closed}:${result.removed}:${result.found}`
    : (result.reason ?? "error");
  redirect(`/coworker-portal?import=${encodeURIComponent(status)}`);
}
