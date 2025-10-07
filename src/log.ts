import type { Context } from "hono";

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40,
};

const PREFERRED_ORDER = [
	"rid",
	"slug",
	"method",
	"path",
	"status",
	"destination",
	"latency_ms",
	"source",
	"component",
	"colo",
];

function normalizeLevel(value: string | undefined): LogLevel {
	const v = (value ?? "info").toLowerCase();
	if (v === "debug" || v === "info" || v === "warn" || v === "error") return v;
	return "info";
}

function safeStringify(value: unknown): string {
	try {
		return typeof value === "string" ? value : JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function shortRequestId(value: string): string {
	let v = String(value);
	const dash = v.indexOf("-");
	if (dash > 0) v = v.slice(0, dash);
	return v.slice(0, 12);
}

function formatOrderedKVs(fields: Record<string, unknown> | undefined): string {
	if (!fields) return "";
	const entries = Object.entries(fields);
	const picked: string[] = [];
	const used = new Set<string>();
	for (const key of PREFERRED_ORDER) {
		if (key in fields) {
			picked.push(`${key}=${safeStringify(fields[key])}`);
			used.add(key);
		}
	}
	const rest = entries
		.filter(([k]) => !used.has(k))
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([k, v]) => `${k}=${safeStringify(v)}`);
	const parts = [...picked, ...rest];
	return parts.length ? ` ${parts.join(" ")}` : "";
}

export type RequestLogger = {
	debug: (message: string, fields?: Record<string, unknown>) => void;
	info: (message: string, fields?: Record<string, unknown>) => void;
	warn: (message: string, fields?: Record<string, unknown>) => void;
	error: (message: string, fields?: Record<string, unknown>) => void;
	child: (extra: Record<string, unknown>) => RequestLogger;
};

export function createRequestLogger(c: Context, extra?: Record<string, unknown>): RequestLogger {
	const req = c.req;
	const raw = req.raw as Request & { cf?: any };
	const cf = raw.cf ?? {};
	const level = normalizeLevel(c.env.LOG_LEVEL);
	const threshold = LEVEL_ORDER[level];
	const requestId = req.header("cf-ray") ?? req.header("x-request-id") ?? crypto.randomUUID();
	const baseFields: Record<string, unknown> = {
		rid: shortRequestId(requestId),
		method: req.method,
		path: new URL(req.url).pathname,
		colo: cf.colo ?? null,
		...extra,
	};

	function logAt(lvl: LogLevel, message: string, fields?: Record<string, unknown>) {
		if (LEVEL_ORDER[lvl] < threshold) return;
		const ts = new Date().toISOString();
		const levelLabel = lvl.toUpperCase();
		const line = `${ts} [${levelLabel}] ${message}${formatOrderedKVs({ ...baseFields, ...fields })}`;
		switch (lvl) {
			case "debug":
				console.debug(line);
				break;
			case "info":
				console.log(line);
				break;
			case "warn":
				console.warn(line);
				break;
			case "error":
				console.error(line);
				break;
		}
	}

	return {
		debug: (m, f) => logAt("debug", m, f),
		info: (m, f) => logAt("info", m, f),
		warn: (m, f) => logAt("warn", m, f),
		error: (m, f) => logAt("error", m, f),
		child: (childExtra) => createRequestLogger(c, { ...baseFields, ...childExtra }),
	};
}


