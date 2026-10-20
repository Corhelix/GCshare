import * as Cesium from 'cesium';
import { flyToGoldCoast } from '../../camera.js';

export const AUSTRALIA_LAYER_DEFINITIONS = Object.freeze([
  {
    id: 'au-road-incidents',
    name: 'Road incidents',
    icon: '!',
    source: 'Queensland Traffic · LIVE',
    endpoint: 'road-incidents',
    updateInterval: 5 * 60_000,
    color: '#ffad33',
  },
  {
    id: 'au-coastal',
    name: 'Coastal conditions',
    icon: '≈',
    source: 'Queensland Open Data · LIVE',
    endpoint: 'coastal',
    updateInterval: 10 * 60_000,
    color: '#35c8ff',
  },
  {
    id: 'au-emergency',
    name: 'Emergency warnings',
    icon: '▲',
    source: 'Queensland Fire Department · LIVE',
    endpoint: 'emergency',
    updateInterval: 3 * 60_000,
    color: '#ff4d3d',
  },
  {
    id: 'au-paths',
    name: 'Paths & marine places',
    icon: '⌁',
    source: 'City of Gold Coast Open Data',
    endpoint: 'paths',
    updateInterval: 24 * 60 * 60_000,
    color: '#55e28a',
  },
  {
    id: 'au-planning',
    name: 'Planning & projects',
    icon: '▧',
    source: 'City of Gold Coast Open Data',
    endpoint: 'planning',
    updateInterval: 6 * 60 * 60_000,
    color: '#c38cff',
  },
  {
    id: 'au-community',
    name: 'Community places',
    icon: '◆',
    source: 'City of Gold Coast Open Data',
    endpoint: 'community',
    updateInterval: 24 * 60 * 60_000,
    color: '#ffe06b',
  },
]);

function color(value) {
  return Cesium.Color.fromCssColorString(value);
}

export function createAustraliaDataLayer(
  definition,
  { fetchImpl = (...args) => fetch(...args) } = {},
) {
  let viewer = null,
    dataSource = null,
    enabled = false,
    destroyed = false;
  let loading = false,
    error = null,
    count = 0,
    lastUpdate = null,
    stale = false,
    request = null;
  const layer = {
    ...definition,
    init(nextViewer) {
      viewer = nextViewer;
    },
    enable() {
      enabled = true;
    },
    disable() {
      enabled = false;
      request?.abort();
      request = null;
      loading = false;
      if (dataSource && viewer) viewer.dataSources.remove(dataSource, true);
      dataSource = null;
      count = 0;
      error = null;
      stale = false;
    },
    async update(_viewer, { signal } = {}) {
      if (!enabled || destroyed || !viewer) return false;
      request?.abort();
      const controller = new AbortController();
      request = controller;
      const abort = () => controller.abort(signal?.reason);
      signal?.addEventListener?.('abort', abort, { once: true });
      loading = true;
      error = null;
      try {
        const response = await fetchImpl(
          `/api/australia/${definition.endpoint}`,
          { signal: controller.signal },
        );
        if (!response.ok)
          throw new Error(
            `${definition.name} unavailable (HTTP ${response.status})`,
          );
        const payload = await response.json();
        if (
          payload?.type !== 'FeatureCollection' ||
          !Array.isArray(payload.features)
        )
          throw new Error(`Malformed ${definition.name} feed`);
        const next = await Cesium.GeoJsonDataSource.load(payload, {
          clampToGround: true,
          stroke: color(definition.color).withAlpha(0.95),
          fill: color(definition.color).withAlpha(0.2),
          strokeWidth: 3,
          markerColor: color(definition.color),
          markerSize: 12,
        });
        if (
          !enabled ||
          destroyed ||
          controller.signal.aborted ||
          request !== controller
        )
          return false;
        next.name = definition.name;
        await viewer.dataSources.add(next);
        if (
          !enabled ||
          destroyed ||
          controller.signal.aborted ||
          request !== controller
        ) {
          viewer.dataSources.remove(next, true);
          return false;
        }
        const previous = dataSource;
        dataSource = next;
        if (previous) viewer.dataSources.remove(previous, true);
        count = payload.features.length;
        lastUpdate = Number(payload.fetchedAt) || Date.now();
        stale = payload.stale === true;
        error = payload.warning || null;
        return true;
      } catch (nextError) {
        if (controller.signal.aborted) return false;
        error = nextError;
        throw nextError;
      } finally {
        signal?.removeEventListener?.('abort', abort);
        if (request === controller) request = null;
        loading = false;
      }
    },
    getStats() {
      return {
        count,
        lastUpdate,
        loading,
        error,
        stale,
        source: definition.source,
      };
    },
    destroy() {
      destroyed = true;
      layer.disable();
      viewer = null;
    },
  };
  return layer;
}

const MODE_TARGETS = new Set([
  'flights',
  'ais-live-vessels',
  'cctv',
  'transit',
  ...AUSTRALIA_LAYER_DEFINITIONS.map(({ id }) => id),
]);

export function createAustraliaModeLayer() {
  let viewer = null,
    manager = null,
    enabled = false,
    generation = 0,
    snapshot = null;
  const apply = async (turnOn, ownedGeneration) => {
    if (!manager || ownedGeneration !== generation) return;
    if (turnOn) {
      snapshot = new Map(
        manager
          .getAll()
          .filter(({ id }) => id !== 'australia-mode')
          .map(({ id, enabled: on }) => [id, on]),
      );
      flyToGoldCoast(viewer, 0);
      await Promise.all(
        manager
          .getAll()
          .filter(({ id }) => id !== 'australia-mode')
          .map(({ id }) =>
            manager
              .setEnabled(id, MODE_TARGETS.has(id), { origin: 'programmatic' })
              .catch(() => false),
          ),
      );
    } else if (snapshot) {
      const restore = snapshot;
      snapshot = null;
      await Promise.all(
        [...restore].map(([id, on]) =>
          manager
            .setEnabled(id, on, { origin: 'programmatic' })
            .catch(() => false),
        ),
      );
    }
  };
  return {
    id: 'australia-mode',
    name: 'Australia mode',
    icon: 'AU',
    source: 'Australian public data preset',
    updateInterval: 0,
    init(nextViewer) {
      viewer = nextViewer;
    },
    attachDataManager(nextManager) {
      manager = nextManager;
    },
    enable() {
      enabled = true;
      const owned = ++generation;
      queueMicrotask(() => apply(true, owned));
    },
    disable() {
      enabled = false;
      const owned = ++generation;
      queueMicrotask(() => apply(false, owned));
    },
    update() {
      return false;
    },
    getStats() {
      return {
        count: MODE_TARGETS.size,
        lastUpdate: null,
        modeActive: enabled,
      };
    },
    destroy() {
      generation += 1;
      enabled = false;
      snapshot = null;
      manager = null;
      viewer = null;
    },
  };
}

export function createAustraliaLayers() {
  return [
    createAustraliaModeLayer(),
    ...AUSTRALIA_LAYER_DEFINITIONS.map((definition) =>
      createAustraliaDataLayer(definition),
    ),
  ];
}
