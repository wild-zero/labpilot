// 题库概况 / 今日完成：给用户看的运营数据。
import { db } from '../db.mjs';
import { requireUser } from '../auth.mjs';

const DAY = 24 * 3600_000;

function levelsOf(result) {
  const rows = Array.isArray(result?.homeworks) ? result.homeworks : [];
  const levels = [];
  for (const row of rows) {
    for (const level of Array.isArray(row.levels) ? row.levels : []) levels.push(level);
  }
  return levels;
}

export const metaRoutes = [
  {
    method: 'GET',
    path: '/api/question-bank/summary',
    async handler(ctx) {
      requireUser(ctx.req);
      const rows = db.prepare('SELECT kind, COUNT(*) AS n FROM bank GROUP BY kind').all();
      const byKind = Object.fromEntries(rows.map(row => [row.kind, row.n]));
      const total = rows.reduce((sum, row) => sum + row.n, 0);
      const today = db.prepare('SELECT COUNT(*) AS n FROM bank WHERE updated_at >= ?').get(new Date(Date.now() - DAY).toISOString()).n;

      // 今天的命中次数：从任务结果里数 source === 'bank' 的关卡
      const jobs = db.prepare('SELECT result, created_at FROM jobs WHERE created_at >= ?').all(new Date(Date.now() - DAY).toISOString());
      let hits = 0;
      let generated = 0;
      for (const job of jobs) {
        let result;
        try { result = JSON.parse(job.result); } catch { continue; }
        for (const level of levelsOf(result)) {
          if (level.source === 'bank') hits += 1;
          else if (level.source) generated += 1;
        }
      }
      return {
        total,
        code: byKind.code ?? 0,
        choice: byKind.choice ?? 0,
        added_today: today,
        hits_today: hits,
        generated_today: generated,
        // 命中一次大约省下一次模型调用
        saved_calls_today: hits,
      };
    },
  },
  {
    method: 'GET',
    path: '/api/service/today-summary',
    async handler(ctx) {
      requireUser(ctx.req);
      const since = new Date(Date.now() - DAY).toISOString();
      const jobs = db.prepare('SELECT result, status, created_at FROM jobs WHERE created_at >= ?').all(since);
      let jobsRun = jobs.length;
      let levelsPassed = 0;
      let homeworksDone = 0;
      for (const job of jobs) {
        let result;
        try { result = JSON.parse(job.result); } catch { continue; }
        for (const level of levelsOf(result)) {
          if (level.status === 'passed') levelsPassed += 1;
        }
        for (const row of Array.isArray(result.homeworks) ? result.homeworks : []) {
          if (row.status === 'completed') homeworksDone += 1;
        }
      }
      return { jobs_today: jobsRun, levels_passed_today: levelsPassed, homeworks_completed_today: homeworksDone };
    },
  },
];
