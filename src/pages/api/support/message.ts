export const prerender = false;

import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { makeId, requireUser } from "../../../lib/support-auth";
import { notifySupportMessage } from "../../../lib/support-cc";
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

/** POST /api/support/message — client reply on a ticket they own */
export const POST: APIRoute = async ({ request }) => {
	const user = await requireUser(request);
	if (!user) return json({ ok: false, error: "Not authenticated" }, 401);

	let ticketId = "";
	let text = "";
	let files: File[] = [];

	const ctype = request.headers.get("content-type") || "";
	if (ctype.includes("multipart/form-data")) {
		let form: FormData;
		try {
			form = await request.formData();
		} catch {
			return json({ ok: false, error: "Invalid form data" }, 400);
		}
		ticketId = clean(form.get("ticket_id") || form.get("id"), 80);
		text = clean(form.get("body") || form.get("message"), 8000);
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
		ticketId = clean(body.ticket_id || body.id, 80);
		text = clean(body.body || body.message, 8000);
	}

	if (!ticketId) return json({ ok: false, error: "ticket_id required" }, 422);
	// A reply may be text, files, or both — but not empty.
	if (!text && files.length === 0) {
		return json({ ok: false, error: "Message is required" }, 422);
	}

	const db = env.DB;
	if (!db) return json({ ok: false, error: "Database unavailable" }, 500);

	const ticket = await db
		.prepare(
			`SELECT id, subject, user_id, status FROM support_tickets WHERE id = ? LIMIT 1`
		)
		.bind(ticketId)
		.first<{ id: string; subject: string; user_id: string; status: string }>();

	if (!ticket || ticket.user_id !== user.id) {
		return json({ ok: false, error: "Not found" }, 404);
	}

	const msgId = makeId("msg");
	const now = new Date().toISOString();
	const bodyText = text || "(sent attachment)";

	// Store files in R2 before the DB write.
	let stored: Awaited<ReturnType<typeof storeFiles>> = [];
	if (files.length) {
		try {
			stored = await storeFiles(env.SUPPORT_UPLOADS, ticketId, files);
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
					`INSERT INTO support_messages
						(id, ticket_id, sender, author_name, body, created_at)
					 VALUES (?, ?, 'client', ?, ?, ?)`
				)
				.bind(msgId, ticketId, user.name || user.email, bodyText, now),
			db
				.prepare(
					`UPDATE support_tickets
					 SET message = ?, updated_at = ?,
					     status = CASE WHEN status IN ('done','closed','waiting_on_client','staging')
					                   THEN 'in_progress' ELSE status END
					 WHERE id = ?`
				)
				.bind(bodyText, now, ticketId),
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
						ticketId,
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
		console.error("support message insert error:", msg);
		return json({ ok: false, error: "Could not send message" }, 500);
	}

	const attachmentsMeta = stored.map((a) => ({
		id: a.id,
		filename: a.filename,
		content_type: a.content_type,
		size_bytes: a.size_bytes,
	}));

	try {
		await notifySupportMessage({
			ticket_id: ticketId,
			message_id: msgId,
			site_id: SITE_ID,
			site: SITE_HOST,
			subject: ticket.subject,
			body: bodyText,
			user_email: user.email,
			user_name: user.name || "",
			created_at: now,
			attachments: attachmentsMeta,
		});
	} catch (err) {
		console.warn("support message CC notify error:", err);
	}

	return json({
		ok: true,
		message: {
			id: msgId,
			ticket_id: ticketId,
			sender: "client",
			author_name: user.name || user.email,
			body: bodyText,
			created_at: now,
			attachments: attachmentsMeta,
		},
	});
};
