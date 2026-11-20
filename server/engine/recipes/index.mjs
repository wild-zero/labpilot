// 环境题的配方库。
//
// 头歌里有一类关卡：判分脚本自己在容器里跑 `/opt/hive/bin/hive ...`、`hadoop fs ...`，
// 你在代码编辑器里写什么文件都没用——必须先把容器环境做出来（装软件、起服务、建目录），
// 再触发测评。这类关卡靠「改文件 + build」永远过不去，所以单独走配方执行。
//
// 配方是纯 JSON（项目零依赖，不引入 yaml 解析器）：
//   match   —— 怎么认出这道题属于哪个配方
//   setup   —— 按顺序在容器里执行的命令
//   verify  —— 可选：执行成功后用来自检的命令 + 期望出现在输出里的片段
//   repair  —— 可选：第一次测评没通过时补跑的命令
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RECIPE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../recipes');

let cache = null;

function load() {
  if (cache) return cache;
  const list = [];
  if (existsSync(RECIPE_DIR)) {
    for (const name of readdirSync(RECIPE_DIR)) {
      if (!name.endsWith('.json')) continue;
      try {
        const recipe = JSON.parse(readFileSync(resolve(RECIPE_DIR, name), 'utf8'));
        if (recipe?.id && Array.isArray(recipe.setup)) list.push(recipe);
      } catch (error) {
        console.warn(`[recipes] 跳过 ${name}: ${error.message}`);
      }
    }
  }
  cache = list;
  return cache;
}

const contains = (haystack, needle) => String(haystack ?? '').toLowerCase().includes(String(needle ?? '').toLowerCase());

/** 给一道关卡挑配方：题干权重最高，其次是描述关键词，最后看文件名 */
export function pickRecipe(task, { precondition = false } = {}) {
  const subject = task?.challenge?.subject ?? '';
  const description = task?.challenge?.description ?? '';
  const fileNames = (task?.files ?? []).map(file => file.path).join(' ');

  let best = null;
  for (const recipe of load()) {
    if (Boolean(recipe.precondition) !== Boolean(precondition)) continue;
    const match = recipe.match ?? {};
    let score = 0;
    for (const word of match.subject_any ?? []) if (contains(subject, word)) score += 4;
    for (const word of match.description_any ?? []) if (contains(description, word)) score += 2;
    for (const word of match.file_any ?? []) if (contains(fileNames, word)) score += 1;
    if (match.all_of && !match.all_of.every(word => contains(description, word) || contains(subject, word))) continue;
    if (score < (recipe.min_score ?? 3)) continue;
    if (!best || score > best.score) best = { recipe, score };
  }
  return best?.recipe ?? null;
}

export function listRecipes() {
  return load().map(recipe => ({ id: recipe.id, title: recipe.title ?? '', match: recipe.match ?? {} }));
}

export const recipeDir = RECIPE_DIR;
