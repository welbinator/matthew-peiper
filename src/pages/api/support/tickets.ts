export const prerender = false;

import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { makeId, requireUser } from "../../../lib/support-auth";
import { notifySupportTicket } from "../../../lib/support-cc";
import { collectValidFiles, storeFiles } from "../../../lib/support-uploads";

const SITE_ID = "matthew-peiper";
const SITE_HOST = "matthewpeiper.com";

function json(data: unknown, status = 200) {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function clean(v: unknown, max: number): string {
	if (typeof v !== "string") return "";
	return v.trim().slice(0, max);
}

export const GET: APIRoute = async ({ request }) => {
	const user = await requireUser(request);
	if (!user) return json({ ok: false, error: "Not authenticated" }, 401);

	const db = env.DB;
	if (!db) return json({ ok: false, error: "Database unavailable" }, 500);

	try {
		const { results } = await db
			.prepare(
				`SELECT id, subject, message, page_url, status, staging_url, approved_at, created_at, updated_at
				 FROM support_tickets
				 WHERE user_id = ?
				 ORDER BY updated_at DESC
				 LIMIT 100`
			)
			.bind(user.id)
			.all();

		const tickets = results || [];
		// Attach last message preview when available
		for (const t of tickets as Array<Record<string, unknown>>) {
			const last = await db
				.prepare(
					`SELECT body, sender, created_at, author_name
					 FROM support_messages
					 WHERE ticket_id = ?
					 ORDER BY created_at DESC
					 LIMIT 1`
				)
				.bind(t.id)
				.first();
			if (last) {
				t.last_message_preview = String(last.body || "").slice(0, 140);
				t.last_message_from = last.sender;
				t.last_message_at = last.created_at;
			} else {
				t.last_message_preview = String(t.message || "").slice(0, 140);
				t.last_message_from = "client";
				t.last_message_at = t.created_at;
			}
		}

		return json({ ok: true, tickets });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error("support tickets list error:", msg);
		return json({ ok: false, error: "Could not load requests" }, 500);
	}
};

export const POST: APIRoute = async ({ request }) => {
	const user = await requireUser(request);
	if (!user) return json({ ok: false, error: "Not authenticated" }, 401);

	const id = makeId("tkt");
	const msgId = makeId("msg");

	// Accept either JSON (no files) or multipart/form-data (with files).
	let subject = "";
	let message = "";
	let page_url = "";
	let files: File[] = [];

	const ctype = request.headers.get("content-type") || "";
	if (ctype.includes("multipart/form-data")) {
		let form: FormData;
		try {
			form = await request.formData();
		} catch {
			return json({ ok: false, error: "Invalid form data" }, 400);
		}
		subject = clean(form.get("subject"), 200);
		message = clean(form.get("message"), 8000);
		page_url = clean(form.get("page_url"), 500);
		const check = collectValidFiles(form);
		if (!check.ok) return json({ ok: false, error: check.error }, 422);
		files = check.files;
	} else {
		let body: Record<string, unknown>;
		try {
			body = await request.json();
		} catch {
			return json({ ok: false, error: "Invalid JSON" }, 400);
		}
		subject = clean(body.subject, 200);
		message = clean(body.message, 8000);
		page_url = clean(body.page_url, 500);
	}

	if (!subject) return json({ ok: false, error: "Subject is required" }, 422);
	if (!message) return json({ ok: false, error: "Please describe what you need" }, 422);

	const db = env.DB;
	if (!db) return json({ ok: false, error: "Database unavailable" }, 500);

	const now = new Date().toISOString();
	const status = "new";

	// Store files in R2 before the DB write so we only record what persisted.
	let stored: Awaited<ReturnType<typeof storeFiles>> = [];
	if (files.length) {
		try {
			stored = await storeFiles(env.SUPPORT_UPLOADS, id, files);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error("support upload store error:", msg);
			return json({ ok: false, error: "Could not save attachments" }, 500);
		}
	}

	try {
		const stmts = [
			db
				.prepare(
					`INSERT INTO support_tickets
						(id, user_id, user_email, user_name, subject, message, page_url, status, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
				)
				.bind(
					id,
					user.id,
					user.email,
					user.name || "",
					subject,
					message,
					page_url || "",
					status,
					now,
					now
				),
			db
				.prepare(
					`INSERT INTO support_messages
						(id, ticket_id, sender, author_name, body, created_at)
					 VALUES (?, ?, 'client', ?, ?, ?)`
				)
				.bind(msgId, id, user.name || user.email, message, now),
		];
		for (const a of stored) {
			stmts.push(
				db
					.prepare(
						`INSERT INTO support_attachments
							(id, ticket_id, message_id, r2_key, filename, content_type, size_bytes, uploaded_by, created_at)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
					)
					.bind(
						a.id,
						id,
						msgId,
						a.r2_key,
						a.filename,
						a.content_type,
						a.size_bytes,
						user.email,
						now
					)
			);
		}
		await db.batch(stmts);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error("support ticket insert error:", msg);
		return json({ ok: false, error: "Could not save request" }, 500);
	}

	const attachmentsMeta = stored.map((a) => ({
		id: a.id,
		filename: a.filename,
		content_type: a.content_type,
		size_bytes: a.size_bytes,
	}));

	try {
		await notifySupportTicket({
			id,
			site_id: SITE_ID,
			site: SITE_HOST,
			subject,
			message,
			page_url,
			user_email: user.email,
			user_name: user.name || "",
			status,
			created_at: now,
			message_id: msgId,
			attachments: attachmentsMeta,
		});
	} catch (err) {
		console.warn("support CC notify error:", err);
	}

	return json({
		ok: true,
		ticket: {
			id,
			subject,
			message,
			page_url,
			status,
			created_at: now,
			updated_at: now,
			attachments: attachmentsMeta,
		},
	});
};
