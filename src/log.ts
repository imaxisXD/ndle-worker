import type { Context } from "hono";

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40,
};

function normalizeLevel(value: string | undefined): LogLevel {
	const v = (value ?? "info").toLowerCase();
	if (v === "debug" || v === "info" || v === "warn" || v === "error") return v;
	return "info";
}

function formatHumanContext(fields: Record<string, unknown> | undefined): string {
	if (!fields) return "";
	const f = fields as Record<string, any>;
	const parts: string[] = [];
	const method = f.method as string | undefined;
	const path = f.path as string | undefined;
	if (method || path) parts.push([method, path].filter(Boolean).join(" "));
	if (f.slug) parts.push(`slug ${String(f.slug)}`);
	if (f.status !== undefined) parts.push(`status ${String(f.status)}`);
	if (f.destination) parts.push(`→ ${String(f.destination)}`);
	if (f.latency_ms !== undefined) parts.push(`${String(f.latency_ms)}ms`);
	if (f.source) parts.push(`via ${String(f.source)}`);
	if (f.component) parts.push(String(f.component));
	if (f.colo) parts.push(`dc ${String(f.colo)}`);
	return parts.length ? ` — ${parts.join(" | ")}` : "";
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
	const baseFields: Record<string, unknown> = {
		method: req.method,
		path: new URL(req.url).pathname,
		colo: cf.colo ?? null,
		...extra,
	};

	function logAt(lvl: LogLevel, message: string, fields?: Record<string, unknown>) {
		if (LEVEL_ORDER[lvl] < threshold) return;
		const ts = new Date().toISOString();
		const levelLabel = lvl.toUpperCase();
		const context = formatHumanContext({ ...baseFields, ...fields });
		const line = `[${levelLabel}] ${message}${context} @ ${ts}`;
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


