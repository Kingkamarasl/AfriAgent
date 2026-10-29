/**
 * Outbound email.
 *
 * Resend is the wired provider; the console logger remains for development.
 * In production an unconfigured or failing provider reports `dispatched: false`
 * rather than throwing or pretending, because a dropped verification email is a
 * locked-out shop and callers need to be able to react to that.
 *
 * Note the distinction the interface preserves: `dispatched: true` means the
 * provider accepted the message, not that it reached an inbox. Nothing here
 * reports delivery.
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

/**
 * Resend.
 *
 * Selected explicitly with EMAIL_PROVIDER=resend. It is not the automatic
 * production default, because sending real mail is not something to fall into
 * by accident -- a misconfigured provider should fail loudly rather than mail a
 * customer's inbox from the wrong domain.
 */
class ResendEmailProvider implements EmailProvider {
  readonly name = "resend";

  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  async send(message: EmailMessage) {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: this.from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
      }),
      // Without a timeout a hung provider holds the request open, and the user
      // is left staring at a password reset form that will never resolve.
      signal: AbortSignal.timeout(EMAIL_TIMEOUT_MS),
    });

    // Resend answers 200 with an id on acceptance. A 2xx is not enough: the API
    // returns 200 with an `error` body for some rejections, so the body is
    // checked rather than the status alone.
    const body = (await res.json().catch(() => ({}))) as {
      id?: string;
      message?: string;
      name?: string;
      error?: { message?: string; name?: string } | string;
    };

    const failure = normaliseResendError(res, body);
    if (failure) {
      console.error(`${LOG_PREFIX} resend rejected "${message.subject}": ${failure}`);
      return { dispatched: false, detail: failure };
    }

    if (!body.id) {
      console.error(
        `${LOG_PREFIX} resend returned no message id for "${message.subject}"`,
      );
      return { dispatched: false, detail: "provider returned no message id" };
    }

    return { dispatched: true, detail: body.id };
  }
}

/**
 * Resend reports failures inconsistently: sometimes a non-2xx with
 * `{message}`, sometimes `{error: "..."}`, sometimes `{error: {...}}`. Normalised
 * here so the log line is worth reading.
 */
function normaliseResendError(
  res: Response,
  body: {
    message?: string;
    name?: string;
    error?: { message?: string; name?: string } | string;
  },
): string | null {
  // `error` is either a bare string or an object. Narrowing once up front keeps
  // the branches below from having to re-check the union.
  const errName = typeof body.error === "object" ? body.error?.name : undefined;
  const errMessage =
    typeof body.error === "string" ? body.error : body.error?.message;

  if (!res.ok) {
    return `${errName ?? body.name ?? res.status}: ${errMessage ?? body.message ?? `HTTP ${res.status}`}`;
  }
  // A 2xx that still carries an error is a rejection the status code hid.
  if (errMessage) return `${errName ?? "error"}: ${errMessage}`;
  return null;
}

class UnconfiguredEmailProvider implements EmailProvider {
  readonly name = "unconfigured";

  async send(message: EmailMessage) {
    // No fake success. A dev-only logger in production would mean nobody
    // notices that password reset is broken until a customer is locked out.
    console.error(
      `${LOG_PREFIX} no email provider configured; DROPPED message to ${message.to} ` +
        `("${message.subject}"). Set EMAIL_PROVIDER=resend and RESEND_API_KEY.`,
    );
    return { dispatched: false, detail: "no provider configured" };
  }
}

const EMAIL_TIMEOUT_MS = 10_000;

/**
 * Picks the provider.
 *
 * `EMAIL_PROVIDER=resend` wins in any environment, so the real path can be
 * exercised in development without editing code. With no explicit choice,
 * development logs and production refuses -- both loudly.
 */
export function getEmailProvider(): EmailProvider {
  const choice = process.env.EMAIL_PROVIDER?.trim().toLowerCase();

  if (choice === "resend") {
    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.EMAIL_FROM;
    if (!apiKey) {
      console.error(
        `${LOG_PREFIX} EMAIL_PROVIDER=resend but RESEND_API_KEY is unset.`,
      );
      return new UnconfiguredEmailProvider();
    }
    if (!from) {
      console.error(
        `${LOG_PREFIX} EMAIL_PROVIDER=resend but EMAIL_FROM is unset. ` +
          `Without a verified sender, every send will bounce.`,
      );
      return new UnconfiguredEmailProvider();
    }
    return new ResendEmailProvider(apiKey, from);
  }

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
