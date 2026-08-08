const CONFIRMATION_PHRASES = [
  'thank you for applying', 'thanks for applying',
  'we received your application', "we've received your application",
  'your application has been received', 'your application was received',
  'your application has been submitted', 'application confirmation'
];

export function isJobEmail(text = '') {
  const keywords = [
    'application','applied','applying','interview','recruiter',
    'position','job','hiring','assessment','interest'
  ];
  const lower = text.toLowerCase();
  if (CONFIRMATION_PHRASES.some(p => lower.includes(p))) return true;
  if (looksLikeJobSuggestion(text)) return false;
  return keywords.some(k => lower.includes(k));
}

// Job recommendation/suggestion digests (LinkedIn, job boards, recruiting
// agencies pitching a role the recipient has NOT applied to) can still
// contain enough incidental English (a role name, "QA", etc.) to slip past
// the English keyword pre-filter even when the email is mostly in another
// language — and the non-English path's own suggestion check only runs for
// emails that path actually flagged. Checking this universally, regardless
// of which path matched, closes that gap. Deliberately excludes anything
// too generic (e.g. a plain "for more details" link) that could appear in
// genuine confirmations too.
const JOB_SUGGESTION_PHRASES = [
  // English
  'jobs you may be interested', 'recommended jobs', 'recommended for you',
  'new jobs for you', 'job alert', 'jobs matching', 'similar jobs',
  'jobs based on your', 'weekly job digest', 'jobs you might like',
  'people are also viewing', 'top job picks', 'apply now to',
  // Hebrew — job board / recruiter "here's a role you haven't applied to" pitches
  'חשבנו עליך', 'התאמה למשרה', 'משרות מומלצות', 'משרות דומות',
  'מצאנו עבורך משרה', 'משרה שעשויה לעניין אותך', 'משרות חדשות עבורך',
  'להתאים לך', 'המתאימות לך', 'המתאימה לך',
];

// Structural signal, not just phrase-matching: a genuine application
// confirmation is always about exactly ONE job. An email announcing a count
// of multiple postings ("2 new jobs...", "עלו 2 משרות...") is a digest, no
// matter how it's phrased — this catches new wording variants without
// needing another reactive phrase added every time.
const JOB_COUNT_DIGEST_REGEX = /\b[2-9]\d*\s*(jobs|job openings|new jobs)\b|\d+\s*משרות/i;

// "Your job's expiring" / "job is expiring soon" — LinkedIn and job boards
// send these as a reminder that a SAVED posting is about to close, not a
// confirmation that the recipient applied to it. Written as a regex (not a
// literal phrase) since the apostrophe in "job's" varies (straight vs
// curly) between senders.
const JOB_EXPIRING_REGEX = /\bjob.{0,3}\s*expir(ing|es|ation)\b/i;

export function looksLikeJobSuggestion(text = '') {
  const lower = text.toLowerCase();
  if (JOB_COUNT_DIGEST_REGEX.test(text) || JOB_EXPIRING_REGEX.test(text)) return true;
  return JOB_SUGGESTION_PHRASES.some((p) => lower.includes(p) || text.includes(p));
}

export function hasStrongConfirmationPhrase(text = '') {
  const lower = text.toLowerCase();
  return CONFIRMATION_PHRASES.some(p => lower.includes(p));
}

// Rejection emails very often open with the same "thank you for applying"
// phrasing as a genuine confirmation, before pivoting to a decline further
// down. This catches that pivot so a strong confirmation-phrase match never
// blindly overrides an actual rejection.
const REJECTION_PHRASES = [
  'we have decided to move forward with other candidates',
  'we have decided to move forward with another candidate',
  'move forward with other candidates',
  'moving forward with other candidates',
  'will not be moving forward',
  "won't be moving forward",
  'not be proceeding with your application',
  'decided not to proceed with your application',
  'other candidates whose qualifications',
  'position has been filled',
  'we will not be able to move forward',
  'unfortunately', 'regret to inform',
];

export function looksLikeRejection(text = '') {
  const lower = text.toLowerCase();
  return REJECTION_PHRASES.some(p => lower.includes(p));
}

// Same problem as rejections: interview invites, assessment/task requests
// can carry the same "thank you for applying"-style boilerplate ATS systems
// reuse across every stage, not just the initial confirmation. Catches that
// so a strong confirmation-phrase match doesn't blindly promote a
// later-stage email into a "confirmation received" send.
const INTERVIEW_STAGE_PHRASES = [
  'schedule your interview', 'schedule an interview', 'interview invitation',
  'technical interview', 'phone interview', 'video interview', 'your video interview',
  'phone screen', 'book a time', 'select a time',
  'next step in our process', 'next steps in the process',
  'coding challenge', 'take-home assignment', 'take home assignment',
  'complete the assessment',
];

export function looksLikeInterviewStage(text = '') {
  const lower = text.toLowerCase();
  return INTERVIEW_STAGE_PHRASES.some(p => lower.includes(p));
}

// Offer letters are their own category (maps to "Hired" on the dashboard),
// distinct from interview/assessment stages (maps to "In Progress").
const OFFER_PHRASES = [
  'offer letter', 'pleased to offer', 'we are excited to offer',
  "we're excited to offer", 'offer of employment', 'employment offer',
  'welcome to the team', 'your start date',
];

export function looksLikeOffer(text = '') {
  const lower = text.toLowerCase();
  return OFFER_PHRASES.some(p => lower.includes(p));
}

