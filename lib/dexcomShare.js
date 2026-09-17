// Client for the unofficial Dexcom Share/Follow API — the same API the
// Dexcom Follow app uses for real-time parent monitoring. Not officially
// documented or supported by Dexcom; the endpoint shapes below are the
// ones long relied on by the diabetes community (e.g. pydexcom, Nightscout).

const APPLICATION_ID = "d8665ade-9673-4e27-9ff6-92db4ce13d13";

const BASE_URLS = {
  us: "https://share2.dexcom.com/ShareWebServices/Services",
  ous: "https://shareous1.dexcom.com/ShareWebServices/Services",
};

const TREND_LABELS = {
  None: "unknown",
  DoubleUp: "rising quickly",
  SingleUp: "rising",
  FortyFiveUp: "rising slightly",
  Flat: "steady",
  FortyFiveDown: "falling slightly",
  SingleDown: "falling",
  DoubleDown: "falling quickly",
  NotComputable: "unknown",
  RateOutOfRange: "unknown",
};

// Session lifetime isn't documented; refresh well before it's likely to
// go stale rather than trusting a long-lived cached session.
const SESSION_TTL_MS = 20 * 60 * 1000;

let cachedSession = null; // { sessionId, expiresAt }

function baseUrl() {
  const region = (process.env.DEXCOM_REGION || "us").toLowerCase();
  return BASE_URLS[region] ?? BASE_URLS.us;
}

async function postJson(path, body) {
  const res = await fetch(`${baseUrl()}/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!res.ok || (data && typeof data === "object" && "Code" in data)) {
    const message = (data && data.Message) || `Dexcom request to ${path} failed (${res.status})`;
    throw new Error(message);
  }

  return data;
}

async function login() {
  const accountName = process.env.DEXCOM_USERNAME;
  const password = process.env.DEXCOM_PASSWORD;
  if (!accountName || !password) {
    throw new Error("DEXCOM_USERNAME and DEXCOM_PASSWORD must be set.");
  }

  const accountId = await postJson("General/AuthenticatePublisherAccount", {
    accountName,
    password,
    applicationId: APPLICATION_ID,
  });

  const sessionId = await postJson("General/LoginPublisherAccountById", {
    accountId,
    password,
    applicationId: APPLICATION_ID,
  });

  cachedSession = { sessionId, expiresAt: Date.now() + SESSION_TTL_MS };
  return sessionId;
}

async function getSessionId({ forceRefresh = false } = {}) {
  if (!forceRefresh && cachedSession && cachedSession.expiresAt > Date.now()) {
    return cachedSession.sessionId;
  }
  return login();
}

function parseDexcomDate(value) {
  const match = /Date\((\d+)/.exec(value || "");
  return match ? new Date(Number(match[1])) : null;
}

async function fetchReadings(sessionId, minutes, maxCount) {
  return postJson(
    `Publisher/ReadPublisherLatestGlucoseValues?sessionId=${sessionId}&minutes=${minutes}&maxCount=${maxCount}`,
    {},
  );
}

// The Share API's rolling window: it only ever returns recent readings, not
// a full history export.
const MAX_MINUTES = 1440; // 24 hours
const MAX_COUNT = 288; // one reading every 5 minutes

async function getReadings(minutes, maxCount) {
  const sessionId = await getSessionId();

  try {
    return await fetchReadings(sessionId, minutes, maxCount);
  } catch {
    // The cached session may have gone stale server-side; retry once fresh.
    const freshSessionId = await getSessionId({ forceRefresh: true });
    return fetchReadings(freshSessionId, minutes, maxCount);
  }
}

function toReading(raw) {
  const timestamp = parseDexcomDate(raw.DT || raw.WT);
  return {
    mgdl: raw.Value,
    trend: raw.Trend,
    trendDescription: TREND_LABELS[raw.Trend] ?? "unknown",
    timestamp,
    minutesAgo: timestamp ? Math.round((Date.now() - timestamp.getTime()) / 60000) : null,
  };
}

export async function getLatestGlucose() {
  const readings = await getReadings(10, 1);
  if (!Array.isArray(readings) || readings.length === 0) {
    return null;
  }
  return toReading(readings[0]);
}

export async function getGlucoseHistory({ hours = 24 } = {}) {
  const minutes = Math.min(Math.max(Math.round(hours * 60), 1), MAX_MINUTES);
  const maxCount = Math.min(Math.ceil(minutes / 5), MAX_COUNT);

  const readings = await getReadings(minutes, maxCount);
  if (!Array.isArray(readings)) {
    return [];
  }

  return readings
    .map(toReading)
    .sort((a, b) => (a.timestamp?.getTime() ?? 0) - (b.timestamp?.getTime() ?? 0));
}
