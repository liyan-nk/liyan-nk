const fs = require('node:fs');

const username = process.env.GITHUB_USERNAME || 'liyan-nk';
const token = process.env.GITHUB_TOKEN;
const endpoint = `https://api.github.com/users/${encodeURIComponent(username)}/events/public?per_page=100`;

const response = await fetch(endpoint, {
  headers: {
    Accept: 'application/vnd.github+json',
    'User-Agent': `${username}-profile-activity`,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  },
});
if (!response.ok) throw new Error(`GitHub events request failed: ${response.status}`);

const events = await response.json();
if (!Array.isArray(events)) throw new Error('GitHub events response was not an array');

const seen = new Set();
const lines = [];
const repoFor = (event) => {
  const name = typeof event?.repo?.name === 'string' ? event.repo.name.trim() : '';
  return /^[^/\s]+\/[^/\s]+$/.test(name) ? { name, url: `https://github.com/${name}` } : null;
};
const integer = (value) => Number.isInteger(value) && value >= 0 ? value : null;
const readableTime = (value) => {
  const date = new Date(value || 0);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().replace('T', ' ').replace(/:\d{2}\.\d{3}Z$/, ' UTC');
};
const describe = (event, repo) => {
  const payload = event?.payload && typeof event.payload === 'object' ? event.payload : {};
  const link = `[${repo.name}](${repo.url})`;
  switch (event?.type) {
    case 'PushEvent': {
      const count = integer(payload.distinct_size) ?? integer(payload.size) ?? (Array.isArray(payload.commits) ? payload.commits.length : null);
      return count && count > 0 ? `Pushed ${count} commit${count === 1 ? '' : 's'} to ${link}` : `Pushed updates to ${link}`;
    }
    case 'PullRequestEvent': {
      const action = typeof payload.action === 'string' ? payload.action : '';
      return ['opened', 'closed', 'reopened', 'merged'].includes(action) ? `${action[0].toUpperCase()}${action.slice(1)} a pull request in ${link}` : null;
    }
    case 'IssuesEvent': {
      const action = typeof payload.action === 'string' ? payload.action : '';
      return ['opened', 'closed', 'reopened'].includes(action) ? `${action[0].toUpperCase()}${action.slice(1)} an issue in ${link}` : null;
    }
    case 'ReleaseEvent': {
      const action = payload.action === 'published' ? 'Published' : null;
      return action ? `${action} a release in ${link}` : null;
    }
    case 'CreateEvent': return payload.ref_type === 'repository' ? `Created a repository ${link}` : null;
    case 'ForkEvent': return `Forked ${link}`;
    case 'WatchEvent': return payload.action === 'started' ? `Starred ${link}` : null;
    default: return null;
  }
};

for (const event of events) {
  const id = event?.id == null ? '' : String(event.id);
  if (!id || seen.has(id)) continue;
  seen.add(id);
  const repo = repoFor(event);
  const description = repo ? describe(event, repo) : null;
  if (!description) continue;
  const time = readableTime(event.created_at);
  lines.push(`→ ${description}${time ? ` · ${time}` : ''}<br>`);
  if (lines.length === 5) break;
}

const synced = new Date().toISOString().replace('T', ' ').replace(/:\d{2}\.\d{3}Z$/, ' UTC');
const activity = lines.length ? lines.join('\n') : '→ No recent public activity found.<br>';
const readme = fs.readFileSync('README.md', 'utf8');
const marker = /<!--RECENT_ACTIVITY:start-->[\s\S]*?<!--RECENT_ACTIVITY:end-->/;
if (!marker.test(readme)) throw new Error('Activity markers were not found in README.md');
const replacement = `<!--RECENT_ACTIVITY:start-->\n${activity}\n<!--RECENT_ACTIVITY:end-->`;
const statusMarker = /<!--ACTIVITY_STATUS:start-->[\s\S]*?<!--ACTIVITY_STATUS:end-->/;
const status = `<!--ACTIVITY_STATUS:start-->\n<span aria-hidden="true">●</span> SYNCED WITH GITHUB · ${synced}\n<!--ACTIVITY_STATUS:end-->`;
const updated = readme.replace(marker, replacement).replace(statusMarker, status);
fs.writeFileSync('README.md', updated);
