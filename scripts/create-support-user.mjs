#!/usr/bin/env node
/**
 * Create a support portal user in Matthew Peiper D1.
 *
 * Usage:
 *   node scripts/create-support-user.mjs --email layne@example.com --password '...' --name 'Layne'
 *   node scripts/create-support-user.mjs --email ... --password ... --remote
 *
 * Default targets local D1 via wrangler. Pass --remote for production D1.
 */
import { execFileSync } from "node:child_process";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { createHash } from "node:crypto";

// Match Worker hash format: pbkdf2$iterations$salt_b64$hash_b64
// Node doesn't share WebCrypto easily here — implement PBKDF2 same as Worker.
import { pbkdf2Sync } from "node:crypto";

function parseArgs(argv) {
	const out = { remote: false, email: "", password: "", name: "" };
	for (let i = 2; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--remote") out.remote = true;
		else if (a === "--email") out.email = argv[++i] || "";
		else if (a === "--password") out.password = argv[++i] || "";
		else if (a === "--name") out.name = argv[++i] || "";
	}
	return out;
}

function b64(buf) {
	return Buffer.from(buf).toString("base64");
}

function hashPassword(password) {
	const iterations = 100000;
	const salt = randomBytes(16);
	const hash = pbkdf2Sync(password, salt, iterations, 32, "sha256");
	return `pbkdf2$${iterations}$${b64(salt)}$${b64(hash)}`;
}

function makeId() {
	const t = Date.now();
	const chars = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
	let id = "";
	let time = t;
	for (let i = 9; i >= 0; i--) {
		id = chars[time % 32] + id;
		time = Math.floor(time / 32);
	}
	for (let i = 0; i < 16; i++) id += chars[Math.floor(Math.random() * 32)];
	return id;
}

function sqlString(s) {
	return "'" + String(s).replace(/'/g, "''") + "'";
}

const args = parseArgs(process.argv);
if (!args.email || !args.password) {
	console.error("Usage: node scripts/create-support-user.mjs --email x --password y [--name N] [--remote]");
	process.exit(1);
}
if (args.password.length < 8) {
	console.error("Password must be at least 8 characters.");
	process.exit(1);
}

const id = makeId();
const now = new Date().toISOString();
const hash = hashPassword(args.password);
const name = args.name || args.email.split("@")[0];

const sql = `INSERT INTO support_users (id, email, name, password_hash, created_at, updated_at)
VALUES (${sqlString(id)}, ${sqlString(args.email.trim().toLowerCase())}, ${sqlString(name)}, ${sqlString(hash)}, ${sqlString(now)}, ${sqlString(now)})
ON CONFLICT(email) DO UPDATE SET
  name=excluded.name,
  password_hash=excluded.password_hash,
  updated_at=excluded.updated_at;`;

const wranglerArgs = [
	"wrangler",
	"d1",
	"execute",
	"matthew-peiper-db",
	...(args.remote ? ["--remote"] : ["--local"]),
	"--command",
	sql,
];

console.log(`Creating/updating support user ${args.email} (${args.remote ? "REMOTE" : "local"})…`);
execFileSync("npx", wranglerArgs, { stdio: "inherit", cwd: new URL("..", import.meta.url).pathname });
console.log("Done. id=", id);
