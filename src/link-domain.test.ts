import { expect, test } from "bun:test";
import { checkLinkDomain } from "./link-domain";

const production = "ndle.fyi,www.ndle.fyi";

test("default short-link hosts serve every link", () => {
	for (const host of ["ndle.fyi", "www.ndle.fyi"]) {
		for (const domain of ["brand.example", null, undefined]) {
			expect(
				checkLinkDomain({ host, domain, shortLinkHosts: production }),
			).toBe("allowed");
		}
	}
});

test("a custom host serves only links bound to that exact domain", () => {
	const check = (domain: string | null | undefined) =>
		checkLinkDomain({
			host: "go.brand.example",
			domain,
			shortLinkHosts: production,
		});
	expect(check("go.brand.example")).toBe("allowed");
	expect(check("other.example")).toBe("denied");
	expect(check("brand.example")).toBe("denied");
	expect(check("")).toBe("denied");
	expect(check(null)).toBe("denied");
	expect(check(undefined)).toBe("legacy");
});

test("malformed stored domains fail closed", () => {
	expect(
		checkLinkDomain({
			host: "go.brand.example",
			domain: 42 as unknown as string,
			shortLinkHosts: production,
		}),
	).toBe("denied");
});

test("hosts and domains compare without case or a trailing dot", () => {
	expect(
		checkLinkDomain({
			host: "NDLE.FYI.",
			domain: null,
			shortLinkHosts: production,
		}),
	).toBe("allowed");
	expect(
		checkLinkDomain({
			host: "Go.Brand.Example.",
			domain: "go.brand.example",
			shortLinkHosts: production,
		}),
	).toBe("allowed");
	expect(
		checkLinkDomain({
			host: "go.brand.example",
			domain: "GO.Brand.Example.",
			shortLinkHosts: production,
		}),
	).toBe("allowed");
	expect(
		checkLinkDomain({
			host: "ndle.fyi",
			domain: null,
			shortLinkHosts: " NDLE.fyi. , www.ndle.fyi ",
		}),
	).toBe("allowed");
});

test("missing or empty SHORT_LINK_HOSTS falls back to the production hosts", () => {
	for (const shortLinkHosts of [undefined, "", " , "]) {
		for (const host of ["ndle.fyi", "www.ndle.fyi"]) {
			expect(checkLinkDomain({ host, domain: null, shortLinkHosts })).toBe(
				"allowed",
			);
		}
		expect(
			checkLinkDomain({ host: "dev.ndle.fyi", domain: null, shortLinkHosts }),
		).toBe("denied");
	}
});

test("a configured SHORT_LINK_HOSTS replaces the default hosts", () => {
	const shortLinkHosts = "dev.ndle.fyi,www.dev.ndle.fyi";
	expect(
		checkLinkDomain({ host: "dev.ndle.fyi", domain: null, shortLinkHosts }),
	).toBe("allowed");
	expect(
		checkLinkDomain({ host: "www.dev.ndle.fyi", domain: null, shortLinkHosts }),
	).toBe("allowed");
	expect(
		checkLinkDomain({ host: "ndle.fyi", domain: null, shortLinkHosts }),
	).toBe("denied");
});
