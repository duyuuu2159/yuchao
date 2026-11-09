import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entropy, fingerprint, looksLikeSecret, mask, scanText } from '../src/core/scan.ts';

// 假密钥在运行时拼接，避免源码里出现「长得像真密钥」的字符串被 GitHub 推送保护拦截
const FAKE_GH = 'gh' + 'p_' + 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5b';
const FAKE_OPENAI = 'sk' + '-proj-' + 'Zx8Kq2Lm9Np4Rt6Vw1Yb3Cd5Fg7Hj0';
const FAKE_AWS = 'AK' + 'IA' + 'Q7XK2M9P4R6T8V1W';
const PW = 'Tq8vLm2Xz9';
/** 私钥标记同样拼接：完整的私钥开头会触发 GitHub 推送保护 */
const BEGIN = (kind: string) => `-----BEGIN ${kind} PRIV` + 'ATE KEY-----';
const END = (kind: string) => `-----END ${kind} PRIV` + 'ATE KEY-----';

const ids = (text: string) => scanText(text).map((m) => m.ruleId).sort();

test('中文描述里的服务器 IP、用户名和密码，识别为服务器登录凭据', () => {
  const [m] = scanText(`我的服务器ip 203.0.113.7 用户名root 密码 ${PW} 你先连接`);
  assert.equal(m.ruleId, 'server_credential');
  assert.equal(m.severity, 'high');
  assert.equal(m.masked, 'Tq******z9');
  assert.ok(!m.context.includes(PW));
  assert.match(m.context, /203\.0\.113\.7/);
});

test('单独出现的密码是中等风险', () => {
  assert.deepEqual(ids(`数据库密码是 ${PW}`), ['password']);
  assert.deepEqual(ids(`password = "${PW}"`), ['password']);
  assert.deepEqual(ids(`密码：${PW}`), ['password']);
});

test('各类 API key 和令牌', () => {
  assert.deepEqual(ids(`export GITHUB_TOKEN=${FAKE_GH}`), ['github_token']);
  assert.deepEqual(ids(`OPENAI_API_KEY=${FAKE_OPENAI}`), ['openai_key']);
  assert.deepEqual(ids(`aws_access_key_id = ${FAKE_AWS}`), ['aws_key']);
  assert.deepEqual(ids(`${BEGIN('OPENSSH')}\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAAB`), ['private_key']);
  // 日志里转义成 \n 的私钥也能识别
  assert.deepEqual(ids(`"${BEGIN('RSA')}\\nMIIEpAIBAAKCAQEA7bq9xZk2Lw4mNp8QrTs6UvWy3Xa5Bc7De9Fg1Hj"`), ['private_key']);
});

test('命令和链接里的凭据', () => {
  assert.deepEqual(ids(`sshpass -p '${PW}' ssh root@203.0.113.7`), ['sshpass']);
  assert.deepEqual(ids(`mysql://admin:${PW}@db.example.com:3306/app`), ['url_credential']);
});

test('常见误报不报告', () => {
  for (const text of [
    'password: string;',
    'const password = process.env.DB_PASSWORD',
    'password=${PASSWORD}',
    '请输入密码 your_password',
    '密码 ********',
    'pwd = input()',
    '密码是你自己设置的那个',
    'sshpass -p "$PASS" ssh host',
    'https://user:password@example.com',
    'secret: true',
    '修改密码功能已上线',
    // 以下来自真实数据里的误报
    "[IO.File]::WriteAllText((Join-Path $PWD 'work2/page.html'), $r.Content)",
    'cat /etc/passwd root:x:0:0',
    'getent passwd |grep -v nologin',
    'I need a way to pass the password non-interactively.',
    "re.search(r'token|secret|password|authorization', k, re.I)",
    'const password = String(req.body.password || "")',
    "ssh.connect('203.0.113.7', username='root', password=os.environ['SSH_PASS'])",
    "$env:OWNER_PASSWORD = 'x'\\n$env:AI_KEY = 'test-key'",
    "password='test-admin-123'",
    'sshpass -p xxx」「中文说明',
    `KEY_HEADER=${BEGIN('OPENSSH')}`,
  ]) {
    assert.deepEqual(scanText(text), [], text);
  }
});

test('同一段文本里同一个秘密只报告一次，取最高风险', () => {
  const ms = scanText(`sshpass -p '${PW}' ssh root@203.0.113.7 # 密码 ${PW}`);
  assert.equal(ms.length, 1);
  assert.equal(ms[0].severity, 'high');
});

test('上下文里的其他秘密也会被打码', () => {
  const text = `password=${PW} token ${FAKE_GH}`;
  for (const m of scanText(text)) {
    assert.ok(!m.context.includes(PW), m.context);
    assert.ok(!m.context.includes(FAKE_GH), m.context);
  }
});

test('多行私钥的整段正文都会被打码，上下文里不出现任何一行', () => {
  const lines = ['b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAAB', 'QyNTUxOQAAACAQzFw2hR2DuMHeGGtAXbztO0Pq0KrS8AomG9x', 'AAAEA7kd93LmQp2Zx8Vb4Nc6Rt1Yw0Hs5Jf3Gu7Ki9Lo2Mn4P'];
  for (const sep of ['\n', '\\n', '\r\n']) {
    const text = `cat id_ed25519\n${BEGIN('OPENSSH')}${sep}${lines.join(sep)}${sep}${END('OPENSSH')}`;
    const [m] = scanText(text);
    assert.equal(m.ruleId, 'private_key');
    for (const line of lines) assert.ok(!m.context.includes(line.slice(4, 20)), `${JSON.stringify(sep)}: ${m.context}`);
  }
});

test('被日志截断的片段不当作密码', () => {
  assert.deepEqual(scanText("connect('203.0.113.7', username='root', password=o…12345 chars truncated…"), []);
});

test('截取范围不会把相邻的秘密切成两半', () => {
  const text = `${FAKE_GH}${' '.repeat(10)}密码 ${PW}`;
  const m = scanText(text, 5).find((x) => x.ruleId === 'password')!;
  assert.ok(!m.context.includes(FAKE_GH.slice(-12)), m.context);
});

test('指纹稳定且不可逆，打码保留首尾', () => {
  assert.equal(fingerprint(PW), fingerprint(PW));
  assert.notEqual(fingerprint(PW), fingerprint(PW + 'x'));
  assert.equal(fingerprint(PW).length, 16);
  assert.ok(!fingerprint(PW).includes(PW));
  assert.equal(mask('abcdefghij'), 'ab******ij');
  assert.equal(mask('abc123'), 'a*****');
});

test('信息熵和疑似秘密判断', () => {
  assert.equal(entropy('aaaa'), 0);
  assert.ok(entropy('Tq8vLm2Xz9') > 3);
  assert.equal(looksLikeSecret('password'), false);
  assert.equal(looksLikeSecret('hello_world'), false);
  assert.equal(looksLikeSecret(PW), true);
});
