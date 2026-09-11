/**
 * No provider lock-in and no dependency on a mail library that needs its
 * own native bindings — plain SMTP via Node's built-in TLS, using
 * whatever host/port/credentials are in the environment. In dev and
 * tests, EMAIL_HOST is unset, so mail is printed rather than sent —
 * exactly like Django's console email backend, and for the same reason:
 * local dev and CI should never need a real mail account.
 *
 * Brevo's own HTTP API is preferred over SMTP when a Brevo API key is
 * configured — found to matter in practice, not just in theory: a raw
 * SMTP handshake (DNS + TCP + TLS negotiation + AUTH + DATA) genuinely
 * timed out against Vercel's serverless function limit, which a real
 * invite attempt hit directly (confirmed via the 504 / X-Vercel-Error:
 * FUNCTION_INVOCATION_TIMEOUT the browser actually showed). A single
 * HTTPS POST to Brevo's API finishes in a fraction of that, which is
 * why this is the recommended integration path for exactly this
 * platform, not merely an alternative. SMTP remains the fallback for
 * any other provider (Gmail, a school's own mail server, etc.) that
 * doesn't have its own HTTP API.
 */

interface SendMailInput {
  to: string;
  subject: string;
  text: string;
}

export async function sendMail({ to, subject, text }: SendMailInput): Promise<void> {
  if (process.env.BREVO_API_KEY) {
    const response = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "api-key": process.env.BREVO_API_KEY,
      },
      body: JSON.stringify({
        sender: {
          email: process.env.DEFAULT_FROM_EMAIL || "no-reply@fee-portal.local",
          name: process.env.DEFAULT_FROM_NAME || "School Fee Portal",
        },
        to: [{ email: to }],
        subject,
        textContent: text,
      }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Brevo API refused the email (${response.status}): ${body}`);
    }
    return;
  }

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
    // Vercel serverless functions have a hard wall-clock limit (as low
    // as 10s on Hobby); nodemailer's own defaults (2 minutes) are
    // useless as a safety net there since the whole function gets
    // killed well before they'd ever fire. Capped well under that limit
    // so a slow/unreachable SMTP server fails with a real, catchable
    // error instead of the function being killed mid-handshake with no
    // error at all — using the HTTP API above avoids this class of
    // problem entirely, which is why it's preferred when available.
    connectionTimeout: 8000,
    greetingTimeout: 8000,
    socketTimeout: 8000,
  });

  await transport.sendMail({
    from: process.env.DEFAULT_FROM_EMAIL || "no-reply@fee-portal.local",
    to,
    subject,
    text,
  });
}
