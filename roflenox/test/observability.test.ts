// Fleet observability (r_uc_observability): hosts publish facts about
// themselves as signed feeds; a reader mirrors them and derives the fleet's
// invariants with its own rules; why explains each finding; a feed that has
// gone silent is an unknown in the answer, never an all-clear. The hosts and
// their facts are the four findings of 2026-09-26 (spec/enox.rofl.md,
// "Находки по хостам") with neutral names — synthetic, no real host data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mirror, publish } from '../src/client.ts';
import type { Fact } from '../src/facts.ts';
import { DAY, exportRule, grant, iso, post, serveAsIs, start, T0, tmpDir, type Running } from './helpers.ts';

const f = (source: string, relation: string, target: string): Fact => ({ source, relation, target, perspective: 'host-report', confidence: 1 });
const rule = (name: string, text: string): Fact => ({ source: name, relation: 'roflenox:rule', target: text, perspective: 'fleet', confidence: 1 });

/** What each host says about itself. */
const REPORTS: Record<string, Fact[]> = {
  // 1 and 2: a daemon outside its unit; contradictory kernel settings.
  'proxy-host': [
    f('proxy-host', 'host_role', 'proxy'),
    f('unit:vpn-userspace@wg0', 'unit_enabled', 'true'), f('unit:vpn-userspace@wg0', 'unit_active', 'false'),
    f('proc:wg-userspace', 'process_unit', 'unit:vpn-userspace@wg0'), f('proc:wg-userspace', 'cgroup_slice', 'user.slice'),
    f('sysctl:60-cloud-network.conf#net.ipv4.ip_forward', 'sysctl_key', 'net.ipv4.ip_forward'),
    f('sysctl:60-cloud-network.conf#net.ipv4.ip_forward', 'sysctl_value', '0'),
    f('sysctl:99-sysctl.conf#net.ipv4.ip_forward', 'sysctl_key', 'net.ipv4.ip_forward'),
    f('sysctl:99-sysctl.conf#net.ipv4.ip_forward', 'sysctl_value', '1'),
    f('sysctl:effective#net.ipv4.ip_forward', 'sysctl_effective', '1'),
  ],
  // 3: a crash loop — 592 restarts in 14 days, all OOM kills.
  'old-node-host': [
    f('old-node-host', 'host_role', 'app'),
    f('container:node-app', 'restarts', '592'), f('container:node-app', 'restart_window_days', '14'), f('container:node-app', 'oom_kills', '592'),
  ],
  // 4: production load on a development host.
  'dev-host': [
    f('dev-host', 'host_role', 'dev'),
    f('pod:x-prod/api', 'namespace', 'x-prod'), f('pod:x-prod/api', 'env_label', 'prod'),
  ],
  // Control: the same kinds of facts, no violation.
  'clean-host': [
    f('clean-host', 'host_role', 'prod'),
    f('unit:web@main', 'unit_enabled', 'true'), f('unit:web@main', 'unit_active', 'true'),
    f('proc:web', 'process_unit', 'unit:web@main'), f('proc:web', 'cgroup_slice', 'system.slice'),
    f('sysctl:60-a.conf#vm.swappiness', 'sysctl_key', 'vm.swappiness'), f('sysctl:60-a.conf#vm.swappiness', 'sysctl_value', '10'),
    f('sysctl:99-b.conf#vm.swappiness', 'sysctl_key', 'vm.swappiness'), f('sysctl:99-b.conf#vm.swappiness', 'sysctl_value', '10'),
    f('container:web', 'restarts', '2'), f('container:web', 'restart_window_days', '14'),
    f('pod:prod/web', 'namespace', 'prod'), f('pod:prod/web', 'env_label', 'prod'),
  ],
  // Reported once, long ago, and then nothing: its violation would be here
  // if it spoke, but its silence must not read as fine.
  'stale-host': [f('stale-host', 'host_role', 'dev')],
};

