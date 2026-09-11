// Railway's edge sets `X-Real-IP` to the client's remote address, and documents
// it as the header for identifying the client IP:
// https://docs.railway.com/networking/public-networking/specs-and-limits
//
// It is the only trustworthy client-IP source behind Railway. Express's `req.ip`
// (with `trust proxy` enabled) reads the LEFT-MOST `X-Forwarded-For` entry, which
// a client can spoof by prepending a fake value — so it must not be used for
// abuse logging or rate-limit keys. We prefer `X-Real-IP` and only fall back to
// `req.ip` for non-Railway/local runs where the edge header is absent.
export function clientIp(req) {
  const realIp = req.get?.("x-real-ip");
  if (typeof realIp === "string" && realIp.trim()) {
    return realIp.trim();
  }
  return req.ip || null;
}
