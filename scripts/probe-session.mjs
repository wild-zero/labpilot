// 用库里已存的（加密）头歌会话直接打平台接口，打印原始返回。只读，不写数据。
//
// 用法：
//   node scripts/probe-session.mjs                    # 取最近登录的用户，全部探测
//   node scripts/probe-session.mjs <login>            # 指定账号
//   node scripts/probe-session.mjs <login> homeworks  # 只看一组：homeworks|exercises|enter|task
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../server/config.mjs';
import { open as openSealed } from '../server/crypto.mjs';

const login = process.argv[2] ?? '';
const only = process.argv[3] ?? '';
const nameFilter = process.argv[4] ?? '';

const db = new DatabaseSync(config.dbFile);
const row = login
  ? db.prepare('SELECT * FROM users WHERE login = ?').get(login)
  : db.prepare('SELECT * FROM users WHERE upstream_cookie IS NOT NULL ORDER BY upstream_seen DESC LIMIT 1').get();

if (!row) {
  console.error('库里没有带会话的用户，先在页面上用真实账号登录一次。');
  process.exit(1);
}

let session = null;
try { session = JSON.parse(openSealed(row.upstream_cookie) ?? 'null'); } catch { session = null; }
if (!session?.cookie) {
  console.error(`用户 ${row.login} 没有可用的头歌会话（可能已失效）。重新登录一次。`);
  process.exit(1);
}

console.log(`账号: ${row.login}  uid=${session.uid || '-'}  zzud=${session.zzud || '(空)'}`);

const base = config.educoder.base.replace(/\/$/, '');
const md5hex = (buf) => createHash('md5').update(buf).digest('hex');

async function api(path, { method = 'GET', body, limit = 1200 } = {}) {
  const ts = Date.now();
  const raw = `method=${method.toUpperCase()}&ak=${config.educoder.ak}&sk=${config.educoder.sk}&time=${ts}`;
  const signature = md5hex(Buffer.from(raw, 'utf8').toString('base64'));
  const headers = {
    Accept: 'application/json',
    'X-EDU-Type': 'pc',
    'X-EDU-Timestamp': String(ts),
    'X-EDU-Signature': signature,
    'Pc-Authorization': session.cookie,
    Cookie: `autologin_trustie=${session.trustie ?? ''}; _educoder_session=${session.cookie}`,
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const started = Date.now();
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  }).catch((error) => ({ _error: error.message }));
  if (response._error) {
    console.log(`\n[${method}] ${path}\n  ✗ ${response._error}`);
    return null;
  }
  const text = await response.text();
  console.log(`\n[${method}] ${path}\n  HTTP ${response.status}  ${Date.now() - started}ms  ${text.length}B`);
  console.log('  ' + text.slice(0, limit).replace(/\n/g, '\n  '));
  try { return JSON.parse(text); } catch { return null; }
}

const want = (name) => !only || only === name || only === 'adapter';

// ---------- 课程与作业 ----------
const coursesBody = await api('/courses.json?page=1&limit=100&order=mine&search=&zzud=', { limit: 300 });
const courses = coursesBody?.courses ?? [];
if (!courses.length) { console.log('没有课程'); process.exit(0); }

let picked = null;
for (const course of courses) {
  if (nameFilter && !String(course.name).includes(nameFilter)) continue;
  const cid = course.identifier ?? course.id;
  const body = await api(`/courses/${cid}/homework_commons/list.json?limit=200&zzud=`, { limit: 200 });
  const homeworks = body?.homeworks ?? body?.homework_commons ?? [];
  if (homeworks.length) { picked = { course, cid, homeworks, listBody: body }; break; }
}

if (!picked) { console.log('\n所有课程都没有作业。'); process.exit(0); }

const { course, cid, homeworks } = picked;
console.log(`\n样本课程：${course.name} (identifier=${course.identifier}, id=${course.id})  作业 ${homeworks.length} 份`);

if (want('homeworks')) {
  const shape = homeworks.slice(0, 3).map(item => ({
    homework_id: item.homework_id,
    id: item.id,
    name: item.name,
    status: item.status,
    shixun_identifier: item.shixun_identifier,
    myshixun_identifier: item.myshixun_identifier,
    challenge_count: item.challenge_count,
    checked_challenge_count: item.checked_challenge_count,
    finished_challenge_count: item.finished_challenge_count,
    shixun_finished_status: item.shixun_finished_status,
    is_enter_shixun: item.is_enter_shixun,
    end_time: item.end_time,
    time_status: item.time_status,
    can_submit: item.can_submit,
    submit_num: item.submit_num,
  }));
  console.log('\n########## 作业字段样本 ##########');
  console.log(JSON.stringify(shape, null, 2));
}

// ---------- 在线考试 ----------
if (want('exercises')) {
  console.log('\n########## 在线考试 ##########');
  for (const path of [
    `/v2/courses/${cid}/exercises.json?limit=100&zzud=`,
    `/courses/${cid}/exercises.json?limit=100&zzud=`,
    `/exercises/get_user_exercises.json?course_id=${course.id}&limit=100&zzud=`,
  ]) {
    await api(path, { limit: 1200 });
  }
}