/** The fleet invariants, written ONCE as rules in the reader's book. Each
 *  ranges over every feed the reader follows: `follows(H, B)` (derived from
 *  its roflenox:follow facts) binds the host and its book, and `edge[B]`
 *  reads that book — under the reader's may_read, like any foreign literal. */
const FLEET: Fact[] = [
  rule('daemon-slice', 'finding(H, "daemon_outside_unit", P) :- follows(H, B), edge[B](F1, P, "process_unit", U), edge[B](F2, P, "cgroup_slice", S), S != "system.slice".'),
  rule('daemon-active', 'finding(H, "daemon_outside_unit", P) :- follows(H, B), edge[B](F1, P, "process_unit", U), edge[B](F2, U, "unit_active", "false").'),
  rule('sysctl', 'finding(H, "sysctl_conflict", K) :- follows(H, B), edge[B](F1, A, "sysctl_key", K), edge[B](F2, C, "sysctl_key", K), edge[B](F3, A, "sysctl_value", V1), edge[B](F4, C, "sysctl_value", V2), V1 != V2.'),
  rule('restarts', 'finding(H, "crash_loop", C) :- follows(H, B), edge_num[B](F1, C, "restarts", R), edge_num[B](F2, C, "restart_window_days", D), R > 3 * D.'),
  rule('prod', 'finding(H, "prod_on_non_prod", P) :- follows(H, B), edge[B](F1, P, "env_label", "prod"), edge[B](F2, X, "host_role", Role), Role != "prod".'),
];

type Answer = { rows: { identity: string; cells: string[] }[]; unknown?: { identity: string; reason: string; window?: number; last_report?: string | null }[] };
const findings = async (ops: Running): Promise<Answer> => (await post(ops.url, '/ask', { query: 'finding(H, K, S)' })).body as unknown as Answer;

/** Start the hosts, each reporting about itself and granting "ops" its book. */
async function hostsReporting(names: string[]): Promise<Record<string, Running>> {
  const hosts: Record<string, Running> = {};
  for (const name of names) {
    const h = hosts[name] = await start(tmpDir(`fleet-${name}`), name);
    await publish(h.url, h.me, [exportRule('*', 'public'), grant('ops', iso(T0 + 30 * DAY)), ...REPORTS[name]!], () => h.clock.t);
  }
  return hosts;
}

