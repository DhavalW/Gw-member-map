export interface SubmissionInput {
  display_name: string;
  email: string | null;
  location_name: string;
  lat: number;
  lng: number;
  bio: string;
  contact: string; // raw "how to connect" value
  consent_public: boolean;
}

export interface ValidationResult {
  ok: boolean;
  errors: Record<string, string>;
  value?: SubmissionInput & { contact_label: string; contact_url: string };
}

const LIMITS = {
  display_name: 80,
  location_name: 120,
  bio: 600,
  contact: 200,
  email: 254,
};

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Turn the freeform "how to connect" value into a safe label + optional href.
 * - http(s) URLs -> link as-is
 * - bare domains  -> https:// prepended
 * - emails        -> mailto:
 * - @handles/text -> shown as plain label (no link)
 */
export function normaliseContact(raw: string): { label: string; url: string } {
  const value = raw.trim();
  if (!value) return { label: "", url: "" };

  if (/^https?:\/\//i.test(value)) {
    try {
      const u = new URL(value);
      if (u.protocol === "http:" || u.protocol === "https:") {
        return { label: value, url: u.toString() };
      }
    } catch {
      /* fall through */
    }
    return { label: value, url: "" };
  }

  if (EMAIL_RE.test(value)) {
    return { label: value, url: `mailto:${value}` };
  }

  // Bare domain like "example.com/foo"
  if (/^[a-z0-9.-]+\.[a-z]{2,}(\/[^\s]*)?$/i.test(value)) {
    return { label: value, url: `https://${value}` };
  }

  // Handle or free text: display only, never linked.
  return { label: value, url: "" };
}

export function validateSubmission(
  body: Record<string, unknown>,
  opts: { requireConsent?: boolean } = {},
): ValidationResult {
  const { requireConsent = true } = opts;
  const errors: Record<string, string> = {};

  const display_name = str(body.display_name);
  const location_name = str(body.location_name);
  const bio = str(body.bio);
  const contact = str(body.contact);
  const emailRaw = str(body.email);
  const email = emailRaw ? emailRaw.toLowerCase() : null;
  const consent_public = body.consent_public === true || body.consent_public === "true";

  const lat = Number(body.lat);
  const lng = Number(body.lng);

  if (!display_name) errors.display_name = "Please enter a name.";
  else if (display_name.length > LIMITS.display_name)
    errors.display_name = `Name must be ${LIMITS.display_name} characters or fewer.`;

  if (!location_name) errors.location_name = "Please enter your city or location.";
  else if (location_name.length > LIMITS.location_name)
    errors.location_name = `Location must be ${LIMITS.location_name} characters or fewer.`;

  if (bio.length > LIMITS.bio)
    errors.bio = `Bio must be ${LIMITS.bio} characters or fewer.`;

  if (contact.length > LIMITS.contact)
    errors.contact = `Contact must be ${LIMITS.contact} characters or fewer.`;

  if (email) {
    if (email.length > LIMITS.email || !EMAIL_RE.test(email))
      errors.email = "Please enter a valid email address.";
  }

  if (!Number.isFinite(lat) || lat < -90 || lat > 90)
    errors.lat = "Invalid location. Pick a point on the map.";
  if (!Number.isFinite(lng) || lng < -180 || lng > 180)
    errors.lng = "Invalid location. Pick a point on the map.";

  if (requireConsent && !consent_public)
    errors.consent_public = "You must opt in to be shown publicly.";

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const { label, url } = normaliseContact(contact);

  return {
    ok: true,
    errors: {},
    value: {
      display_name,
      email,
      location_name,
      lat,
      lng,
      bio,
      contact,
      consent_public,
      contact_label: label,
      contact_url: url,
    },
  };
}
