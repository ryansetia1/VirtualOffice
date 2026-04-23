import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import https from 'https';
import http from 'http';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================
// KONFIGURASI
// ============================================
const HTML_FILE = path.join(__dirname, 'index.html');
const UPDATE_INTERVAL_MS = 30 * 60 * 1000; // 30 menit

// Sumber berita prioritas
const NEWS_SOURCES = [
  { name: 'Gematsu', url: 'https://www.gematsu.com', search: 'gematsu.com latest news' },
  { name: 'IGN', url: 'https://www.ign.com', search: 'ign.com gaming news' },
  { name: 'PC Gamer', url: 'https://www.pcgamer.com', search: 'pcgamer.com news' },
  { name: 'Eurogamer', url: 'https://www.eurogamer.net', search: 'eurogamer.net news' },
  { name: 'Polygon', url: 'https://www.polygon.com', search: 'polygon.com gaming news' },
  { name: 'GameSpot', url: 'https://www.gamespot.com', search: 'gamespot.com news' },
  { name: 'Kotaku', url: 'https://kotaku.com', search: 'kotaku.com gaming' }
];

// ============================================
// HELPER FUNCTIONS
// ============================================

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5'
      },
      timeout: 10000
    };

    client.get(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, html: data }));
    }).on('error', reject);
  });
}

// Simple HTML parser helpers
function extractText(html, tag) {
  const regex = new RegExp(`<${tag}[^>]*>([^<]+)</${tag}>`, 'gi');
  const matches = [...html.matchAll(regex)];
  return matches.map(m => m[1].trim()).filter(t => t.length > 0);
}

function extractLinks(html) {
  const links = [];
  const regex = /<a[^>]+href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gis;
  let match;
  while ((match = regex.exec(html)) !== null) {
    links.push({
      href: match[1],
      text: match[2].replace(/<[^>]+>/g, '').trim()
    });
  }
  return links;
}

