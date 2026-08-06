import { google } from 'googleapis';

export function getGmailClient(auth) {
  return google.gmail({ version: 'v1', auth });
}

export async function listEmails(gmail) {
  const res = await gmail.users.messages.list({
    userId: 'me',
    labelIds: ['INBOX'],
    maxResults: 200
  });
  return res.data.messages || [];
}

// One-time onboarding scan of a user-named Gmail label/folder (e.g. a folder
// they've been manually moving application emails into), before the bot
// settles into the normal recurring Inbox-only poll.
export async function listEmailsByFolder(gmail, folderName) {
  const res = await gmail.users.messages.list({
    userId: 'me',
    q: `label:"${folderName}"`,
    maxResults: 200
  });
  return res.data.messages || [];
}

export async function getEmail(gmail, id) {
  const res = await gmail.users.messages.get({
    userId: 'me',
    id
  });
  return res.data;
}

function findTextPart(parts) {
  for (const part of parts) {
    if (part.mimeType === 'text/plain' && part.body?.data) return part.body.data;
    if (part.parts) {
      const found = findTextPart(part.parts);
      if (found) return found;
    }
  }
  return null;
}

export function decodeEmail(payload) {
  try {
    const parts = payload.payload?.parts;
    const data = parts ? findTextPart(parts) : payload.payload?.body?.data;
    if (!data) return payload.snippet || '';
    return Buffer.from(data, 'base64').toString('utf8');
  } catch {
    return payload.snippet || '';
  }
}

function findHtmlPart(parts) {
  for (const part of parts) {
    if (part.mimeType === 'text/html' && part.body?.data) return part.body.data;
    if (part.parts) {
      const found = findHtmlPart(part.parts);
      if (found) return found;
    }
  }
  return null;
}

// Separate from decodeEmail on purpose: classification wants clean plain
// text, but link anchor text ("Visit our website", "Career page") only
// exists in the HTML version — plain-text alternatives usually strip
// formatting and leave bare/no URLs.
export function decodeEmailHtml(payload) {
  try {
    const parts = payload.payload?.parts;
    const isTopLevelHtml = payload.payload?.mimeType === 'text/html';
    const data = parts ? findHtmlPart(parts) : (isTopLevelHtml ? payload.payload?.body?.data : null);
    if (!data) return '';
    return Buffer.from(data, 'base64').toString('utf8');
  } catch {
    return '';
  }
}
