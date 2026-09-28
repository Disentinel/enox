---
world: enox_spec
books: main
default: main
---

# Enox — спецификация

> Что такое Enox и что обязан делать узел Enox. Документ исполняемый: каждое
> требование — факт, у каждого требования есть источник, и правила ниже
> выводят, какие требования ещё не проверены машиной и какие ещё не
> доспецифицированы. Цикл работы — как в ноутбуке: пишем требование, смотрим,
> что в нём неясно, доспецифицируем, привязываем тест или машинную проверку.
>
> Загрузить и спросить: `npm run repl -- spec/enox.rofl.md` из репозитория rofl,
> затем `? R is unchecked`, `? R is underspecified`, `whynot R is ready`.

## Словарь

Declared as facts:

- <a id="requirement"></a>A requirement R is about an area A
- <a id="obliges"></a>A requirement R binds as a force F
- <a id="says"></a>A requirement R says a text T
- <a id="source"></a>A requirement R is stated in a document D
- <a id="open"></a>A requirement R leaves open a question Q
- <a id="guards"></a>A check C guards a requirement R
- <a id="lives"></a>A check C lives in a file P
- <a id="planned"></a>A requirement R is to be checked by a text T
- <a id="kind"></a>A requirement R is of a kind K
- <a id="queued"></a>A requirement R is queued at a rank N
- <a id="accepted"></a>A requirement R is accepted at a revision V
- <a id="rejected"></a>A requirement R is rejected at a revision V
- <a id="resists"></a>A requirement R resists an adversary A

> Вид требования, закрытый список: `feature` — что можно делать; `model` — что
> такое данные; `security` — защита от враждебной стороны; `reliability` —
> переживает сбои; `constraint` — форма и минимализм; `gate` — проверка самого
> процесса. Каждое требование ровно одного вида.
>
> Сила требования: `must` — обязательно, `must_not` — запрещено, `should` —
> желательно. Проверка — это тест, гейт или скрипт, чьё падение означает,
> что требование нарушено.

## Что такое Enox

> Enox — федеративный протокол переноса проверяемого знания между
> независимыми хранилищами. Единица данных — отношение (ребро) между
> сущностями, а не документ. У каждого утверждения есть автор, уверенность и
> перспектива. Узел — участник федерации: сервер, статическое дерево файлов
> или клиент.

### Модель данных

Требования раздела:

- `r_relation_primary` is about `data_model`.
- `r_relation_primary` binds as `must`.
- `r_relation_primary` says "the primary unit of data is a directed typed relation between two entities, not a document".
- `r_relation_primary` is stated in "PROTOCOL.md#1.0".
- `r_relation_primary` is to be checked by "a batch line that is not a relation between two entities is refused".
- `r_relation_primary` is to be checked by "a name made only of invisible or text-direction characters is refused, the same way by the client and the node".
- `r_asserted_by` is about `data_model`.
- `r_asserted_by` binds as `must`.
- `r_asserted_by` is to be checked by "every admitted fact reads back asserted by the identity that signed its batch, whatever the batch claims".
- `r_asserted_by` says "every assertion carries asserted_by; an assertion without it is rejected".
- `r_asserted_by` is stated in "PROTOCOL.md#1.2".
- `r_fact_id_derived` is about `data_model`.
- `r_fact_id_derived` binds as `must`.
- `r_fact_id_derived` says "fact_id is SHA256 of source, relation and target; it is derived, never primary, and never travels without its assertion".
- `r_fact_id_derived` is stated in "PROTOCOL.md#1.2".
- `r_fact_id_derived` is to be checked by "fact_id equals SHA-256 of the RFC 8785 serialisation of [source, relation, target] for a fixed vector".
- `r_confidence` is about `data_model`.
- `r_confidence` binds as `must`.
- `r_confidence` says "every relation carries a confidence between 0 and 1".
- `r_confidence` says "a control fact (grant, delegate, export, rule, trust in rules, follow) acts only while its identity's current assertion of it has confidence above 0; re-asserting it at 0 retires it, and that is how access, delegation and rules are withdrawn".
- `r_confidence` is to be checked by "each control fact retired at confidence 0 stops acting: a retired grant reads nothing, a retired delegation vouches for nobody and stops its agent, a retired rule derives nothing, a retired export publishes nothing".
- `r_confidence` is stated in "README.md#verification".
- `r_confidence` says "confidence belongs to one identity's assertion; a later assertion of the same fact by the same identity replaces the earlier one in the order of the log; combining confidence across identities is a perspective rule, not a property of the store".
- `r_confidence` is to be checked by "re-asserting a fact with a new confidence leaves exactly one confidence for that identity, the latest".
- `r_perspective` is about `data_model`.
- `r_perspective` binds as `must`.
- `r_perspective` says "every relation is asserted under a named perspective; queries can filter by perspective".
- `r_perspective` is stated in "PROTOCOL.md#3".
- `r_perspective` is to be checked by "a question restricted to one perspective sees only the facts asserted under it".

### Сохранность данных

> Раздел появился после 2026-09-18: узел молча стёр хранилище эмбеддингов,
> потому что не смог его прочитать, и ушёл в OOM-цикл на месяц.

Требования раздела:

- `r_no_silent_reset` is about `durability`.
- `r_no_silent_reset` binds as `must_not`.
- `r_no_silent_reset` says "a store that cannot be read is never replaced by an empty one; the node refuses to start or quarantines the file and reports it".
- `r_no_silent_reset` is stated in "incident 2026-09-18".
- `r_no_silent_reset` is to be checked by "a committed log file that cannot be read stops the node instead of an empty start".
- `r_engine_crash_recovery` is about `durability`.
- `r_engine_crash_recovery` binds as `must`.
- `r_engine_crash_recovery` says "when the engine process dies the node loses no admitted batch, refuses the batch in flight as a whole, rebuilds the engine from the log and answers again".
- `r_engine_crash_recovery` is stated in "import of the real Enox snapshot 2026-09-27: rofl-serve panicked twice at store.rs under fork-per-batch load".
- `r_engine_crash_recovery` is to be checked by "killing the engine during an admission leaves the log consistent, refuses that batch, and the node answers after it rebuilds".
- `r_engine_crash_recovery` is to be checked by "killing the engine during an ask never yields a plain answer: the asker gets an error or unknown, and the next ask is answered".
- `r_atomic_write` is about `durability`.
- `r_atomic_write` binds as `must`.
- `r_atomic_write` is to be checked by "a node killed at each write step reopens with the whole batch or none of it".
- `r_atomic_write` is to be checked by "a backup killed between any two of its steps leaves a readable backup at the latest path".
- `r_atomic_write` says "a process killed during any write leaves the previous consistent version readable".
- `r_atomic_write` is stated in "incident 2026-09-18".
- `r_backup` is about `durability`.
- `r_backup` binds as `must`.
- `r_backup` says "the primary data of a node is backed up outside the host it runs on".
- `r_backup` is stated in "owner 2026-09-26".
- `r_backup` says "a backup is a copy of the log up to a committed receipt, verified by rebuilding a node from it; the node takes one on a schedule to a target outside its host, and at most one schedule period of writes can be lost".
- `r_backup` is to be checked by "a node rebuilt from its latest backup answers every question the same as the node up to that backup".
- `r_backup` says "a backup becomes the latest only after every file and directory it holds is on disk, so a power loss never leaves the latest path naming a torn copy".
- `r_backup` is to be checked by "a backup syncs every file and directory it holds before it becomes the latest".
- `r_derived_rebuildable` is about `durability`.
- `r_derived_rebuildable` binds as `must`.
- `r_derived_rebuildable` says "derived data such as embeddings can be rebuilt from primary data alone, and losing it never loses knowledge".
- `r_derived_rebuildable` is stated in "incident 2026-09-18".
- `r_derived_rebuildable` is to be checked by "a meaning search returns a fact after the embedder answers its intent, and the core answers the same with the embedder absent".

### Ресурсы и доступность

Требования раздела:

- `r_bounded_memory` is about `operations`.
- `r_bounded_memory` binds as `must`.
- `r_bounded_memory` says "a node runs within a declared memory budget and never grows past it under idle load".
- `r_bounded_memory` is stated in "incident 2026-09-18".
- `r_bounded_memory` is to be checked by "a node holding 200000 facts stays under 1.5 GB of resident memory while idle".
- `r_session_eviction` is about `operations`.
- `r_session_eviction` binds as `must`.
- `r_session_eviction` says "an MCP session that stays idle is closed and its memory released".
- `r_session_eviction` is stated in "incident 2026-09-18".
- `r_session_eviction` is to be checked by "the MCP endpoint issues no session id and keeps no state per client".
- `r_batch_write` is about `operations`.
- `r_batch_write` binds as `should`.
- `r_batch_write` says "a batch of 2000 facts is admitted within one second while the node already holds 200000 facts".
- `r_batch_write` is stated in "owner 2026-09-26".
- `r_batch_write` is to be checked by "a batch of 2000 facts is admitted within one second with 200000 facts held".
- `r_uri_prefix_stable` is about `identity`.
- `r_uri_prefix_stable` binds as `must_not`.
- `r_uri_prefix_stable` says "the URI prefix of a node never changes silently, including across upgrades that change defaults".
- `r_uri_prefix_stable` is stated in "audit 2026-09-26".
- `r_uri_prefix_stable` is to be checked by "a node whose imported ids sit under another URI prefix says so at startup".

### Перенос знания

Требования раздела:

- `r_substrate_independent` is about `transfer`.
- `r_substrate_independent` binds as `must`.
- `r_substrate_independent` says "a share is a JSONL slice plus a manifest; consuming it needs a parser, not a migration".
- `r_substrate_independent` is stated in "PROTOCOL.md#1.2".
- `r_substrate_independent` is to be checked by "a feed copied to a static directory mirrors under a fresh checkpoint and is refused under an expired one".
- `r_verify_without_author` is about `transfer`.
- `r_verify_without_author` binds as `must`.
- `r_verify_without_author` says "a recipient recomputes the content digest of a share and confirms it holds the same version, without the author".
- `r_verify_without_author` is stated in "PROTOCOL.md#6.3".
- `r_verify_without_author` is to be checked by "a feed copied to a static directory mirrors under a fresh checkpoint and is refused under an expired one".
- `r_revocation_receipt` is about `transfer`.
- `r_revocation_receipt` binds as `must`.
- `r_revocation_receipt` is to be checked by "a revoked grant answers 410 on the next read, while facts read before the revocation still verify against their batch digest".
- `r_revocation_receipt` says "revoking a share stops future reads with status 410; what was already read stays attested by its digest".
- `r_revocation_receipt` is stated in "PROTOCOL.md#1.2".

### Доступ

Требования раздела:


### Возможности гибрида (решения 2026-09-26)

> Одни примитивы на все масштабы: идентичность (имя, за которым ключ),
> подписанный батч в журнале, книга, правило в книге, намерение, адресованное
> идентичности, грант. Один агент на ноутбуке, федерация узлов и рой агентов
> поверх федерации отличаются только тем, сколько идентичностей и узлов
> участвует, — не набором механизмов.

Требования раздела:

