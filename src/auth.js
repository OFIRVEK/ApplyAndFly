import { google } from "googleapis";
import { config } from "./config.js";
import { upsertUser } from "./users.js";

// Stateless — only used to build the authorization URL and do the one-time
// code exchange in the callback. Never holds a specific user's credentials.
export const oauth2Client = new google.auth.OAuth2(
  config.google.clientId,
  config.google.clientSecret,
  config.google.redirectUri
);

export function getAuthUrl(state) {
  return oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [
      "https://www.googleapis.com/auth/gmail.readonly",
    ],
    ...(state ? { state } : {}),
  });
}

// A fresh client per user, built from that user's own stored tokens —
// replaces the old single shared `userAuth` that a second user's login
// would silently overwrite. Google's client refreshes access tokens
// automatically; the "tokens" event fires when it does, so the refreshed
// token gets persisted back to this specific user's record instead of
// being lost when the process exits.
export function createUserOAuthClient(waId, tokens) {
  const client = new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
    config.google.redirectUri
  );
  client.setCredentials(tokens);
  client.on("tokens", (newTokens) => {
    upsertUser(waId, { tokens: { ...tokens, ...newTokens } });
  });
  return client;
}

// Unsubscribe flow: tells Google to invalidate this grant entirely (both
// access and refresh token) rather than just deleting our own local copy —
// without this, the app would stop USING the tokens but Google would still
// consider the grant active, so the tokens would keep silently working if
// they ever leaked or were somehow retained elsewhere. Best-effort: a token
// already expired/revoked makes Google's endpoint error, which shouldn't
// block the rest of the unsubscribe flow (local revocation already
// happened by the time this is called — tokens are being cleared either
// way), so this only logs on failure rather than throwing.
export async function revokeUserTokens(tokens) {
  if (!tokens?.access_token && !tokens?.refresh_token) return;
  const client = new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
    config.google.redirectUri
  );
  client.setCredentials(tokens);
  try {
    await client.revokeCredentials();
    console.log("[auth] Google token grant revoked");
  } catch (err) {
    console.error("[auth] failed to revoke Google tokens (continuing anyway):", err.response?.data || err.message || err);
  }
}