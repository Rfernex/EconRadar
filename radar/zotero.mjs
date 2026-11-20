const API = 'https://api.zotero.org';

function requestError(status) {
  if (status === 401 || status === 403) {
    return new Error('Zotero rejected the key. Check that it has personal library access and write permissions.');
  }
  if ([409, 429, 503].includes(status)) {
    return new Error('Zotero is busy. Try again in a moment.');
  }
  return new Error(`Zotero could not complete the request (HTTP ${status}).`);
}

async function request(path, apiKey, options = {}) {
  const { headers, ...init } = options;
  try {
    return await fetch(API + path, {
      ...init,
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
      headers: { 'Zotero-API-Version': '3', 'Zotero-API-Key': apiKey, ...headers },
    });
  } catch {
    throw new Error('Could not reach Zotero. Check your connection and try again.');
  }
}

async function readResponse(response) {
  try { return await response.json(); }
  catch { throw new Error('Zotero returned an unreadable response. Try again.'); }
}

export async function connectZotero(apiKey) {
  const response = await request('/keys/current', apiKey);
  if (!response.ok) throw requestError(response.status);
  const { userID, username, access } = await readResponse(response);
  if (access?.user?.library !== true || access.user.write !== true) {
    throw new Error('Enable personal library access and write permissions for this key in Zotero.');
  }
  if (!Number.isSafeInteger(userID) || userID < 1 || typeof username !== 'string') {
    throw new Error('Zotero did not return a valid account.');
  }
  return { apiKey, userID, username };
}

function author({ n }) {
  // OpenAlex provides a display name. Keep single names and likely group authors intact.
  const name = n.trim();
  const [last, first] = name.split(/,\s+/, 2);
  if (first && !/^(jr\.?|sr\.?|[iv]+)$/i.test(first)) {
    return { creatorType: 'author', firstName: first, lastName: last };
  }
  const parts = name.split(/\s+/);
  if (parts.length < 2 || /\b(bank|bureau|committee|consortium|council|group|institute|organisation|organization|team)\b/i.test(name)) {
    return { creatorType: 'author', name };
  }
  const suffix = /^(jr\.?|sr\.?|[IV]{2,4})$/i.test(parts.at(-1)) ? parts.pop() : '';
  const family = [parts.pop().replace(/,$/, ''), suffix].filter(Boolean);
  while (parts.length > 1 && /^(da|de|del|den|der|di|dos|du|la|le|van|von)$/i.test(parts.at(-1))) family.unshift(parts.pop());
  return { creatorType: 'author', firstName: parts.join(' '), lastName: family.join(' ') };
}

export function zoteroItem(paper, venue) {
  const item = {
    title: paper.title,
    creators: paper.authors.map(author),
    date: paper.published || '',
    url: paper.url || '',
    tags: (paper.topics || []).map(tag => ({ tag })),
  };
  if (paper.abstract) item.abstractNote = paper.abstract;
  if (paper.doi) item.DOI = paper.doi;
  if (paper.kind === 'working') {
    const number = paper.doi?.match(/^10\.3386\/w(\d+)$/i)?.[1];
    return {
      ...item, itemType: 'preprint', genre: 'Working paper',
      ...(number ? { repository: 'National Bureau of Economic Research', series: 'NBER Working Papers', seriesNumber: number } : { repository: venue }),
    };
  }
  if (paper.kind === 'book' || paper.kind === 'chapter') {
    // The Focus data stores the index's source name, which may be a repository or a series.
    return { ...item, itemType: paper.kind === 'book' ? 'book' : 'bookSection', ...(venue ? { extra: `Source: ${venue}` } : {}) };
  }
  return { ...item, itemType: 'journalArticle', publicationTitle: venue };
}

export function zoteroPaperRef(paper) {
  return paper.doi ? `doi:${paper.doi.toLowerCase()}` : `id:${paper.id}`;
}

export async function saveZoteroPaper(connection, paper, venue) {
  // Reuse the write token after a lost response and across tabs. Zotero remembers it for 12 hours.
  const identity = `econradar:${connection.userID}:${zoteroPaperRef(paper)}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity));
  const token = Array.from(new Uint8Array(digest, 0, 16), byte => byte.toString(16).padStart(2, '0')).join('');
  const response = await request(`/users/${connection.userID}/items`, connection.apiKey, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Zotero-Write-Token': token },
    body: JSON.stringify([zoteroItem(paper, venue)]),
  });
  if (response.status === 412) return; // This unversioned request's write token was already accepted.
  if (!response.ok) throw requestError(response.status);
  const result = await readResponse(response);
  if (!result.successful?.['0']?.key) {
    if (result.failed?.['0']?.code === 403) throw requestError(403);
    throw new Error('Zotero did not save this reference. Try again or use the citation export.');
  }
}
