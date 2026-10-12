/**
 * Outbound email.
 *
 * There is no provider wired up. Rather than pretend otherwise, this is a
 * seam with one honest implementation: in development the message is logged,
 * and in production the absence of a provider is a loud, explicit failure
 * rather than a silent no-op.
 *
 * A dropped verification email is a locked-out shop, so `sendEmail` reports
 * whether it actually dispatched. Callers must decide what to do about that;
 * they must not assume delivery.
 *
 * To add a provider (Resend, Postmark, SendGrid, SES), implement
 * `EmailProvider` and select it in `getEmailProvider()`.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface EmailProvider {
  readonly name: string;
  /** Resolves true only when the provider accepted the message. */
  send(message: EmailMessage): Promise<{ dispatched: boolean; detail?: string }>;
}

const LOG_PREFIX = "[email]";

class ConsoleEmailProvider implements EmailProvider {
  readonly name = "console";

  async send(message: EmailMessage) {
    console.log(
      [
        "",
        `  ${LOG_PREFIX} ─────────────────────────────────`,
        `  to:      ${message.to}`,
        `  subject: ${message.subject}`,
        ...message.text.split("\n").map((line) => `  | ${line}`),
        `  ${"─".repeat(48)}`,
        "",
      ].join("\n"),
    );
    return { dispatched: true, detail: "logged to console" };
  }
}

class UnconfiguredEmailProvider implements EmailProvider {
  readonly name = "unconfigured";

  async send(message: EmailMessage) {
    // No fake success. A dev-only logger in production would mean nobody
    // notices that password reset is broken until a customer is locked out.
    console.error(
      `${LOG_PREFIX} no email provider configured; DROPPED message to ${message.to} ` +
        `("${message.subject}"). Set EMAIL_PROVIDER and its credentials.`,
    );
    return { dispatched: false, detail: "no provider configured" };
  }
}

export function getEmailProvider(): EmailProvider {
  const isProduction = process.env.NODE_ENV === "production";
  return isProduction ? new UnconfiguredEmailProvider() : new ConsoleEmailProvider();
}

/**
 * Best-effort send.
 *
 * Never throws: a mail failure must not turn a password reset into a 500 for
 * the user. Returns the dispatch result so the caller can react.
 */
export async function sendEmail(message: EmailMessage): Promise<{
  dispatched: boolean;
  detail?: string;
}> {
  try {
    return await getEmailProvider().send(message);
  } catch (error) {
    console.error(
      `${LOG_PREFIX} failed to send to ${message.to}:`,
      error instanceof Error ? error.message : error,
    );
    return { dispatched: false, detail: "provider threw" };
  }
}

/* ------------------------------------------------------------------ */
/* Templates                                                           */
/* ------------------------------------------------------------------ */

export function verificationEmail(
  businessName: string,
  link: string,
): EmailMessage {
  return {
    to: "",
    subject: `Confirm your email for ${businessName}`,
    text: [
      `Welcome to AfriAgent.`,
      ``,
      `Confirm this email address so you can recover your account if you ever`,
      `lose your password:`,
      ``,
      link,
      ``,
      `The link works for 48 hours. If you did not create this account you can`,
      `safely ignore this message.`,
    ].join("\n"),
  };
}

export function passwordResetEmail(link: string): EmailMessage {
  return {
    to: "",
    subject: "Reset your AfriAgent password",
    text: [
      `Someone asked to reset the password for this AfriAgent account.`,
      ``,
      link,
      ``,
      `This link works for one hour and can only be used once.`,
      ``,
      `If this was not you, no action is needed -- your password has not`,
      `changed, and nothing in your account has been touched.`,
    ].join("\n"),
  };
}
