/**
 * X 바이럴 탐색기 - Node.js 백엔드 서버
 * Nitter RSS 피드를 통해 인기 게시물 수집
 *
 * 실행: node server.js
 * 포트: http://localhost:3000
 */

const express = require('express');
const axios = require('axios');
const xml2js = require('xml2js');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────
// Nitter 인스턴스 목록 (하나 막히면 다음으로)
// ─────────────────────────────────────────
const NITTER_INSTANCES = [
  'https://nitter.privacydev.net',
  'https://nitter.poast.org',
  'https://nitter.lucabased.xyz',
  'https://lightbrd.com',
];

const parser = new xml2js.Parser({ explicitArray: false });

// ─────────────────────────────────────────
// 유틸: Nitter RSS 파싱
// ─────────────────────────────────────────
async function fetchNitterRSS(query, instance) {
  const encoded = encodeURIComponent(query);
  const url = `${instance}/search/rss?q=${encoded}&f=tweets`;

  const response = await axios.get(url, {
    timeout: 8000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; RSSReader/1.0)',
    },
  });

  const result = await parser.parseStringPromise(response.data);
  const items = result?.rss?.channel?.item;
  if (!items) return [];

  const list = Array.isArray(items) ? items : [items];

  return list.map((item) => {
    const text = item.description || '';
    // 좋아요·리트윗 파싱 (Nitter HTML 형식)
    const likesMatch = text.match(/(\d[\d,]*)\s*(?:like|❤|heart)/i);
    const rtMatch = text.match(/(\d[\d,]*)\s*(?:retweet|RT|🔁)/i);
    const repliesMatch = text.match(/(\d[\d,]*)\s*(?:repl|💬)/i);

    return {
      id: item.guid?._ || item.guid || '',
      title: item.title || '',
      link: (item.link || '').replace(/nitter\.[^/]+/, 'x.com').replace('nitter.', 'x.com/'),
      author: item['dc:creator'] || item.author || '',
      pubDate: item.pubDate || '',
      likes: parseStat(likesMatch?.[1]),
      retweets: parseStat(rtMatch?.[1]),
      replies: parseStat(repliesMatch?.[1]),
      text: stripHtml(text),
    };
  });
}

function parseStat(str) {
  if (!str) return 0;
  return parseInt(str.replace(/,/g, ''), 10) || 0;
}

function stripHtml(html) {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 280);
}

// ─────────────────────────────────────────
// 유틸: 여러 인스턴스 순차 시도
// ─────────────────────────────────────────
async function fetchWithFallback(query) {
  for (const instance of NITTER_INSTANCES) {
    try {
      console.log(`[fetch] 시도: ${instance}`);
      const items = await fetchNitterRSS(query, instance);
      if (items.length > 0) {
        console.log(`[fetch] 성공: ${instance} (${items.length}건)`);
        return { items, source: instance };
      }
    } catch (err) {
      console.warn(`[fetch] 실패: ${instance} → ${err.message}`);
    }
  }
  throw new Error('모든 Nitter 인스턴스에서 데이터를 가져오지 못했습니다.');
}

// ─────────────────────────────────────────
// API: GET /api/search
// 쿼리 파라미터: q, minLikes, minRT, sort, limit
// ─────────────────────────────────────────
app.get('/api/search', async (req, res) => {
  const {
    q = 'AI',
    minLikes = 0,
    minRT = 0,
    sort = 'likes',  // likes | retweets | recent
    limit = 20,
  } = req.query;

  if (!q.trim()) {
    return res.status(400).json({ error: '검색어(q)를 입력해주세요.' });
  }

  try {
    const { items, source } = await fetchWithFallback(q.trim());

    // 필터링
    let filtered = items.filter(
      (t) => t.likes >= Number(minLikes) && t.retweets >= Number(minRT)
    );

    // 정렬
    if (sort === 'retweets') {
      filtered.sort((a, b) => b.retweets - a.retweets);
    } else if (sort === 'recent') {
      filtered.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
    } else {
      filtered.sort((a, b) => b.likes - a.likes);
    }

    filtered = filtered.slice(0, Number(limit));

    res.json({
      ok: true,
      query: q,
      source,
      total: filtered.length,
      results: filtered,
    });
  } catch (err) {
    console.error('[API Error]', err.message);
    res.status(502).json({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────
// API: GET /api/trending
// 여러 키워드를 병렬로 수집해 종합 인기 목록 반환
// ─────────────────────────────────────────
const DEFAULT_TOPICS = ['AI', '주식', '마케팅', '스타트업', '개발자'];

app.get('/api/trending', async (req, res) => {
  const topics = req.query.topics
    ? req.query.topics.split(',').map((t) => t.trim())
    : DEFAULT_TOPICS;

  try {
    const results = await Promise.allSettled(
      topics.map((t) => fetchWithFallback(t))
    );

    const merged = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        r.value.items.forEach((item) => {
          merged.push({ ...item, topic: topics[i] });
        });
      }
    });

    // 좋아요 + 리트윗 * 2 로 점수 계산
    merged.sort((a, b) => (b.likes + b.retweets * 2) - (a.likes + a.retweets * 2));

    res.json({
      ok: true,
      total: merged.length,
      results: merged.slice(0, 30),
    });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────
// API: GET /api/status - 서버 상태 확인
// ─────────────────────────────────────────
app.get('/api/status', (req, res) => {
  res.json({ ok: true, message: 'X 바이럴 탐색기 서버 정상 가동 중', instances: NITTER_INSTANCES });
});

// ─────────────────────────────────────────
// 서버 시작
// ─────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('  ██╗  ██╗    ███████╗██╗  ██╗██████╗ ');
  console.log('   ╚██╔╝     ██╔════╝╚██╗██╔╝██╔══██╗');
  console.log('    ██║      █████╗   ╚███╔╝ ██████╔╝');
  console.log('   ██╔██╗    ██╔══╝   ██╔██╗ ██╔═══╝ ');
  console.log('  ██╔╝ ██╗   ███████╗██╔╝ ██╗██║     ');
  console.log('  ╚═╝  ╚═╝   ╚══════╝╚═╝  ╚═╝╚═╝     ');
  console.log('');
  console.log(`  🚀 서버 실행 중: http://localhost:${PORT}`);
  console.log(`  📡 API 엔드포인트:`);
  console.log(`     GET /api/search?q=AI&minLikes=100&sort=likes`);
  console.log(`     GET /api/trending?topics=AI,주식,개발자`);
  console.log(`     GET /api/status`);
  console.log('');
});
