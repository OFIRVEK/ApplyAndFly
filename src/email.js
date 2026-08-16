import axios from "axios";
import { config } from "./config.js";

// Raw HTTP call to Resend's API rather than their SDK package — consistent
// with how every other third-party service in this app (Groq, Serper,
// WhatsApp) is called directly via axios, no extra dependency needed for a
// single POST. Used solely for the operator unsubscribe notification today.
// Degrades gracefully (logs only) when RESEND_API_KEY isn't configured, the
// same pattern backup.js uses for Firebase — the app must keep working
// without this being set up yet.
export async function sendAdminNotification(subject, text) {
  const apiKey = config.resend.apiKey;
  if (!apiKey) {
    console.log(`[email] RESEND_API_KEY not configured, skipping notification: "${subject}"`);
    return;
  }

  try {
    await axios.post(
      "https://api.resend.com/emails",
      {
        // Resend's shared sandbox sender — works for any recipient without
        // verifying a custom domain, sufficient for a single operator
        // notification rather than bulk/marketing mail.
        from: "ApplyAndFly <onboarding@resend.dev>",
        to: [config.adminNotifyEmail],
        subject,
        text,
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
      }
    );
    console.log(`[email] sent admin notification: "${subject}"`);
  } catch (err) {
    console.error("[email] failed to send admin notification:", err.response?.data || err.message || err);
  }
}
