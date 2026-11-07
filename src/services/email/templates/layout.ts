/**
 * Branded email layout.
 *
 * Every template is rendered from the same document model, so the HTML and the
 * plain text version always carry the same information. The HTML is built for
 * mail clients: inline styles, a single column table and a maximum width of
 * 560 pixels.
 *
 * Rules that the rest of the code relies on:
 *
 * - Every value that comes from a user is escaped before it reaches the HTML.
 * - A single use link only ever appears in the message body, never in a
 *   subject line, a log line or a custom header.
 * - The plain text version contains the raw URL, because several clients
 *   strip the link from the HTML part.
 */

export interface EmailBrand {
  appName: string;
  supportAddress?: string | undefined;
  appUrl?: string | undefined;
}

export interface EmailAction {
  label: string;
  url: string;
}

export interface EmailDocument {
  heading: string;
  preheader?: string | undefined;
  paragraphs: string[];
  code?: string;
  action?: EmailAction | undefined;
  note?: string | undefined;
  footerNote?: string | undefined;
}

export interface RenderedEmail {
  html: string;
  text: string;
}

const COLORS = {
  page: '#f4f5f7',
  card: '#ffffff',
  text: '#111827',
  muted: '#6b7280',
  border: '#e5e7eb',
  accent: '#2563eb',
  accentText: '#ffffff',
};

/**
 * Escapes a value for safe inclusion in HTML.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Collapses whitespace so a value cannot break out of its paragraph.
 */
export function toPlainText(value: string): string {
  return value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function renderFooterHtml(brand: EmailBrand, footerNote: string | undefined): string {
  const support = brand.supportAddress
    ? `<p style="margin:0 0 6px;font-size:12px;line-height:1.5;color:${COLORS.muted};">Questions? Reply to this email or contact <a href="mailto:${escapeHtml(brand.supportAddress)}" style="color:${COLORS.muted};">${escapeHtml(brand.supportAddress)}</a>.</p>`
    : '';

  const site = brand.appUrl
    ? `<p style="margin:0 0 6px;font-size:12px;line-height:1.5;color:${COLORS.muted};"><a href="${escapeHtml(brand.appUrl)}" style="color:${COLORS.muted};">${escapeHtml(brand.appUrl)}</a></p>`
    : '';

  const note = footerNote
    ? `<p style="margin:0 0 6px;font-size:12px;line-height:1.5;color:${COLORS.muted};">${escapeHtml(footerNote)}</p>`
    : '';

  return `<tr>
            <td style="padding:24px 32px 8px 32px;border-top:1px solid ${COLORS.border};">
              ${note}${support}${site}
              <p style="margin:12px 0 0;font-size:12px;line-height:1.5;color:${COLORS.muted};">&copy; ${new Date().getUTCFullYear()} ${escapeHtml(brand.appName)}. All rights reserved.</p>
            </td>
          </tr>`;
}

function renderActionHtml(action: EmailAction | undefined): string {
  if (!action) {
    return '';
  }

  return `<tr>
            <td style="padding:8px 32px 0 32px;">
              <p style="margin:0 0 16px;">
                <a href="${escapeHtml(action.url)}" style="display:inline-block;padding:12px 22px;background:${COLORS.accent};color:${COLORS.accentText};text-decoration:none;border-radius:6px;font-weight:600;font-size:15px;">${escapeHtml(action.label)}</a>
              </p>
              <p style="margin:0 0 8px;font-size:12px;line-height:1.5;color:${COLORS.muted};">If the button does not work, copy this link into your browser:</p>
              <p style="margin:0 0 16px;font-size:12px;line-height:1.5;color:${COLORS.muted};word-break:break-all;">${escapeHtml(action.url)}</p>
            </td>
          </tr>`;
}

/**
 * Renders the branded HTML version of a document.
 */
export function renderEmailHtml(document: EmailDocument, brand: EmailBrand): string {
  const preheader = document.preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(document.preheader)}</div>`
    : '';

  const paragraphs = document.paragraphs
    .map(
      (paragraph) =>
        `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:${COLORS.text};">${escapeHtml(paragraph)}</p>`,
    )
    .join('\n              ');
  const codeBlock = document.code
    ? `<p style="margin:8px 32px 20px;text-align:center;font-size:34px;line-height:1.3;letter-spacing:8px;font-weight:700;color:${COLORS.accent};">${escapeHtml(document.code)}</p>`
    : '';

  const note = document.note
    ? `<p style="margin:0 0 14px;font-size:13px;line-height:1.6;color:${COLORS.muted};">${escapeHtml(document.note)}</p>`
    : '';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${escapeHtml(document.heading)}</title>
  </head>
  <body style="margin:0;padding:0;background:${COLORS.page};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${COLORS.text};">
    ${preheader}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${COLORS.page};">
      <tr>
        <td align="center" style="padding:32px 12px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:${COLORS.card};border-radius:10px;border:1px solid ${COLORS.border};">
            <tr>
              <td style="padding:28px 32px 0 32px;">
                <p style="margin:0 0 18px;font-size:13px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${COLORS.accent};">${escapeHtml(brand.appName)}</p>
                <h1 style="margin:0 0 18px;font-size:22px;line-height:1.3;font-weight:700;color:${COLORS.text};">${escapeHtml(document.heading)}</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px;">
              ${paragraphs}${codeBlock}
                ${note}
              </td>
            </tr>
            ${renderActionHtml(document.action)}
            ${renderFooterHtml(brand, document.footerNote)}
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

/**
 * Renders the plain text version of a document.
 *
 * The action URL is printed on its own line, because a number of clients
 * remove the link from the HTML part.
 */
export function renderEmailText(document: EmailDocument, brand: EmailBrand): string {
  const lines: string[] = [];

  lines.push(brand.appName);
  lines.push('');
  lines.push(document.heading);
  lines.push('');

  for (const paragraph of document.paragraphs) {
    lines.push(toPlainText(paragraph));
    lines.push('');
  }

  if (document.code) {
    lines.push(document.code);
    lines.push('');
  }

  if (document.action) {
    lines.push(`${document.action.label}:`);
    lines.push(document.action.url);
    lines.push('');
  }

  if (document.note) {
    lines.push(toPlainText(document.note));
    lines.push('');
  }

  lines.push('--');
  lines.push(brand.appName);

  if (brand.supportAddress) {
    lines.push(`Support: ${brand.supportAddress}`);
  }

  if (brand.appUrl) {
    lines.push(brand.appUrl);
  }

  if (document.footerNote) {
    lines.push('');
    lines.push(toPlainText(document.footerNote));
  }

  return lines.join('\n');
}

/**
 * Renders both versions of a document.
 */
export function renderEmailDocument(document: EmailDocument, brand: EmailBrand): RenderedEmail {
  return {
    html: renderEmailHtml(document, brand),
    text: renderEmailText(document, brand),
  };
}