// Covers Hebrew, Arabic, Cyrillic, Greek, Devanagari, Thai, CJK, Hangul.
// The English keyword lists above only ever match Latin-script English text,
// so anything written in one of these scripts would otherwise be silently
// dropped before it ever reaches the LLM. This is a broad "might be a
// non-English email, let the LLM take a look" signal — not a precise
// language detector.
const NON_LATIN_SCRIPT_REGEX =
  /[Ͱ-ϿЀ-ӿ֐-׿؀-ۿऀ-ॿ฀-๿぀-ヿ一-鿿가-힣]/;

export function looksNonEnglish(text = '') {
  return NON_LATIN_SCRIPT_REGEX.test(text);
}

// Cheap reject list for obvious marketing/promo emails in non-English scripts,
// so we don't burn an LLM call (and rate-limit budget) on things like
// "...| פרסומת" (Hebrew for "advertisement"). Mirrors suggestionPhrases above.
const NON_ENGLISH_PROMO_MARKERS = [
  'פרסומת', 'מבצע', 'מבצעים', 'הנחה', 'הנחות', 'קופון',
  'إعلان', 'خصم', 'عرض',
];

export function looksPromotional(text = '') {
  return NON_ENGLISH_PROMO_MARKERS.some(p => text.includes(p));
}

// Cheap reject list for common non-job transactional emails in non-English
// scripts (banking, payments, deliveries) — these often contain words like
// "confirmation" or a reference number that could otherwise look job-like
// to a keyword scan, e.g. a bank notice with an אסמכתה (reference number).
const NON_ENGLISH_NON_JOB_MARKERS = [
  // Hebrew: bank / payment / transaction terms
  'בנק', 'אסמכתה', 'חיוב', 'זיכוי', 'יתרה', 'העברה בנקאית',
  'כרטיס אשראי', 'חשבונית', 'תשלום', 'משכורת', 'ביטוח לאומי',
];

export function looksNonJobTransactional(text = '') {
  return NON_ENGLISH_NON_JOB_MARKERS.some(p => text.includes(p));
}

// Positive requirement (allowlist), mirroring how the English keyword list
// in isJobEmail works — require an actual job-related term, rather than
// just "didn't match a known-bad category". A blocklist alone means every
// new non-job category (receipts, deliveries, newsletters, ...) needs its
// own reactive patch; this closes that gap by default instead of per-case.
const JOB_RELATED_NON_ENGLISH_KEYWORDS = [
  // Hebrew: application / position / interview / recruiting / resume
  'מועמדות', 'משרה', 'משרות', 'ראיון', 'ראיונות', 'קורות חיים',
  'גיוס', 'מגייס', 'מגייסת', 'מכרז', 'דרושים', 'דרוש', 'התפקיד', 'מיון מועמדים',
];

export function looksJobRelatedNonEnglish(text = '') {
  return JOB_RELATED_NON_ENGLISH_KEYWORDS.some(k => text.includes(k));
}

// Genuine job-application-confirmation emails never mention prices/payments
// — that's not what a "we received your application" email does. A clear
// payment-info signal (currency amount, checkout/receipt language) is a
// strong sign this is a purchase/booking of some kind, not a job
// application, regardless of language or what else matched. Works across
// both the English and non-English pipelines.
const PAYMENT_INDICATOR_REGEX = /[$€£₪]\s?\d|\d\s?[$€£₪]/;
const PAYMENT_KEYWORDS = [
  // English
  'total amount', 'payment method', 'amount charged', 'grand total',
  'subtotal', 'order total', 'amount due', 'card ending', 'transaction id',
  'receipt number', 'billing address', 'payment confirmation', 'amount paid',
  // Hebrew
  'סכום לתשלום', 'סה"כ לתשלום', 'אמצעי תשלום', 'סכום כולל', 'אישור תשלום',
];

// Automated service notifications — Google account/security alerts (OAuth
// consent grants, new sign-in alerts, password-changed emails), and this
// app's own hosting platform (Render deploy/cron-job alerts) — always come
// from a known infra domain and are NEVER job-application confirmations.
// But their boilerplate can legitimately contain the exact generic words
// the keyword pre-filter looks for: Google's "third-party application", or
// Render's own "job" terminology in something like "Your deploy job
// failed", which is enough to fool both the keyword pre-filter and,
// sometimes, the classification LLM. Checking the sender's actual domain is
// a hard, reliable signal that phrase-matching can't be.
const AUTOMATED_SERVICE_DOMAINS = ['google.com', 'render.com'];

export function looksLikeAccountNotice(fromHeader = '') {
  const match = fromHeader.match(/[\w.+-]+@([\w.-]+)/);
  if (!match) return false;
  const domain = match[1].toLowerCase();
  return AUTOMATED_SERVICE_DOMAINS.some((known) => domain === known || domain.endsWith(`.${known}`));
}

// Messages from Israel's Employment Service can contain job-related words,
// but a visit/appointment at a government employment office is not an
// application submitted to an employer. Treat these notices as non-job mail
// before the LLM classifier has a chance to mistake them for an application.
const ISRAELI_EMPLOYMENT_SERVICE_MARKERS = [
  'sherut hataasuka', 'israeli employment service',
  'שירות התעסוקה', 'לשכת התעסוקה',
];

export function looksLikeIsraeliEmploymentServiceNotice(text = '', fromHeader = '') {
  const combined = `${text}\n${fromHeader}`.toLowerCase();
  return ISRAELI_EMPLOYMENT_SERVICE_MARKERS.some((marker) => combined.includes(marker));
}

export function looksLikePayment(text = '') {
  const lower = text.toLowerCase();
  if (PAYMENT_KEYWORDS.some(k => lower.includes(k.toLowerCase()) || text.includes(k))) {
    return true;
  }
  return PAYMENT_INDICATOR_REGEX.test(text);
}

export function extractCompany(from = '') {
  return from.split('<')[0]?.trim() || 'Unknown Company';
}
