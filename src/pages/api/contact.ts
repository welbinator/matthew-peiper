export const prerender = false;

import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";

// ── Spam scoring (same heuristics as Apex Branding Worker) ───────────────────
// Runs at ingest, zero external calls. Manual override lives in Command Center.
const SPAM_KEYWORDS = [
	"viagra",
	"cialis",
	"casino",
	"porn",
	"crypto pump",
	"forex",
	"bitcoin doubler",
	"seo services",
	"guest post",
	"backlink",
	"loan offer",
	"weight loss",
	"buy followers",
	// Cold-outreach / agency spam selling TO the site owner (not inquiring)
	"branding refresh",
	"could benefit from",
	"we can help elevate",
	"elevate your visual",
	"online visibility",
	"backend analysis",
	"not appearing on google",
	"digital marketing agency",
	"grow your online",
	"our team would be happy",
];

function scoreSpam(input: {
	message: string;
	name: string;
	email: string;
}): { spam: boolean; reason: string } {
	const reasons: string[] = [];
	const body = `${input.message}`.toLowerCase();
	const nameBlob = `${input.name}`.toLowerCase();

	// 1. Link stuffing — genuine contact messages rarely carry several URLs.
	const linkCount = (body.match(/https?:\/\/|www\.|\[url|<a\s/gi) || []).length;
	if (linkCount >= 3) reasons.push(`links:${linkCount}`);

	// 2. Known spam keywords.
	const hitKw = SPAM_KEYWORDS.filter((k) => body.includes(k));
	if (hitKw.length) reasons.push(`kw:${hitKw.slice(0, 3).join("/")}`);

	// 3. BBCode / raw anchor markup — a bot fingerprint.
	if (/\[url=|\[link=|<a\s+href/i.test(input.message)) reasons.push("markup");

	// 4. Cyrillic / CJK in name field on an English-only form.
	if (/[\u0400-\u04FF\u4E00-\u9FFF]/.test(nameBlob)) reasons.push("nonlatin-name");

	// 5. Name equals email (common bot fill).
	if (input.email && nameBlob.replace(/\s/g, "") === input.email.toLowerCase()) {
		reasons.push("name=email");
	}

	// 6. Cold outreach selling marketing/branding/SEO *to* the business.
	//    Real clients ask about carpentry; spammers pitch their own services.
	if (
		/\b(we can help|our (team|agency)|i can help)\b/i.test(input.message) &&
		/\b(branding|seo|marketing|visibility|ranking|leads|web design)\b/i.test(input.message)
	) {
		reasons.push("cold-outreach");
	}

	return { spam: reasons.length > 0, reason: reasons.join(",") };
}

// ── Command Center lead notification ─────────────────────────────────────────
// After a successful NON-SPAM insert we POST a small payload to Command Center's
// /api/push/notify, signed with HMAC-SHA256 (scheme: v0:{ts}:{body}) using the
// shared PUSH_NOTIFY_SECRET secret. CC drops it in the desktop bell and fires a
// phone Web Push. Fire-and-forget — never blocks or fails the submission.
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

async function notifyCommandCenter(lead: { name: string; email: string; message: string }) {
	const secret = (env as Record<string, string>).PUSH_NOTIFY_SECRET;
	if (!secret) return; // not configured — skip silently
	const url =
		(env as Record<string, string>).CC_NOTIFY_URL ||
		"https://cc.crweb.design/api/push/notify";
	try {
		const ts = Math.floor(Date.now() / 1000);
		const body = JSON.stringify({
			name: lead.name,
			email: lead.email,
			site: "matthewpeiper.com",
			message: lead.message,
			ts,
		});
		const sig = await hmacHex(secret, `v0:${ts}:${body}`);
		await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-CC-Signature": `t=${ts},v0=${sig}`,
			},
			body,
		});
	} catch (_) {
		// CC unreachable — the submission is already safely in D1; ignore.
	}
}

// Generate a ULID-compatible ID
function makeId(): string {
	const t = Date.now();
	const chars = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
	let id = "";
	let time = t;
	for (let i = 9; i >= 0; i--) {
		id = chars[time % 32] + id;
		time = Math.floor(time / 32);
	}
	for (let i = 0; i < 16; i++) {
		id += chars[Math.floor(Math.random() * 32)];
	}
	return id;
}

function clean(v: unknown, max: number): string {
	if (typeof v !== "string") return "";
	return v.trim().slice(0, max);
}

