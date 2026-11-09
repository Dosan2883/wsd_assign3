/**
 * 웹서비스설계 9주차 실습 · 백엔드 API 서버 (Node.js Express + 1,000건 대량 데이터셋)
 * 3학년 전공심화:
 *   1) 양의 정수 파라미터 검사와 조회 건수 상한
 *   2) 정렬 키 화이트리스트와 조회수 동점의 id DESC 정렬
 *   3) 오프셋 페이징 API (/api/posts) + 표준 meta Envelope
 *   4) 검색을 지원하는 커서 기반 페이징 API (/api/posts/cursor)
 *
 * 실행 방법:
 *   1) npm install express
 *   2) node server.js
 *   3) 브라우저에서 http://localhost:3000 접속
 */

const express = require('express');
const path = require('path');
const app = express();
const PORT = 3000;

app.use(express.static(__dirname)); // 현재 폴더의 index.html 정적 서빙
app.use(express.json());

// 1,000건의 대용량 더미 게시글 데이터 생성 (1~1000)
const TOPICS = [
  'B-Tree 인덱스 구조와 LIKE %kw% 검색 튜닝 실무',
  '커서 기반(Keyset) 페이지네이션 O(log N) 탐색 원리',
  'ORDER BY SQL Injection과 화이트리스트 매핑 방어',
  'InnoDB 버퍼 풀과 LIMIT OFFSET Cache Thrashing',
  'AbortController를 이용한 비동기 Race Condition 방어',
  '300ms 디바운스(Debounce)와 프론트엔드 입력 최적화',
  'URLSearchParams와 history.pushState 뒤로가기 동기화',
  'InnoDB MVCC 메커니즘과 COUNT(*) 전수 스캔 병목',
  '복합 인덱스(Compound Index) 컬럼 순서의 황금률',
  'Redis 분산 캐시를 활용한 카운트 캐싱 아키텍처',
  'RESTful JSON 페이징 Envelope 규격 표준화',
  'ElasticSearch 역색인(Inverted Index)과 N-gram 전문 검색'
];
const AUTHORS = ['이경수', '김철수', '이영희', '박민수', '정다은', '최준호', '강서연', '윤성호'];

const POSTS = Array.from({ length: 1000 }, (_, i) => {
  const id = 1000 - i;
  const topic = TOPICS[i % TOPICS.length];
  const author = AUTHORS[i % AUTHORS.length];
  // 서버를 재시작해도 조회수와 동점 테스트 결과가 같다.
  const views = id >= 999 ? 5000 : 10 + (id * 137) % 4990;
  return {
    id,
    title: `[#${id}] ${topic}`,
    content: `게시글 ${id}번의 상세 본문 데이터입니다. DB 인덱스와 페이징 최적화를 실습합니다.`,
    author,
    views,
    createdAt: `2026-${(10 - Math.floor(i / 150)).toString().padStart(2, '0')}-${((i % 28) + 1).toString().padStart(2, '0')}`
  };
});

// 화이트리스트 정렬 정의 (동점자 방지 id 결합)
const SORT_WHITELIST = Object.freeze({
  latest: (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id,
  oldest: (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id,
  views: (a, b) => (b.views !== a.views ? b.views - a.views : b.id - a.id)
});

function positiveInteger(value, fallback) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return fallback;
  const number = parseInt(value, 10);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function normalizeSearch(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function matchesSearch(post, search) {
  return !search || post.title.toLowerCase().includes(search) ||
    post.content.toLowerCase().includes(search);
}

// ==========================================
// 1. 오프셋 기반 페이지네이션 API
// GET /api/posts?page=1&limit=10&sort=views&search=인덱스
// ==========================================
app.get('/api/posts', (req, res) => {
  const startTime = process.hrtime();

  // 파라미터 정제 및 방어 코딩
  const page = positiveInteger(req.query.page, 1);
  const limit = Math.min(positiveInteger(req.query.limit, 10), 100);
  const search = normalizeSearch(req.query.search);
  const sort = req.query.sort;
  const sortKey = typeof sort === 'string' && Object.hasOwn(SORT_WHITELIST, sort)
    ? sort
    : 'latest';

  // 1) 검색 필터링 (WHERE title LIKE '%search%')
  const filtered = POSTS.filter(post => matchesSearch(post, search));

  // 2) 화이트리스트 정렬 (ORDER BY ...)
  filtered.sort(SORT_WHITELIST[sortKey]);

  // 3) 오프셋 계산 및 데이터 슬라이싱
  const totalCount = filtered.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / limit));
  const safePage = Math.min(page, totalPages);
  const offset = (safePage - 1) * limit;
  const items = filtered.slice(offset, offset + limit);

  const diff = process.hrtime(startTime);
  const executionTimeMs = (diff[0] * 1000 + diff[1] / 1e6).toFixed(2);

  res.setHeader('X-Response-Time', `${executionTimeMs}ms`);
  res.json({
    items,
    meta: {
      page: safePage,
      limit,
      totalCount,
      totalPages,
      hasNext: safePage < totalPages,
      hasPrev: safePage > 1,
      executionTimeMs: Number(executionTimeMs)
    }
  });
});

// ==========================================
// 2. 커서 기반(Keyset) 페이지네이션 API
// GET /api/posts/cursor?cursor=950&limit=10&search=인덱스
// ==========================================
app.get('/api/posts/cursor', (req, res) => {
  const startTime = process.hrtime();

  const cursor = positiveInteger(req.query.cursor, null);
  const limit = Math.min(positiveInteger(req.query.limit, 10), 50);
  const search = normalizeSearch(req.query.search);

  // POSTS는 ID 내림차순이다. 두 조건을 통과한 글만 limit + 1개까지 모은다.
  const sliced = [];
  for (const post of POSTS) {
    if (cursor !== null && post.id >= cursor) continue;
    if (!matchesSearch(post, search)) continue;
    sliced.push(post);
    if (sliced.length === limit + 1) break;
  }
  const hasNext = sliced.length > limit;
  const items = sliced.slice(0, limit);
  const nextCursor = items.length > 0 ? items[items.length - 1].id : null;

  const diff = process.hrtime(startTime);
  const executionTimeMs = (diff[0] * 1000 + diff[1] / 1e6).toFixed(2);

  res.setHeader('X-Response-Time', `${executionTimeMs}ms`);
  res.json({
    items,
    meta: {
      cursor,
      nextCursor,
      limit,
      hasNext,
      executionTimeMs: Number(executionTimeMs)
    }
  });
});

if (require.main === module) {
  app.listen(PORT, error => {
    if (error) {
      console.error(error);
      process.exitCode = 1;
      return;
    }
    console.log(`실습 서버 실행 중 · http://localhost:${PORT} · 인메모리 게시글 1,000건`);
  });
}

module.exports = app;