test('rules over host feeds rediscover the four host findings of 2026-09-26 and explain each with why', async () => {
  const LATER = 20 * 60_000;                                   // the stale host last spoke 20 min before the others
  const ops = await start(tmpDir('fleet-ops'), 'ops', { silenceSec: 600 });
  const hosts = await hostsReporting(Object.keys(REPORTS));
  try {
    // Everyone but the stale host speaks again, later; the clocks move on.
    for (const r of [ops, ...Object.values(hosts)]) r.clock.t = T0 + LATER;
    for (const [name, h] of Object.entries(hosts)) {
      if (name !== 'stale-host') await publish(h.url, h.me, [f(name, 'reported_at', String(Math.floor(h.clock.t / 1000)))], () => h.clock.t);
    }

    // The reader follows the fleet — quiet-host included, which never says a
    // thing — mirrors what there is, and holds the invariants as its rules.
    const fleet = [...Object.keys(hosts), 'quiet-host'];
    await publish(ops.url, ops.me, [
      ...fleet.map((n) => f(n, 'roflenox:follow', hosts[n]?.url ?? 'http://127.0.0.1:9/quiet-host')),
      ...FLEET,
    ], () => ops.clock.t);
    for (const [name, h] of Object.entries(hosts)) await mirror(ops.url, h.url, name, ops.me, () => ops.clock.t);

    const ans = await findings(ops);
    // The four findings, and nothing about the clean host.
    assert.deepEqual(ans.rows.map((r) => r.cells).sort(), [
      ['dev-host', 'prod_on_non_prod', 'pod:x-prod/api'],
      ['old-node-host', 'crash_loop', 'container:node-app'],
      ['proxy-host', 'daemon_outside_unit', 'proc:wg-userspace'],
      ['proxy-host', 'sysctl_conflict', 'net.ipv4.ip_forward'],
    ]);
    assert.ok(ans.rows.every((r) => r.identity === 'ops'), 'findings are the reader\'s own conclusions');
    // A silent feed is an unknown, never an all-clear: the stale host (last
    // report 20 min ago, window 10 min) and the one that never reported.
    assert.deepEqual((ans.unknown ?? []).map((u) => [u.identity, u.reason.split(':')[0], u.window]).sort(),
      [['quiet-host', 'silent_feed', 600], ['stale-host', 'silent_feed', 600]]);
    assert.equal(ans.unknown!.find((u) => u.identity === 'stale-host')!.last_report, iso(T0));
    assert.equal(ans.unknown!.find((u) => u.identity === 'quiet-host')!.last_report, null);

    // why explains each finding down to the host's own reported facts.
    const why = async (lit: string) => {
      const all = (await post(ops.url, '/op/why', { literal: lit })).body as unknown as { identity: string; holds: boolean; text: string }[];
      const w = all.filter((x) => x.holds);
      assert.equal(w.length, 1, `${lit}: ${JSON.stringify(all)}`);
      return w[0]!.text;
    };
    const daemon = await why('finding("proxy-host", "daemon_outside_unit", "proc:wg-userspace")');
    assert.match(daemon, /"proc:wg-userspace","process_unit","unit:vpn-userspace@wg0"\) \[axiom\]/);
    assert.match(daemon, /"unit:vpn-userspace@wg0","unit_active","false"\) \[axiom\]|"proc:wg-userspace","cgroup_slice","user\.slice"\) \[axiom\]/);
    const sysctl = await why('finding("proxy-host", "sysctl_conflict", "net.ipv4.ip_forward")');
    assert.match(sysctl, /"sysctl:60-cloud-network\.conf#net\.ipv4\.ip_forward","sysctl_value","0"\) \[axiom\]/);
    assert.match(sysctl, /"sysctl:99-sysctl\.conf#net\.ipv4\.ip_forward","sysctl_value","1"\) \[axiom\]/);
    const loop = await why('finding("old-node-host", "crash_loop", "container:node-app")');
    assert.match(loop, /"container:node-app","restarts",592\) \[axiom\]/);
    assert.match(loop, /"container:node-app","restart_window_days",14\) \[axiom\]/);
    const prod = await why('finding("dev-host", "prod_on_non_prod", "pod:x-prod/api")');
    assert.match(prod, /"pod:x-prod\/api","env_label","prod"\) \[axiom\]/);
    assert.match(prod, /"dev-host","host_role","dev"\) \[axiom\]/);

    // When the stale host speaks again, it is no longer unknown.
    await publish(hosts['stale-host']!.url, hosts['stale-host']!.me, [f('stale-host', 'reported_at', String(Math.floor((T0 + LATER) / 1000)))], () => T0 + LATER);
    await mirror(ops.url, hosts['stale-host']!.url, 'stale-host', ops.me, () => ops.clock.t);
    const again = await findings(ops);
    assert.deepEqual((again.unknown ?? []).map((u) => u.identity), ['quiet-host']);
  } finally {
    await ops.stop();
    for (const h of Object.values(hosts)) await h.stop();
  }
});