- `r_ask_explain` is about `hybrid`.
- `r_ask_explain` binds as `must`.
- `r_ask_explain` says "anyone reads a node by asking a question and gets rows; for any answer why names the facts and rules it stands on and whynot names the missing premise, within what the asker may see".
- `r_ask_explain` is stated in "owner 2026-09-26: ask, why and whynot are first-class".
- `r_ask_explain` is to be checked by "why names the facts and the rule an answer stands on, and whynot names the missing premise".
- `r_user_rules` is about `hybrid`.
- `r_user_rules` binds as `must`.
- `r_user_rules` says "an identity publishes rules as ordinary signed content into its own book; the engine runs them over that book and over books it is granted; a rule never concludes into another identity's book".
- `r_user_rules` is stated in "owner 2026-09-26: a hybrid where rofl programs do something".
- `r_user_rules` is to be checked by "a rule published by alice derives facts in her book from bob's granted facts, and cannot conclude into bob's book".
- `r_foreign_rules_opt_in` is about `hybrid`.
- `r_foreign_rules_opt_in` binds as `must`.
- `r_foreign_rules_opt_in` says "a node runs the rules of another identity only if its operator trusts that identity for rules, whether the rules came by mirror or were posted to the node by their author; a book brings its facts, never its code, by default".
- `r_foreign_rules_opt_in` is stated in "verification 2026-09-26: mirroring a feed loaded its author's rules into the reader's engine".
- `r_foreign_rules_opt_in` is to be checked by "a mirrored rule does not run until the reader trusts its author for rules, and then it does".
- `r_rule_budget` is about `hybrid`.
- `r_rule_budget` binds as `must`.
- `r_rule_budget` says "each author's rules run under that author's own derivation budget; an exhausted budget makes the affected answers unknown with the reason, never a silently truncated answer, and never slows another author's admissions".
- `r_rule_budget` is stated in "verification 2026-09-26: an unbounded rule returned exactly 500000 rows as a normal answer and held the admission queue for seconds".
- `r_rule_budget` is to be checked by "an unbounded rule yields unknown with its budget named, and another identity's batch is admitted meanwhile without delay".
- `r_answer_limits` is about `operations`.
- `r_answer_limits` binds as `must`.
- `r_answer_limits` says "an answer carries at most a stated number of rows and says when it was cut, with a way to fetch the rest".
- `r_answer_limits` is stated in "verification 2026-09-26: a 500000-row answer came back in one response with no mark".
- `r_answer_limits` is to be checked by "an answer longer than the limit is marked cut and the rest is fetched page by page to the same total".
- `r_intent_loop` is about `hybrid`.
- `r_intent_loop` binds as `must`.
- `r_intent_loop` says "a rule derives an intent addressed to an identity; that identity's executor reads its intents like any reader, does the work outside the node, and publishes the result as a signed batch citing the intent, so why crosses from the result back to the rule that asked".
- `r_intent_loop` is stated in "owner 2026-09-26; ROFL runtime ingest, scheduler and admission".
- `r_intent_loop` is to be checked by "an intent derived by a rule is answered by an executor and why of the result reaches the rule".
- `r_agents_as_identities` is about `hybrid`.
- `r_agents_as_identities` binds as `must`.
- `r_agents_as_identities` says "an agent is an identity whose key is delegated by a parent identity until an expiry; agents of a swarm write only to their own books and see each other through grants; the node needs nothing agent-specific".
- `r_agents_as_identities` is stated in "owner 2026-09-26: swarms of agents over a federation on the same primitives".
- `r_agents_as_identities` is to be checked by "a delegated agent key publishes until its expiry and is refused after it".
- `r_agents_as_identities` is to be checked by "a sub-agent is refused as soon as any identity above it in the delegation chain is".
- `r_follow` is about `hybrid`.
- `r_follow` binds as `must`.
- `r_follow` says "a node follows another identity's feed and keeps its mirror current, live or static, with the same checks as a single pull".
- `r_follow` is stated in "owner 2026-09-26: federation".
- `r_follow` is to be checked by "a follower converges to the publisher's head after new batches without a manual pull".
- `r_local_stdio` is about `hybrid`.
- `r_local_stdio` binds as `must`.
- `r_local_stdio` says "a single agent on one machine uses a node over stdio MCP with no server, no network and no account; serving the same data directory over HTTP later changes nothing in the data".
- `r_local_stdio` is stated in "owner 2026-09-26: from one local Claude Code upward".
- `r_local_stdio` is to be checked by "the same data directory answers the same over stdio and over HTTP".
- `r_semantic_search` is about `hybrid`.
- `r_semantic_search` binds as `should`.
- `r_semantic_search` says "search by meaning is an executor that embeds facts into its own book; the core answers without it and a lost index is rebuilt from the log".
- `r_semantic_search` is stated in "Enox today; incident 2026-09-18".
- `r_semantic_search` is to be checked by "a meaning search returns a fact after the embedder answers its intent, and the core answers the same with the embedder absent".
- `r_semantic_search` is to be checked by "a meaning search finds a fact that shares none of the query's words".
- `r_semantic_search` is to be checked by "a search the operator asks is never published by a wildcard export".
- `r_uc_observability` is about `hybrid`.
- `r_uc_observability` binds as `must`.
- `r_uc_observability` says "hosts publish facts about themselves as feeds; a reader derives fleet invariants with rules and explains each finding; a silent feed gives unknown, never all-clear".
- `r_uc_observability` is stated in "owner 2026-09-26: the first use case".
- `r_uc_observability` is to be checked by "rules over host feeds rediscover the four host findings of 2026-09-26 and explain each with why".
- `r_uc_observability` is to be checked by "a fleet rule written once covers every followed host, including a host followed after the rule was written".
- `r_uc_observability` is to be checked by "a followed feed that no rule reads is reported as unknown, never as all-clear".
- `r_uc_observability` is to be checked by "a follow retired with confidence 0 stops every rule ranging over that host's book".
- `r_import` is about `hybrid`.
- `r_import` binds as `must`.
- `r_import` says "an existing Enox node's graph, with entities, assertions, confidence, perspective and provenance, is imported into the log as signed batches of the importing identity, each original author kept as a fact about the fact; the import is repeatable and gives the same log for the same input".
- `r_import` is stated in "owner 2026-09-26: fix Enox in the right direction at once".
- `r_import` is to be checked by "importing an Enox snapshot twice gives the same log head and every imported assertion answers by ask with its original author".
- `r_enox_compat` is about `hybrid`.
- `r_enox_compat` binds as `must`.
- `r_enox_compat` says "an Enox write's asserted_by label is kept as claimed_by, shown beside the signer and marked as a claim; it never replaces the signer as asserted_by".
- `r_enox_compat` is to be checked by "an agent label given to an Enox write reads back as claimed_by next to the signing identity, and a forged label changes nothing but claimed_by".
- `r_enox_compat` says "claimed_by is untrusted text: it is refused at write when longer than 128 characters or when it holds a control character, and every text view shows it as a quoted, escaped string, so a label can never read as a signer, a line or a fact".
- `r_enox_compat` is to be checked by "a claimed label holding brackets, a newline or 5000 characters can neither forge a signer nor add a line to a text view".
- `r_enox_compat` says "the MCP tools that current Enox clients call, such as remember, recall, semantic_search, add_assertion, batch_assertions, query_graph, explore and graph_stats, are rows of the operation table mapped onto ask, assert and executors, so a client moves by changing its URL".
- `r_enox_compat` is stated in "owner 2026-09-26; the twenty tools of the Enox MCP server in use".
- `r_enox_compat` is to be checked by "the tool calls an Enox client made on 2026-09-26 run unchanged against a node and get answers of the same shape".
- `r_enox_compat` is to be checked by "an Enox read right after a write answers within one second with 200000 facts held".
- `r_minimal_parts` is about `architecture`.
- `r_minimal_parts` binds as `must`.
- `r_minimal_parts` says "a node is one process with one log, one engine, one wire format which is the signed batch, and one proof of who which is an identity signature; the one declared exception is an operator bearer token that acts only as the node's own identity, for MCP clients that cannot sign requests; its transports are stdio and HTTP; every use from one local agent to a federated swarm composes these and nothing else".
- `r_minimal_parts` is stated in "owner 2026-09-26: as few moving parts as possible".
- `r_minimal_parts` is to be checked by "a census of the source finds no second store, queue, wire format or proof of who".
- `r_interface_parity` is about `architecture`.
- `r_interface_parity` binds as `must`.
- `r_interface_parity` says "every operation is declared once, with its input schema, its access rule and its handler, and the MCP tools, the CLI commands and the HTTP routes are generated from that one table; an operation that must stay on the local machine says so with a reason and is absent from HTTP".
- `r_interface_parity` is stated in "owner 2026-09-26: parity of MCP, CLI and API from one source".
- `r_interface_parity` is to be checked by "every operation in the table is reachable with the same name and schema over MCP, CLI and HTTP, and nothing outside the table is".
- `r_typed` is about `spec`.
- `r_typed` binds as `must`.
- `r_no_orphan_tests` is about `spec`.
- `r_no_orphan_tests` binds as `must`.
- `r_no_orphan_tests` says "every test case in the repository guards at least one requirement; test names are static strings; the list of test cases is read by a deterministic scanner and compared with the test runner's own list, so a test the scanner cannot see fails the gate instead of passing unseen".
- `r_no_orphan_tests` is stated in "owner 2026-09-27: a scanner lists every test case, and no test case is unlinked".
- `r_no_orphan_tests` says "the scanner and the runner compare top-level test names; a subtest (t.test) may carry a dynamic name, so a loop of cases is one static top-level test with subtests; the scan covers roflenox/test, roflenox/executors/*/test and spec/check.test.mjs; the implementer owns spec/check.mjs and spec/check.test.mjs for this".
- `r_no_orphan_tests` is to be checked by "a test that guards no requirement fails the spec gate, and linking it passes".
- `r_no_orphan_tests` is to be checked by "a test the scanner cannot read, or one the runner lists and the scanner does not, fails the spec gate".
- `r_no_orphan_tests` is to be checked by "an accepted requirement whose checks guard no existing test fails the spec gate".
- `r_no_orphan_tests` says "a test counts as linked through a guards fact and its lives-in file; the one exception is work in review: a test named by a planned check of a requirement not yet accepted counts as linked until that requirement is accepted, after which it needs its own guards line; and every planned check of an accepted requirement must itself be guarded by an existing test, not just one of them".
- `r_no_orphan_tests` is to be checked by "a test that matches a planned check of an accepted requirement but has no guards line is an orphan, and an accepted requirement with one unguarded planned check fails the spec gate".
- `r_no_orphan_tests` says "whole-suite nested runs belong to the hermetic5 gate, not to npm test, so npm test does not run the suite twice under its own time limit".
- `r_single_writer` is about `storage`.
- `r_single_writer` binds as `must`.
- `r_single_writer` says "one process at a time owns a data directory: serve, stdio and every local operation that signs take an exclusive lock on it, and a second process refuses to start, naming the holder, before it reads or writes anything; so a node can never sign two successors of its own head by accident".
- `r_single_writer` is stated in "found 2026-09-27 while verifying the quickstart: stdio and serve on one data dir forked the node's own chain, and the node then refused to start".
- `r_single_writer` is to be checked by "a second serve or stdio on a data directory another process holds refuses to start, names the holder and changes nothing".
- `r_single_writer` says "only the process that holds the lock signs: when a serve holds the directory, local signing operations hand their facts to it and it signs them one at a time, so concurrent local writes never become two successors of the node's own head".
- `r_single_writer` is to be checked by "eight concurrent local publishes through one serve are all admitted, in one chain, and the node records no fork of its own identity".
- `r_compat_parity` is about `enox`.
- `r_compat_parity` binds as `must`.
- `r_compat_parity` says "the Enox tools answer like the Enox they replace on the same data: recall uses meaning as well as names, semantic_search carries age_days and stale, proof_depth is an integer, the embedder runs in bounded memory and survives writes during its read, updates and deletes stay fast, a read after a write meets the one-second bound under load, and why agrees with ask".
- `r_compat_parity` is stated in "side-by-side comparison with the base Enox on the owner's data, 2026-09-27 (private report, not in the repo)".
- `r_compat_parity` is to be checked by "recall finds an entity from a natural-language question that shares no word with its name".
- `r_compat_parity` is to be checked by "semantic_search results carry age_days and stale like the base".
- `r_compat_parity` is to be checked by "a fractional proof_depth is refused".
- `r_compat_parity` is to be checked by "the embedder embeds a book of mixed text lengths in bounded memory and finishes although writes land during its read".
- `r_compat_parity` is to be checked by "update_assertion and delete_assertion answer within 100 ms and a read after a write within one second while writes keep arriving".
- `r_compat_parity` is to be checked by "why agrees with ask for every literal ask returns, including conf".
- `r_typed` says "every requirement is of exactly one kind from the closed list".
- `r_typed` is stated in "owner 2026-09-26".
- `r_typed` is to be checked by "a requirement with an unknown kind fails typing".
- `r_balanced` is about `spec`.
- `r_balanced` binds as `must`.
- `r_balanced` says "the restricting kinds, security, reliability, constraint and gate, and the enabling kinds, feature and model, stay within a factor of one and a half of each other, and no kind is empty; a skew fails the spec check".
- `r_balanced` is stated in "owner 2026-09-26: a skew must be caught at once".
- `r_balanced` is to be checked by "flipping features to security past 3/2 fails balance".

### Архитектура ROFLENOX (решения 2026-09-26)

