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
import { DAY, exportRule, grant, iso, post, start, T0, tmpDir, type Running } from './helpers.ts';

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

/** The fleet invariants, as rules in the reader's book, one set per host
 *  (a rule names the book it reads). */
function fleetRules(h: string): Fact[] {
  const H = `"${h}"`, B = `[@${h}]`;
  return [
    rule(`daemon-slice-${h}`, `finding(${H}, "daemon_outside_unit", P) :- edge${B}(F1, P, "process_unit", U), edge${B}(F2, P, "cgroup_slice", S), S != "system.slice".`),
    rule(`daemon-active-${h}`, `finding(${H}, "daemon_outside_unit", P) :- edge${B}(F1, P, "process_unit", U), edge${B}(F2, U, "unit_active", "false").`),
    rule(`sysctl-${h}`, `finding(${H}, "sysctl_conflict", K) :- edge${B}(F1, A, "sysctl_key", K), edge${B}(F2, C, "sysctl_key", K), edge${B}(F3, A, "sysctl_value", V1), edge${B}(F4, C, "sysctl_value", V2), V1 != V2.`),
    rule(`restarts-${h}`, `finding(${H}, "crash_loop", C) :- edge_num${B}(F1, C, "restarts", R), edge_num${B}(F2, C, "restart_window_days", D), R > 3 * D.`),
    rule(`prod-${h}`, `finding(${H}, "prod_on_non_prod", P) :- edge${B}(F1, P, "env_label", "prod"), edge${B}(F2, X, "host_role", Role), Role != "prod".`),
  ];
}

test('rules over host feeds rediscover the four host findings of 2026-09-26 and explain each with why', async () => {
  const LATER = 20 * 60_000;                                   // the stale host last spoke 20 min before the others
  const ops = await start(tmpDir('fleet-ops'), 'ops', { silenceSec: 600 });
  const hosts: Record<string, Running> = {};
  try {
    for (const [name, facts] of Object.entries(REPORTS)) {
      const h = hosts[name] = await start(tmpDir(`fleet-${name}`), name);
      // A host grants its fleet reader its book, and reports.
      await publish(h.url, h.me, [exportRule('*', 'public'), grant('ops', iso(T0 + 30 * DAY)), ...facts], () => h.clock.t);
    }
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
      ...fleet.flatMap(fleetRules),
    ], () => ops.clock.t);
    for (const [name, h] of Object.entries(hosts)) await mirror(ops.url, h.url, name, ops.me, () => ops.clock.t);

    const ans = (await post(ops.url, '/ask', { query: 'finding(H, K, S)' })).body as {
      rows: { identity: string; cells: string[] }[]; unknown?: { identity: string; reason: string; window?: number; last_report?: string | null }[] };
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
    const again = (await post(ops.url, '/ask', { query: 'finding(H, K, S)' })).body as { unknown?: { identity: string }[] };
    assert.deepEqual((again.unknown ?? []).map((u) => u.identity), ['quiet-host']);
  } finally {
    await ops.stop();
    for (const h of Object.values(hosts)) await h.stop();
  }
});
