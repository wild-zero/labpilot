// mock 上游：内置夹具平台，无需真实头歌账号即可跑通完整流水线。
// 行为刻意贴近真实平台的几个坑：进度计数滞后、判定需要二次读取、首次提交可能不通过。
import { createHash } from 'node:crypto';

const digest = (value) => createHash('sha1').update(String(value)).digest('hex');

// ---------- 夹具定义 ----------
const KINDS = ['choice', 'code'];

function challenge({ id, name, kind, position, answer, files = [], flaky = false }) {
  return { id, name, kind, position, answer, files, flaky };
}

const FIXTURES = [
  {
    identifier: 'cls-ds-2026',
    name: '数据结构与算法（2026 秋）',
    membersCount: 128,
    ended: false,
    homeworks: [
      {
        id: 101,
        name: '第 1 章 线性表',
        deadline: '2026-12-20 23:59:59',
        challenges: [
          challenge({ id: 1011, name: '顺序表的插入', kind: 'choice', position: 1, answer: ['B', 'C'] }),
          challenge({
            id: 1012, name: '实现单链表反转', kind: 'code', position: 2, files: [{
              path: 'src/step2/LinkList.java',
              content: 'public class LinkList {\n    public Node reverse(Node head) {\n        // TODO\n        return head;\n    }\n}\n',
            }],
          }),
          challenge({
            id: 1013, name: '删除倒数第 N 个结点', kind: 'code', position: 3, flaky: true, files: [{
              path: 'src/step3/RemoveNth.java',
              content: 'public class RemoveNth {\n    public Node remove(Node head, int n) {\n        // TODO\n        return head;\n    }\n}\n',
            }],
          }),
        ],
      },
      {
        id: 102,
        name: '第 2 章 栈与队列',
        deadline: '2026-12-27 23:59:59',
        challenges: [
          challenge({ id: 1021, name: '栈的基本概念', kind: 'choice', position: 1, answer: ['A', 'D'] }),
          challenge({
            id: 1022, name: '用两个栈实现队列', kind: 'code', position: 2, files: [{
              path: 'src/step2/MyQueue.java',
              content: 'public class MyQueue {\n    public void push(int x) {\n        // TODO\n    }\n}\n',
            }],
          }),
        ],
      },
    ],
    exercises: [
      { id: 9001, name: '数据结构 期中在线测试', totalQuestions: 20, available: true, actionRequired: false },
    ],
  },
  {
    identifier: 'cls-os-2026',
    name: '操作系统原理',
    membersCount: 96,
    ended: false,
    homeworks: [
      {
        id: 201,
        name: '进程与线程',
        deadline: '2026-12-15 23:59:59',
        challenges: [
          challenge({ id: 2011, name: '进程状态转换', kind: 'choice', position: 1, answer: ['C'] }),
          challenge({
            id: 2012, name: '实现生产者消费者', kind: 'code', position: 2, files: [{
              path: 'src/step2/ProducerConsumer.java',
              content: 'public class ProducerConsumer {\n    public void run() {\n        // TODO\n    }\n}\n',
            }],
          }),
        ],
      },
    ],
    exercises: [
      { id: 9101, name: '操作系统 单元测验', totalQuestions: 15, available: true, actionRequired: false },
      { id: 9102, name: '操作系统 期末考试', totalQuestions: 40, available: false, actionRequired: true, reasonCode: 'proctoring_required' },
    ],
  },
];

// ---------- 可变状态：按账号隔离 ----------
// login -> { games: Map<gameId, {status, score, accuracy, evaluateCount, compileOutput}>, commits: Map }
const WORLD = new Map();

function worldOf(login) {
  if (!WORLD.has(login)) WORLD.set(login, { games: new Map(), commits: new Map(), seq: 1 });
  return WORLD.get(login);
}

function courseById(identifier) {
  return FIXTURES.find(course => course.identifier === identifier) ?? null;
}

function homeworkById(course, homeworkId) {
  return course?.homeworks.find(homework => homework.id === Number(homeworkId)) ?? null;
}

function challengeById(course, gameId) {
  for (const homework of course.homeworks) {
    const found = homework.challenges.find(item => item.id === Number(gameId));
    if (found) return { homework, challenge: found };
  }
  return null;
}

function requirementOf(homework) {
  return homework.challenges.length;
}