function getDomain(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

// ============================================
// WEB SEARCH (Menggunakan DuckDuckGo HTML)
// ============================================

async function searchGamingNews() {
  console.log('[SEARCH] Mencari gaming news terbaru...');

  // Gunakan DuckDuckGo untuk search
  const searchQuery = encodeURIComponent('gaming news new release 2026 site:gematsu.com OR site:ign.com OR site:pcgamer.com OR site:eurogamer.net -esports');
  const searchUrl = `https://html.duckduckgo.com/html/?q=${searchQuery}`;

  try {
    const result = await fetchUrl(searchUrl);
    if (result.status !== 200) {
      throw new Error(`Search failed with status ${result.status}`);
    }

    const articles = parseSearchResults(result.html);
    console.log(`[SEARCH] Ditemukan ${articles.length} artikel potensial`);
    return articles;
  } catch (error) {
    console.error('[SEARCH] Error:', error.message);
    // Fallback: coba sumber langsung
    return fetchFromSources();
  }
}

function parseSearchResults(html) {
  const results = [];
  const resultRegex = /<a[^>]+class=["']result__a["'][^>]+href=["']([^"']+)["'][^>]*>([^<]+)<\/a>/gis;
  const snippetRegex = /<a[^>]+class=["']result__snippet["'][^>]*>([^<]+)<\/a>/gis;

  let match;
  const seenUrls = new Set();

  while ((match = resultRegex.exec(html)) !== null) {
    const url = match[1];
    const title = match[2].replace(/<[^>]+>/g, '').trim();

    // Filter: bukan esports, bukan youtube, bukan video
    if (url.includes('esports') || url.includes('youtube') || url.includes('/video/')) {
      continue;
    }

    // Hanya ambil URL eksternal (bukan duckduckgo)
    if (!url.includes('duckduckgo.com') && !seenUrls.has(url) && title.length > 20) {
      seenUrls.add(url);

      // Coba ambil snippet
      const snippetMatch = snippetRegex.exec(html);
      const snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]+>/g, '').trim() : '';

      results.push({
        title,
        url,
        snippet
      });

      if (results.length >= 10) break;
    }
  }

  return results;
}

// ============================================
// FETCH DIRECT FROM SOURCES
// ============================================

async function fetchFromSources() {
  console.log('[FETCH] Mengambil dari sumber langsung...');
  const articles = [];

  for (const source of NEWS_SOURCES) {
    try {
      const result = await fetchUrl(source.url);
      if (result.status === 200) {
        const sourceArticles = parseSourcePage(result.html, source);
        articles.push(...sourceArticles);
        console.log(`[FETCH] ${source.name}: ${sourceArticles.length} artikel`);
      }
    } catch (error) {
      console.error(`[FETCH] Error fetching ${source.name}:`, error.message);
    }

    if (articles.length >= 10) break;
  }

  return articles.slice(0, 10);
}

function parseSourcePage(html, source) {
  const articles = [];
  const links = extractLinks(html);
  const seenUrls = new Set();

  for (const link of links) {
    // Filter: headline articles, bukan nav/menu
    if (link.text.length < 30 || link.text.length > 150) continue;
    if (link.href.startsWith('#') || link.href.includes('javascript:')) continue;
    if (link.href.includes('/tag/') || link.href.includes('/category/')) continue;
    if (link.text.toLowerCase().includes('esports')) continue;

    // Make absolute URL
    let fullUrl = link.href;
    if (fullUrl.startsWith('/')) {
      fullUrl = source.url + fullUrl;
    }

    if (!seenUrls.has(fullUrl) && fullUrl.includes(getDomain(source.url))) {
      seenUrls.add(fullUrl);
      articles.push({
        title: link.text,
        url: fullUrl,
        snippet: '',
        source: source
      });
    }

    if (articles.length >= 3) break;
  }

  return articles;
}

// ============================================
// FETCH ARTICLE DETAILS
// ============================================

async function fetchArticleDetails(article) {
  try {
    const result = await fetchUrl(article.url);
    if (result.status === 200) {
      return extractArticleData(result.html, article);
    }
  } catch (error) {
    console.error(`[DETAIL] Error fetching ${article.url}:`, error.message);
  }
  return null;
}

function extractArticleData(html, article) {
  // Extract title
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  let title = titleMatch ? titleMatch[1].replace(/\s*\|.*$/, '').trim() : article.title;

  // Extract description/meta
  const metaDesc = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
  let snippet = metaDesc ? metaDesc[1] : article.snippet;

  // Clean up snippet
  snippet = snippet.replace(/\s+/g, ' ').trim();
  if (snippet.length > 280) {
    snippet = snippet.substring(0, 277) + '...';
  }

  // Determine category
  const category = categorizeArticle(title, snippet);

  // Get media name
  const media = article.source?.name || getDomain(article.url);

  // Get logo
  const domain = getDomain(article.url);
  const logo = `https://${domain}/favicon.ico`;

  // Generate image URL
  const gameTitle = extractGameTitle(title);
  const image = `https://via.placeholder.com/400x200?text=${encodeURIComponent(gameTitle)}`;

  return {
    title,
    snippet,
    category,
    url: article.url,
    media,
    logo,
    image
  };
}

function categorizeArticle(title, snippet) {
  const text = (title + ' ' + snippet).toLowerCase();

  if (text.includes('rpg') || text.includes('role-playing')) return 'RPG';
  if (text.includes('fps') || text.includes('shooter')) return 'FPS';
  if (text.includes('mmo') || text.includes('mmorpg')) return 'MMORPG';
  if (text.includes('indie')) return 'Indie';
  if (text.includes('mobile')) return 'Mobile';
  if (text.includes('hardware') || text.includes('gpu') || text.includes('cpu')) return 'Hardware';
  if (text.includes('review')) return 'Review';
  if (text.includes('preview')) return 'Preview';
  if (text.includes('announcement') || text.includes('announce')) return 'News';
  if (text.includes('release') || text.includes('launch') || text.includes('rilis')) return 'News';

  return 'News';
}

function extractGameTitle(articleTitle) {
  // Coba ekstrak nama game dari title
  const patterns = [
    /["']([^"']{2,40})["']\s*(gets|receives|announced|revealed)/i,
    /^(.{2,50})\s*[-:]/,
    /(.{2,50})\s+(review|preview|announcement)/i
  ];

  for (const pattern of patterns) {
    const match = articleTitle.match(pattern);
    if (match && match[1].length > 2 && match[1].length < 50) {
      return match[1].trim();
    }
  }

  // Fallback: ambil 3-5 kata pertama
  const words = articleTitle.split(/\s+/).slice(0, 4).join(' ');
  return words.replace(/[^a-zA-Z0-9\s]/g, '').trim() || 'Gaming News';
}

// ============================================
// TRANSLATE TO BAHASA INDONESIA
// ============================================

async function translateToBahasa(text) {
  // Simple translation mapping untuk common terms
  const translations = {
    'announces': 'umumkan',
    'announcement': 'pengumuman',
    'reveals': 'ungkap',
    'revealed': 'terungkap',
    'releases': 'rilis',
    'release': 'rilisan',
    'launch': 'luncur',
    'launched': 'diluncurkan',
    'coming': 'datang',
    'arrives': 'tiba',
    'new': 'baru',
    'update': 'pembaruan',
    'preview': 'pratinjau',
    'review': 'ulasan',
    'game': 'game',
    'games': 'game',
    'players': 'pemain',
    'features': 'fitur',
    'includes': 'termasuk',
    'with': 'dengan',
    'for': 'untuk',
    'from': 'dari',
    'now available': 'tersedia sekarang',
    'coming soon': 'segera hadir',
    'is here': 'hadir',
    'debut': 'debut',
    'unveils': 'perkenalkan',
    'showcases': 'pamerkan'
  };

  let translated = text;

  // Replace common phrases
  for (const [eng, ind] of Object.entries(translations)) {
    const regex = new RegExp(`\\b${eng}\\b`, 'gi');
    translated = translated.replace(regex, ind);
  }

  // Untuk hasil yang lebih baik, bisa integrate dengan API translate
  // Untuk sekarang, return dengan sedikit processing
  return translated;
}

// ============================================
// GENERATE BERITA DATA
// ============================================

async function generateBeritaData() {
  console.log('[UPDATE] Memulai update berita gaming...');

  // Step 1: Search for articles
  const searchResults = await searchGamingNews();

  if (searchResults.length === 0) {
    console.error('[UPDATE] Tidak ada artikel ditemukan!');
    return null;
  }

  // Step 2: Fetch details for top 3 articles
  const beritaList = [];
  let id = 1;

  for (const article of searchResults.slice(0, 6)) {
    console.log(`[UPDATE] Memproses: ${article.title.substring(0, 50)}...`);

    const details = await fetchArticleDetails(article);
    if (details) {
      // Translate title dan snippet ke Bahasa Indonesia
      const judul = await translateToBahasa(details.title);
      const ringkasan = await translateToBahasa(details.snippet);

      beritaList.push({
        id: id++,
        judul,
        ringkasan: ringkasan || 'Baca selengkapnya di sumber.',
        kategori: details.category,
        sumber: details.url,
        media: details.media,
        logo: details.logo,
        gambar: details.image
      });

      if (beritaList.length >= 3) break;
    }
  }

  if (beritaList.length === 0) {
    console.error('[UPDATE] Gagal mengambil detail artikel!');
    return null;
  }

  // Generate timestamp dengan +07:00 offset
  const now = new Date();
  const offsetMs = 7 * 60 * 60 * 1000; // +07:00
  const localTime = new Date(now.getTime() + offsetMs);
  const lastUpdated = localTime.toISOString().replace('Z', '+07:00');

  console.log(`[UPDATE] Berhasil mengumpulkan ${beritaList.length} artikel`);

  return {
    lastUpdated,
    berita: beritaList
  };
}

// ============================================
// UPDATE HTML FILE
// ============================================

function updateHtmlFile(beritaData) {
  const htmlContent = fs.readFileSync(HTML_FILE, 'utf-8');

  // Find and replace the beritaData object
  const startIndex = htmlContent.indexOf('const beritaData = {');
  const endIndex = htmlContent.indexOf('// ============================================', startIndex + 20);

  if (startIndex === -1 || endIndex === -1) {
    console.error('[HTML] Tidak dapat menemukan beritaData object!');
    return false;
  }

  const beforeData = htmlContent.substring(0, startIndex);
  const afterData = htmlContent.substring(endIndex);

  const newData = `const beritaData = ${JSON.stringify(beritaData, null, 8)};`;

  const newHtml = beforeData + newData + '\n    ' + afterData;

  fs.writeFileSync(HTML_FILE, newHtml, 'utf-8');
  console.log('[HTML] File berhasil diupdate!');
  return true;
}

// ============================================
// MAIN LOOP
// ============================================

async function runUpdate() {
  console.log('\n' + '='.repeat(50));
  console.log(`[UPDATE] ${new Date().toISOString()} - Memulai update...`);
  console.log('='.repeat(50));

  try {
    const beritaData = await generateBeritaData();

    if (beritaData) {
      updateHtmlFile(beritaData);
      console.log('[UPDATE] Selesai! Next update dalam 30 menit.\n');
    } else {
      console.error('[UPDATE] Gagal update, retry dalam 30 menit.\n');
    }
  } catch (error) {
    console.error('[UPDATE] Error:', error.message);
    console.error(error.stack);
  }
}

// Run immediately on start
runUpdate();

// Then run every 30 minutes
setInterval(runUpdate, UPDATE_INTERVAL_MS);

console.log(`[INIT] Updater berjalan. Update setiap 30 menit.`);
console.log(`[INIT] Tekan Ctrl+C untuk berhenti.\n`);