// ── Cloudflare Turnstile verification ────────────────────────────────────────
// Validates the client-supplied token against Cloudflare's siteverify endpoint.
// Returns { ok: true } when the challenge passed. If no secret is configured
// (TURNSTILE_SECRET_KEY unset) we fail OPEN so the form never bricks — the
// honeypot + heuristic scoring still apply. A present-but-failed token fails
// CLOSED (rejected as a bot).
async function verifyTurnstile(
	token: string,
	ip: string | null
): Promise<{ ok: boolean; reason: string }> {
	const secret = (env as Record<string, string>).TURNSTILE_SECRET_KEY;
	if (!secret) return { ok: true, reason: "turnstile-not-configured" };
	if (!token) return { ok: false, reason: "turnstile-missing" };
	try {
		const form = new FormData();
		form.append("secret", secret);
		form.append("response", token);
		if (ip) form.append("remoteip", ip);
		const resp = await fetch(
			"https://challenges.cloudflare.com/turnstile/v0/siteverify",
			{ method: "POST", body: form }
		);
		const data = (await resp.json()) as { success: boolean; "error-codes"?: string[] };
		if (data.success) return { ok: true, reason: "ok" };
		return { ok: false, reason: (data["error-codes"] || ["turnstile-failed"]).join(",") };
	} catch {
		// Network error reaching Cloudflare — fail open rather than lose a lead.
		return { ok: true, reason: "turnstile-verify-error" };
	}
}

export const POST: APIRoute = async ({ request }) => {
	const headers = { "Content-Type": "application/json" };

	// Parse request body
	let body: Record<string, string>;
	try {
		const ct = request.headers.get("content-type") || "";
		if (ct.includes("application/json")) {
			body = await request.json();
		} else {
			const fd = await request.formData();
			body = Object.fromEntries([...fd.entries()].map(([k, v]) => [k, String(v)]));
		}
	} catch {
		return new Response(JSON.stringify({ ok: false, error: "Invalid request body" }), {
			status: 400,
			headers,
		});
	}

	// Turnstile: verify the anti-spam challenge before doing anything else.
	// (Skipped automatically if TURNSTILE_SECRET_KEY is not configured.)
	const ip = request.headers.get("CF-Connecting-IP");
	const turnstileToken = clean(body["cf-turnstile-response"], 4096);
	const ts = await verifyTurnstile(turnstileToken, ip);
	if (!ts.ok) {
		return new Response(
			JSON.stringify({ ok: false, error: "Anti-spam check failed. Please try again." }),
			{ status: 403, headers }
		);
	}

	// Honeypot: real users leave this blank. A filled honeypot is almost certainly
	// a bot — store it flagged as spam (so it surfaces under the spam filter in
	// Command Center) rather than silently dropping it.
	const honeypotTripped = !!clean(body.website_hp, 200);

	const name = clean(body.name, 120);
	const email = clean(body.email, 254);
	const phone = clean(body.phone, 40);
	const project = clean(body.project, 80);
	const message = clean(body.message, 5000);

	// Validate required fields (skip for honeypot so we still store the attempt)
	if (!honeypotTripped) {
		if (!name || !email) {
			return new Response(
				JSON.stringify({ ok: false, error: "Name and email are required" }),
				{ status: 422, headers }
			);
		}
		if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
			return new Response(JSON.stringify({ ok: false, error: "Invalid email address" }), {
				status: 422,
				headers,
			});
		}
	}

	// Heuristic spam scoring (honeypot is an automatic, definitive flag).
	let is_spam = 0;
	let spam_reason: string | null = null;
	if (honeypotTripped) {
		is_spam = 1;
		spam_reason = "honeypot";
	} else {
		const s = scoreSpam({ message, name, email });
		if (s.spam) {
			is_spam = 1;
			spam_reason = s.reason;
		}
	}

	// 1. Save to D1
	try {
		const db = env.DB;

		if (!db) {
			return new Response(
				JSON.stringify({
					ok: false,
					error: "DB binding not available — check Cloudflare Pages bindings",
				}),
				{ status: 500, headers }
			);
		}

		const id = makeId();
		const now = new Date().toISOString();
		const slug = `submission-${id.toLowerCase()}`;

		await db
			.prepare(
				`INSERT INTO ec_contact_submissions
					(id, slug, status, created_at, updated_at, published_at, version, locale, translation_group,
					 name, email, phone, project, message, is_spam, spam_reason)
				VALUES (?, ?, 'published', ?, ?, ?, 1, 'en', ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.bind(
				id,
				slug,
				now,
				now,
				now,
				id,
				name || "(honeypot)",
				email || "",
				phone || "",
				project || "",
				message || "",
				is_spam,
				spam_reason
			)
			.run();
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error("D1 save error:", msg);
		return new Response(JSON.stringify({ ok: false, error: `D1 error: ${msg}` }), {
			status: 500,
			headers,
		});
	}

	// 2. Notify Command Center only for genuine (non-spam) leads. Fire-and-forget.
	if (!is_spam) {
		try {
			await notifyCommandCenter({
				name: name || "",
				email: email || "",
				message: message || "",
			});
		} catch (err) {
			console.warn("Command Center notify error:", err);
		}
	}

	// Always return ok to bots so they don't retry; real users get the same success UX.
	return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
};
