// core-backend/scripts/cleanup-empty-asset-meta.js
// Usage:
//   node scripts/cleanup-empty-asset-meta.js            # dry-run (no deletes)
//   node scripts/cleanup-empty-asset-meta.js --apply    # actually delete
//
// Auth:
//   - If API_TOKEN is set, it's used directly.
//   - Otherwise it will try to login with AUTH_EMAIL + AUTH_PASSWORD.
//
// Env (optional):
//   BACKEND=http://localhost:5000   default
//   API_BASE=/api                   default
//
// What is "empty"?
//   - No photoUrl (missing/blank), AND
//   - No valid location with numeric lat & lng
//
// Safety:
//   - Prints each candidate with reason.
//   - Dry-run by default.

const BACKEND  = process.env.BACKEND  || 'http://localhost:5000';
const API_BASE = process.env.API_BASE || '/api';

async function getFetch() {
  if (global.fetch) return global.fetch.bind(global);
  // Node < 18 fallback
  const { default: nodeFetch } = await import('node-fetch');
  return nodeFetch;
}

function absUrl(u) {
  if (!u) return '';
  if (/^https?:\/\//i.test(u)) return u;
  if (u.startsWith('/')) return BACKEND.replace(/\/+$/,'') + u;
  return `${BACKEND.replace(/\/+$/,'')}/${u.replace(/^\/+/, '')}`;
}

function hasValidLocation(meta) {
  const loc = meta && meta.location;
  if (!loc) return false;
  const { lat, lng } = loc;
  const nlat = Number(lat), nlng = Number(lng);
  return Number.isFinite(nlat) && Number.isFinite(nlng);
}

function isBlank(str) {
  return !str || !String(str).trim();
}

function isEmptyMeta(meta) {
  if (!meta || typeof meta !== 'object') return true;
  const photoBlank = isBlank(meta.photoUrl);
  const noLoc = !hasValidLocation(meta);
  return photoBlank && noLoc;
}

async function login(fetch) {
  if (process.env.API_TOKEN) {
    return process.env.API_TOKEN.trim();
  }
  const email = process.env.AUTH_EMAIL;
  const password = process.env.AUTH_PASSWORD;
  if (!email || !password) {
    console.error('No API_TOKEN and no AUTH_EMAIL/AUTH_PASSWORD provided. Set one of them.');
    process.exitCode = 1;
    return null;
  }
  const res = await fetch(absUrl(`${API_BASE}/auth/login`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  if (!res.ok) {
    console.error('Login failed:', res.status, await res.text().catch(()=>'(no body)'));
    process.exitCode = 1;
    return null;
  }
  const json = await res.json();
  const token = json.token || json.accessToken || json.jwt;
  if (!token) {
    console.error('Login ok but no token in response. Keys seen:', Object.keys(json));
    process.exitCode = 1;
    return null;
  }
  return token;
}

async function listDocuments(fetch, token) {
  // We’ll grab up to 1000 and filter client-side
  const url = new URL(absUrl(`${API_BASE}/documents`));
  url.searchParams.set('limit', '1000');
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) {
    throw new Error(`GET /documents ${res.status}: ${await res.text().catch(()=>'(no body)')}`);
  }
  const data = await res.json();
  return Array.isArray(data) ? data : (Array.isArray(data.items) ? data.items : []);
}

async function fetchMetaJson(fetch, doc) {
  const latest =
    (doc.latest && (doc.latest.url || doc.latest.downloadUrl)) ||
    (Array.isArray(doc.versions) && doc.versions.length
      ? (doc.versions[doc.versions.length - 1].url || doc.versions[doc.versions.length - 1].downloadUrl)
      : '');

  if (!latest) return null;
  try {
    const res = await fetch(absUrl(latest));
    if (!res.ok) return null;
    const json = await res.json().catch(() => null);
    return json;
  } catch {
    return null;
  }
}

async function delDocument(fetch, token, id) {
  const res = await fetch(absUrl(`${API_BASE}/documents/${id}`), {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) {
    throw new Error(`DELETE /documents/${id} ${res.status}: ${await res.text().catch(()=>'(no body)')}`);
  }
}

(async () => {
  const fetch = await getFetch();
  const APPLY = process.argv.includes('--apply');

  console.log(`Backend: ${BACKEND}${API_BASE}`);
  console.log(`Mode: ${APPLY ? 'APPLY (will delete)' : 'DRY-RUN (no deletes)'}\n`);

  const token = await login(fetch);
  if (!token) return;

  console.log('Listing documents…');
  const docs = await listDocuments(fetch, token);

  // Only look at asset-meta docs
  const candidates = docs.filter(d => {
    const title = String(d.title || '').toLowerCase();
    const tags = Array.isArray(d.tags) ? d.tags.map(t => String(t).toLowerCase()) : [];
    return title === 'asset-meta.json' || tags.includes('asset-meta');
  });

  console.log(`Found ${docs.length} docs total, ${candidates.length} candidate asset-meta docs.\n`);

  let checked = 0, emptyCount = 0, deleted = 0;

  for (const doc of candidates) {
    checked++;
    const meta = await fetchMetaJson(fetch, doc);
    const empty = isEmptyMeta(meta);
    const reason = empty
      ? (!meta ? 'no JSON / fetch failed' : 'no photoUrl & no location')
      : 'has data';

    const tagStr = Array.isArray(doc.tags) ? doc.tags.join(',') : '';
    const linkStr = Array.isArray(doc.links)
      ? doc.links.map(l => `${l.type||l.module}:${l.refId}`).join(', ')
      : '';

    if (empty) {
      emptyCount++;
      console.log(`🗑️  [EMPTY] ${doc._id} "${doc.title}"  tags=[${tagStr}]  links=[${linkStr}]  -> ${reason}`);
      if (APPLY) {
        try {
          await delDocument(fetch, token, doc._id);
          deleted++;
        } catch (e) {
          console.error(`   ✖ delete failed: ${e.message}`);
        }
      }
    } else {
      console.log(`✅ [KEEP ] ${doc._id} "${doc.title}"  -> ${reason}`);
    }
  }

  console.log(`\nDone. Checked ${checked} candidate docs.`);
  console.log(`Empty: ${emptyCount}`);
  if (APPLY) console.log(`Deleted: ${deleted}`);
  else console.log('No deletes performed (dry-run). Add --apply to delete.');
})().catch(err => {
  console.error('Fatal error:', err);
  process.exitCode = 1;
});
