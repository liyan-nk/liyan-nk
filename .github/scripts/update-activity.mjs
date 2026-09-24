import fs from 'node:fs/promises';

const username = process.env.GITHUB_USERNAME || 'liyan-nk';
const fixturePath = process.env.ACTIVITY_FIXTURE;
const endpoint = `https://api.github.com/users/${encodeURIComponent(username)}/events/public?per_page=100`;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const asString = (value) => typeof value === 'string' ? value.trim() : '';
const asNonNegativeInteger = (value) => Number.isInteger(value) && value >= 0 ? value : null;

function repositoryFor(event) {
  const name = asString(event?.repo?.name);
  return /^[^\/\s]+\/[^\/\s]+$/.test(name)
    ? { name, url: `https://github.com/${name}` }
    : null;
}

function markdownText(value) {
  return asString(value).replace(/[\[\]`*_]/g, '\\$&');
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
  if (!isObject(event)) return null;
  const payload = isObject(event.payload) ? event.payload : {};
  const repoName = markdownText(repository.name);
  const repo = `[${repoName}](${repository.url})`;

  switch (asString(event.type)) {
    case 'PushEvent': {
      const count = asNonNegativeInteger(payload.distinct_size)
        ?? asNonNegativeInteger(payload.size)
        ?? (Array.isArray(payload.commits) ? payload.commits.length : null);

      const commits = Array.isArray(payload.commits) ? payload.commits : [];
      const firstMsg = commits.length > 0 && typeof commits[0]?.message === 'string'
        ? commits[0].message.split('\n')[0].trim()
        : null;

      if (firstMsg) {
        const cleanMsg = markdownText(firstMsg.length > 45 ? firstMsg.slice(0, 42) + '...' : firstMsg);
        return count && count > 1
          ? `Pushed ${count} commits to ${repo} (\`${cleanMsg}\`)`
          : `Pushed to ${repo} (\`${cleanMsg}\`)`;
      }

      return count !== null && count > 0
        ? `Pushed ${count} commit${count === 1 ? '' : 's'} to ${repo}`
        : `Pushed updates to ${repo}`;
    }
    case 'PullRequestEvent': {
      const action = asString(payload.action);
      const isMerged = action === 'closed' && payload.pull_request?.merged === true;
      if (isMerged) {
        return `Merged pull request in ${repo}`;
      }
      if (['opened', 'closed', 'reopened'].includes(action)) {
        const noun = `${action[0].toUpperCase()}${action.slice(1)} pull request`;
        return `${noun} in ${repo}`;
      }
      return null;
    }
    case 'IssuesEvent': {
      const action = asString(payload.action);
      if (!['opened', 'closed', 'reopened'].includes(action)) return null;
      return `${action[0].toUpperCase()}${action.slice(1)} issue in ${repo}`;
    }
    case 'ReleaseEvent': {
      const action = asString(payload.action);
      if (action === 'published') {
        const tag = asString(payload.release?.tag_name || payload.release?.name);
        return tag ? `Published release \`${markdownText(tag)}\` in ${repo}` : `Published release in ${repo}`;
      }
      return null;
    }
    case 'CreateEvent': {
      const refType = asString(payload.ref_type);
      if (refType === 'repository') {
        return `Created repository ${repo}`;
      }
      if (refType === 'branch' || refType === 'tag') {
        const ref = asString(payload.ref);
        return ref ? `Created ${refType} \`${markdownText(ref)}\` in ${repo}` : `Created ${refType} in ${repo}`;
      }
      return null;
    }
    case 'ForkEvent': {
      return `Forked ${repo}`;
    }
    case 'WatchEvent': {
      const action = asString(payload.action);
      if (action === 'started' || !action) {
        return `Starred ${repo}`;
      }
      return null;
    }
    default:
      return null;
  }
}

async function loadEvents() {
  if (fixturePath) {
    try {
      const fixture = JSON.parse(await fs.readFile(fixturePath, 'utf8'));
      return Array.isArray(fixture) ? fixture : [];
    } catch (error) {
      console.warn(`Unable to read fixture file: ${error.message}`);
      return [];
    }
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
  if (!Array.isArray(events)) return '→ No recent public activity found.<br>';
  const seenKeys = new Set();
  const repoCount = new Map();
  const lines = [];

  const maxEntries = 3;

  for (const event of events) {
    if (!isObject(event)) continue;
    const eventId = asString(event.id);
    const fallbackKey = `${asString(event.type)}|${asString(event.created_at)}|${asString(event.repo?.name)}`;
    const key = eventId || fallbackKey;
    if (!key || seenKeys.has(key)) continue;
    seenKeys.add(key);

    const repository = repositoryFor(event);
    if (!repository) continue;

    // Limit repetitive padding for the same repo if multiple events exist
    const currentCount = repoCount.get(repository.name) || 0;
    if (currentCount >= 2 && events.length > maxEntries) {
      continue;
    }

    const description = describe(event, repository);
    if (!description) continue;

    repoCount.set(repository.name, currentCount + 1);

    const age = relativeTime(event.created_at);
    lines.push(`→ ${description}${age ? ` · ${age}` : ''}<br>`);
    if (lines.length === maxEntries) break;
  }

  return lines.length ? lines.join('\n') : '→ No recent public activity found.<br>';
}

const readmePath = process.env.README_PATH || 'README.md';
const readme = await fs.readFile(readmePath, 'utf8');
const marker = /<!--RECENT_ACTIVITY:start-->[\s\S]*?<!--RECENT_ACTIVITY:end-->/;
if (!marker.test(readme)) throw new Error('Activity markers were not found in README.md');

const events = await loadEvents();
const activityOutput = renderActivity(events);
const replacement = `<!--RECENT_ACTIVITY:start-->\n${activityOutput}\n<!--RECENT_ACTIVITY:end-->`;

let updated = readme.replace(marker, replacement);

const statusMarker = /<!--ACTIVITY_STATUS:start-->[\s\S]*?<!--ACTIVITY_STATUS:end-->/;
if (statusMarker.test(updated)) {
  const existingActivityMatch = readme.match(marker);
  if (existingActivityMatch && existingActivityMatch[0] !== replacement) {
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = now.toISOString().slice(11, 16);
    const statusReplacement = `<!--ACTIVITY_STATUS:start-->\n<sub><span style="color:#E53935;">●</span> SYNCED WITH GITHUB · ${dateStr} ${timeStr} UTC</sub>\n<!--ACTIVITY_STATUS:end-->`;
    updated = updated.replace(statusMarker, statusReplacement);
  }
}

if (updated !== readme) {
  await fs.writeFile(readmePath, updated);
  console.log('README.md successfully updated with recent activity.');
} else {
  console.log('No activity changes detected. README.md left unchanged.');
}
