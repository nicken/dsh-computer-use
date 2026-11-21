/**
 * 能力开关与高级工具面的单元测试（不需要真实桌面）：
 *  - 默认只暴露 computer 工具，computer_screenshot 由 advanced 开关控制；
 *  - capability 路由读写 enabled/advanced；
 *  - advanced 依赖 enabled（关闭主开关后两个 when 都为 false）。
 */
import assert from 'node:assert/strict';

const HOME = `${process.cwd()}/.capability-unit-home`;
const fs = await import('node:fs');
const path = await import('node:path');
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });
process.on('exit', () => {
  try {
    fs.rmSync(HOME, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});
process.env.DSH_HOME = HOME;

const SESSION = 'session-capability-test';
const togglesPath = path.join(HOME, 'capability-toggles.json');
const writeToggles = (record) => fs.writeFileSync(togglesPath, JSON.stringify({ version: 1, sessions: { [SESSION]: record } }));

writeToggles({ computerUse: true });

const tools = new Map();
const routes = [];
const disposers = [];
const effect = (fn) => {
  const dispose = typeof fn === 'function' ? fn() : undefined;
  if (typeof dispose === 'function') disposers.push(dispose);
  return () => {};
};
const ctx = {
  tools: {
    register(tool, options = {}) {
      tools.set(tool.name, { tool, when: options?.when });
      return () => tools.delete(tool.name);
    },
  },
  effect,
  inject(deps, callback) {
    if (deps.includes('computerUse')) return;
    callback({
      effect,
      connection: {
        fetch: {
          register(spec) {
            routes.push(spec);
            return () => {};
          },
        },
      },
    });
  },
  get() {
    return undefined;
  },
};

const plugin = await import('../index.js');
plugin.apply(ctx);

let failures = 0;
let checks = 0;
function check(label, condition, detail = '') {
  checks += 1;
  if (condition) {
    console.log(`PASS ${label}`);
    return;
  }
  failures += 1;
  console.log(`FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`);
}

const agent = { session: { id: SESSION } };
const when = (name) => {
  const entry = tools.get(name);
  if (!entry) return false;
  return typeof entry.when === 'function' ? entry.when({ agent }) : true;
};

check('computer tool is registered', tools.has('computer'));
check('computer_screenshot tool is registered (gated)', tools.has('computer_screenshot'));
check('computer is visible by default', when('computer') === true);
check('computer_screenshot is hidden by default', when('computer_screenshot') === false);

const route = routes.find((entry) => entry.path === '/api/computer-use/capability');
check('capability route is registered', Boolean(route));

const getCapability = async () => {
  const response = await route.fetch(
    new Request(`http://localhost/api/computer-use/capability?sessionId=${SESSION}`, {
      method: 'GET',
      headers: { accept: 'application/json' },
    }),
  );
  return (await response.json()).value;
};
const postCapability = async (body) => {
  const response = await route.fetch(
    new Request(`http://localhost/api/computer-use/capability?sessionId=${SESSION}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  return response;
};

const initial = await getCapability();
check('capability GET reports enabled', initial.enabled === true, JSON.stringify(initial));
check('capability GET reports advanced=false', initial.advanced === false, JSON.stringify(initial));

let posted = await postCapability({ advanced: true });
check('capability POST advanced=true succeeds', posted.status === 200);
check('advanced switch turns computer_screenshot visible', when('computer_screenshot') === true);
check('advanced keeps computer visible', when('computer') === true);

const advancedValue = await getCapability();
check('capability GET reports advanced=true', advancedValue.advanced === true, JSON.stringify(advancedValue));

posted = await postCapability({ enabled: false });
check('capability POST enabled=false succeeds', posted.status === 200);
check('disabled main switch hides computer', when('computer') === false);
check('disabled main switch hides advanced tools too', when('computer_screenshot') === false);

for (const dispose of disposers.reverse()) dispose();
fs.rmSync(HOME, { recursive: true, force: true });

console.log(`${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
