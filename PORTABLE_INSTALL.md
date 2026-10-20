# Portable Gold Coast install

This checkout includes the Gold Coast default camera, the Australia mode,
Queensland traffic cameras, and the currently implemented Australian public
data layers. It is a Node-backed web application, not a static `dist` folder:
the local server is required to proxy and normalize live upstream feeds.

## Install the bundle on a Mac

1. Install Git and [nvm](https://github.com/nvm-sh/nvm), if needed.
2. Extract the release archive and open Terminal in the extracted folder.
3. Install the pinned runtime and dependencies:

   ```bash
   nvm install
   nvm use
   npm ci
   npm run doctor
   npm run build
   ```

4. Start the application:

   ```bash
   ./scripts/dev-fresh.sh
   ```

5. Open <http://localhost:4173/>.

`npm ci` reads `package-lock.json` and installs the exact dependency versions
recorded by this release. Do not replace it with `npm update` when the goal is
an identical install.

## Credentials

Credential files are deliberately excluded from the portable archive. Copy
`.env.example` to `.env` on the destination laptop and add only the providers
you intend to use, or add the same values to macOS Keychain as documented in
`README.md`. Never email or commit `.env`.

The six Australian proxy layers and the Queensland camera catalogue currently
work without new API subscriptions. Other existing features remain optional:
OpenAI enables voice, Google/Cesium enable their imagery, AISStream enables
ships, FIRMS enables its fire feed, TomTom enables traffic, and Mapillary
enables street-level imagery.

## Verify the Australian installation

With the app running, these checks should return HTTP 200 and non-zero feature
counts:

```bash
curl -fsS http://localhost:4173/api/australia/road-incidents | jq '.features | length'
curl -fsS http://localhost:4173/api/australia/coastal       | jq '.features | length'
curl -fsS http://localhost:4173/api/australia/emergency     | jq '.features | length'
curl -fsS http://localhost:4173/api/australia/paths         | jq '.features | length'
curl -fsS http://localhost:4173/api/australia/planning      | jq '.features | length'
curl -fsS http://localhost:4173/api/australia/community     | jq '.features | length'
curl -fsS http://localhost:4173/api/cctv/sources            | jq '[.sources[] | select(.id | startswith("qld-"))] | length'
```

Live counts can change as publishers update their feeds. Matching source code,
the archive SHA-256 checksum, Node 24.14.0, and `package-lock.json` is the
reproducibility guarantee; identical live records at two different times are
not expected.

## What the research report does not mean

The referenced research report catalogues 358 possible sources and identifies
59 first-priority candidates. The app does **not** ingest all 358. This release
implements the current zero-key starter set: incidents, coastal observations,
fire warnings, paths, capital works, community places, and Queensland traffic
cameras. Remaining sources need separate ingestion work and, in several cases,
licence or credential approval before publication.
