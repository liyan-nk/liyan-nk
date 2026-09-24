const fs = await import('node:fs/promises');

const username = process.env.GITHUB_USERNAME || 'liyan-nk';
const fixturePath = process.env.ACTIVITY_FIXTURE;
const endpoint = `https://api.github.com/users/${encodeURIComponent(username)}/events/public?per_page=100`;
const maxEntries = 5;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const asString = (value) => typeof value === 'string' ? value.trim() : '';
const asNonNegativeInteger = (value) => Number.isInteger(value) && value >= 0 ? value : null;

function repositoryFor(event) {
  const name = asString(event?.repo?.name);
  return /^[^/\\s]+\\/[^/\\s]+$/.test(name)
    ? { name, url: `https://github.com/${name}` }
    : null;
}

function markdownText(value) {
  return asString(value).replace(/[\\[\\]`*_]/g, '\\$&');
}

function relativeTime(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

function describe(event, repository) {
  const payload = isObject(event?.payload) ? event.payload : {};
  const repo = `[${repository.name}](${repository.url})`;

  switch (asString(event?.type)) {
    case 'PushEvent': {
      const count = asNonNegativeInteger(payload.distinct_size)
        ?? asNonNegativeInteger(payload.size)
        ?? (Array.isArray(payload.commits) ? payload.commits.length : null);
      return count > 0
        ? `Pushed ${count} commit${count === 1 ? '' : 's'} to ${repo}`
        : `Pushed updates to ${repo}`;
    }
    case 'PullRequestEvent': {
      const action = asString(payload.action);
      if (!['opened', 'closed', 'reopened', 'merged'].includes(action)) return null;
      const noun = action === 'merged' ? 'Merged a pull request' : `${action[0].toUpperCase()}${action.slice(1)} a pull request`;
      return `${noun} in ${repo}`;
    }
    case 'IssuesEvent': {
      const action = asString(payload.action);
      if (!['opened', 'closed', 'reopened'].includes(action)) return null;
      return `${action[0].toUpperCase()}${action.slice(1)} an issue in ${repo}`;
    }
    case 'ReleaseEvent':
      return payload.action === 'published' ? `Published a release in ${repo}` : null;
    case 'CreateEvent':
      return payload.ref_type === 'repository' ? `Created repository ${repo}` : null;
    case 'ForkEvent':
      return `Forked ${repo}`;
    case 'WatchEvent':
      return payload.action === 'started' ? `Starred ${repo}` : null;
    default:
      return null;
  }
}

async function loadEvents() {
  if (fixturePath) {
    const fixture = JSON.parse(await fs.readFile(fixturePath, 'utf8'));
    return Array.isArray(fixture) ? fixture : [];
  }

  try {
    const response = await fetch(endpoint, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `${username}-profile-activity`,
        ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return [];
    const events = await response.json();
    return Array.isArray(events) ? events : [];
  } catch (error) {
    console.warn(`Unable to read public GitHub events: ${error.message}`);
    return [];
  }
}

function renderActivity(events) {
  const seen = new Set();
  const lines = [];

  for (const event of events) {
    if (!isObject(event)) continue;
    const eventId = asString(event.id);
    const fallbackKey = `${asString(event.type)}|${asString(event.created_at)}|${asString(event.repo?.name)}`;
    const key = eventId || fallbackKey;
    if (!key || seen.has(key)) continue;
    seen.add(key);

    const repository = repositoryFor(event);
    if (!repository) continue;
    const description = describe(event, repository);
    if (!description) continue;
    const age = relativeTime(event.created_at);
    lines.push(`→ ${description}${age ? ` · ${age}` : ''}<br>`);
    if (lines.length === maxEntries) break;
  }

  return lines.length ? lines.join('\n') : '→ No recent public activity found.<br>';
}

const readmePath = process.env.README_PATH || 'README.md';
const readme = await fs.readFile(readmePath, 'utf8');
const marker = /<!--RECENT_ACTIVITY:start-->[\\s\\S]*?<!--RECENT_ACTIVITY:end-->/;
if (!marker.test(readme)) throw new Error('Activity markers were not found in README.md');

const replacement = `<!--RECENT_ACTIVITY:start-->\n${renderActivity(await loadEvents())}\n<!--RECENT_ACTIVITY:end-->`;
const updated = readme.replace(marker, replacement);
if (updated !== readme) await fs.writeFile(readmePath, updated);