// ---------- 进入实训 ----------
const target = homeworks.find(item => item.shixun_identifier && item.is_enter_shixun !== false) ?? homeworks[0];
if (!target?.shixun_identifier) {
  console.log('\n没有可进入的实训作业。');
  process.exit(0);
}

if (want('enter')) {
  console.log(`\n########## 进入实训：${target.name} ##########`);
  await api(`/shixuns/${target.shixun_identifier}/shixun_exec.json?homework_common_id=${target.homework_id}&zzud=`, { limit: 2500 });
}

// ---------- 关卡详情 ----------
if (want('task')) {
  console.log('\n########## 关卡详情 ##########');
  // 先拿到 entry game id
  const entry = await api(`/shixuns/${target.shixun_identifier}/shixun_exec.json?homework_common_id=${target.homework_id}&zzud=`, { limit: 4000 });
  const gid = entry?.game_identifier ?? entry?.entry_game_id ?? entry?.game_id ?? entry?.game?.id ?? entry?.current_game_id;
  console.log('\n  entry game id =', gid ?? '(未识别)');
  if (gid) {
    const task = await api(`/tasks/${gid}.json?homework_common_id=${target.homework_id}&zzud=`, { limit: 400 });
    if (task) {
      console.log('\n  —— 结构（键 -> 值预览）——');
      for (const [key, value] of Object.entries(task)) {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          console.log(`  ${key}: {`);
          for (const [k2, v2] of Object.entries(value)) {
            const preview = typeof v2 === 'string' ? `${JSON.stringify(v2.slice(0, 60))}${v2.length > 60 ? '…' : ''}` : JSON.stringify(v2);
            console.log(`      ${k2}: ${preview}`);
          }
          console.log('  }');
        } else {
          console.log(`  ${key}: ${JSON.stringify(value)?.slice(0, 80)}`);
        }
      }
    }
  }
  console.log('\n  entry 顶层字段：', Object.keys(entry ?? {}).join(', '));
}

// ---------- 走我们自己的适配器 ----------
if (only === 'adapter' || !only) {
  console.log('\n########## 适配器归一化结果 ##########');
  const { createEduCoderUpstream } = await import('../server/upstream/educoder.mjs');
  const up = createEduCoderUpstream();
  const normalized = await up.courses(session);
  console.log(`courses: ${normalized.length} 门`);
  const target = (nameFilter && normalized.find(c => String(c.name).includes(nameFilter))) || normalized[0];
  console.log('选中课程:', target.name, target.identifier);
  const hws = await up.homeworks(session, row.login, target.identifier);
  console.log(`homeworks: ${hws.length} 份`);
  console.log(JSON.stringify(hws.slice(0, 3), null, 2));
  const live = hws.find(h => h.shixunIdentifier && !h.expired);
  if (live) {
    console.log(`\nenter: ${live.name} (id=${live.id})`);
    const entry = await up.enter(session, row.login, target.identifier, live.id);
    console.log(JSON.stringify(entry, null, 2));
    const task = await up.task(session, entry.gameIdentifier, live.id);
    console.log('\ntask:');
    console.log(JSON.stringify({
      challenge: { ...task.challenge, description: `${(task.challenge.description ?? '').slice(0, 60)}…` },
      game: task.game,
      myshixun: task.myshixun,
      files: task.files.map(f => ({ path: f.path, bytes: f.content.length })),
      prevGame: task.prevGame,
      nextGame: task.nextGame,
      gameCount: task.gameCount,
    }, null, 2));
  } else {
    console.log('没有可进入且未截止的作业');
  }
}

// ---------- 代码文件读取 ----------
if (only === 'content') {
  const cid2 = course.identifier ?? course.id;
  const listBody = await api(`/courses/${cid2}/homework_commons/list.json?limit=200&zzud=`, { limit: 150 });
  const hw = (listBody?.homeworks ?? []).find(item => item.shixun_identifier && item.is_enter_shixun !== false);
  const entryBody = await api(`/shixuns/${hw.shixun_identifier}/shixun_exec.json?homework_common_id=${hw.homework_id}&zzud=`, { limit: 200 });
  const gid = entryBody?.game_identifier;
  const taskBody = await api(`/tasks/${gid}.json?homework_common_id=${hw.homework_id}&zzud=`, { limit: 200 });
  const path = taskBody?.challenge?.path;
  console.log('\n  path =', path);
  const raw = await api(`/tasks/${gid}/rep_content.json?path=${encodeURIComponent(path)}&homework_common_id=${hw.homework_id}&exercise_id=&zzud=`, { limit: 4000 });
  console.log('\n  rep_content 顶层键：', Object.keys(raw ?? {}).join(', '));
  console.log('  content 类型：', typeof raw?.content, Array.isArray(raw?.content) ? '(array)' : '');
  if (raw?.content && typeof raw.content === 'object') {
    for (const [k, v] of Object.entries(raw.content)) {
      console.log(`    content.${k}: ${typeof v === 'string' ? JSON.stringify(v.slice(0, 120)) : JSON.stringify(v)?.slice(0, 120)}`);
    }
  }
}
