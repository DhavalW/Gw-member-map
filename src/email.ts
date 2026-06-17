import type { Env } from "./types";

export function emailConfigured(env: Env): boolean {
  return Boolean(env.RESEND_API_KEY && env.EMAIL_FROM);
}

/**
 * Send an email via Resend (https://resend.com). Resend is a good fit for
 * Cloudflare Workers (simple HTTPS API, generous free tier). Returns true on
 * success. No-op + false when email isn't configured.
 */
export async function sendEmail(
  env: Env,
  to: string,
  subject: string,
  text: string,
  html: string,
): Promise<boolean> {
  if (!emailConfigured(env)) return false;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: env.EMAIL_FROM, to, subject, text, html }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