function finishedIn(world, homework) {
  return homework.challenges.filter(item => world.games.get(item.id)?.status === 2).length;
}

// 真实平台：选择题在提交响应里回吐答案键（这也是「零 token 做题」的基础）
function answerKeyOf(challenge) {
  return challenge.kind === 'choice' ? challenge.answer : undefined;
}

export function createMockUpstream() {
  return {
    name: 'mock',

    async login(login, password) {
      if (!login || !password) throw new Error('缺少账号或密码');
      if (String(password).length < 4) throw new Error('密码不正确');
      const world = worldOf(login);
      world.user = { id: `mock-${digest(login).slice(0, 8)}`, name: login.split('@')[0], avatarUrl: '' };
      return { cookie: `mock-session-${digest(login).slice(0, 12)}`, uid: world.user.id, user: world.user };
    },

    async courses() {
      return FIXTURES.map(course => ({
        identifier: course.identifier,
        name: course.name,
        homeworkCount: course.homeworks.length,
        membersCount: course.membersCount,
        ended: course.ended,
      }));
    },

    async homeworks(cookie, login, courseIdentifier) {
      const course = courseById(courseIdentifier);
      if (!course) throw new Error('课程不存在');
      const world = worldOf(login);
      return course.homeworks.map(homework => {
        const total = requirementOf(homework);
        const done = finishedIn(world, homework);
        return {
          id: homework.id,
          name: homework.name,
          status: done >= total ? 'completed' : 'ongoing',
          challengeCount: total,
          finishedChallengeCount: done,
          requiredChallengeCount: total,
          finishedRequiredChallengeCount: done,
          // 真实平台这个计数会滞后，这里保留 completed 标记用于演示跳过逻辑
          requiredProgressKnown: true,
          deadline: homework.deadline,
          canEnter: true,
        };
      });
    },

    async exercises(cookie, login, courseIdentifier) {
      const course = courseById(courseIdentifier);
      if (!course) throw new Error('课程不存在');
      const world = worldOf(login);
      return course.exercises.map(exercise => {
        const state = world.games.get(`exam-${exercise.id}`);
        return {
          id: exercise.id,
          name: exercise.name,
          status: state?.status === 2 ? 'submitted' : 'pending',
          submitted: state?.status === 2,
          scoreKnown: Boolean(state?.scoreKnown),
          score: state?.score,
          maxScore: 100,
          totalQuestions: exercise.totalQuestions,
          deadline: '2026-12-31 23:59:59',
          available: exercise.available,
          actionRequired: exercise.actionRequired,
          reasonCode: exercise.reasonCode,
        };
      });
    },

    async enter(cookie, login, courseIdentifier, homeworkId) {
      const course = courseById(courseIdentifier);
      const homework = homeworkById(course, homeworkId);
      if (!homework) throw new Error('作业不存在');
      const world = worldOf(login);
      // entry_game_id 返回「上次访问」，需要 prev_game 回卷到第一关
      const first = homework.challenges[0];
      return {
        kind: first.kind,
        homeworkId: homework.id,
        gameCount: homework.challenges.length,
        gameIdentifier: String(first.id),
        challenge: {
          id: first.id,
          subject: first.name,
          position: first.position,
          path: first.files[0]?.path,
        },
        game: { id: first.id, status: world.games.get(first.id)?.status ?? 0 },
        myshixunIdentifier: `mys-${homework.id}`,
        nextGame: null,
        requiredStatus: 'ongoing',
      };
    },

    async task(cookie, login, gameId) {
      let found = null;
      for (const course of FIXTURES) {
        const hit = challengeById(course, gameId);
        if (hit) { found = hit; break; }
      }
      if (!found) throw new Error('关卡不存在');
      const { homework, challenge } = found;
      const world = worldOf(login);
      const state = world.games.get(challenge.id) ?? { status: 0, evaluateCount: 0, accuracy: null, score: null };
      const index = homework.challenges.indexOf(challenge);
      const next = homework.challenges[index + 1] ?? null;
      const prev = homework.challenges[index - 1] ?? null;
      return {
        challenge: {
          id: challenge.id,
          name: challenge.name,
          kind: challenge.kind,
          subject: `${homework.name} · ${challenge.name}`,
          description: challenge.kind === 'code'
            ? `请补全 ${challenge.files[0]?.path ?? '源码'}，通过全部评测用例。`
            : `${challenge.name}：请选择正确的选项，多选题按顺序作答。`,
          position: challenge.position,
          path: challenge.files[0]?.path,
          // 夹具专用：让 mock 求解器知道正确答案
          __answer: challenge.answer,
          __flaky: Boolean(challenge.flaky),
        },
        game: {
          id: challenge.id,
          identifier: String(challenge.id),
          status: state.status,
          final_score: state.score,
          accuracy: state.accuracy,
          evaluate_count: state.evaluateCount,
        },
        myshixun: {
          identifier: `mys-${homework.id}`,
          commitId: world.commits.get(challenge.id) ?? null,
        },
        files: challenge.files.map(file => ({
          path: file.path,
          content: world.commits.get(`${challenge.id}:${file.path}`) ?? file.content,
        })),
        nextGame: next ? String(next.id) : null,
        prevGame: prev ? String(prev.id) : null,
        testSets: state.evaluateCount ? [{ result: state.status === 2 ? 'pass' : 'fail' }] : null,
      };
    },

    async saveFile(cookie, login, { gameId, path, content }) {
      const world = worldOf(login);
      const key = String(gameId);
      world.commits.set(`${key}:${path}`, content);
      const commitId = (world.commits.get(key) ?? 0) + 1;
      world.commits.set(key, commitId);
      return { commitID: commitId };
    },

    async build(cookie, login, { gameId }) {
      const world = worldOf(login);
      const key = String(gameId);
      const state = world.games.get(key) ?? { status: 0, evaluateCount: 0 };
      state.evaluateCount += 1;
      world.games.set(key, state);
      return { status: 0, evaluate_count: state.evaluateCount };
    },

    async choose(cookie, login, { gameId, answer }) {
      const world = worldOf(login);
      const key = String(gameId);
      const state = world.games.get(key) ?? { status: 0, evaluateCount: 0 };
      state.evaluateCount += 1;
      state.answer = answer;
      world.games.set(key, state);
      let standard = null;
      for (const course of FIXTURES) {
        const hit = challengeById(course, gameId);
        if (hit) { standard = answerKeyOf(hit.challenge); break; }
      }
      // 平台在提交响应里回吐答案键
      return { status: 0, standard_answer: standard };
    },

    async verdict(cookie, login, rawGameId) {
      const gameId = String(rawGameId);
      let found = null;
      for (const course of FIXTURES) {
        const hit = challengeById(course, gameId);
        if (hit) { found = hit; break; }
      }
      if (!found) throw new Error('关卡不存在');
      const { challenge } = found;
      const world = worldOf(login);
      const state = world.games.get(gameId) ?? { status: 0, evaluateCount: 0, accuracy: null };
      const correct = (() => {
        if (!state.evaluateCount) return false;
        if (challenge.kind === 'choice') {
          const expected = challenge.answer.join('');
          const actual = Array.isArray(state.answer) ? state.answer.join('') : String(state.answer ?? '');
          return expected === actual;
        }
        const content = world.commits.get(`${gameId}:${challenge.files[0]?.path}`) ?? '';
        if (!content.includes('// SOLVED')) return false;
        // 故意让 flaky 关卡第一次判负，演示 repairing
        if (challenge.flaky && state.evaluateCount < 2) return false;
        return true;
      })();
      state.status = correct ? 2 : 1;
      state.accuracy = correct ? 100 : 40;
      state.score = correct ? 100 : 40;
      world.games.set(gameId, state);
      return {
        finished: correct,
        status: state.status,
        final_score: state.score,
        accuracy: state.accuracy,
        evaluate_count: state.evaluateCount,
        compile_output: correct ? 'compile successfully' : 'error: test case 2 failed',
        testSets: state.evaluateCount ? [{ result: correct ? 'pass' : 'fail' }] : null,
      };
    },

    async submitExercise(cookie, login, { courseIdentifier, exerciseId }) {
      const world = worldOf(login);
      world.games.set(`exam-${exerciseId}`, { status: 2, score: 88, scoreKnown: false, submittedAt: Date.now() });
      void courseIdentifier;
      return { submitted: true, totalQuestions: 20 };
    },
  };
}

export const mockFixtures = FIXTURES;