> Минимализм, надёжность, масштабируемость. Один процесс Node на узел, ноль
> runtime-зависимостей (как у rofl), движок вывода — Rust `rofl-serve` через
> `RoflPort` (дочерний процесс, пять глаголов: load/assert/tick/ask/state плюс
> why/whynot/retract/excise).
>
> 1. Истина — журнал. Хранимое — это только принятые подписанные батчи:
>    `log/<book>/<digest>.jsonl` + `.manifest.json` (по идентичности: две
>    идентичности могут подписать побайтно одинаковый JSONL), запись через
>    временный файл, fsync и rename; индекс батчей — дозаписываемый
>    `log/index.jsonl`. Ничего, кроме журнала, не является первичным.
> 2. Всё остальное пересчитываемо: состояние движка восстанавливается
>    повтором журнала; снапшот `state` — только кэш ускорения старта, с
>    digest журнала, на котором он снят; не совпал — выбрасывается.
> 3. Канонизация — RFC 8785 (JCS). Строка JSONL = JCS одного факта;
>    digest батча = SHA-256 байтов JSONL; `fact_id` = SHA-256 от JCS массива
>    `[source, relation, target]`. Этим закрыт открытый вопрос `r_fact_id_derived`.
> 4. Подпись — Ed25519 над `"roflenox-batch-v1\n" + JCS(манифест без sig)`
>    (разделение доменов). Манифест несёт: identity, key id, prev (digest
>    предыдущего батча этой идентичности), claimed_at, count, digest, sig —
>    и подписано всё, кроме самой подписи: иначе `prev` можно переписать
>    на чужом настоящем батче, и цепочка стала бы заявленной, а не доказанной.
> 5. Допуск: проверка подписи → ключ действовал в claimed_at → цепочка (prev
>    совпадает с головой) → окно свежести (|claimed_at − received_at| ≤ 300 с,
>    как допуск часов в Kerberos) → факты грузятся в движок с `who =
>    identity`, то есть только в книгу подписанта. Квитанция — received_at и
>    digest, дозаписью в индекс.
> 6. Ключ сервера — файл 0600 вне журнала; у людей — системный keychain.
> 7. HTTP: `GET /.well-known/roflenox/identity` (подписанная история ключей),
>    `POST /batches` (допуск), `GET /feeds/<identity>?after=<digest>` (батчи
>    как есть, с исходными подписями), `POST /ask` (запрос с why, в пределах
>    книг, которые запрашивающему разрешено видеть), `GET /health`.
>    Запросы к закрытому подписываются по RFC 9421 (HTTP Message Signatures).
> 8. Эмбеддинги, извлечение через LLM, MCP — исполнители и адаптеры поверх
>    ядра, не часть ядра: ядро работает без них.
> 9. Масштаб: журнал разбит по идентичностям, движок — Rust; повтор журнала
>    линеен по числу фактов.

Требования раздела:

- `r_log_is_truth` is about `architecture`.
- `r_log_is_truth` binds as `must`.
- `r_log_is_truth` says "the only primary data is the append-only log of admitted signed batches; every other store is rebuilt from it".
- `r_log_is_truth` is stated in "architecture 2026-09-26".
- `r_log_is_truth` is to be checked by "delete everything except the log, restart, and every ask returns the same answers".
- `r_snapshot_is_cache` is about `architecture`.
- `r_snapshot_is_cache` binds as `must`.
- `r_snapshot_is_cache` says "a node opens by replaying its log, and does so within 30 seconds for 200000 facts; a cache of engine state exists only while it opens faster than replay and always proves it was built from the same batches as the log".
- `r_snapshot_is_cache` is stated in "architecture 2026-09-26".
- `r_snapshot_is_cache` is to be checked by "a node holding 200000 facts reopens from its log within 30 seconds".
- `r_zero_deps` is about `architecture`.
- `r_zero_deps` binds as `must`.
- `r_zero_deps` says "the server has no runtime npm dependencies; it uses node built-ins and the rofl-serve binary".
- `r_zero_deps` is stated in "architecture 2026-09-26".
- `r_zero_deps` is to be checked by "package.json declares no dependencies".
- `r_core_without_executors` is about `architecture`.
- `r_core_without_executors` binds as `must`.
- `r_core_without_executors` says "the core admits, stores and answers with no embedding model, LLM or MCP present".
- `r_core_without_executors` is stated in "architecture 2026-09-26".
- `r_core_without_executors` is to be checked by "the full test suite passes with no network and no model files".
- `r_mcp_adapter` is about `architecture`.
- `r_mcp_adapter` binds as `must`.
- `r_mcp_adapter` says "agents reach a node over MCP streamable HTTP with tools to ask, explain with why and whynot, and assert facts as the node's own identity; the adapter is a thin layer over the same admission and access rules".
- `r_mcp_adapter` is stated in "loop goal 2026-09-26: a full replacement for the Enox node".
- `r_mcp_adapter` is to be checked by "an MCP client lists the tools, asserts a fact, and asks it back with why, all under the node's access rules".
- `r_executors_off_read_path` is about `architecture`.
- `r_executors_off_read_path` binds as `must`.
- `r_executors_off_read_path` says "an executor such as an embedder runs outside the process that answers reads, so a busy executor never delays an ask".
- `r_executors_off_read_path` is stated in "migration rehearsal 2026-09-26: smart-node MCP reads hung over 60 s while its embed worker ran".
- `r_executors_off_read_path` is to be checked by "an ask answers within one second while an executor saturates its CPU budget".

### Идентичность, подпись и время

> Решение владельца 2026-09-26: приватность, аутентификация и доступ
> закладываются с первого дня одним простым механизмом, без церемоний и без
> «потом». Пользователь работает с именами (`prod-host`, `alice@example.org`,
> «поделиться с Катей») и ничего не знает о ключах — как wget ничего не
> спрашивает про TLS handshake. Ключи всплывают только когда что-то не так,
> и объясняются через `whynot`.
>
> Механизм, целиком: у идентичности есть ключ Ed25519; публикуется батч —
> канонический JSONL и манифест с digest; подписывается digest; батчи одной
> идентичности сцеплены digest'ами предыдущих; допуск кладёт факт только в
> книгу подписанта; доступ — подписанные гранты-факты; приватное шифруется
> под получателя. Всё остальное — rofl-правила над фактами о ключах, грантах
> и доверии.
>
> Время бывает трёх видов, и правило обязано сказать, на какой опирается:
> порядок в цепочке (доказан), время получения (наблюдено мной), заявленное
> время подписи (утверждение подписанта, самое слабое). Подпись задним
> числом возможна, но батч мы получаем в известный нам момент: если
> заявленное время слишком далеко от времени получения, подпись протухла, и
> мы просим переподписать. Так окно свежести ограничивает, насколько далеко
> назад может «соврать» украденный ключ.

> Решения реализации ядра (исполнитель, приняты 2026-09-26): имя
> идентичности 1–128 символов `[A-Za-z0-9._@-]`; книга = `b_` + 16 hex
> SHA-256 имени; key_id = SHA-256 публичного ключа, ключи и подписи в
> base64url; файл ключа 0600 в каталоге 0700, вне журнала; документ
> идентичности подписан над `"roflenox-identity-v1\n" + JCS(doc)`; первый
> контакт — доверие при первом использовании, документ закрепляется в том же
> коммите журнала, что и первый батч; время — RFC 3339 UTC с миллисекундами,
> ключ действует в `valid_from ≤ t < valid_until`; JSONL строгий, пустой
> батч и повтор факта внутри батча отклоняются; точка коммита — строка
> индекса, оборванная строка уходит в `quarantine/` и видна в `/health`;
> допуск через форк движка, без частичного допуска; голова журнала =
> SHA-256 байтов индекса; при повторе журнала свежесть не проверяется
> (время получения берётся из квитанции); уверенность хранится в
> движке как промилле 0..1000.
>
> Конфликт, найденный реализацией: окно свежести отклоняет зеркалирование
> старых батчей. Разрешение: свежесть относится к моменту ПОЛУЧЕНИЯ, а не к
> возрасту содержимого. Живой POST от автора проверяется по claimed_at;
> батч из чужого фида проверяется по свежей подписи издателя над головой
> фида и вызовом читателя (nonce) — исходные подписи батчей остаются как
> есть и проверяются на действительность ключа, а не на возраст.

Требования раздела:

- `r_mirror_old_batches` is about `identity`.
- `r_mirror_old_batches` binds as `must`.
- `r_mirror_old_batches` says "a batch of any age is admitted from a peer feed when the publisher signs the feed head together with the reader's fresh challenge; freshness applies to that signature, not to the age of the batch".
- `r_mirror_old_batches` is stated in "implementation finding 2026-09-26".
- `r_mirror_old_batches` is to be checked by "a batch a week old mirrors from a live peer, and the same feed replayed without a fresh challenge is refused".
- `r_static_feed` is about `identity`.
- `r_static_feed` binds as `must`.
- `r_static_feed` says "a feed on dumb static hosting is mirrored under a signed checkpoint of its head that the publisher renews on a schedule; a checkpoint older than the checkpoint window is refused; a live challenge is used whenever the publisher is reachable".
- `r_static_feed` is stated in "verification 2026-09-26: only the home node can attest, which contradicts static nodes being first-class".
- `r_static_feed` says "the checkpoint window is 24 hours by default and set per node".
- `r_static_feed` is to be checked by "a checkpoint one second past the window is refused and one second inside it mirrors".
- `r_static_feed` is to be checked by "a feed copied to a static directory mirrors under a fresh checkpoint and is refused under an expired one".
- `r_challenge_stateless` is about `operations`.
- `r_challenge_stateless` binds as `must`.
- `r_challenge_stateless` says "a challenge is a nonce with its expiry authenticated by the node's own key, so issuing one stores nothing; only nonces consumed by a verified feed are remembered until they expire, and a flood of requests denies nobody else".
- `r_challenge_stateless` is stated in "verification 2026-09-26: a global cap turns the memory attack into denial of service for honest mirrors; it replaces the capped table".
- `r_challenge_stateless` is to be checked by "a flood of challenge requests neither grows memory nor stops an honest mirror".

Требования раздела:

