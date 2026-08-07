import { config } from "./config.js";
import { upsertUser } from "./users.js";

// Registers (or re-registers) Gmail push notifications for one user's
// INBOX — Gmail will publish to the configured Pub/Sub topic the moment new
// mail arrives, instead of this app having to poll for it. Returns null
// (and logs, rather than throwing) when GMAIL_PUBSUB_TOPIC isn't configured,
// so the app still runs on plain polling if Pub/Sub hasn't been set up yet.
export async function startOrRenewWatch(waId, gmail) {
  if (!config.google.pubsubTopic) {
    console.log(`[gmailWatch] GMAIL_PUBSUB_TOPIC not set, skipping watch registration for ${waId}`);
    return null;
  }

  try {
    const res = await gmail.users.watch({
      userId: "me",
      requestBody: {
        topicName: config.google.pubsubTopic,
        labelIds: ["INBOX"],
      },
    });

    const historyId = res.data.historyId;
    const watchExpiration = Number(res.data.expiration); // epoch ms, Google-provided
    upsertUser(waId, { historyId, watchExpiration });

    console.log(`[gmailWatch] watch registered for ${waId}, expires ${new Date(watchExpiration).toISOString()}`);
    return { historyId, watchExpiration };
  } catch (err) {
    console.error(`[gmailWatch] failed to register watch for ${waId}:`, err.response?.data || err.message || err);
    return null;
  }
}

// Gmail watch registrations expire after up to 7 days — renew with a day
// of slack so a slightly-delayed renewal check never lets one lapse.
const RENEWAL_SLACK_MS = 24 * 60 * 60 * 1000;

export function needsRenewal(user) {
  if (!user.watchExpiration) return true;
  return user.watchExpiration - Date.now() < RENEWAL_SLACK_MS;
}
