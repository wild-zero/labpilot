// 配方体检：列出所有环境题配方；给课程/作业时打印每关会命中哪个配方、为什么。
//
//   node scripts/recipes.mjs
//   node scripts/recipes.mjs 5m9itqyf 4293815
import { DatabaseSync } from 'node:sqlite';
import { config } from '../server/config.mjs';
import { open as openSealed } from '../server/crypto.mjs';
import { createEduCoderUpstream } from '../server/upstream/educoder.mjs';
import { listRecipes, pickRecipe, recipeDir } from '../server/engine/recipes/index.mjs';
import { environmentRecipe } from '../server/engine/env-level.mjs';

const [course, homeworkRaw] = process.argv.slice(2);

console.log(`配方目录：${recipeDir}`);
for (const recipe of listRecipes()) console.log(` · ${recipe.id.padEnd(20)} ${recipe.title}`);

if (course && homeworkRaw) {
  const db = new DatabaseSync(config.dbFile);
  const row = db.prepare('SELECT * FROM users WHERE upstream_cookie IS NOT NULL ORDER BY upstream_seen DESC LIMIT 1').get();
  db.close();
  const session = JSON.parse(openSealed(row.upstream_cookie));
  const up = createEduCoderUpstream();

  const entry = await up.enter(session, row.login, course, Number(homeworkRaw));
  let cursor = entry.gameIdentifier;
  const seen = new Set();
  for (let i = 0; i < 20; i += 1) {
    const task = await up.task(session, row.login, cursor, Number(homeworkRaw));
    seen.add(String(cursor));
    if (!task.prevGame || seen.has(String(task.prevGame))) break;
    cursor = task.prevGame;
  }
  const chain = [];
  for (let i = 0; i < 20 && cursor; i += 1) {
    const task = await up.task(session, row.login, cursor, Number(homeworkRaw));
    chain.push(task);
    if (!task.nextGame) break;
    cursor = task.nextGame;
  }
  for (const task of chain) {
    const recipe = environmentRecipe(task);
    const loose = pickRecipe(task);
    const files = (task.files ?? []).map(file => file.path).join(', ') || '(无文件)';
    console.log(`\n关卡 ${task.challenge.position} ${task.challenge.subject} | status ${task.game.status} | files ${files}`);
    console.log(`  环境分支：${recipe ? recipe.id : '不走（按代码题处理）'}${!recipe && loose ? `（弱匹配到 ${loose.id}）` : ''}`);
  }
}