- `r_identity_names` is about `identity`.
- `r_identity_names` binds as `must`.
- `r_identity_names` says "users address identities by name; in normal operation no key, fingerprint or signature is shown or asked for".
- `r_identity_names` is stated in "owner 2026-09-26".
- `r_identity_names` says "a name is either a host-like name or user@domain, the form people already use for themselves; the domain, and a host-like name as a whole, are normalised by IDNA UTS 46 (the platform's domainToASCII); the part before the last @ is normalised by the PRECIS UsernameCaseMapped profile of RFC 8265 (width mapping, case mapping, NFC; letters, digits and printable ASCII without spaces); the canonical form is the identity and its Unicode form is how it is shown; one format for people, hosts and agents".
- `r_identity_names` says "a name is refused when normalisation refuses it, when a label mixes letters of more than one script, when a label is longer than 63 or the whole longer than 253 characters, or when a label starts or ends with a hyphen".
- `r_identity_names` says "every door that compares names — pinning, grants, delegation, follows, invitations, books — compares canonical forms through one function".
- `r_identity_names` is to be checked by "a name with a space or a text-direction mark is refused, and names at the label and total length limits are accepted".
- `r_identity_names` says "a name holds at most one @; the part before it is a dot-atom as in email (RFC 5321): no @, no leading or trailing dot and no two dots in a row, so no name can read as one identity while belonging to another domain".
- `r_identity_names` is to be checked by "admin@example.org@evil.example, ada@@example.org and ada.@example.org are refused, so no name reads as an identity of a domain it does not belong to".
- `r_identity_names` is to be checked by "a user part holding any of < > ( ) [ ] : ; , a backslash or a double quote is refused, while one with + or ' is accepted, as email atext allows".
- `r_identity_names` is to be checked by "Node-A, node-a and NODE-A are one identity, and so are a composed and a decomposed accent and a name with a zero-width mark".
- `r_identity_names` is to be checked by "a label mixing Cyrillic and Latin letters is refused, while an all-Cyrillic name is accepted and shown in Cyrillic".
- `r_identity_names` is to be checked by "a grant, a delegation and a follow written with a differently cased or composed name act on the same identity".
- `r_identity_names` is to be checked by "ada@example.org, Ada@Example.ORG and a fullwidth spelling of it are one identity; ada@пример.рф is accepted and shown in Cyrillic; bot.ada@example.org is its delegated agent's name".
- `r_identity_names` is to be checked by "an end-to-end pull between two nodes whose transcript contains no key material".
- `r_keys_automatic` is about `identity`.
- `r_keys_automatic` binds as `must`.
- `r_keys_automatic` says "keys are generated on first run and kept in the OS keychain; an agent gets a short-lived key delegated by its parent identity as a grant".
- `r_keys_automatic` is stated in "owner 2026-09-26".
- `r_keys_automatic` is to be checked by "a fresh install that publishes a signed batch with no manual key step".
- `r_signed_batch` is about `identity`.
- `r_signed_batch` binds as `must`.
- `r_signed_batch` says "a published batch is canonical JSONL plus a manifest; the signature covers the digest together with a context string, so a signature cannot be reused in another protocol".
- `r_signed_batch` is stated in "best practice, Ed25519 with domain separation".
- `r_signed_batch` is to be checked by "a batch with one byte changed is rejected".
- `r_chain` is about `identity`.
- `r_chain` binds as `must`.
- `r_chain` says "every batch of an identity names the digest of its previous batch, so before and after within one identity is proven, not claimed".
- `r_chain` is stated in "best practice, sigchain and transparency logs".
- `r_chain` is to be checked by "a batch inserted into the middle of a chain is rejected".
- `r_chain` is to be checked by "a batch whose prev was rewritten after signing is rejected".
- `r_chain` says "two validly signed batches of one identity that name the same prev are kept as proof of a fork, and every answer over that book says the identity forked".
- `r_chain` is to be checked by "a node given a second signed successor of the same batch keeps both signatures as fork proof and marks every answer over that book".
- `r_admit_by_signer` is about `identity`.
- `r_admit_by_signer` binds as `must`.
- `r_admit_by_signer` says "an admitted fact lands only in the book of the identity that signed it; an unsigned or badly signed batch is not admitted at all".
- `r_admit_by_signer` is stated in "ROFL runtime/admission.ts".
- `r_admit_by_signer` is to be checked by "a batch signed by B that writes into the book of A is refused".
- `r_freshness` is about `identity`.
- `r_freshness` binds as `must`.
- `r_freshness` says "stale means claimed EARLIER than the receipt minus the freshness window; a claimed time later than the receipt plus the allowed skew is refused as future-dated by every door, live, mirrored or sealed, and is never kept as stale".
- `r_freshness` is to be checked by "a live batch dated 301 seconds ahead of its receipt is refused as future-dated, while one dated 301 seconds behind is refused as stale with a request to re-attest".
- `r_freshness` says "a signature whose claimed time is further from the time we received it than the freshness window is stale; a stale batch is not trusted until the publisher re-attests it; a live pull uses a fresh challenge from the reader instead of a clock".
- `r_freshness` is stated in "owner 2026-09-26".
- `r_freshness` is to be checked by "a batch claiming a time outside the window is marked stale and a re-attestation is requested".
- `r_reattest` is about `identity`.
- `r_reattest` binds as `must`.
- `r_reattest` says "a publisher re-attests an old batch by signing the same digest with its current key and time; the content and its original provenance do not change".
- `r_reattest` is stated in "owner 2026-09-26".
- `r_reattest` is to be checked by "a re-attested batch keeps its digest and gains a second, fresh signature".
- `r_rotation` is about `identity`.
- `r_rotation` binds as `must`.
- `r_rotation` says "a key is valid from one moment and invalid from another; rotation is a fact signed by the old key, and the user notices nothing".
- `r_rotation` is stated in "owner 2026-09-26".
- `r_rotation` says "a key's validity is judged at the time its signer claims, and a claimed time later than the receipt plus 300 seconds is refused".
- `r_rotation` is to be checked by "a batch signed after its key's invalid_from is refused, and one dated 301 seconds past its receipt is refused as future-dated".
- `r_rotation` says "claimed times within one identity's chain never go backwards, and once a batch signed by a newer key stands in the chain, no older key appends to it".
- `r_rotation` is to be checked by "after a batch signed by the new key, a batch signed by the rotated key is refused whatever time it claims, and a batch claiming a time earlier than its predecessor is refused".
- `r_rotation` says "the publishing client claims the later of its clock and its previous batch's claimed time, as a hybrid logical clock does, so an honest publisher whose clock steps back keeps publishing".
- `r_rotation` is to be checked by "a publisher whose clock steps back publishes on without a refusal, each batch claiming no earlier than the one before".
- `r_rotation` is to be checked by "a rotation in the middle of a chain is followed without a warning".
- `r_recovery` is about `identity`.
- `r_recovery` binds as `must`.
- `r_recovery` says "an offline recovery key, handed to the user once as a backup code, can revoke and replace a compromised key".
- `r_recovery` is stated in "best practice, recovery codes and pre-rotation".
- `r_recovery` is to be checked by "a stolen current key cannot rotate the identity away from its recovery key".
- `r_recovery` is to be checked by "a thief future-dating a rotation cannot lock out the recovery key".
- `r_no_future_docs` is about `identity`.
- `r_no_future_docs` binds as `must`.
- `r_no_future_docs` says "an identity document or a batch whose claimed time is later than its receipt plus the allowed clock skew is refused, and a document signed by the recovery key is ordered by the chain, never by its claimed time".
- `r_no_future_docs` is stated in "verification 2026-09-26: a rotation dated 2099 by a stolen key was accepted and then the owner's recovery was refused".
- `r_no_future_docs` is to be checked by "an identity document dated past the allowed skew is refused".
- `r_revocation_bound` is about `identity`.
- `r_revocation_bound` binds as `must`.
- `r_revocation_bound` says "after a key is revoked, a batch it signed is accepted only if it stands before the revocation in the chain or was received before the revocation".
- `r_revocation_bound` is stated in "PROTOCOL.md#1.2".
- `r_revocation_bound` is to be checked by "a backdated batch received after revocation is rejected".
- `r_domain_vouch` is about `identity`.
- `r_domain_vouch` binds as `should`.
- `r_domain_vouch` says "optionally, a node whose operator turns it on lets the domain of a user@domain identity vouch for its first key: the domain publishes the identity's first document at https://domain/.well-known/roflenox/<local part, percent-encoded>, and that answer pins first contact the way an invitation link does; off by default".
- `r_domain_vouch` says "a domain vouches only for names under it, only over HTTPS with a valid certificate and no redirect to another host, and only for first contact: it never replaces a key already pinned, which still changes only by a rotation signed by the key or the recovery key".
- `r_domain_vouch` is stated in "owner 2026-09-27: add domain vouching as an optional variant".
- `r_domain_vouch` is to be checked by "with domain vouching on, a first contact with user@domain pins the key its domain publishes over HTTPS, and with it off the same contact needs an invitation".
- `r_domain_vouch` is to be checked by "a domain vouches for no name outside it, never over plain HTTP or across a redirect to another host, and never replaces an already pinned key".
- `r_domain_vouch` says "the node asks only public DNS names: the domain of user@domain must be a multi-label DNS name, never an IP literal or a single label like localhost; every address it resolves to must be public (not loopback, private, link-local, unique-local, shared or multicast), and the connection goes to the address that was checked, never a fresh resolution".
- `r_domain_vouch` says "domain lookups are bounded: at most a few at a time per node, and each answer, including no answer, is cached for minutes, so first contacts cannot turn the node into a flood or a scanner".
- `r_domain_vouch` is to be checked by "an anonymous first contact as user@127.0.0.1, user@localhost or a user at a name resolving to a private address makes no outbound connection".
- `r_domain_vouch` is to be checked by "a flood of first contacts naming many domains opens a bounded number of domain lookups at a time and repeats none within the cache time".
- `r_domain_vouch` says "an IPv6 address is public only inside global unicast 2000::/3 and outside the IANA special blocks 2001::/23 and 2002::/16 (an allow-list, not a deny-list), so NAT64, 6to4, IPv4-compatible and Teredo forms of an internal IPv4 are never public".
- `r_domain_vouch` is to be checked by "an internal IPv4 written in any IPv6 form, NAT64, 6to4, IPv4-compatible or mapped, is not a public address".
- `r_key_change_loud` is about `identity`.
- `r_key_change_loud` binds as `must`.
- `r_key_change_loud` says "first contact is bootstrapped over HTTPS and pinned; a key that changes without a signed rotation stops the pull and says why".
- `r_key_change_loud` is stated in "best practice, SSH known_hosts and did:web".
- `r_key_change_loud` says "without HTTPS first contact needs an invitation link that carries the key id; the user copies a link and never sees a key; a plain-HTTP first contact without one is refused".
- `r_key_change_loud` is to be checked by "a first contact over plain HTTP is refused without an invitation link and pins with one whose key id matches".
- `r_key_change_loud` says "a node pins an identity it does not know only on its operator's word or a delegation from an identity it already pins; an anonymous write, introduction or pushed feed naming an unknown identity is refused and pins nothing".
- `r_key_change_loud` is to be checked by "an identity nobody vouched for cannot be pinned by writing, introducing or pushing a feed, and the invited pull of the real one still pins".
- `r_key_change_loud` says "a delegation vouches only for a name under its parent, of the form label.parent, the way a DNS zone owns only its subdomains".
- `r_key_change_loud` is to be checked by "a delegation to a name outside the parent's own names pins nothing, and the invited pull of that name's real owner still pins".
- `r_key_change_loud` is to be checked by "a node that swaps its key without rotation is refused with a whynot".
- `r_grants` is about `access`.
- `r_grants` binds as `must`.
- `r_grants` says "access is a signed grant fact naming owner, recipient, scope and expiry; a request is signed by the recipient; there are no sessions and no user table".
- `r_grants` is stated in "owner 2026-09-26".
- `r_grants` is to be checked by "a request signed by an identity with no grant is refused and whynot names the missing grant".
- `r_default_deny` is about `access`.
- `r_default_deny` binds as `must`.
- `r_default_deny` says "nothing leaves a node unless an export rule derives it, and the leak audit runs before signing".
- `r_default_deny` is stated in "owner 2026-09-26".
- `r_default_deny` is to be checked by "a fact with no export rule never appears in a published batch".
- `r_default_deny` is to be checked by "an anonymous caller of every open endpoint learns the node's own name and liveness and nothing about the identities, facts or batches it holds".
- `r_withheld_unguessable` is about `access`.
- `r_withheld_unguessable` binds as `must`.
- `r_withheld_unguessable` says "a withheld batch reveals nothing that confirms a guess of its content: its digest commits to a secret random salt that travels only with the content".
- `r_withheld_unguessable` is stated in "verification 2026-09-26: an anonymous reader confirmed a withheld salary by hashing guesses".
- `r_withheld_unguessable` is to be checked by "a guessed secret cannot be confirmed from a withheld manifest".
- `r_sig_behind_proxy` is about `access`.
- `r_sig_behind_proxy` binds as `must`.
- `r_sig_behind_proxy` says "a signed request verifies behind a TLS-terminating proxy: the node takes the scheme and authority of @target-uri from its configured public base URL, never from the request".
- `r_sig_behind_proxy` is stated in "verification 2026-09-26: @target-uri was built as http plus the Host header".
- `r_sig_behind_proxy` is to be checked by "a request signed for the public https URL verifies at a node listening on plain http behind a proxy".
- `r_encrypt_private` is about `access`.
- `r_encrypt_private` binds as `must`.
- `r_encrypt_private` says "a private batch is encrypted to its recipients with X25519, HKDF and AES-256-GCM, so it can sit on dumb static hosting that cannot read it".
- `r_encrypt_private` is stated in "best practice, age and HPKE".
- `r_encrypt_private` is to be checked by "a static host holding a private batch cannot decrypt it, a recipient can".
- `r_offline_admission` is about `identity`.
- `r_offline_admission` binds as `must`.
- `r_offline_admission` says "freshness is checked only on live channels; a batch arriving through a static host or a sealed envelope is judged by the validity of its key at the claimed time against the reader's freshest identity chain, and a repeat is only a duplicate".
- `r_offline_admission` is stated in "implementation finding 2026-09-26: a recipient opening an envelope after the freshness window got stale".
- `r_offline_admission` is to be checked by "a sealed batch opened a day later is admitted, and one signed by a key revoked before it was sealed is refused".
- `r_mutation_gate` is about `architecture`.
- `r_mutation_gate` binds as `must`.
- `r_mutation_gate` is to be checked by "every test file exits on its own without force-exit, leaving no engine process behind".
- `r_mutation_gate` is to be checked by "a failing mutant shard fails the whole mutant gate".
- `r_mutation_gate` says "before any mutant, the gate runs every named red test on the unmutated tree; a red test that already fails there is a broken baseline and fails the gate, never counting as a kill".
- `r_mutation_gate` is to be checked by "a mutant whose red test already fails on the unmutated tree is reported as a broken baseline, never as killed".
- `r_mutation_gate` is to be checked by "the hermetic suite passes five runs in a row, and a nested failure prints the failing test's own error".
- `r_mutation_gate` says "the mutation harness lives in the repository and runs as a gate: every listed mutant must turn at least one test red, except the ones marked as surviving by design with a reason".
- `r_mutation_gate` is stated in "owner rule: a gate that never said no is an assumption".
- `r_mutation_gate` is to be checked by "the mutation gate fails when a listed mutant survives".

