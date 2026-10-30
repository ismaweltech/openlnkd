#!/usr/bin/env node
// OpenLnkd smoke test — checks every LinkedIn parser against the live site.
//
// LinkedIn changes its markup every few weeks. This hits the read-only endpoints
// of a running OpenLnkd and validates the *content* of each answer (not just the
// status code), so a silent break — reactions coming back null, a button label
// leaking into a name — shows up as a FAIL with the reason.
//
// It never sends anything: no messages, invites or campaigns. It only creates
// and deletes a throwaway template and webhook in your local DB.
//
//   npm run smoke                       # against http://127.0.0.1:3000
//   OPENLNKD_URL=http://127.0.0.1:3005 npm run smoke
//   SMOKE_LOCATION=Barcelona npm run smoke
//
// Exit code 1 if anything fails.

const BASE = process.env.OPENLNKD_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`;
const LOCATION = process.env.SMOKE_LOCATION ?? 'Madrid';
const results = [];

async function call(method, path, body, timeoutMs = 180_000) {
  const t0 = Date.now();
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json, ms: Date.now() - t0 };
}

/** Run one check. `verify` returns a short summary, or throws with the reason. */
async function check(name, fn) {
  const t0 = Date.now();
  try {
    const summary = await fn();
    results.push({ name, ok: true });
    console.log(`OK    ${name.padEnd(28)} ${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s  ${summary ?? ''}`);
  } catch (e) {
    results.push({ name, ok: false, why: e.message });
    console.log(`FAIL  ${name.padEnd(28)} ${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s  ${e.message}`);
  }
}

const must = (cond, why) => { if (!cond) throw new Error(why); };
const list = (r, what) => {
  must(r.status < 300, `${what}: HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 120)}`);
  must(Array.isArray(r.json), `${what}: expected a list`);
  return r.json;
};
// UI chrome that must never end up inside a parsed field
const CHROME = /^(conectar|connect|seguir|follow|mensaje|message|enviar mensaje|ver perfil)$|•\s*\d|\d(º|er)\+?$/i;
const cleanName = (n) => typeof n === 'string' && n.length > 1 && !CHROME.test(n) && !/[+•]\s*$/.test(n);

let me = null;
let otherSlug = null;
let jobId = null;
let companyId = null;

console.log(`OpenLnkd smoke test → ${BASE} (location: ${LOCATION})\n`);

await check('server reachable', async () => {
  const r = await call('GET', '/version', null, 10_000);
  must(r.status === 200, `HTTP ${r.status}`);
  return `v${r.json.current}${r.json.upToDate === false ? ` (v${r.json.latest} available — update first)` : ''}`;
}).catch(() => {});
if (!results[0].ok) {
  console.log(`\nOpenLnkd is not answering on ${BASE}. Start it first.`);
  process.exit(1);
}

await check('session', async () => {
  const r = await call('GET', '/session/status');
  must(r.json?.authenticated === true, 'not logged in — POST /session/login first');
  const m = await call('GET', '/session/me');
  must(m.json?.slug, '/session/me returned no slug');
  me = m.json.slug;
  return me;
});

await check('locations/typeahead', async () => {
  const xs = list(await call('GET', `/locations/typeahead?q=${encodeURIComponent(LOCATION)}`), 'typeahead');
  must(xs.length > 0, 'no suggestions');
  must(xs.every((x) => x.id && x.label), 'suggestion without id/label');
  must(xs.some((x) => x.label.toLowerCase().includes(LOCATION.toLowerCase())), `no label contains "${LOCATION}"`);
  return `${xs.length} suggestions`;
});

await check('jobs/search', async () => {
  const xs = list(await call('POST', '/jobs/search', { keywords: 'software engineer', location: LOCATION, limit: 3 }), 'jobs');
  must(xs.length > 0, 'no jobs found');
  for (const j of xs) must(j.id && j.title && j.company, `job missing id/title/company: ${JSON.stringify(j).slice(0, 100)}`);
  jobId = xs[0].id;
  return `${xs.length} jobs, e.g. "${xs[0].title}" @ ${xs[0].company}`;
});

await check('jobs/:id/description', async () => {
  must(jobId, 'skipped: no job from the previous check');
  const r = await call('GET', `/jobs/${jobId}/description`);
  must(r.status === 200, `HTTP ${r.status}`);
  must((r.json?.description ?? '').length > 100, 'description empty or too short');
  return `${r.json.description.length} chars`;
});

await check('companies/search', async () => {
  const xs = list(await call('POST', '/companies/search', { keywords: 'software', location: LOCATION, limit: 3 }), 'companies');
  must(xs.length > 0, 'no companies found');
  for (const c of xs) {
    must(c.id && cleanName(c.name), `bad company name: ${JSON.stringify(c.name)}`);
    must(c.industry && !/seguidores|followers/i.test(c.industry), `bad industry: ${JSON.stringify(c.industry)}`);
    must(!/seguidores|followers/i.test(c.size ?? '') && !/seguidores|followers/i.test(c.headline ?? ''), 'follower line leaked into size/headline');
    must(c.follower_count === null || /^[\d.,]+(\s*(mil|k))?$/i.test(c.follower_count), `bad follower_count: ${JSON.stringify(c.follower_count)}`);
  }
  companyId = xs[0].id;
  return `${xs.length} companies, e.g. ${xs[0].name} (${xs[0].industry}, ${xs[0].follower_count ?? '?'} followers)`;
});

await check('companies/:id/people', async () => {
  must(companyId, 'skipped: no company from the previous check');
  const xs = list(await call('POST', `/companies/${encodeURIComponent(companyId)}/people`, { limit: 3 }), 'people at company');
  // A company can legitimately have nobody visible to you; only validate what comes back.
  for (const p of xs) must(cleanName(p.name), `bad person name: ${JSON.stringify(p.name)}`);
  return xs.length ? `${xs.length} people, e.g. ${xs[0].name}` : '0 people (can be legitimate for small companies)';
});

await check('people/search', async () => {
  const xs = list(await call('POST', '/people/search', { keywords: 'CTO', location: LOCATION, limit: 5 }), 'people');
  must(xs.length > 0, 'no people found');
  for (const p of xs) must(p.id && cleanName(p.name) && p.headline, `bad person: ${JSON.stringify(p).slice(0, 120)}`);
  otherSlug = xs.find((p) => p.id !== me)?.id ?? null;
  return `${xs.length} people, e.g. ${xs[0].name} — ${xs[0].headline.slice(0, 40)}`;
});

const checkPosts = (posts, who) => {
  must(posts.length > 0, `${who}: no posts parsed`);
  for (const p of posts) {
    must(['post', 'repost'].includes(p.type), `bad type ${p.type}`);
    must(p.days !== null && p.days !== undefined, `date not parsed (age=${JSON.stringify(p.age)})`);
    must(p.body && !/^(conectar|connect|seguir|follow)\b/i.test(p.body), `button text leaked into body: "${(p.body ?? '').slice(0, 30)}"`);
    must(!/\n[\d.,]+$/.test(p.body), 'engagement counts leaked into the end of the body');
    must(['text', 'image', 'images', 'video', 'document'].includes(p.media), `bad media ${p.media}`);
  }
  must(posts.some((p) => p.reactions !== null), `${who}: reactions are null on every post`);
};

await check('people/:slug/activity (you)', async () => {
  must(me, 'skipped: no session slug');
  const posts = list(await call('GET', `/people/${me}/activity?limit=4`), 'activity');
  checkPosts(posts, 'your profile');
  const own = posts.filter((p) => p.type === 'post');
  if (own.length) must(own.some((p) => p.impressions !== null), 'impressions missing on your own posts');
  return `${posts.length} posts, e.g. ${posts[0].reactions ?? 0} reactions, ${posts[0].days} d ago, ${posts[0].media}`;
});

await check('people/:slug/profile', async () => {
  must(otherSlug, 'skipped: no profile from people/search');
  const r = await call('GET', `/people/${encodeURIComponent(otherSlug)}/profile?posts=4`);
  must(r.status === 200, `HTTP ${r.status}`);
  must(r.json.name && typeof r.json.followers === 'number', `name/followers missing: ${JSON.stringify({ name: r.json.name, followers: r.json.followers })}`);
  if (r.json.posts.length) checkPosts(r.json.posts, otherSlug);
  return `${r.json.name}: ${r.json.followers} followers, ${r.json.posts.length} posts, median ${r.json.metrics.medianEngagement ?? '–'}`;
});

await check('people/:slug/comments', async () => {
  must(otherSlug, 'skipped: no profile from people/search');
  const xs = list(await call('GET', `/people/${encodeURIComponent(otherSlug)}/comments?limit=3`), 'comments');
  for (const c of xs) {
    must(c.comment && c.comment.length > 1, 'empty comment text');
    must(typeof c.onOwnPost === 'boolean', 'onOwnPost missing');
  }
  return xs.length ? `${xs.length} comments` : '0 comments (this person may not comment)';
});

await check('outreach/inbox', async () => {
  const xs = list(await call('GET', '/outreach/inbox'), 'inbox');
  must(xs.length > 0, 'no conversations parsed');
  must(xs.every((m) => m.senderName && typeof m.preview === 'string'), 'conversation without senderName/preview');
  return `${xs.length} conversations`;
});

await check('local CRUD (templates, webhooks)', async () => {
  const t = await call('POST', '/templates', { name: 'smoke-test', body: 'Hola {name}' });
  must(t.json?.id && t.json.variables?.includes('name'), 'template not created');
  must((await call('DELETE', `/templates/${t.json.id}`)).status === 200, 'template not deleted');
  const w = await call('POST', '/webhooks', { url: 'http://127.0.0.1:9/smoke' });
  must(w.json?.id, 'webhook not created');
  must((await call('DELETE', `/webhooks/${w.json.id}`)).status === 200, 'webhook not deleted');
  return 'created and deleted';
});

await check('research job', async () => {
  const r = await call('POST', '/research/voice', { posts: 3 });
  must(r.json?.id, 'job not created');
  const t0 = Date.now();
  let job;
  do {
    await new Promise((ok) => setTimeout(ok, 3000));
    job = (await call('GET', `/research/jobs/${r.json.id}`)).json;
  } while (['queued', 'running'].includes(job.status) && Date.now() - t0 < 120_000);
  must(job.status === 'done', `job ended as ${job.status}: ${job.error ?? ''}`);
  return `voice: median ${job.result.medianEngagement ?? '–'}, ${job.result.ownPosts} own posts`;
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} OK`);
if (failed.length) {
  console.log('\nBroken:');
  for (const f of failed) console.log(`  - ${f.name}: ${f.why}`);
  console.log('\nIf a parser broke, LinkedIn probably changed its markup. Update OpenLnkd (git pull) or open an issue with this output.');
}
process.exit(failed.length ? 1 : 0);
