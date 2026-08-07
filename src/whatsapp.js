import axios from "axios";
import { config } from "./config.js";

export async function sendWhatsApp(message, to = config.whatsapp.to) {
  try {
    const url = `https://graph.facebook.com/v20.0/${config.whatsapp.phoneNumberId}/messages`;

    console.log(
      `[whatsapp] sending -> phoneNumberId=${config.whatsapp.phoneNumberId} to=${to} tokenSet=${!!config.whatsapp.token}`
    );

    const res = await axios.post(
      url,
      {
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: message },
      },
      {
        headers: {
          Authorization: `Bearer ${config.whatsapp.token}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log("[whatsapp] send success:", JSON.stringify(res.data));
  } catch (err) {
    console.error("WhatsApp send error:", err.response?.data || err.message || err);
  }
}

// Plain WhatsApp text has no way to give a link custom label text — it only
// auto-detects raw URLs as-is. An interactive "cta_url" button is the actual
// WhatsApp Cloud API feature for a labeled tappable button (e.g. "Click here
// to sign in") instead of a long raw URL sitting in the message body.
export async function sendWhatsAppCtaUrl(bodyText, buttonText, url, to = config.whatsapp.to) {
  try {
    const endpoint = `https://graph.facebook.com/v20.0/${config.whatsapp.phoneNumberId}/messages`;

    console.log(`[whatsapp] sending CTA URL button -> to=${to} button="${buttonText}"`);

    const res = await axios.post(
      endpoint,
      {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "cta_url",
          body: { text: bodyText },
          action: {
            name: "cta_url",
            parameters: { display_text: buttonText, url },
          },
        },
      },
      {
        headers: {
          Authorization: `Bearer ${config.whatsapp.token}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log("[whatsapp] CTA URL send success:", JSON.stringify(res.data));
  } catch (err) {
    console.error("WhatsApp CTA URL send error:", err.response?.data || err.message || err);
  }
}

// Approved message templates can be sent outside the 24h customer service
// window (unlike sendWhatsApp's free-form text) — used to proactively nudge
// someone who has messages queued because the window is closed.
export async function sendWhatsAppTemplate(templateName, languageCode, to = config.whatsapp.to) {
  try {
    const url = `https://graph.facebook.com/v20.0/${config.whatsapp.phoneNumberId}/messages`;

    console.log(`[whatsapp] sending template "${templateName}" -> to=${to}`);

    const res = await axios.post(
      url,
      {
        messaging_product: "whatsapp",
        to,
        type: "template",
        template: {
          name: templateName,
          language: { code: languageCode },
        },
      },
      {
        headers: {
          Authorization: `Bearer ${config.whatsapp.token}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log("[whatsapp] template send success:", JSON.stringify(res.data));
  } catch (err) {
    console.error("WhatsApp template send error:", err.response?.data || err.message || err);
  }
}