// Outbound email. Every send in the project goes through here, so swapping Gmail for
// Resend later is a change to this one file.
//
// Supabase Edge Functions block outbound ports 25 and 587, so this must use
// smtp.gmail.com:465 with implicit TLS. Gmail also caps sending at roughly 500
// recipients/day, which is fine at current scale but is the reason to keep it isolated.

import nodemailer from "npm:nodemailer@6.9.16";

export type Mail = {
  /** The user's auth email. Never GMAIL_USER, which is only the envelope sender. */
  to: string;
  subject: string;
  html: string;
  /** Plain-text alternative. Gmail shows it in previews and some clients prefer it. */
  text: string;
};

function env(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`${name} is not set on this project`);
  return v;
}

/** The published app URL, used for every link back into the product. */
export function appUrl(): string {
  return (Deno.env.get("APP_URL") ?? "").replace(/\/+$/, "");
}

let transport: nodemailer.Transporter | null = null;

function mailer(): nodemailer.Transporter {
  if (transport) return transport;
  transport = nodemailer.createTransport({
    host: "smtp.gmail.com",
    // 465 + implicit TLS. 587 is blocked by the platform, so do not "fix" this to STARTTLS.
    port: 465,
    secure: true,
    auth: { user: env("GMAIL_USER"), pass: env("GMAIL_APP_PASSWORD") },
  });
  return transport;
}

export async function sendMail(mail: Mail): Promise<void> {
  const from = env("GMAIL_USER");
  await mailer().sendMail({
    from: `Daily Edge <${from}>`,
    to: mail.to,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
  });
}

// ------------------------------------------------------------------ templating

/**
 * Gmail strips <style> blocks, so everything is inline. These are the few tokens the
 * templates share — kept as plain strings rather than a CSS object so the templates
 * read as the HTML they produce.
 */
export const S = {
  body:
    "margin:0;padding:24px 12px;background:#f6f6f4;" +
    "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;" +
    "color:#1c1c1a;line-height:1.5;",
  card: "max-width:600px;margin:0 auto;background:#ffffff;border-radius:12px;padding:28px 24px;",
  h1: "margin:0 0 4px;font-size:22px;font-weight:600;letter-spacing:-0.01em;",
  sub: "margin:0 0 24px;font-size:13px;color:#6b6b66;",
  h2: "margin:28px 0 10px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:#6b6b66;",
  glance: "margin:0 0 4px;padding:14px 16px;background:#f3f1ec;border-radius:8px;font-size:14px;",
  item: "margin:0 0 16px;",
  headline: "margin:0;font-size:15px;font-weight:600;",
  link: "color:#1c1c1a;text-decoration:none;",
  meta: "margin:3px 0 0;font-size:12px;color:#8a8a84;",
  why: "margin:4px 0 0;font-size:13px;color:#4a4a45;",
  task: "margin:0 0 8px;font-size:14px;",
  taskMeta: "font-size:12px;color:#8a8a84;",
  footer: "max-width:600px;margin:16px auto 0;font-size:12px;color:#8a8a84;text-align:center;",
  footerLink: "color:#8a8a84;",
};

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Every email ends with a way out, as CLAUDE.md requires: a link to /settings to change
 * times or turn the digest off.
 */
export function footer(note: string): { html: string; text: string } {
  const url = `${appUrl()}/settings`;
  return {
    html:
      `<div style="${S.footer}">${escapeHtml(note)}<br>` +
      `<a href="${url}" style="${S.footerLink}">Change your times or turn this off</a></div>`,
    text: `\n\n${note}\nChange your times or turn this off: ${url}\n`,
  };
}

export function wrap(title: string, inner: string, note: string): string {
  const f = footer(note);
  return `<div style="${S.body}"><div style="${S.card}">${inner}</div>${f.html}</div>`;
}
