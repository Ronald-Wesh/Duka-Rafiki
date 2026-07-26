/**
 * Twilio media arrives as a URL, not bytes, and the URL needs HTTP basic auth
 * with the account credentials. The AccountSid comes in the webhook body, so
 * only the auth token has to be configured.
 */

export interface Attachment {
  contentType: string;
  base64: string;
}

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

export function isImage(contentType: string): boolean {
  return IMAGE_TYPES.includes(contentType.split(";")[0].trim().toLowerCase());
}

export function isAudio(contentType: string): boolean {
  return contentType.toLowerCase().startsWith("audio/");
}

/** Pull MediaUrl0..N / MediaContentType0..N out of a Twilio form body. */
export function mediaFromBody(body: Record<string, unknown>): Array<{ url: string; contentType: string }> {
  const n = Number(body.NumMedia ?? 0);
  const out: Array<{ url: string; contentType: string }> = [];
  for (let i = 0; i < n; i++) {
    const url = body[`MediaUrl${i}`];
    const contentType = body[`MediaContentType${i}`];
    if (typeof url === "string" && typeof contentType === "string") {
      out.push({ url, contentType });
    }
  }
  return out;
}

/**
 * MediaUrl comes from the request body, which is attacker-controlled whenever
 * signature checking is off — so the host is checked before any credential is
 * attached. Compare parsed `hostname`, never the raw string: a startsWith test
 * is defeated by `https://api.twilio.com@evil.com/`.
 */
const TWILIO_HOSTS = /^(api\.twilio\.com|media\.twiliocdn\.com|mcs\.[a-z0-9-]+\.twilio\.com)$/;

function isTwilioHost(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && TWILIO_HOSTS.test(u.hostname);
  } catch {
    return false;
  }
}

export async function downloadMedia(
  url: string,
  accountSid: string,
  authToken: string
): Promise<Attachment | null> {
  if (!accountSid || !authToken) {
    console.error("[media] missing Twilio credentials — cannot fetch media");
    return null;
  }
  if (!isTwilioHost(url)) {
    console.error(`[media] refusing non-Twilio media URL: ${url.slice(0, 120)}`);
    return null;
  }

  try {
    const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
    // redirect: "manual" — api.twilio.com 307s to a pre-signed CDN URL, and an
    // automatic follow would replay the Authorization header at wherever the
    // redirect points.
    let res = await fetch(url, {
      headers: { Authorization: `Basic ${auth}` },
      redirect: "manual",
    });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location") ?? "";
      if (!isTwilioHost(location)) {
        console.error(`[media] refusing redirect to ${location.slice(0, 120)}`);
        return null;
      }
      // No credentials on the second hop: the CDN URL is already signed.
      res = await fetch(location, { redirect: "manual" });
    }

    if (!res.ok) {
      console.error(`[media] fetch failed ${res.status} for ${url}`);
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    // Anthropic caps images at 5MB base64; a phone photo can exceed it.
    if (buf.length > 3_500_000) {
      console.error(`[media] too large (${buf.length} bytes)`);
      return null;
    }
    return {
      contentType: (res.headers.get("content-type") ?? "image/jpeg").split(";")[0].trim(),
      base64: buf.toString("base64"),
    };
  } catch (err) {
    console.error("[media] download error:", err);
    return null;
  }
}
