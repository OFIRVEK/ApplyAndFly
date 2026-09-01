import dotenv from "dotenv";
import path from "path";

// load env ONCE, explicitly
dotenv.config({ path: path.resolve(process.cwd(), ".env") });

// Confirms which values loaded without printing the values themselves —
// the old version logged the actual client ID, redirect URI, and WhatsApp
// number on every boot, which meant they sat in plain view in Render's logs.
console.log("Config loaded:", {
  googleClientId: Boolean(process.env.GOOGLE_CLIENT_ID),
  googleRedirectUri: Boolean(process.env.GOOGLE_REDIRECT_URI),
  whatsappToNumber: Boolean(process.env.WHATSAPP_TO_NUMBER),
});

export const config = {
  port: 3000,

  app: {
    // Set to the public Render/custom-domain URL in production, e.g.
    // https://applyandfly.example.com. Left blank locally so WhatsApp never
    // receives an unusable localhost link.
    publicUrl: (process.env.PUBLIC_APP_URL || "").replace(/\/+$/, ""),
  },

  google: {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    redirectUri: process.env.GOOGLE_REDIRECT_URI,
    // Full Pub/Sub topic name (projects/<project-id>/topics/<topic-name>)
    // used to register Gmail push notifications via users.watch().
    pubsubTopic: process.env.GMAIL_PUBSUB_TOPIC,
    // Expected "audience" claim on the OIDC token Pub/Sub attaches to push
    // requests when the subscription is configured with a service account
    // (Pub/Sub -> subscription -> Enable authentication). Optional: if
    // unset, /webhook/gmail accepts requests without verifying they
    // actually came from Google, same as before.
    pubsubAudience: process.env.GMAIL_PUBSUB_AUDIENCE,
    // The exact service account configured on the Pub/Sub push subscription
    // (Enable authentication -> Service account). When set, push requests
    // must carry a token minted AS this identity, not merely one with the
    // right audience — any GCP account can mint a token for any audience.
    pubsubServiceAccount: process.env.GMAIL_PUBSUB_SERVICE_ACCOUNT,
  },

  whatsapp: {
    token: process.env.WHATSAPP_TOKEN,
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
    to: process.env.WHATSAPP_TO_NUMBER,
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN,
    // Meta App Dashboard -> Settings -> Basic -> App Secret. Used to verify
    // the X-Hub-Signature-256 header on inbound webhook POSTs, so a request
    // that didn't actually come from Meta can't be processed as if it did.
    appSecret: process.env.WHATSAPP_APP_SECRET,
  },

  groq: {
    apiKey: process.env.GROQ_API_KEY,
  },

  tavily: {
    apiKey: process.env.TAVILY_API_KEY,
  },

  serper: {
    apiKey: process.env.SERPER_API_KEY,
  },

  // Google's official Programmable Search Engine (Custom Search JSON API) —
  // see googleSearch.js. Distinct from the google.clientId/clientSecret
  // above, which are for Gmail OAuth, not search.
  googleSearch: {
    apiKey: process.env.GOOGLE_SEARCH_API_KEY,
    engineId: process.env.GOOGLE_SEARCH_ENGINE_ID,
  },

  firecrawl: {
    apiKey: process.env.FIRECRAWL_API_KEY,
  },

  // Gates the /debug/* routes — without this set, they're disabled outright
  // (fail closed) rather than left reachable by anyone who finds the URL.
  debugSecret: process.env.DEBUG_SECRET,

  firebase: {
    // Full JSON key file content for a Firebase service account (Project
    // Settings -> Service Accounts -> Generate new private key). Used to
    // persist applications.json/users.json to Firestore across Render
    // redeploys, which otherwise wipe the local disk. The project ID is
    // read directly from this key, so no separate env var is needed.
    serviceAccountKey: process.env.FIREBASE_SERVICE_ACCOUNT_KEY,
  },

  resend: {
    // Transactional-email API key (resend.com). Used solely to notify the
    // operator by email when a user unsubscribes. Unset = email.js no-ops
    // (logs only), same graceful-degradation pattern as every other
    // optional integration in this app.
    apiKey: process.env.RESEND_API_KEY,
  },

  // Where the unsubscribe notification email is sent. Configurable via env
  // so this isn't hardcoded, but defaults to the operator's own address.
  adminNotifyEmail: process.env.ADMIN_NOTIFY_EMAIL || "ofirvqa@gmail.com",
};
