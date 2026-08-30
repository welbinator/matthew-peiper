export const prerender = false;

import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { makeId } from "../../../lib/support-auth";
import { ALLOWED_TYPES, MAX_FILE_BYTES, safeName } from "../../../lib/support-uploads";

/**
 * Server-to-server R2 ingest for support attachments filed through a Command
 * Center that has no R2 access of its own (e.g. Matthew's Flask CC).
 *
 * The CC streams raw file bytes here; we validate, store in R2, insert the
 * support_attachments row, and return metadata. Viewing is a signed GET.
 *
 * Auth: HMAC-SHA256 with PUSH_NOTIFY_SECRET (already shared CC↔site).
 *   POST sig base:  v0:<ts>:<ticket>:<filename>:<sha256hex(body)>
 *   GET  sig base:  v0:<ts>:get:<attachment_id>
 * Header: X-CC-Signature: t=<ts>,v0=<hex>
 */

function json(data: unknown, status = 200) {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json" },
	});
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

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
	const d = await crypto.subtle.digest("SHA-256", buf);
	return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function parseSig(header: string | null): { ts: string; v0: string } | null {
	if (!header) return null;
	const parts = Object.fromEntries(
		header.split(",").map((p) => {
			const [k, ...rest] = p.trim().split("=");
			return [k, rest.join("=")];
		})
	);
	if (!parts.t || !parts.v0) return null;
	return { ts: parts.t, v0: parts.v0 };
}

function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

const REPLAY_WINDOW = 300; // seconds

/** POST — CC uploads a file (raw body) → R2 + support_attachments row. */
export const POST: APIRoute = async ({ request }) => {
	const secret = (env as Record<string, string | undefined>).PUSH_NOTIFY_SECRET;
	if (!secret) return json({ ok: false, error: "Not configured" }, 500);

	const ticketId = (request.headers.get("X-CC-Ticket") || "").trim().slice(0, 80);
	const messageId = (request.headers.get("X-CC-Message") || "").trim().slice(0, 80) || null;
	const rawName = request.headers.get("X-CC-Filename") || "file";
	const contentType = (request.headers.get("X-CC-Content-Type") || "").trim();
	const uploadedBy = (request.headers.get("X-CC-Uploader") || "").trim().slice(0, 200);

	if (!ticketId) return json({ ok: false, error: "ticket required" }, 400);
	if (!ALLOWED_TYPES[contentType]) {
		return json({ ok: false, error: "unsupported type" }, 415);
	}

	const buf = await request.arrayBuffer();
	if (buf.byteLength === 0) return json({ ok: false, error: "empty file" }, 400);
	if (buf.byteLength > MAX_FILE_BYTES) {
		return json({ ok: false, error: "file too large" }, 413);
	}

	const sig = parseSig(request.headers.get("X-CC-Signature"));
	if (!sig) return json({ ok: false, error: "unsigned" }, 401);
	const ts = parseInt(sig.ts, 10);
	if (!ts || Math.abs(Math.floor(Date.now() / 1000) - ts) > REPLAY_WINDOW) {
		return json({ ok: false, error: "stale signature" }, 401);
	}
	const decodedName = decodeURIComponent(rawName);
	const bodyHash = await sha256Hex(buf);
	const expect = await hmacHex(secret, `v0:${sig.ts}:${ticketId}:${decodedName}:${bodyHash}`);
	if (!timingSafeEqual(expect, sig.v0)) {
		return json({ ok: false, error: "bad signature" }, 401);
	}

	const db = env.DB;
	if (!db) return json({ ok: false, error: "Database unavailable" }, 500);

	const ext = ALLOWED_TYPES[contentType] || "bin";
	const id = makeId("att");
	const key = `support/${ticketId}/${id}.${ext}`;
	const filename = safeName(decodedName, ext);
	const now = new Date().toISOString();

	try {
		await env.SUPPORT_UPLOADS.put(key, buf, { httpMetadata: { contentType } });
		await db
			.prepare(
				`INSERT INTO support_attachments
					(id, ticket_id, message_id, r2_key, filename, content_type, size_bytes, uploaded_by, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.bind(id, ticketId, messageId, key, filename, contentType, buf.byteLength, uploadedBy, now)
			.run();
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error("support ingest error:", msg);
		return json({ ok: false, error: "store failed" }, 500);
	}

	return json({
		ok: true,
		attachment: { id, filename, content_type: contentType, size_bytes: buf.byteLength },
	});
};

/** GET ?id=<att>&t=<ts>&v0=<sig> — signed fetch so the CC can proxy a file to staff. */
export const GET: APIRoute = async ({ request }) => {
	const secret = (env as Record<string, string | undefined>).PUSH_NOTIFY_SECRET;
	if (!secret) return json({ ok: false, error: "Not configured" }, 500);

	const url = new URL(request.url);
	const id = (url.searchParams.get("id") || "").trim();
	const tsStr = url.searchParams.get("t") || "";
	const v0 = url.searchParams.get("v0") || "";
	if (!id) return json({ ok: false, error: "id required" }, 400);

	const ts = parseInt(tsStr, 10);
	if (!ts || Math.abs(Math.floor(Date.now() / 1000) - ts) > REPLAY_WINDOW) {
		return json({ ok: false, error: "stale signature" }, 401);
	}
	const expect = await hmacHex(secret, `v0:${tsStr}:get:${id}`);
	if (!timingSafeEqual(expect, v0)) {
		return json({ ok: false, error: "bad signature" }, 401);
	}

	const db = env.DB;
	if (!db) return json({ ok: false, error: "Database unavailable" }, 500);

	const row = await db
		.prepare(
			`SELECT r2_key, filename, content_type FROM support_attachments WHERE id = ? LIMIT 1`
		)
		.bind(id)
		.first<{ r2_key: string; filename: string; content_type: string }>();
	if (!row) return json({ ok: false, error: "Not found" }, 404);

	const obj = await env.SUPPORT_UPLOADS.get(row.r2_key);
	if (!obj) return json({ ok: false, error: "File no longer available" }, 404);

	const headers = new Headers();
	headers.set("Content-Type", row.content_type || "application/octet-stream");
	const safe = row.filename.replace(/["\\\r\n]/g, "_");
	headers.set("Content-Disposition", `inline; filename="${safe}"`);
	return new Response(obj.body, { status: 200, headers });
};