> Решения по итогам проверки (2026-09-26): допустимое расхождение часов
> для документов и батчей из будущего равно окну свежести (300 с);
> соль батча — 32 байта base64url, живёт в квитанции и путешествует только
> с содержимым; `count` в скрытом манифесте остаётся видимым (сколько
> фактов, но не какие) — издатель может дополнять батчи; публичный URL задаёт
> только схему и хост, путь берётся из запроса; окно чекпоинта 24 ч,
> статическая копия — анонимный публичный фид.

Kinds of the requirements:

- `r_mirror_old_batches` is of `feature`.
- `r_static_feed` is of `feature`.
- `r_identity_names` is of `feature`.
- `r_keys_automatic` is of `feature`.
- `r_reattest` is of `feature`.
- `r_rotation` is of `feature`.
- `r_recovery` is of `feature`.
- `r_offline_admission` is of `feature`.
- `r_mcp_adapter` is of `feature`.
- `r_grants` is of `feature`.
- `r_encrypt_private` is of `feature`.
- `r_backup` is of `feature`.
- `r_substrate_independent` is of `feature`.
- `r_verify_without_author` is of `feature`.
- `r_revocation_receipt` is of `feature`.
- `r_ask_explain` is of `feature`.
- `r_user_rules` is of `feature`.
- `r_intent_loop` is of `feature`.
- `r_agents_as_identities` is of `feature`.
- `r_follow` is of `feature`.
- `r_local_stdio` is of `feature`.
- `r_semantic_search` is of `feature`.
- `r_uc_observability` is of `feature`.
- `r_foreign_rules_opt_in` is of `security`.
- `r_foreign_rules_opt_in` resists "an author whose book this node holds, who wants its code run here by mirror, by posting, or through a delegate".
- `r_rule_budget` is of `reliability`.
- `r_answer_limits` is of `reliability`.
- `r_import` is of `feature`.
- `r_enox_compat` is of `feature`.
- `r_signed_batch` is of `security`.
- `r_signed_batch` resists "anyone on the path, who alters a batch or reuses its signature in another protocol".
- `r_chain` is of `security`.
- `r_chain` resists "a publisher or a mirror that reorders, drops or rewrites history within one identity".
- `r_admit_by_signer` is of `security`.
- `r_admit_by_signer` resists "any signer, through any admitting op, who wants a fact to land in another identity's book".
- `r_freshness` is of `security`.
- `r_freshness` resists "a replayer holding an old validly signed batch".
- `r_no_future_docs` is of `security`.
- `r_no_future_docs` resists "a signer who dates a document ahead to outlive a later revocation or rotation".
- `r_revocation_bound` is of `security`.
- `r_revocation_bound` resists "the holder of a stolen and since revoked key, who backdates new batches".
- `r_key_change_loud` is of `security`.
- `r_domain_vouch` is of `security`.
- `r_key_change_loud` resists "anyone, including an identity this node already trusts, who wants a name here pinned to a key its owner does not hold".
- `r_domain_vouch` resists "whoever controls the domain's DNS or web server, or the network between nodes, trying to pin a key the user does not hold, and the domain's owner trying to take over an identity already pinned".
- `r_domain_vouch` resists "an anonymous caller who names crafted domains to make the node connect to internal addresses or to flood outbound lookups".
- `r_default_deny` is of `security`.
- `r_default_deny` resists "an anonymous or granted caller of ANY endpoint, who wants to learn what no export rule derives, facts or metadata".
- `r_withheld_unguessable` is of `security`.
- `r_withheld_unguessable` resists "a reader of a withheld manifest who guesses its content".
- `r_challenge_stateless` is of `security`.
- `r_challenge_stateless` resists "a flooder who wants to exhaust memory or deny honest mirrors".
- `r_uri_prefix_stable` is of `reliability`.
- `r_snapshot_is_cache` is of `reliability`.
- `r_executors_off_read_path` is of `reliability`.
- `r_sig_behind_proxy` is of `reliability`.
- `r_bounded_memory` is of `reliability`.
- `r_session_eviction` is of `reliability`.
- `r_batch_write` is of `reliability`.
- `r_no_silent_reset` is of `reliability`.
- `r_engine_crash_recovery` is of `reliability`.
- `r_atomic_write` is of `reliability`.
- `r_derived_rebuildable` is of `reliability`.
- `r_log_is_truth` is of `constraint`.
- `r_zero_deps` is of `constraint`.
- `r_core_without_executors` is of `constraint`.
- `r_minimal_parts` is of `constraint`.
- `r_interface_parity` is of `constraint`.
- `r_mutation_gate` is of `gate`.
- `r_typed` is of `gate`.
- `r_compat_parity` is of `feature`.
- `r_single_writer` is of `reliability`.
- `r_no_orphan_tests` is of `gate`.
- `r_balanced` is of `gate`.
- `r_relation_primary` is of `model`.
- `r_asserted_by` is of `model`.
- `r_fact_id_derived` is of `model`.
- `r_confidence` is of `model`.
- `r_perspective` is of `model`.

> Решение 2026-09-27 по реальным данным (импорт 22371 сущности, 162245
> фактов): снапшот движка открывается за 74–80 с, повтор журнала — за 15.5 с,
> поэтому снапшоты убираются как лишняя движущаяся часть; допуск форком с
> полным пересчётом стоит около 3.4 с на батч из 2000 фактов — нужен
> инкрементальный пересчёт; rofl-serve (ветка spat-rust, ee6aaac) дважды
> падал с паникой в store.rs на пути форк-на-батч — дефект движка, у узла
> своя защита.

> Решение 2026-09-27 (перепись частей): токен оператора остаётся как
> единственное объявленное исключение из «одного доказательства кто» —
> коннекторы claude.ai не подписывают запросы по RFC 9421. Он действует
> только от имени идентичности узла. Направление: выразить его через
> делегирование — токен выбирает делегированного агента, чей ключ держит
> узел, и исключение исчезает.

## Очередь и приёмка

> Поправка 2026-09-27: при отказе r_relation_primary ведущий утверждал, что
> клиент и узел расходились на U+200B; на деле клиент бросил на BOM (trim его
> срезает), расхождения не было — исполнитель прав. Сама находка (узел
> принимал U+200B и U+202E) была верной.
>
> Приёмка 81647a8 (2026-09-27): crash — оба теста и исходная проба ведущего
> (503 вместо пустого ответа); reopen 200k — 23.4 с при нагрузке 24, но 30.5 с
> при нагрузке выше 40: порог близок к пределу на нагруженной 4-ядерной машине.
>
> Пишет только ведущий. Ранг — порядок работ (меньше — раньше); приёмка —
> после независимой проверки ведущим ревизии, которую исполнитель объявил
> сделанной. Доска `spec/work/board.rofl.md` выводит из этого `next`,
> `in progress` и `awaits review`.

The queue:

- `r_session_eviction` is queued at 45.
- `r_bounded_memory` is queued at 47.
- `r_relation_primary` is queued at 48.
- `r_derived_rebuildable` is queued at 51.
- `r_uri_prefix_stable` is queued at 44.
- `r_engine_crash_recovery` is queued at 10.
- `r_foreign_rules_opt_in` is queued at 20.
- `r_snapshot_is_cache` is queued at 30.
- `r_batch_write` is queued at 40.
- `r_semantic_search` is queued at 50.
- `r_uc_observability` is queued at 60.
- `r_rule_budget` is queued at 5.
- `r_answer_limits` is queued at 6.
- `r_key_change_loud` is queued at 70.
- `r_atomic_write` is queued at 71.
- `r_asserted_by` is queued at 72.
- `r_revocation_receipt` is queued at 73.
- `r_rotation` is queued at 74.
- `r_static_feed` is queued at 75.
- `r_identity_names` is queued at 76.
- `r_default_deny` is queued at 77.
- `r_chain` is queued at 78.
- `r_backup` is queued at 79.
- `r_confidence` is queued at 69.
- `r_enox_compat` is queued at 80.
- `r_no_orphan_tests` is queued at 76.
- `r_freshness` is queued at 77.
- `r_domain_vouch` is queued at 82.
- `r_single_writer` is queued at 83.
- `r_compat_parity` is queued at 84.
- `r_mutation_gate` is queued at 73.
- `r_key_change_loud` is rejected at "a4a880b53bf0dd24e6e071c3a3f509457e7682a3".
- `r_atomic_write` is rejected at "4cc3e06f8ea18e959c23b43e7a052a4cb697e1b1".
- `r_key_change_loud` is rejected at "6bfb1bbf0121614ca309293042adf2231ecc31d1".
- `r_atomic_write` is accepted at "cb8730b753d33b9d28115ad4db650776d2c5a154".
- `r_key_change_loud` is accepted at "2873ca82a93a210e7954cd7dc7e6d9f33d604569".
- `r_asserted_by` is accepted at "47c198a247231c85bf38ef70395a3fb9514f5306".
- `r_confidence` is accepted at "27f4b5e57621eae2ebf937f99d7cf3540c766a1e".
- `r_revocation_receipt` is accepted at "85443bd2b257d98972e1de35b2ad3b5feace3e36".
- `r_static_feed` is accepted at "c42404137f12fcbf7962f8fc936c480bb83f3e13".
- `r_default_deny` is accepted at "a1bb4a0d379138676deab6a7b2bf05915362a5f7".
- `r_chain` is accepted at "68809976741d5ab863ba19d57a9920566d4afa60".
- `r_backup` is accepted at "d8f57a54ae23621d1c63757978d8ee7b69098e18".
- `r_enox_compat` is accepted at "047c616173ff5b28ed1f33cfb24ff4aec1d7febc".
- `r_mutation_gate` is accepted at "3ca019fb84ae9d2aaeea0979e21e86715ec0b8b8".
- `r_rotation` is accepted at "4f7c3617e44a355a89ed563c133438d5e58bd6fe".
- `r_identity_names` is accepted at "2db9e9f9d7518478a277e98369bccc38681654b1".
- `r_single_writer` is rejected at "3b85c6fa439a297cbabe1ac16852031c02a61370".
- `r_freshness` is accepted at "90c44041770a0cd1c0c83595b88f17c9a5e4519c".
- `r_no_orphan_tests` is accepted at "401323a64dfa1c3eea9ab4aea24143fc54818ed7".
- `r_domain_vouch` is accepted at "85a2cfc1bfc3969bc9de6f5c9ab62422faa255dd".
- `r_domain_vouch` is rejected at "806c6af8065554dfda58a02fa06d1e7f591fdc32".
- `r_domain_vouch` is rejected at "e63b41e1564229c02ffde8d8463f71ef03984823".
- `r_no_orphan_tests` is rejected at "2db9e9f9d7518478a277e98369bccc38681654b1".
- `r_identity_names` is rejected at "fd7980616c080677b958b90759493edde1012954".
- `r_no_orphan_tests` is rejected at "34572fa77b7e52c361d36c2d705e18285bf84bf2".
- `r_rotation` is rejected at "07e4c49652e4dc5c8277573a363ecbdeecb2ef6d".
- `r_identity_names` is rejected at "3afa102a9be65b5e69fc77ca7da2839d8684ba77".
- `r_enox_compat` is rejected at "63f344e6d8b0cc2c6b578bbd558a2dbaad21e357".
- `r_mutation_gate` is rejected at "b6b67403f2e7a5c645be914d5f45754273e77418".
- `r_identity_names` is rejected at "4800a6841d8476258cb98c07a16cfaf815353c4e".
- `r_rotation` is rejected at "db71b41d7281fe72aae5d4d4302303045a5fb4ce".

Rejected after verification:

