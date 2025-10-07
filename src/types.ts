export type AnalyticsEvent = {
	idempotency_key: string;
	occurred_at: string; // ISO 8601 string
	link_slug: string;
	short_url: string;
	link_id: string | null;
	user_id: string | null;
	destination_url: string;
	redirect_status: number;
	tracking_enabled: boolean;
	latency_ms_worker: number;
	session_id: string | null;
	first_click_of_session: boolean;
	request_id: string;
	worker_datacenter: string;
	worker_version: string;
	user_agent: string;
	device_type: string | null;
	browser: string | null;
	os: string | null;
	ip_hash: string;
	country: string;
	region: string | null;
	city: string | null;
	referer: string | null;
	utm_source: string | null;
	utm_medium: string | null;
	utm_campaign: string | null;
	utm_term: string | null;
	utm_content: string | null;
	is_bot: boolean;
	language: string | null;
	timezone: string | null;
};

export type AnalyticsEventInput = Omit<AnalyticsEvent, "occurred_at" |
	"link_id" | "user_id" | "session_id" | "device_type" | "browser" |
	"os" | "region" | "city" | "referer" | "utm_source" | "utm_medium" |
	"utm_campaign" | "utm_term" | "utm_content" | "language" | "timezone"> & {
	occurred_at: string | Date;
	link_id?: string | null;
	user_id?: string | null;
	session_id?: string | null;
	device_type?: string | null;
	browser?: string | null;
	os?: string | null;
	region?: string | null;
	city?: string | null;
	referer?: string | null;
	utm_source?: string | null;
	utm_medium?: string | null;
	utm_campaign?: string | null;
	utm_term?: string | null;
	utm_content?: string | null;
	language?: string | null;
	timezone?: string | null;
};

export type Bindings = {
	UPSTASH_REDIS_REST_TOKEN: string;
	UPSTASH_REDIS_REST_URL: string;
	ANALYTICS_ENDPOINT?: string;
	ANALYTICS_TOKEN?: string;
	WORKER_VERSION?: string;
	TRACKING_ENABLED?: string;
};


export type RedisValueObject = {
  destination: string;
  user_id: string;
  tenant_id: string;
  redirect_type: number;
  created_at: number;
  updated_at: number;
  link_id: string;
  is_active: boolean;
  expires_at: number | null;
  max_clicks: number | null;
  tags: string[];
  utm_params: Record<string, string>;
  rules: Record<string, unknown>;
  features: {
    track_clicks: boolean;
    track_conversions: boolean;
  };
  custom_metadata: Record<string, unknown>;
  version: number;
};
