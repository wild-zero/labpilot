// 真实头歌账号连通性诊断：登录 → 课程 → 作业 → 考试 → 进入实训读关卡。
// 只读，不保存、不提交任何东西。
//
// 用法：
//   node scripts/probe-upstream.mjs <头歌账号> <头歌密码>
// 或
//   EDUCODER_LOGIN=... EDUCODER_PASSWORD=... node scripts/probe-upstream.mjs
import { createEduCoderUpstream } from '../server/upstream/educoder.mjs';
import { config } from '../server/config.mjs';

const login = process.argv[2] ?? process.env.EDUCODER_LOGIN ?? '';
const password = process.argv[3] ?? process.env.EDUCODER_PASSWORD ?? '';

if (!login || !password) {
  console.error('需要账号和密码：node scripts/probe-upstream.mjs <login> <password>');
  process.exit(2);
}

const up = createEduCoderUpstream();
const step = (name) => console.log(`\n=== ${name} ===`);
const preview = (value, limit = 900) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return text.length > limit ? `${text.slice(0, limit)}\n…（共 ${text.length} 字符）` : text;
};
const fail = (error) => {
  console.error('失败：', error.code ?? '', error.message ?? error);
  process.exitCode = 1;
};

step('签名自检（错误账号应返回 -3 而不是 -102）');
try {
  await up.login('probe_not_exist_9527@example.com', 'definitely-wrong-pass');
  console.log('意外的成功？平台没有拒绝错误账号');
} catch (error) {
  if (error.code === 'AUTH_FAILED') console.log('签名有效（平台返回账号密码错误，说明请求被接受）');
  else if (error.code === 'UPSTREAM_SIGNATURE_REJECTED') console.log('签名被拒绝 —— 重跑 node scripts/extract-aksk.mjs');
  else console.log('未归类的失败：', error.code, error.message);
}

step('登录');
let session;
try {
  session = await up.login(login, password);
  console.log(preview({
    uid: session.uid,
    zzud: session.zzud || '(空，稍后从当前用户接口兜底读取)',
    name: session.user?.name,
    cookieLength: session.cookie?.length,
    trustie: Boolean(session.trustie),
  }));
} catch (error) {
  fail(error);
  process.exit(1);
}

const cookie = {
  cookie: session.cookie,
  trustie: session.trustie ?? '',
  zzud: session.zzud ?? '',
  uid: session.uid ?? '',
};

step('我的课程');
let courses = [];
try {
  courses = await up.courses(cookie);
  console.log(`共 ${courses.length} 门`);
  console.log(preview(courses));
} catch (error) {
  fail(error);
  process.exit(1);
}

if (!courses.length) {
  console.log('\n课程为空：账号确实没有加入课堂，或者 zzud 没取到。');
  process.exit(0);
}

const course = courses[0];
step(`作业列表：${course.name} (${course.identifier})`);
let homeworks = [];
try {
  homeworks = await up.homeworks(cookie, login, course.identifier);
  console.log(preview(homeworks));
} catch (error) {
  fail(error);
}

step(`在线考试：${course.name}`);
try {
  const exercises = await up.exercises(cookie, login, course.identifier);
  console.log(preview(exercises));
} catch (error) {
  fail(error);
}

const target = homeworks.find(homework => homework.shixunIdentifier) ?? homeworks[0];
if (!target) {
  console.log('\n没有可进入的作业，诊断到此为止。');
  process.exit(0);
}

step(`进入实训：${target.name} (id=${target.id})`);
let entry = null;
try {
  entry = await up.enter(cookie, login, course.identifier, target.id);
  console.log(preview(entry));
} catch (error) {
  fail(error);
}

if (entry?.gameIdentifier) {
  step(`读取关卡：${entry.gameIdentifier}`);
  try {
    const task = await up.task(cookie, entry.gameIdentifier, target.id);
    console.log(preview({
      challenge: { ...task.challenge, description: `${(task.challenge.description ?? '').slice(0, 200)}…` },
      game: task.game,
      myshixun: task.myshixun,
      files: (task.files ?? []).map(file => ({ path: file.path, bytes: file.content?.length ?? 0 })),
      prevGame: task.prevGame,
      nextGame: task.nextGame,
    }));
  } catch (error) {
    fail(error);
  }
}

console.log(`\n上游：${config.educoder.base}`);
console.log(process.exitCode ? '诊断结束：有问题需要处理' : '诊断结束：链路通');
