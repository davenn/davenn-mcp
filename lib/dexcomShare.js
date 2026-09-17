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

async function fetchLatestReading(sessionId) {
  return postJson(
    `Publisher/ReadPublisherLatestGlucoseValues?sessionId=${sessionId}&minutes=10&maxCount=1`,
    {},
  );
}

export async function getLatestGlucose() {
  const sessionId = await getSessionId();

  let readings;
  try {
    readings = await fetchLatestReading(sessionId);
  } catch {
    // The cached session may have gone stale server-side; retry once fresh.
    const freshSessionId = await getSessionId({ forceRefresh: true });
    readings = await fetchLatestReading(freshSessionId);
  }

  if (!Array.isArray(readings) || readings.length === 0) {
    return null;
  }

  const [reading] = readings;
  const timestamp = parseDexcomDate(reading.DT || reading.WT);

  return {
    mgdl: reading.Value,
    trend: reading.Trend,
    trendDescription: TREND_LABELS[reading.Trend] ?? "unknown",
    timestamp,
    minutesAgo: timestamp ? Math.round((Date.now() - timestamp.getTime()) / 60000) : null,
  };
}