- `r_uc_observability` is rejected at "ef2147d2f7ff0e6faa68971239964306da5a4c0d".
- `r_uc_observability` is rejected at "1ab2863c26a2db55074d9d7dbd4a72bcf4f46aa0".
- `r_uc_observability` is accepted at "6f0bfeb26babcdf43d877d105c1a011a8efec47f".
- `r_semantic_search` is rejected at "4170fad256ebfbac06d77bc0fefac9d2fac388d2".
- `r_relation_primary` is rejected at "c7f2ea68049192b5ad4dffb5164ae8ef10fd14a3".

Accepted after verification:

- `r_semantic_search` is accepted at "956f233fabf5c9d044be0bc18962e4fa0c3e15dd".
- `r_relation_primary` is accepted at "d04297a3de2013e18508beb00289d9be6e084164".
- `r_derived_rebuildable` is accepted at "4170fad256ebfbac06d77bc0fefac9d2fac388d2".
- `r_bounded_memory` is accepted at "fe6c2b55716d73ef8889f3d3ae57a74eae083063".
- `r_uri_prefix_stable` is accepted at "8a03765e17e2a44a75ec811bfe911c30e25c16d1".
- `r_session_eviction` is accepted at "4bed1e467dd5b09c5d04ffb0b83aa0fbb9d05056".
- `r_batch_write` is accepted at "f8d14237e81c0e829d003203764242f18727e336".
- `r_foreign_rules_opt_in` is accepted at "092801d551b6840886541f5d5d2249e5c2fae1eb".
- `r_engine_crash_recovery` is accepted at "81647a8c36ae605b2ffc51a449fb870dcf399d29".
- `r_snapshot_is_cache` is accepted at "81647a8c36ae605b2ffc51a449fb870dcf399d29".
- `r_rule_budget` is accepted at "roflenox tree verified 2026-09-27, rules.test.ts 3/3 under load 80".
- `r_answer_limits` is accepted at "roflenox tree verified 2026-09-27, suite 68/68".

> Решение 2026-09-27 по замерам на 200000 фактах: rofl-serve пересчитывает
> все выведенные факты при каждом evaluate (Eval::run → clear_derived), форк
> копирует весь мир. Поэтому, пока в движке нет инкрементального пересчёта:
> (A) допуск не пересчитывает — загрузка без форка, пересчёт лениво при
> первом чтении; (B) «последнее утверждение побеждает» делается при допуске
> через retract прежней строки, журнал хранит всё; (C) сроки грантов и
> делегирования сравниваются с часами в момент решения, whynot отказа —
> по-прежнему текст движка; (D) представление Enox поддерживается
> инкрементально. Пользовательские правила остаются в rofl. Как только в
> движке появится инкрементальный evaluate, системная логика возвращается в
> правила: это обход ограничения, а не принцип. Паника rofl-serve в
> store.rs:985 воспроизводится на синтетике примерно в одном прогоне из трёх
> (roflenox/scripts/engine-panic-repro.ts, docs/engine-panic.md).

### Находки по хостам 2026-09-26 (данные для r_uc_observability)

> Найдены ведущим вручную при инвентаризации парка. Имена хостов нейтральные.
> Каждая находка — какие факты хост публикует о себе и какой инвариант они
> нарушают. Приёмка r_uc_observability: правила над фидами этих фактов
> находят все четыре, `why` объясняет каждую, а хост с молчащим фидом даёт
> unknown, а не «всё в порядке».
>
> 1. proxy-host — демон вне юнита. Факты: юнит `vpn-userspace@wg0` enabled
>    = true, active = false; процесс `wg-userspace` запущен, его cgroup —
>    пользовательская сессия, а не system.slice. Инвариант: работающий
>    демон принадлежит включённому и активному юниту, иначе он не переживёт
>    перезагрузку.
> 2. proxy-host — противоречивая настройка ядра. Факты: файл
>    `60-cloud-network.conf` задаёт `net.ipv4.ip_forward` = 0, файл
>    `99-sysctl.conf` задаёт 1; действующее значение 1. Инвариант: файлы
>    настроек не противоречат друг другу по одному ключу (иначе итог
>    зависит от порядка применения).
> 3. old-node-host — цикл падений. Факты: контейнер `node-app` перезапущен
>    592 раза за 14 дней, все 592 — убийства по нехватке памяти (OOM).
>    Инвариант: не больше 3 перезапусков в сутки.
> 4. dev-host — прод-нагрузка на хосте разработки. Факты: роль хоста `dev`;
>    на нём работает под в пространстве имён `x-prod` с меткой окружения
>    `prod`. Инвариант: прод-нагрузка работает только на хостах с ролью
>    `prod`.
>
> Контроль: чистый хост `clean-host` с теми же видами фактов без нарушений
> не даёт ни одной находки.

## Проверки

> Проверки, которые реально есть: тесты `personal-node` на `origin/master` и тесты `roflenox/test`, привязанные по точному совпадению названия с `is to be checked by`. Проверка головы журнала в снапшоте — фильтр-оптимизация, не защита: её перекрывает сверка набора батчей (мутант M6 выживает).
> Проверка без файла — тоже находка.

The checks that exist:

