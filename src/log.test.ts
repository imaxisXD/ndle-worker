import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { createLogger } from "./log";

afterEach(() => mock.restore());

test("LOG_LEVEL=silent suppresses all log levels", () => {
	const debug = spyOn(console, "debug").mockImplementation(() => {});
	const info = spyOn(console, "info").mockImplementation(() => {});
	const warn = spyOn(console, "warn").mockImplementation(() => {});
	const error = spyOn(console, "error").mockImplementation(() => {});

	const logger = createLogger("silent", { component: "test" });
	logger.debug("d");
	logger.info("i");
	logger.warn("w");
	logger.error("e");

	expect(debug).not.toHaveBeenCalled();
	expect(info).not.toHaveBeenCalled();
	expect(warn).not.toHaveBeenCalled();
	expect(error).not.toHaveBeenCalled();
});

test("LOG_LEVEL filters below threshold and emits at or above threshold", () => {
	const info = spyOn(console, "info").mockImplementation(() => {});
	const warn = spyOn(console, "warn").mockImplementation(() => {});
	const error = spyOn(console, "error").mockImplementation(() => {});

	const logger = createLogger("warn");
	logger.info("hidden");
	logger.warn("shown warn");
	logger.error("shown error");

	expect(info).not.toHaveBeenCalled();
	expect(warn).toHaveBeenCalledTimes(1);
	expect(error).toHaveBeenCalledTimes(1);
});
