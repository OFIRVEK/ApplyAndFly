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