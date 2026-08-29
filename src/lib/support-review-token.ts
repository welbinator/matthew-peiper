/**
 * Signed staging-review tokens.
 * Format: base64url(json).hex_hmac_sha256
 * Payload: { tid, sid, exp }  // ticket id, site id, unix expiry
 * Secret: PUSH_NOTIFY_SECRET (same as CC webhooks)
 *
 * Must stay in lockstep with command-center/support_manager.py mint helpers.
 */

function b64urlEncode(bytes: Uint8Array): string {
	let bin = "";
	for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
	// btoa is available in Workers
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function b64urlEncodeStr(s: string): string {
	return b64urlEncode(new TextEncoder().encode(s));
}

function b64urlDecodeToString(s: string): string {
	const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
	const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
	const bin = atob(b64);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return new TextDecoder().decode(bytes);
}

async function hmacHex(secret: string, msg: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"]
	);
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
	return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type ReviewTokenPayload = {
	tid: string;
	sid: string;
	exp: number;
};

export async function mintReviewToken(
	secret: string,
	ticketId: string,
	siteId: string,
	ttlSeconds = 60 * 60 * 24 * 30
): Promise<string> {
	const payload: ReviewTokenPayload = {
		tid: ticketId,
		sid: siteId,
		exp: Math.floor(Date.now() / 1000) + ttlSeconds,
	};
	// Compact JSON — must match Python separators=(",", ":")
	const body = JSON.stringify(payload);
	const bodyB64 = b64urlEncodeStr(body);
	const sig = await hmacHex(secret, bodyB64);
	return `${bodyB64}.${sig}`;
}

export async function verifyReviewToken(
	secret: string,
	token: string,
	expectedSiteId?: string
): Promise<{ ok: true; payload: ReviewTokenPayload } | { ok: false; error: string }> {
	const raw = String(token || "").trim();
	const parts = raw.split(".");
	if (parts.length !== 2 || !parts[0] || !parts[1]) {
		return { ok: false, error: "Invalid review link" };
	}
	const [bodyB64, sig] = parts;
	const expect = await hmacHex(secret, bodyB64);
	// constant-time-ish compare
	if (expect.length !== sig.length) return { ok: false, error: "Invalid review link" };
	let diff = 0;
	for (let i = 0; i < expect.length; i++) diff |= expect.charCodeAt(i) ^ sig.charCodeAt(i);
	if (diff !== 0) return { ok: false, error: "Invalid review link" };

	let payload: ReviewTokenPayload;
	try {
		payload = JSON.parse(b64urlDecodeToString(bodyB64)) as ReviewTokenPayload;
	} catch {
		return { ok: false, error: "Invalid review link" };
	}
	if (!payload?.tid || !payload?.sid || !payload?.exp) {
		return { ok: false, error: "Invalid review link" };
	}
	if (Math.floor(Date.now() / 1000) > Number(payload.exp)) {
		return { ok: false, error: "This review link has expired. Open the link from your support thread." };
	}
	if (expectedSiteId && payload.sid !== expectedSiteId) {
		return { ok: false, error: "Invalid review link for this site" };
	}
	return { ok: true, payload };
}

/** Attach or replace ?review= token on a staging URL. */
export function withReviewQuery(stagingUrl: string, token: string): string {
	const base = String(stagingUrl || "").trim();
	if (!base) return base;
	try {
		const u = new URL(base);
		u.searchParams.set("review", token);
		return u.toString();
	} catch {
		const join = base.includes("?") ? "&" : "?";
		// strip existing review=
		const cleaned = base.replace(/([?&])review=[^&]*&?/g, "$1").replace(/[?&]$/, "");
		return `${cleaned}${cleaned.includes("?") ? "&" : join === "?" ? "?" : "&"}review=${encodeURIComponent(token)}`.replace(
			"&&",
			"&"
		);
	}
}
