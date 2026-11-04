// Linear webhook signatures. AGE-20 builds the full receiver on top of this:
// the timestamp window, de-duplication by Linear-Delivery, and the queue.
import { createHmac, timingSafeEqual } from "node:crypto";

// Linear-Signature is the lowercase hex HMAC-SHA256 of the raw body, keyed with
// the webhook secret. Verify the exact bytes received, before any JSON parsing.
export function hasValidSignature(
  rawBody: Buffer,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(signature, "hex"));
}