- "a node whose imported ids sit under another URI prefix says so at startup" guards `r_uri_prefix_stable`.
- "a node whose imported ids sit under another URI prefix says so at startup" lives in "roflenox/test/import.test.ts".
- "a requirement with an unknown kind fails typing" guards `r_typed`.
- "a requirement with an unknown kind fails typing" lives in "spec/check.test.mjs".
- "flipping features to security past 3/2 fails balance" guards `r_balanced`.
- "flipping features to security past 3/2 fails balance" lives in "spec/check.test.mjs".
- "killing the engine during an admission leaves the log consistent, refuses that batch, and the node answers after it rebuilds" guards `r_engine_crash_recovery`.
- "killing the engine during an admission leaves the log consistent, refuses that batch, and the node answers after it rebuilds" lives in "roflenox/test/durability.test.ts".
- "killing the engine during an ask never yields a plain answer: the asker gets an error or unknown, and the next ask is answered" guards `r_engine_crash_recovery`.
- "killing the engine during an ask never yields a plain answer: the asker gets an error or unknown, and the next ask is answered" lives in "roflenox/test/durability.test.ts".
- "a batch of 2000 facts is admitted within one second with 200000 facts held" guards `r_batch_write`.
- "a batch of 2000 facts is admitted within one second with 200000 facts held" lives in "roflenox/test/perf/write.test.ts".
- "a rule published by alice derives facts in her book from bob's granted facts, and cannot conclude into bob's book" guards `r_user_rules`.
- "a rule published by alice derives facts in her book from bob's granted facts, and cannot conclude into bob's book" lives in "roflenox/test/rules.test.ts".
- "a mirrored rule does not run until the reader trusts its author for rules, and then it does" guards `r_foreign_rules_opt_in`.
- "a mirrored rule does not run until the reader trusts its author for rules, and then it does" lives in "roflenox/test/rules.test.ts".
- "an unbounded rule yields unknown with its budget named, and another identity's batch is admitted meanwhile without delay" guards `r_rule_budget`.
- "an unbounded rule yields unknown with its budget named, and another identity's batch is admitted meanwhile without delay" lives in "roflenox/test/rules.test.ts".
- "an answer longer than the limit is marked cut and the rest is fetched page by page to the same total" guards `r_answer_limits`.
- "an answer longer than the limit is marked cut and the rest is fetched page by page to the same total" lives in "roflenox/test/limits.test.ts".
- "a sub-agent is refused as soon as any identity above it in the delegation chain is" guards `r_agents_as_identities`.
- "a sub-agent is refused as soon as any identity above it in the delegation chain is" lives in "roflenox/test/agents.test.ts".
- "a follower converges to the publisher's head after new batches without a manual pull" guards `r_follow`.
- "a follower converges to the publisher's head after new batches without a manual pull" lives in "roflenox/test/follow.test.ts".
- "an Enox read right after a write answers within one second with 200000 facts held" guards `r_enox_compat`.
- "an Enox read right after a write answers within one second with 200000 facts held" lives in "roflenox/test/perf/write.test.ts".
- "a node holding 200000 facts reopens from its log within 30 seconds" guards `r_snapshot_is_cache`.
- "a node holding 200000 facts reopens from its log within 30 seconds" lives in "roflenox/test/perf/reopen.test.ts".
- "an MCP client lists the tools, asserts a fact, and asks it back with why, all under the node's access rules" guards `r_mcp_adapter`.
- "an MCP client lists the tools, asserts a fact, and asks it back with why, all under the node's access rules" lives in "roflenox/test/mcp.test.ts".
- "why names the facts and the rule an answer stands on, and whynot names the missing premise" guards `r_ask_explain`.
- "why names the facts and the rule an answer stands on, and whynot names the missing premise" lives in "roflenox/test/rules.test.ts".
- "an intent derived by a rule is answered by an executor and why of the result reaches the rule" guards `r_intent_loop`.
- "an intent derived by a rule is answered by an executor and why of the result reaches the rule" lives in "roflenox/test/executor.test.ts".
- "a delegated agent key publishes until its expiry and is refused after it" guards `r_agents_as_identities`.
- "a delegated agent key publishes until its expiry and is refused after it" lives in "roflenox/test/agents.test.ts".
- "the same data directory answers the same over stdio and over HTTP" guards `r_local_stdio`.
- "the same data directory answers the same over stdio and over HTTP" lives in "roflenox/test/stdio.test.ts".
- "importing an Enox snapshot twice gives the same log head and every imported assertion answers by ask with its original author" guards `r_import`.
- "importing an Enox snapshot twice gives the same log head and every imported assertion answers by ask with its original author" lives in "roflenox/test/import.test.ts".
- "the tool calls an Enox client made on 2026-09-26 run unchanged against a node and get answers of the same shape" guards `r_enox_compat`.
- "the tool calls an Enox client made on 2026-09-26 run unchanged against a node and get answers of the same shape" lives in "roflenox/test/enox.test.ts".
- "a census of the source finds no second store, queue, wire format or proof of who" guards `r_minimal_parts`.
- "a census of the source finds no second store, queue, wire format or proof of who" lives in "roflenox/test/census.test.ts".
- "every operation in the table is reachable with the same name and schema over MCP, CLI and HTTP, and nothing outside the table is" guards `r_interface_parity`.
- "every operation in the table is reachable with the same name and schema over MCP, CLI and HTTP, and nothing outside the table is" lives in "roflenox/test/parity.test.ts".
- "re-asserting a fact with a new confidence leaves exactly one confidence for that identity, the latest" guards `r_confidence`.
- "re-asserting a fact with a new confidence leaves exactly one confidence for that identity, the latest" lives in "roflenox/test/model.test.ts".
- "a question restricted to one perspective sees only the facts asserted under it" guards `r_perspective`.
- "a question restricted to one perspective sees only the facts asserted under it" lives in "roflenox/test/model.test.ts".
- "a committed log file that cannot be read stops the node instead of an empty start" guards `r_no_silent_reset`.
- "a committed log file that cannot be read stops the node instead of an empty start" lives in "roflenox/test/durability.test.ts".
- "a node rebuilt from its latest backup answers every question the same as the node up to that backup" guards `r_backup`.
- "a node rebuilt from its latest backup answers every question the same as the node up to that backup" lives in "roflenox/test/durability.test.ts".
- "a feed copied to a static directory mirrors under a fresh checkpoint and is refused under an expired one" guards `r_substrate_independent`.
- "a feed copied to a static directory mirrors under a fresh checkpoint and is refused under an expired one" lives in "roflenox/test/freshness.test.ts".
- "a feed copied to a static directory mirrors under a fresh checkpoint and is refused under an expired one" guards `r_verify_without_author`.
- "a feed copied to a static directory mirrors under a fresh checkpoint and is refused under an expired one" lives in "roflenox/test/freshness.test.ts".
- "an ask answers within one second while an executor saturates its CPU budget" guards `r_executors_off_read_path`.
- "an ask answers within one second while an executor saturates its CPU budget" lives in "roflenox/test/executor.test.ts".
- "a flood of challenge requests neither grows memory nor stops an honest mirror" guards `r_challenge_stateless`.
- "a flood of challenge requests neither grows memory nor stops an honest mirror" lives in "roflenox/test/freshness.test.ts".
- "a batch a week old mirrors from a live peer, and the same feed replayed without a fresh challenge is refused" guards `r_mirror_old_batches`.
- "a batch a week old mirrors from a live peer, and the same feed replayed without a fresh challenge is refused" lives in "roflenox/test/freshness.test.ts".
- "a feed copied to a static directory mirrors under a fresh checkpoint and is refused under an expired one" guards `r_static_feed`.
- "a feed copied to a static directory mirrors under a fresh checkpoint and is refused under an expired one" lives in "roflenox/test/freshness.test.ts".
- "a fresh install that publishes a signed batch with no manual key step" guards `r_keys_automatic`.
- "a fresh install that publishes a signed batch with no manual key step" lives in "roflenox/test/keys.test.ts".
- "a re-attested batch keeps its digest and gains a second, fresh signature" guards `r_reattest`.
- "a re-attested batch keeps its digest and gains a second, fresh signature" lives in "roflenox/test/freshness.test.ts".
- "a rotation in the middle of a chain is followed without a warning" guards `r_rotation`.
- "a rotation in the middle of a chain is followed without a warning" lives in "roflenox/test/keys.test.ts".
- "a stolen current key cannot rotate the identity away from its recovery key" guards `r_recovery`.
- "a stolen current key cannot rotate the identity away from its recovery key" lives in "roflenox/test/keys.test.ts".
- "a thief future-dating a rotation cannot lock out the recovery key" guards `r_recovery`.
- "a thief future-dating a rotation cannot lock out the recovery key" lives in "roflenox/test/keys.test.ts".
- "an identity document dated past the allowed skew is refused" guards `r_no_future_docs`.
- "an identity document dated past the allowed skew is refused" lives in "roflenox/test/keys.test.ts".
- "a backdated batch received after revocation is rejected" guards `r_revocation_bound`.
- "a backdated batch received after revocation is rejected" lives in "roflenox/test/keys.test.ts".
- "a node that swaps its key without rotation is refused with a whynot" guards `r_key_change_loud`.
- "a node that swaps its key without rotation is refused with a whynot" lives in "roflenox/test/keys.test.ts".
- "a request signed by an identity with no grant is refused and whynot names the missing grant" guards `r_grants`.
- "a request signed by an identity with no grant is refused and whynot names the missing grant" lives in "roflenox/test/access.test.ts".
- "a fact with no export rule never appears in a published batch" guards `r_default_deny`.
- "a fact with no export rule never appears in a published batch" lives in "roflenox/test/access.test.ts".
- "a guessed secret cannot be confirmed from a withheld manifest" guards `r_withheld_unguessable`.
- "a guessed secret cannot be confirmed from a withheld manifest" lives in "roflenox/test/access.test.ts".
- "a request signed for the public https URL verifies at a node listening on plain http behind a proxy" guards `r_sig_behind_proxy`.
- "a request signed for the public https URL verifies at a node listening on plain http behind a proxy" lives in "roflenox/test/access.test.ts".
- "a static host holding a private batch cannot decrypt it, a recipient can" guards `r_encrypt_private`.
- "a static host holding a private batch cannot decrypt it, a recipient can" lives in "roflenox/test/private.test.ts".
- "a sealed batch opened a day later is admitted, and one signed by a key revoked before it was sealed is refused" guards `r_offline_admission`.
- "a sealed batch opened a day later is admitted, and one signed by a key revoked before it was sealed is refused" lives in "roflenox/test/private.test.ts".
- "the mutation gate fails when a listed mutant survives" guards `r_mutation_gate`.
- "the mutation gate fails when a listed mutant survives" lives in "roflenox/test/gate.test.ts".
- "fact_id equals SHA-256 of the RFC 8785 serialisation of [source, relation, target] for a fixed vector" guards `r_fact_id_derived`.
- "fact_id equals SHA-256 of the RFC 8785 serialisation of [source, relation, target] for a fixed vector" lives in "roflenox/test/canonical.test.ts".
- "delete everything except the log, restart, and every ask returns the same answers" guards `r_log_is_truth`.
- "delete everything except the log, restart, and every ask returns the same answers" lives in "roflenox/test/durability.test.ts".
- "package.json declares no dependencies" guards `r_zero_deps`.
- "package.json declares no dependencies" lives in "roflenox/test/hermetic.test.ts".
- "the full test suite passes with no network and no model files" guards `r_core_without_executors`.
- "the full test suite passes with no network and no model files" lives in "roflenox/test/hermetic5/hermetic5.test.ts".
- "an end-to-end pull between two nodes whose transcript contains no key material" guards `r_identity_names`.
- "an end-to-end pull between two nodes whose transcript contains no key material" lives in "roflenox/test/federation.test.ts".
- "a batch with one byte changed is rejected" guards `r_signed_batch`.
- "a batch with one byte changed is rejected" lives in "roflenox/test/admission.test.ts".
- "a batch inserted into the middle of a chain is rejected" guards `r_chain`.
- "a batch inserted into the middle of a chain is rejected" lives in "roflenox/test/admission.test.ts".
- "a batch whose prev was rewritten after signing is rejected" guards `r_chain`.
- "a batch whose prev was rewritten after signing is rejected" lives in "roflenox/test/admission.test.ts".
- "a batch signed by B that writes into the book of A is refused" guards `r_admit_by_signer`.
- "a batch signed by B that writes into the book of A is refused" lives in "roflenox/test/admission.test.ts".
- "a batch claiming a time outside the window is marked stale and a re-attestation is requested" guards `r_freshness`.
- "a batch claiming a time outside the window is marked stale and a re-attestation is requested" lives in "roflenox/test/admission.test.ts".
- "auth: missing/wrong token -> 401, revoked -> 410, expired -> 410" guards `r_revocation_receipt`.
- "auth: missing/wrong token -> 401, revoked -> 410, expired -> 410" lives in "personal-node/src/shares/shares.test.ts".
- "manifest paths 410 once a share is revoked, including an unknown subpath" guards `r_revocation_receipt`.
- "manifest paths 410 once a share is revoked, including an unknown subpath" lives in "personal-node/src/shares/shares.test.ts".
- "a batch line that is not a relation between two entities is refused" guards `r_relation_primary`.
- "a batch line that is not a relation between two entities is refused" lives in "roflenox/test/admission.test.ts".
- "a name made only of invisible or text-direction characters is refused, the same way by the client and the node" guards `r_relation_primary`.
- "a name made only of invisible or text-direction characters is refused, the same way by the client and the node" lives in "roflenox/test/admission.test.ts".
- "every admitted fact reads back asserted by the identity that signed its batch, whatever the batch claims" guards `r_asserted_by`.
- "every admitted fact reads back asserted by the identity that signed its batch, whatever the batch claims" lives in "roflenox/test/enox.test.ts".
- "each control fact retired at confidence 0 stops acting: a retired grant reads nothing, a retired delegation vouches for nobody and stops its agent, a retired rule derives nothing, a retired export publishes nothing" guards `r_confidence`.
- "each control fact retired at confidence 0 stops acting: a retired grant reads nothing, a retired delegation vouches for nobody and stops its agent, a retired rule derives nothing, a retired export publishes nothing" lives in "roflenox/test/model.test.ts".
- "a node killed at each write step reopens with the whole batch or none of it" guards `r_atomic_write`.
- "a node killed at each write step reopens with the whole batch or none of it" lives in "roflenox/test/durability.test.ts".
- "a backup killed between any two of its steps leaves a readable backup at the latest path" guards `r_atomic_write`.
- "a backup killed between any two of its steps leaves a readable backup at the latest path" lives in "roflenox/test/durability.test.ts".
- "a meaning search returns a fact after the embedder answers its intent, and the core answers the same with the embedder absent" guards `r_derived_rebuildable`.
- "a meaning search returns a fact after the embedder answers its intent, and the core answers the same with the embedder absent" lives in "roflenox/test/search.test.ts".
- "a node holding 200000 facts stays under 1.5 GB of resident memory while idle" guards `r_bounded_memory`.
- "a node holding 200000 facts stays under 1.5 GB of resident memory while idle" lives in "roflenox/test/perf/memory.test.ts".
- "the MCP endpoint issues no session id and keeps no state per client" guards `r_session_eviction`.
- "the MCP endpoint issues no session id and keeps no state per client" lives in "roflenox/test/mcp.test.ts".
- "a revoked grant answers 410 on the next read, while facts read before the revocation still verify against their batch digest" guards `r_revocation_receipt`.
- "a revoked grant answers 410 on the next read, while facts read before the revocation still verify against their batch digest" lives in "roflenox/test/access.test.ts".
- "a meaning search returns a fact after the embedder answers its intent, and the core answers the same with the embedder absent" guards `r_semantic_search`.
- "a meaning search returns a fact after the embedder answers its intent, and the core answers the same with the embedder absent" lives in "roflenox/test/search.test.ts".
- "a meaning search finds a fact that shares none of the query's words" guards `r_semantic_search`.
- "a meaning search finds a fact that shares none of the query's words" lives in "roflenox/executors/embedder/test/meaning.test.ts".
- "a search the operator asks is never published by a wildcard export" guards `r_semantic_search`.
- "a search the operator asks is never published by a wildcard export" lives in "roflenox/test/search.test.ts".
- "rules over host feeds rediscover the four host findings of 2026-09-26 and explain each with why" guards `r_uc_observability`.
- "rules over host feeds rediscover the four host findings of 2026-09-26 and explain each with why" lives in "roflenox/test/observability.test.ts".
- "a fleet rule written once covers every followed host, including a host followed after the rule was written" guards `r_uc_observability`.
- "a fleet rule written once covers every followed host, including a host followed after the rule was written" lives in "roflenox/test/observability.test.ts".
- "a followed feed that no rule reads is reported as unknown, never as all-clear" guards `r_uc_observability`.
- "a followed feed that no rule reads is reported as unknown, never as all-clear" lives in "roflenox/test/observability.test.ts".
- "a follow retired with confidence 0 stops every rule ranging over that host's book" guards `r_uc_observability`.
- "a follow retired with confidence 0 stops every rule ranging over that host's book" lives in "roflenox/test/observability.test.ts".
- "a first contact over plain HTTP is refused without an invitation link and pins with one whose key id matches" guards `r_key_change_loud`.
- "a first contact over plain HTTP is refused without an invitation link and pins with one whose key id matches" lives in "roflenox/test/keys.test.ts".
- "an identity nobody vouched for cannot be pinned by writing, introducing or pushing a feed, and the invited pull of the real one still pins" guards `r_key_change_loud`.
- "an identity nobody vouched for cannot be pinned by writing, introducing or pushing a feed, and the invited pull of the real one still pins" lives in "roflenox/test/keys.test.ts".
- "a delegation to a name outside the parent's own names pins nothing, and the invited pull of that name's real owner still pins" guards `r_key_change_loud`.
- "a delegation to a name outside the parent's own names pins nothing, and the invited pull of that name's real owner still pins" lives in "roflenox/test/keys.test.ts".
- "RFC 8785 appendix B: number serialisation vectors" guards `r_signed_batch`.
- "RFC 8785 appendix B: number serialisation vectors" lives in "roflenox/test/canonical.test.ts".
- "RFC 8785 section 3.2.2: the example object canonicalises exactly" guards `r_signed_batch`.
- "RFC 8785 section 3.2.2: the example object canonicalises exactly" lives in "roflenox/test/canonical.test.ts".
- "RFC 8785 section 3.2.3: members sort by UTF-16 code units" guards `r_signed_batch`.
- "RFC 8785 section 3.2.3: members sort by UTF-16 code units" lives in "roflenox/test/canonical.test.ts".
- "batch digest is SHA-256 of the salt followed by the JSONL bytes" guards `r_signed_batch`.
- "batch digest is SHA-256 of the salt followed by the JSONL bytes" lives in "roflenox/test/canonical.test.ts".
- "a batch whose JSONL is not canonical is refused, naming the line" guards `r_signed_batch`.
- "a batch whose JSONL is not canonical is refused, naming the line" lives in "roflenox/test/admission.test.ts".
- "createAssertion requires asserted_by: a batch with no identity or signature is not admitted" guards `r_admit_by_signer`.
- "createAssertion requires asserted_by: a batch with no identity or signature is not admitted" lives in "roflenox/test/admission.test.ts".
- "negation over an ungranted book is no oracle" guards `r_default_deny`.
- "negation over an ungranted book is no oracle" lives in "roflenox/test/rules.test.ts".
- "a key file that is not the identity the log knows stops the node" guards `r_key_change_loud`.
- "a key file that is not the identity the log knows stops the node" lives in "roflenox/test/durability.test.ts".
- "a checkpoint one second past the window is refused and one second inside it mirrors" guards `r_static_feed`.
- "a checkpoint one second past the window is refused and one second inside it mirrors" lives in "roflenox/test/freshness.test.ts".
- "an anonymous caller of every open endpoint learns the node's own name and liveness and nothing about the identities, facts or batches it holds" guards `r_default_deny`.
- "an anonymous caller of every open endpoint learns the node's own name and liveness and nothing about the identities, facts or batches it holds" lives in "roflenox/test/access.test.ts".
- "a node given a second signed successor of the same batch keeps both signatures as fork proof and marks every answer over that book" guards `r_chain`.
- "a node given a second signed successor of the same batch keeps both signatures as fork proof and marks every answer over that book" lives in "roflenox/test/admission.test.ts".
- "a backup syncs every file and directory it holds before it becomes the latest" guards `r_backup`.
- "a backup syncs every file and directory it holds before it becomes the latest" lives in "roflenox/test/durability.test.ts".
- "an agent label given to an Enox write reads back as claimed_by next to the signing identity, and a forged label changes nothing but claimed_by" guards `r_enox_compat`.
- "an agent label given to an Enox write reads back as claimed_by next to the signing identity, and a forged label changes nothing but claimed_by" lives in "roflenox/test/enox.test.ts".
- "a claimed label holding brackets, a newline or 5000 characters can neither forge a signer nor add a line to a text view" guards `r_enox_compat`.
- "a claimed label holding brackets, a newline or 5000 characters can neither forge a signer nor add a line to a text view" lives in "roflenox/test/enox.test.ts".
- "every test file exits on its own without force-exit, leaving no engine process behind" guards `r_mutation_gate`.
- "every test file exits on its own without force-exit, leaving no engine process behind" lives in "roflenox/test/hermetic5/hermetic5.test.ts".
- "a failing mutant shard fails the whole mutant gate" guards `r_mutation_gate`.
- "a failing mutant shard fails the whole mutant gate" lives in "roflenox/test/gate.test.ts".
- "a mutant whose red test already fails on the unmutated tree is reported as a broken baseline, never as killed" guards `r_mutation_gate`.
- "a mutant whose red test already fails on the unmutated tree is reported as a broken baseline, never as killed" lives in "roflenox/test/gate.test.ts".
- "the hermetic suite passes five runs in a row, and a nested failure prints the failing test's own error" guards `r_mutation_gate`.
- "the hermetic suite passes five runs in a row, and a nested failure prints the failing test's own error" lives in "roflenox/test/hermetic5/hermetic5.test.ts".
- "a batch signed after its key's invalid_from is refused, and one dated 301 seconds past its receipt is refused as future-dated" guards `r_rotation`.
- "a batch signed after its key's invalid_from is refused, and one dated 301 seconds past its receipt is refused as future-dated" lives in "roflenox/test/keys.test.ts".
- "after a batch signed by the new key, a batch signed by the rotated key is refused whatever time it claims, and a batch claiming a time earlier than its predecessor is refused" guards `r_rotation`.
- "after a batch signed by the new key, a batch signed by the rotated key is refused whatever time it claims, and a batch claiming a time earlier than its predecessor is refused" lives in "roflenox/test/keys.test.ts".
- "a publisher whose clock steps back publishes on without a refusal, each batch claiming no earlier than the one before" guards `r_rotation`.
- "a publisher whose clock steps back publishes on without a refusal, each batch claiming no earlier than the one before" lives in "roflenox/test/keys.test.ts".
- "a node killed at each point of a later batch restarts with it or at the previous head" guards `r_atomic_write`.
- "a node killed at each point of a later batch restarts with it or at the previous head" lives in "roflenox/test/durability.test.ts".
- "two nodes: publish on A, mirror into B, identical ask answers; mirrored batches keep their original signer's book on B" guards `r_follow`.
- "two nodes: publish on A, mirror into B, identical ask answers; mirrored batches keep their original signer's book on B" lives in "roflenox/test/federation.test.ts".
- "ROFL_DIR is set for this test run" guards `r_typed`.
- "ROFL_DIR is set for this test run" lives in "spec/check.test.mjs".
- "without ROFL_DIR the gate fails and says where to point it" guards `r_typed`.
- "without ROFL_DIR the gate fails and says where to point it" lives in "spec/check.test.mjs".
- "the real spec passes" guards `r_typed`.
- "the real spec passes" lives in "spec/check.test.mjs".
- "a status question the spec cannot answer fails, not counted" guards `r_typed`.
- "a status question the spec cannot answer fails, not counted" lives in "spec/check.test.mjs".
- "a REPL that answers empty to everything is not trusted" guards `r_typed`.
- "a REPL that answers empty to everything is not trusted" lives in "spec/check.test.mjs".
- "a sentence the reader cannot parse fails the reader" guards `r_typed`.
- "a sentence the reader cannot parse fails the reader" lives in "spec/check.test.mjs".
- "a requirement with its `is of` line removed fails typing, in ROFL and textually" guards `r_typed`.
- "a requirement with its `is of` line removed fails typing, in ROFL and textually" lives in "spec/check.test.mjs".
- "flipping security to features below 2/3 fails balance" guards `r_balanced`.
- "flipping security to features below 2/3 fails balance" lives in "spec/check.test.mjs".
- "an empty kind fails balance" guards `r_balanced`.
- "an empty kind fails balance" lives in "spec/check.test.mjs".
- "a guard naming a test that does not exist fails links" guards `r_no_orphan_tests`.
- "a guard naming a test that does not exist fails links" lives in "spec/check.test.mjs".
- "a guard with no `lives in` fact fails links" guards `r_no_orphan_tests`.
- "a guard with no `lives in` fact fails links" lives in "spec/check.test.mjs".
- "a name with a space or a text-direction mark is refused, and names at the label and total length limits are accepted" guards `r_identity_names`.
- "a name with a space or a text-direction mark is refused, and names at the label and total length limits are accepted" lives in "roflenox/test/keys.test.ts".
- "admin@example.org@evil.example, ada@@example.org and ada.@example.org are refused, so no name reads as an identity of a domain it does not belong to" guards `r_identity_names`.
- "admin@example.org@evil.example, ada@@example.org and ada.@example.org are refused, so no name reads as an identity of a domain it does not belong to" lives in "roflenox/test/keys.test.ts".
- "a user part holding any of < > ( ) [ ] : ; , a backslash or a double quote is refused, while one with + or ' is accepted, as email atext allows" guards `r_identity_names`.
- "a user part holding any of < > ( ) [ ] : ; , a backslash or a double quote is refused, while one with + or ' is accepted, as email atext allows" lives in "roflenox/test/keys.test.ts".
- "Node-A, node-a and NODE-A are one identity, and so are a composed and a decomposed accent and a name with a zero-width mark" guards `r_identity_names`.
- "Node-A, node-a and NODE-A are one identity, and so are a composed and a decomposed accent and a name with a zero-width mark" lives in "roflenox/test/keys.test.ts".
- "a label mixing Cyrillic and Latin letters is refused, while an all-Cyrillic name is accepted and shown in Cyrillic" guards `r_identity_names`.
- "a label mixing Cyrillic and Latin letters is refused, while an all-Cyrillic name is accepted and shown in Cyrillic" lives in "roflenox/test/keys.test.ts".
- "a grant, a delegation and a follow written with a differently cased or composed name act on the same identity" guards `r_identity_names`.
- "a grant, a delegation and a follow written with a differently cased or composed name act on the same identity" lives in "roflenox/test/keys.test.ts".
- "ada@example.org, Ada@Example.ORG and a fullwidth spelling of it are one identity; ada@пример.рф is accepted and shown in Cyrillic; bot.ada@example.org is its delegated agent's name" guards `r_identity_names`.
- "ada@example.org, Ada@Example.ORG and a fullwidth spelling of it are one identity; ada@пример.рф is accepted and shown in Cyrillic; bot.ada@example.org is its delegated agent's name" lives in "roflenox/test/keys.test.ts".
- "a live batch dated 301 seconds ahead of its receipt is refused as future-dated, while one dated 301 seconds behind is refused as stale with a request to re-attest" guards `r_freshness`.
- "a live batch dated 301 seconds ahead of its receipt is refused as future-dated, while one dated 301 seconds behind is refused as stale with a request to re-attest" lives in "roflenox/test/admission.test.ts".
- "a test that guards no requirement fails the spec gate, and linking it passes" guards `r_no_orphan_tests`.
- "a test that guards no requirement fails the spec gate, and linking it passes" lives in "spec/check.test.mjs".
- "a test the scanner cannot read, or one the runner lists and the scanner does not, fails the spec gate" guards `r_no_orphan_tests`.
- "a test the scanner cannot read, or one the runner lists and the scanner does not, fails the spec gate" lives in "spec/check.test.mjs".
- "an accepted requirement whose checks guard no existing test fails the spec gate" guards `r_no_orphan_tests`.
- "an accepted requirement whose checks guard no existing test fails the spec gate" lives in "spec/check.test.mjs".
- "a test that matches a planned check of an accepted requirement but has no guards line is an orphan, and an accepted requirement with one unguarded planned check fails the spec gate" guards `r_no_orphan_tests`.
- "a test that matches a planned check of an accepted requirement but has no guards line is an orphan, and an accepted requirement with one unguarded planned check fails the spec gate" lives in "spec/check.test.mjs".
- "with domain vouching on, a first contact with user@domain pins the key its domain publishes over HTTPS, and with it off the same contact needs an invitation" guards `r_domain_vouch`.
- "with domain vouching on, a first contact with user@domain pins the key its domain publishes over HTTPS, and with it off the same contact needs an invitation" lives in "roflenox/test/domain.test.ts".
- "a domain vouches for no name outside it, never over plain HTTP or across a redirect to another host, and never replaces an already pinned key" guards `r_domain_vouch`.
- "a domain vouches for no name outside it, never over plain HTTP or across a redirect to another host, and never replaces an already pinned key" lives in "roflenox/test/domain.test.ts".
- "an anonymous first contact as user@127.0.0.1, user@localhost or a user at a name resolving to a private address makes no outbound connection" guards `r_domain_vouch`.
- "an anonymous first contact as user@127.0.0.1, user@localhost or a user at a name resolving to a private address makes no outbound connection" lives in "roflenox/test/domain.test.ts".
- "a flood of first contacts naming many domains opens a bounded number of domain lookups at a time and repeats none within the cache time" guards `r_domain_vouch`.
- "a flood of first contacts naming many domains opens a bounded number of domain lookups at a time and repeats none within the cache time" lives in "roflenox/test/domain.test.ts".
- "an internal IPv4 written in any IPv6 form, NAT64, 6to4, IPv4-compatible or mapped, is not a public address" guards `r_domain_vouch`.
- "an internal IPv4 written in any IPv6 form, NAT64, 6to4, IPv4-compatible or mapped, is not a public address" lives in "roflenox/test/domain.test.ts".
- "createAssertion requires asserted_by — 400 when missing, round-trips (with proof_depth) when present" guards `r_asserted_by`.
- "createAssertion requires asserted_by — 400 when missing, round-trips (with proof_depth) when present" lives in "personal-node/src/mcp/main-graph.test.ts".

## Что выводится

<a id="unchecked"></a>A requirement R is unchecked if R binds as a force F, unless R is checked.

<a id="underspecified"></a>A requirement R is underspecified either:
1. if R leaves open some question;
2. if R is unthreatened.

> Требование безопасности без названного противника — недоспецифицировано: оно
> описывает одну дверь, и реализация закрывает ровно её (r_key_change_loud,
> 2026-09-27: два отказа подряд). Противник формулируется как «кто, что может,
> чего добивается», а `says` — как инвариант над состоянием по ВСЕМ путям.

<a id="unthreatened"></a>A requirement R is unthreatened if R is of `security`, unless R resists some adversary.

<a id="unsourced"></a>A requirement R is unsourced if R says some text, unless R is stated in some document.

<a id="homeless"></a>A check C is homeless if C guards some requirement, unless C lives in some file.

<a id="ready"></a>A requirement R is ready if R is checked, unless R is underspecified.

<a id="checked"></a>A requirement R is checked if a check C guards R and C lives in some file.

<a id="unplanned"></a>A requirement R is unplanned if R is unchecked, unless R is to be checked by some text.

<a id="untyped"></a>A requirement R is untyped if R says some text, unless R is of some kind.

