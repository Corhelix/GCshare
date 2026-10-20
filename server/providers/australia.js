import { readResponseTextCapped } from './common/http.js';

const MINUTE = 60_000;
const GOLD_COAST = Object.freeze({ lat: -28.0167, lon: 153.4 });
const SOURCES = Object.freeze({
  'road-incidents': {
    ttlMs: 5 * MINUTE,
    maxBytes: 2 * 1024 * 1024,
    url: 'https://queensland.opendatasoft.com/api/explore/v2.1/catalog/datasets/queensland-traffic-incidents/records?limit=100&where=road_summary%20like%20%22Gold%20Coast%22',
    parse: parseRoadIncidents,
  },
  coastal: {
    ttlMs: 10 * MINUTE,
    // The statewide seven-day tide CSV is about 5 MB before we reduce it to
    // the newest observation per Gold Coast-area site.
    maxBytes: 8 * 1024 * 1024,
    urls: [
      'https://apps.des.qld.gov.au/data-sets/waves/wave-7dayopdata.csv',
      'https://apps.des.qld.gov.au/data-sets/storm-tides/tide-7dayopdata.csv',
    ],
    parse: parseCoastal,
  },
  emergency: {
    ttlMs: 3 * MINUTE,
    maxBytes: 6 * 1024 * 1024,
    url: 'https://publiccontent-gis-psba-qld-gov-au.s3.amazonaws.com/content/Feeds/BushfireCurrentIncidents/bushfireAlert.json',
    parse: parseGeoJson,
  },
  paths: {
    ttlMs: 24 * 60 * MINUTE,
    maxBytes: 12 * 1024 * 1024,
    url: 'https://services-ap1.arcgis.com/lnVW0dLI3fvST2hd/arcgis/rest/services/Pathway_view/FeatureServer/0/query?where=1%3D1&outFields=*&returnGeometry=true&outSR=4326&f=geojson&resultRecordCount=2000',
    parse: parseGeoJson,
  },
  planning: {
    ttlMs: 6 * 60 * MINUTE,
    maxBytes: 10 * 1024 * 1024,
    url: 'https://services.arcgis.com/3vStCH7NDoBOZ5zn/arcgis/rest/services/Capital_Works/FeatureServer/0/query?where=1%3D1&outFields=*&returnGeometry=true&outSR=4326&f=geojson&resultRecordCount=1000',
    parse: parseGeoJson,
  },
  community: {
    ttlMs: 24 * 60 * MINUTE,
    maxBytes: 6 * 1024 * 1024,
    url: 'https://services-ap1.arcgis.com/lnVW0dLI3fvST2hd/arcgis/rest/services/Broadwater_Parklands_POI/FeatureServer/0/query?where=1%3D1&outFields=*&returnGeometry=true&outSR=4326&f=geojson&resultRecordCount=1000',
    parse: parseGeoJson,
  },
});

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function csvRows(text) {
  const rows = [];
  let row = [],
    field = '',
    quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else quoted = !quoted;
    } else if (char === ',' && !quoted) {
      row.push(field.trim());
      field = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      row.push(field.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      field = '';
    } else field += char;
  }
  row.push(field.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

function parseCsvDataset(text, kind) {
  const rows = csvRows(text);
  const headerIndex = rows.findIndex(
    (row) => row.includes('Latitude') && row.includes('Longitude'),
  );
  if (headerIndex < 0) throw new Error(`Invalid ${kind} CSV`);
  const headers = rows[headerIndex];
  const newestBySite = new Map();
  for (const values of rows.slice(headerIndex + 1)) {
    const record = Object.fromEntries(
      headers.map((key, i) => [key, values[i] ?? '']),
    );
    const lat = finite(record.Latitude);
    const lon = finite(record.Longitude);
    if (
      lat === null ||
      lon === null ||
      lat > -25 ||
      lat < -31 ||
      lon < 150 ||
      lon > 155
    )
      continue;
    const properties = { kind };
    for (const [key, value] of Object.entries(record)) {
      if (!key || value === '' || value === '-99.9' || value === '-99')
        continue;
      properties[key] = value.length > 256 ? value.slice(0, 256) : value;
    }
    const site = String(record.Site || `${lat},${lon}`).slice(0, 100);
    const observedAt =
      finite(record.Seconds) ?? Date.parse(record.DateTime || '') / 1000;
    const previous = newestBySite.get(site);
    if (!previous || observedAt > previous.observedAt) {
      newestBySite.set(site, {
        observedAt,
        feature: {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [lon, lat] },
          properties,
        },
      });
    }
  }
  return [...newestBySite.values()].map(({ feature }) => feature);
}

function objectField(value, key) {
  if (value && typeof value === 'object') return value[key];
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value)?.[key] ?? null;
  } catch {
    return null;
  }
}

export function parseCoastal(payloads) {
  if (!Array.isArray(payloads) || payloads.length !== 2)
    throw new Error('Invalid coastal payload');
  return {
    type: 'FeatureCollection',
    features: [
      ...parseCsvDataset(payloads[0], 'wave'),
      ...parseCsvDataset(payloads[1], 'storm-tide'),
    ],
  };
}

