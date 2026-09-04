/**
 * No provider lock-in and no dependency on a mail library that needs its
 * own native bindings — plain SMTP via Node's built-in TLS, using
 * whatever host/port/credentials are in the environment. In dev and
 * tests, EMAIL_HOST is unset, so mail is printed rather than sent —
 * exactly like Django's console email backend, and for the same reason:
 * local dev and CI should never need a real mail account.
 */

interface SendMailInput {
  to: string;
  subject: string;
  text: string;
}

export async function sendMail({ to, subject, text }: SendMailInput): Promise<void> {
  if (!process.env.EMAIL_HOST) {
    console.log(`[mail:console] to=${to} subject=${JSON.stringify(subject)}\n${text}\n`);
    return;
  }

  // Loaded lazily so nodemailer is only required at all once real SMTP is
  // configured — keeps it out of the bundle path entirely in dev/test.
  const nodemailer = await import("nodemailer");
  const transport = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: Number(process.env.EMAIL_PORT) || 587,
    secure: process.env.EMAIL_PORT === "465",
    auth: process.env.EMAIL_HOST_USER
      ? { user: process.env.EMAIL_HOST_USER, pass: process.env.EMAIL_HOST_PASSWORD }
      : undefined,
  });

  await transport.sendMail({
    from: process.env.DEFAULT_FROM_EMAIL || "no-reply@fee-portal.local",
    to,
    subject,
    text,
  });
}