test('a fleet rule written once covers every followed host, including a host followed after the rule was written', async () => {
  const ops = await start(tmpDir('fleet-once-ops'), 'ops');
  const hosts = await hostsReporting(['proxy-host', 'old-node-host', 'dev-host', 'clean-host']);
  try {
    // The rules first, following nobody: no findings, and nothing unknown.
    await publish(ops.url, ops.me, FLEET, () => ops.clock.t);
    const none = await findings(ops);
    assert.deepEqual([none.rows, none.unknown ?? []], [[], []]);
    // Follow two hosts: their findings appear.
    const follow = async (...names: string[]) => {
      await publish(ops.url, ops.me, names.map((n) => f(n, 'roflenox:follow', hosts[n]!.url)), () => ops.clock.t);
      for (const n of names) await mirror(ops.url, hosts[n]!.url, n, ops.me, () => ops.clock.t);
    };
    await follow('proxy-host', 'clean-host');
    assert.deepEqual((await findings(ops)).rows.map((r) => r.cells).sort(), [
      ['proxy-host', 'daemon_outside_unit', 'proc:wg-userspace'],
      ['proxy-host', 'sysctl_conflict', 'net.ipv4.ip_forward'],
    ]);
    // Hosts followed AFTER the rules were written are covered by the same
    // rules — no rule was added, changed or re-published.
    await follow('old-node-host', 'dev-host');
    const later = await findings(ops);
    assert.deepEqual(later.rows.map((r) => r.cells).sort(), [
      ['dev-host', 'prod_on_non_prod', 'pod:x-prod/api'],
      ['old-node-host', 'crash_loop', 'container:node-app'],
      ['proxy-host', 'daemon_outside_unit', 'proc:wg-userspace'],
      ['proxy-host', 'sysctl_conflict', 'net.ipv4.ip_forward'],
    ]);
    assert.deepEqual(later.unknown ?? [], []);
    const rules = (await post(ops.url, '/ask', { query: 'edge(F, N, "roflenox:rule", T)' })).body.rows as unknown[];
    assert.equal(rules.length, FLEET.length, 'the same five rules, written once');
    // A ranging rule reads a followed book only while its host grants it: a
    // host that follows-but-does-not-grant is not read (may_read, as always).
    const loner = await start(tmpDir('fleet-loner'), 'loner-host');
    try {
      await publish(loner.url, loner.me, [exportRule('*', 'public'), ...REPORTS['dev-host']!.map((x) => (x.source === 'dev-host' ? { ...x, source: 'loner-host' } : x))], () => loner.clock.t);
      await publish(ops.url, ops.me, [f('loner-host', 'roflenox:follow', loner.url)], () => ops.clock.t);
      await mirror(ops.url, loner.url, 'loner-host', ops.me, () => ops.clock.t);
      assert.ok(!(await findings(ops)).rows.some((r) => r.cells[0] === 'loner-host'), 'no grant, no reading');
      const why = (await post(ops.url, '/op/whynot', { literal: 'finding("loner-host", "prod_on_non_prod", "pod:x-prod/api")' })).body as unknown as { text: string }[];
      assert.match(JSON.stringify(why), /may_read_book/, 'whynot names the missing permission');
    } finally { await loner.stop(); }
  } finally {
    await ops.stop();
    for (const h of Object.values(hosts)) await h.stop();
  }
});

test('a followed feed that no rule reads is reported as unknown, never as all-clear', async () => {
  const ops = await start(tmpDir('fleet-unread-ops'), 'ops', { silenceSec: 600 });
  const hosts = await hostsReporting(['clean-host']);
  try {
    // ops follows two feeds — one that reports, one that never has — and has
    // a rule that reads NEITHER (only its own book).
    await publish(ops.url, ops.me, [
      f('clean-host', 'roflenox:follow', hosts['clean-host']!.url),
      f('quiet-host', 'roflenox:follow', 'http://127.0.0.1:9/quiet-host'),
      rule('mine', 'watched(H) :- edge(F, H, "roflenox:follow", U).'),
    ], () => ops.clock.t);
    await mirror(ops.url, hosts['clean-host']!.url, 'clean-host', ops.me, () => ops.clock.t);
    const unknownOf = async (query: string) =>
      (((await post(ops.url, '/ask', { query })).body as unknown as Answer).unknown ?? []).map((u) => [u.identity, u.reason.split(':')[0]]);
    // The rule's own answer, a plain ask over the book, and a question about
    // something else entirely: each says the quiet feed is unknown.
    for (const q of ['watched(H)', 'edge(F, S, R, T)', 'edge(F, "nobody", R, T)']) {
      assert.deepEqual(await unknownOf(q), [['quiet-host', 'silent_feed']], q);
    }
    // Control: once it speaks (and nothing else is followed silent), no unknown.
    const quiet = await start(tmpDir('fleet-quiet'), 'quiet-host');
    try {
      await publish(quiet.url, quiet.me, [f('quiet-host', 'host_role', 'prod')], () => quiet.clock.t);
      await mirror(ops.url, quiet.url, 'quiet-host', ops.me, () => ops.clock.t);
      assert.deepEqual(await unknownOf('watched(H)'), []);
      // And silence returns when the window passes with no word.
      ops.clock.t += 601_000;
      assert.deepEqual((await unknownOf('watched(H)')).map((u) => u[0]).sort(), ['clean-host', 'quiet-host']);
    } finally { await quiet.stop(); }
  } finally {
    await ops.stop();
    for (const h of Object.values(hosts)) await h.stop();
  }
});

