/**
 * Configuration loading.
 *
 * Every number that describes a world, a star, a scatterer or a phrase of text
 * lives in a JSON file under /config. The loader reads the manifest and then
 * pulls in whatever it lists, so adding a new planet means dropping in a file
 * and naming it in config/index.json - no code changes.
 *
 * Over http the files are fetched individually, which keeps them editable and
 * live. Opened straight from disk, fetch is blocked by the browser, so the
 * loader falls back to config/bundle.js, a generated copy of the same data
 * that index.html loads with a plain script tag. The JSON files stay the one
 * source of truth; the bundle is rebuilt from them by tools/build-bundle.js.
 */

const BASE = 'config/';

async function fetchJson(path) {
  const response = await fetch(BASE + path, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}

/** The generated fallback, if index.html managed to load it. */
function bundled() {
  return typeof window !== 'undefined' ? window.__ATMO_CONFIG__ : undefined;
}

function fromBundle(path) {
  const b = bundled();
  if (!b || !b[path]) throw new Error(`${path} missing from the offline bundle`);
  return b[path];
}

/**
 * Load everything the application needs.
 * Returns maps keyed by id, ready for the UI to enumerate.
 */
export async function loadConfiguration() {
  let useBundle = false;
  let index;

  try {
    index = await fetchJson('index.json');
  } catch (err) {
    if (!bundled()) {
      throw new Error(
        'Configuration could not be loaded. Serve the folder over http, ' +
        'or run "npm run build" once so that config/bundle.js exists.');
    }
    useBundle = true;
    index = fromBundle('index.json');
  }

  const get = async (path) => (useBundle ? fromBundle(path) : fetchJson(path));

  const collect = async (dir, ids) => {
    const entries = await Promise.all(ids.map((id) => get(`${dir}/${id}.json`)));
    const map = new Map();
    ids.forEach((id, i) => map.set(id, entries[i]));
    return map;
  };

  const [atmospheres, stars, scattering, experiments, localization, color] = await Promise.all([
    collect('atmospheres', index.atmospheres),
    collect('stars', index.stars),
    collect('scattering', index.scattering),
    collect('experiments', index.experiments),
    collect('localization', index.localization),
    collect('color', index.color),
  ]);

  return {
    index,
    atmospheres,
    stars,
    scattering,
    experiments,
    localization,
    colorimetryData: color.get(index.color[0]),
    loadedFrom: useBundle ? 'bundle' : 'files',
  };
}