export function parseRoadIncidents(payload) {
  const rows = Array.isArray(payload?.results) ? payload.results : [];
  return {
    type: 'FeatureCollection',
    features: rows.slice(0, 500).flatMap((row, index) => {
      const point = row?.geo_point_2d;
      const lat = finite(point?.lat ?? point?.latitude);
      const lon = finite(point?.lon ?? point?.longitude);
      if (lat === null || lon === null) return [];
      return [
        {
          type: 'Feature',
          id: String(row.id ?? row.incident_id ?? index),
          geometry: { type: 'Point', coordinates: [lon, lat] },
          properties: {
            name: String(
              objectField(row.road_summary, 'road_name') ??
                row.roads_main_street ??
                row.location ??
                'Traffic incident',
            ).slice(0, 180),
            category: String(
              row.incident_category ?? row.type ?? 'incident',
            ).slice(0, 80),
            impact: String(
              objectField(row.impact, 'delay') ?? row.impact_impact_type ?? '',
            ).slice(0, 160),
            updated: String(row.last_updated ?? row.lastupdate ?? '').slice(
              0,
              64,
            ),
          },
        },
      ];
    }),
  };
}

function coordinateCount(value, budget) {
  if (!Array.isArray(value)) throw new Error('Invalid GeoJSON coordinates');
  if (value.length >= 2 && value.every((item) => typeof item === 'number')) {
    budget.count += 1;
    if (budget.count > 100_000 || !value.every(Number.isFinite))
      throw new Error('GeoJSON geometry too large');
    return;
  }
  for (const child of value) coordinateCount(child, budget);
}

export function parseGeoJson(payload) {
  if (payload?.type !== 'FeatureCollection' || !Array.isArray(payload.features))
    throw new Error('Invalid GeoJSON feed');
  if (payload.features.length > 5_000)
    throw new Error('GeoJSON feature cap exceeded');
  const budget = { count: 0 };
  const features = payload.features.flatMap((feature, index) => {
    if (feature?.type !== 'Feature' || !feature.geometry?.type) return [];
    coordinateCount(feature.geometry.coordinates, budget);
    const properties = {};
    for (const [key, value] of Object.entries(feature.properties || {}).slice(
      0,
      80,
    )) {
      if (
        ['string', 'number', 'boolean'].includes(typeof value) ||
        value === null
      )
        properties[String(key).slice(0, 80)] =
          typeof value === 'string' ? value.slice(0, 1000) : value;
    }
    return [
      {
        type: 'Feature',
        id: feature.id ?? index,
        geometry: feature.geometry,
        properties,
      },
    ];
  });
  return { type: 'FeatureCollection', features };
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

/** Same-origin, bounded, cached gateway for the Australian public-data pack. */
export function australiaProxy({
  fetchImpl = (...args) => fetch(...args),
  now = () => Date.now(),
} = {}) {
  const cache = new Map();
  const inflight = new Map();
  async function load(id, spec) {
    const cached = cache.get(id);
    if (cached && now() - cached.fetchedAt < spec.ttlMs) return cached;
    if (inflight.has(id)) return inflight.get(id);
    const request = (async () => {
      const urls = spec.urls || [spec.url];
      const texts = await Promise.all(
        urls.map(async (url) => {
          const response = await fetchImpl(url, {
            headers: {
              Accept: url.endsWith('.csv') ? 'text/csv' : 'application/json',
            },
            signal: AbortSignal.timeout(15_000),
          });
          if (!response.ok)
            throw new Error(`Australian source HTTP ${response.status}`);
          return readResponseTextCapped(response, spec.maxBytes);
        }),
      );
      const raw = texts.map((text, i) =>
        urls[i].endsWith('.csv') ? text : JSON.parse(text),
      );
      const data = spec.parse(spec.urls ? raw : raw[0]);
      const entry = { fetchedAt: now(), data };
      cache.set(id, entry);
      return entry;
    })().finally(() => inflight.delete(id));
    inflight.set(id, request);
    return request;
  }
  const middleware = async (req, res) => {
    if (req.method !== 'GET')
      return json(res, 405, { error: 'method_not_allowed' });
    const id = String(req.url || '')
      .split('?')[0]
      .replace(/^\/+/, '');
    const spec = SOURCES[id];
    if (!spec) return json(res, 404, { error: 'unknown_australia_source' });
    try {
      const result = await load(id, spec);
      json(res, 200, {
        source: id,
        fetchedAt: result.fetchedAt,
        refreshAfterMs: spec.ttlMs,
        center: GOLD_COAST,
        ...result.data,
      });
    } catch (error) {
      const stale = cache.get(id);
      if (stale)
        return json(res, 200, {
          source: id,
          fetchedAt: stale.fetchedAt,
          refreshAfterMs: spec.ttlMs,
          stale: true,
          warning: String(error?.message || error),
          center: GOLD_COAST,
          ...stale.data,
        });
      console.warn(
        `[Australia] ${id} refresh failed:`,
        error?.message || error,
      );
      json(res, 502, { error: 'australia_source_unavailable', source: id });
    }
  };
  return {
    name: 'australia-public-data-proxy',
    configureServer(server) {
      server.middlewares.use('/api/australia', middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use('/api/australia', middleware);
    },
  };
}