test('a follow retired with confidence 0 stops every rule ranging over that host\'s book', async () => {
  const dir = tmpDir('fleet-retire-ops');
  let ops = await start(dir, 'ops');
  const hosts = await hostsReporting(['proxy-host', 'dev-host']);
  try {
    const follow = (name: string, url: string, confidence = 1): Fact => ({ ...f(name, 'roflenox:follow', url), confidence });
    // Asked as ops (signed), so the same calls work after the restart below.
    const ask = async (query: string) => (await post(ops.url, '/ask', { query }, { as: ops.me })).body.rows as { cells: string[] }[];
    const ranged = async () => (await ask('ranged(H)')).map((r) => r.cells[0]).sort();
    const hostsFound = async () => [...new Set((await ask('finding(H, K, S)')).map((r) => r.cells[0]))].sort();
    await publish(ops.url, ops.me, [...FLEET, rule('ranged', 'ranged(H) :- follows(H, B).'),
      follow('proxy-host', hosts['proxy-host']!.url), follow('proxy-host', 'https://mirror.example.org/proxy-host'),
      follow('dev-host', hosts['dev-host']!.url)], () => ops.clock.t);
    for (const n of ['proxy-host', 'dev-host']) await mirror(ops.url, hosts[n]!.url, n, ops.me, () => ops.clock.t);
    assert.deepEqual(await ranged(), ['dev-host', 'proxy-host']);
    assert.deepEqual(await hostsFound(), ['dev-host', 'proxy-host']);

    // Re-asserting a follow keeps it (the new row is not retracted with the old).
    await publish(ops.url, ops.me, [follow('dev-host', hosts['dev-host']!.url)], () => ops.clock.t);
    assert.deepEqual(await ranged(), ['dev-host', 'proxy-host']);

    // Retire ONE of proxy-host's two follows: it is still followed.
    await publish(ops.url, ops.me, [follow('proxy-host', 'https://mirror.example.org/proxy-host', 0)], () => ops.clock.t);
    assert.deepEqual(await ranged(), ['dev-host', 'proxy-host']);
    // Retire the other: no rule ranges over its book any more — neither the
    // bare ranged(H) nor any fleet finding — though its facts are still held.
    await publish(ops.url, ops.me, [follow('proxy-host', hosts['proxy-host']!.url, 0)], () => ops.clock.t);
    assert.deepEqual(await ranged(), ['dev-host']);
    assert.deepEqual(await hostsFound(), ['dev-host']);
    assert.ok((await ask('edge(F, S, "sysctl_key", K)')).length > 0, 'its facts are still here');

    // The same after a restart: replay rebuilds only current follows.
    await ops.stop();
    ops = { ...(await serveAsIs(dir, ops.clock)), me: ops.me };
    assert.deepEqual(await ranged(), ['dev-host']);
    assert.deepEqual(await hostsFound(), ['dev-host']);

    // Following it again brings it back.
    await publish(ops.url, ops.me, [follow('proxy-host', hosts['proxy-host']!.url, 0.9)], () => ops.clock.t);
    assert.deepEqual(await ranged(), ['dev-host', 'proxy-host']);
    assert.deepEqual(await hostsFound(), ['dev-host', 'proxy-host']);
  } finally {
    await ops.stop();
    for (const h of Object.values(hosts)) await h.stop();
  }
});
