import dotenv from "dotenv";
import path from "path";

// load env ONCE, explicitly
dotenv.config({ path: path.resolve(process.cwd(), ".env") });

console.log("CLIENT_ID:", process.env.GOOGLE_CLIENT_ID);
console.log("Redirect URI:", process.env.GOOGLE_REDIRECT_URI);
console.log("ENV TO NUMBER:", process.env.WHATSAPP_TO_NUMBER);

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
  },

  whatsapp: {
    token: process.env.WHATSAPP_TOKEN,
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
    to: process.env.WHATSAPP_TO_NUMBER,
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN,
  },

  groq: {
    apiKey: process.env.GROQ_API_KEY,
  },

  tavily: {
    apiKey: process.env.TAVILY_API_KEY,
  },

  firecrawl: {
    apiKey: process.env.FIRECRAWL_API_KEY,
  },

  firebase: {
    // Full JSON key file content for a Firebase service account (Project
    // Settings -> Service Accounts -> Generate new private key). Used to
    // persist applications.json/users.json to Firestore across Render
    // redeploys, which otherwise wipe the local disk. The project ID is
    // read directly from this key, so no separate env var is needed.
    serviceAccountKey: process.env.FIREBASE_SERVICE_ACCOUNT_KEY,
  },
};
