import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseCoastal,
  parseGeoJson,
  parseRoadIncidents,
} from '../../server/providers/australia.js';

test('Australian road incidents become bounded GeoJSON points with readable fields', () => {
  const result = parseRoadIncidents({
    results: [
      {
        id: 7,
        geo_point_2d: { lat: -28.1, lon: 153.3 },
        road_summary: '{"road_name":"Gold Coast Highway"}',
        incident_category: 'Crash',
        impact: '{"delay":"Delays expected"}',
        last_updated: '2026-10-17T01:02:03Z',
      },
    ],
  });
  assert.equal(result.features.length, 1);
  assert.deepEqual(result.features[0].geometry.coordinates, [153.3, -28.1]);
  assert.equal(result.features[0].properties.name, 'Gold Coast Highway');
  assert.equal(result.features[0].properties.impact, 'Delays expected');
});

test('coastal parser keeps the newest observation per site and removes sentinels', () => {
  const banner = 'Feed generated now\n';
  const header = 'Site,Seconds,DateTime,Latitude,Longitude,Hs,Direction\n';
  const wave = `${banner}${header}Gold Coast,1,old,-28,153.4,0.5,-99.9\nGold Coast,2,new,-28,153.4,0.8,90\n`;
  const tide = `${banner}${header}Southport,3,new,-27.97,153.41,-99.9,100\n`;
  const result = parseCoastal([wave, tide]);
  assert.equal(result.features.length, 2);
  assert.equal(result.features[0].properties.Hs, '0.8');
  assert.equal(Object.hasOwn(result.features[1].properties, 'Hs'), false);
});

test('GeoJSON sanitizer caps properties and rejects oversized geometry', () => {
  const clean = parseGeoJson({
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [153.4, -28] },
        properties: { label: 'safe', nested: { ignored: true } },
      },
    ],
  });
  assert.deepEqual(clean.features[0].properties, { label: 'safe' });
  assert.throws(
    () =>
      parseGeoJson({
        type: 'FeatureCollection',
        features: new Array(5001).fill({}),
      }),
    /feature cap/,
  );
});
