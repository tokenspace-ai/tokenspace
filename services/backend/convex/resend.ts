import { Resend } from "@convex-dev/resend";
import { components } from "./_generated/api";

export const RESEND_AVAILABLE =
  process.env.RESEND_API_KEY !== undefined && process.env.RESEND_API_KEY !== "" && process.env.RESEND_API_KEY !== "...";

export const RESEND_FROM_ADDRESS = "TokenSpace <no-reply@updates.tokenspace.ai>";
export const TOKENSPACE_EMAIL_LOGO_URL = "https://app.tokenspace.ai/ts-email-logo-icon.png";

export type TokenspaceEmailHtmlParams = {
  previewText: string;
  headline: string;
  bodyText: string;
  ctaText: string;
  ctaUrl: string;
  footerText: string;
  disclaimerText: string;
};

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderParagraphText(value: string): string {
  return escapeHtml(value).replaceAll("\n", "<br>");
}

export function renderTokenspaceEmailHtml({
  previewText,
  headline,
  bodyText,
  ctaText,
  ctaUrl,
  footerText,
  disclaimerText,
}: TokenspaceEmailHtmlParams): string {
  const safePreviewText = escapeHtml(previewText);
  const safeHeadline = escapeHtml(headline);
  const safeBodyText = renderParagraphText(bodyText);
  const safeCtaText = escapeHtml(ctaText);
  const safeCtaUrl = escapeHtml(ctaUrl);
  const safeFooterText = renderParagraphText(footerText);
  const safeDisclaimerText = renderParagraphText(disclaimerText);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta http-equiv="X-UA-Compatible" content="IE=edge" />
    <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${safeHeadline}</title>
    <style>
      body {
        margin: 0;
        padding: 0;
        background: #ffffff;
        color: #202020;
      }
      table,
      td {
        border-collapse: collapse;
      }
      img {
        border: 0;
        display: block;
      }
      .shell {
        width: 100%;
        max-width: 674px;
        margin: 0 auto;
        padding: 32px 16px 24px;
      }
      .card-top {
        background: #ffffff;
        border: 1px solid #e0e0e0;
        border-bottom: none;
        border-radius: 16px 16px 0 0;
        padding: 28px 32px 0;
      }
      .card-bottom {
        background: #ffffff;
        border: 1px solid #e0e0e0;
        border-top: none;
        border-radius: 0 0 16px 16px;
        padding: 0 40px 36px;
      }
      .heading {
        font-family:
          -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
        font-size: 24px;
        font-weight: 600;
        line-height: 30px;
        margin: 0;
        color: #202020;
      }
      .body-copy {
        font-family:
          -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
        font-size: 16px;
        line-height: 24px;
        margin: 0;
        color: #202020;
      }
      .button {
        display: inline-block;
        padding: 7px 11px;
        border-radius: 4px;
        background: #000000;
        color: #ffffff !important;
        text-decoration: none;
        font-family:
          -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
        font-size: 14px;
        font-weight: 600;
        line-height: 16px;
      }
      .divider {
        border: 0;
        border-top: 1px solid #d9d9d9;
        margin: 0;
      }
      .meta {
        font-family:
          -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
        font-size: 12px;
        line-height: 18px;
        margin: 0;
        color: #646464;
      }
    </style>
  </head>
  <body>
    <div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;color:#fff;font-size:1px;line-height:1px;">
      ${safePreviewText}
    </div>
    <table role="presentation" width="100%">
      <tr>
        <td align="center">
          <table role="presentation" class="shell" width="100%">
            <tr>
              <td class="card-top">
                <img src="${TOKENSPACE_EMAIL_LOGO_URL}" alt="TokenSpace" width="80" height="80" />
                <div style="height:16px;line-height:16px;">&#8202;</div>
              </td>
            </tr>
            <tr>
              <td class="card-bottom">
                <div style="height:32px;line-height:32px;">&#8202;</div>
                <p class="heading">${safeHeadline}</p>
                <div style="height:16px;line-height:16px;">&#8202;</div>
                <p class="body-copy">${safeBodyText}</p>
                <div style="height:24px;line-height:24px;">&#8202;</div>
                <a href="${safeCtaUrl}" target="_blank" rel="noreferrer" class="button">${safeCtaText}</a>
                <div style="height:32px;line-height:32px;">&#8202;</div>
                <hr class="divider" />
                <div style="height:32px;line-height:32px;">&#8202;</div>
                <p class="meta">${safeFooterText}</p>
                <div style="height:12px;line-height:12px;">&#8202;</div>
                <p class="meta">${safeDisclaimerText}</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export const resend = RESEND_AVAILABLE
  ? new Resend(components.resend, {
      // Production should deliver to real recipients by default.
      testMode: false,
      apiKey: process.env.RESEND_API_KEY,
    })
  : ({
      sendEmail: async (_ctx: unknown, email: unknown) => {
        console.warn("RESEND_API_KEY is not set, sending emails is disabled");
        console.log("Would send this email:", email);
      },
    } as unknown as Resend);
