---
name: deliver
description: "Delivery (контур 3): холодний старт → дошка тікетів → вибір scope → worktree/PR на тікет → babysit до зеленого (CI + CodeRabbit/Copilot re-init). Наприкінці фази — integrator."
argument-hint: "[тікети через кому — опційно, інакше вибір на дошці]"
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Grep
  - Glob
  - Agent
  - Workflow
  - AskUserQuestion
---

# /shipyard:deliver

Ти ведеш контур 3: набір тікетів → окремі worktrees → PR на тікет → зелений
стан. Стан живе в GitHub і `.planning/graph/` — сесію можна вбити будь-коли
і перезапустити `/shipyard:deliver` без втрат.

## Моделі агентів (обов'язково передавай `model` при кожному спавні)

Політика (два яруси): важке судження + важка кодова робота → Opus 4.8 з 1M
контекстом, легка механіка → Sonnet 5.

```text
integrator     → opus[1m]  (емерджентні порушення, найдорожчі помилки)
arch-review    → opus[1m]  (вердикт проти ADR — судження)
executor       → opus[1m]  (основна кодова робота за контрактом)
review-fix     → opus[1m]  (верифікація чужих claim'ів + правки)
ci-fix         → opus[1m]  (діагностика падінь)
drift-check    → sonnet    (механічна звірка контракту з кодом)
```

Точні ID: Opus-ярус — Opus 4.8 з 1M контекстом: аліас `opus[1m]`
(повна форма `claude-opus-4-8[1m]`); `sonnet` резолвиться в найновіший
Sonnet (зараз `claude-sonnet-5`). (Раніше найважчі судження — integrator,
arch-review — йшли на Fable 5, але вона тепер платна; усі судження зведені
до Opus 4.8 1M.)

Override: якщо в `.planning/config.json` є блок `pipeline.models`
(`{"pipeline": {"models": {"drift-check": "opus", ...}}}`) — його значення
мають пріоритет; допускаються tier-аліаси (opus/sonnet) і повні model ID.

Скрипти (детермінований шар — НЕ імпровізуй git/gh руками там, де є скрипт):

```text
node ${CLAUDE_PLUGIN_ROOT}/scripts/validate-graph.cjs
node ${CLAUDE_PLUGIN_ROOT}/scripts/state-sync.cjs
node ${CLAUDE_PLUGIN_ROOT}/scripts/reviewers.cjs <reinit|unresolved> <pr>
bash ${CLAUDE_PLUGIN_ROOT}/scripts/ticket-worktree.sh <create|remove|path|list> ...
```

## Burst-паралелізм через Workflow (опційно, з fallback)

Три ділянки конвеєра — чистий fan-out по незалежних одиницях: drift-gate
(Step 2), виконавці (Step 3), fix-прохід у babysit (Step 4). Якщо тобі
доступний **Workflow tool**, оркеструй ці ділянки ним — так паралелізм
детермінований, з гарантованим structured-output і керованим кепом
конкурентності. Це легальний opt-in: slash-команда прямо інструктує задіяти
Workflow.

Готові скрипти (виконуй через `Workflow({scriptPath, args})`):

```text
${CLAUDE_PLUGIN_ROOT}/workflows/drift-gate.mjs   # Step 2 — паралельні судді
${CLAUDE_PLUGIN_ROOT}/workflows/executors.mjs    # Step 3 — код+push+draft-PR+reinit
${CLAUDE_PLUGIN_ROOT}/workflows/fix-round.mjs    # Step 4 — один паралельний fix-прохід
```

Кожен скрипт має у шапці `args`-контракт — будуй `args` рівно за ним
(абсолютні шляхи: резолвни `${CLAUDE_PLUGIN_ROOT}` у конкретний шлях; референс-
промпти й плани агенти читають самі — скрипти файлів не читають). Правила:

- **Workflow асинхронний.** Виклик `Workflow(...)` повертається одразу (task id;
  запуск фоновий) — фінальний structured-результат приходить ПІЗНІШЕ
  (task-notification про завершення). Дочекайся завершення, ЗАБЕРИ результат і
  перевір на error/failure (впав запуск / ненульовий вихід). Дошку, `state-sync`,
  attempts і будь-які гейти будуй ТІЛЬКИ на завершеному Workflow з отриманим
  результатом — ніколи на не-завершеному чи помилковому. Workflow впав до старту
  (напр. недоступний) → перемкнись на Agent-фолбек цього кроку.
- **Worktrees створює main-loop СЕРІЙНО** (`ticket-worktree.sh create`) ще ДО
  інвокації Workflow і передає готові шляхи в `args.tickets[].worktreePath`.
  `git worktree add` пише у спільний `.git` — паралельне створення дало б гонку
  за index-lock. НЕ вживай нативний `isolation:'worktree'` Workflow — worktrees
  конвеєра durable й base-specific, а не ефемерні.
- Гейти лишаються за main-loop: attempts, очікування CI, arch-review,
  conform-гейт, human-checkpoints, ескалації. Workflow робить лише burst-роботу
  й повертає structured-вердикти — рішення ухвалюєш ти.
- Моделі резолви ТУТ (політика + `pipeline.models` override) і передавай у
  `args.tickets[].model` / `args.prs[].model` — скрипт лише вживає передане.

**Фолбек і флаг.** Немає Workflow tool у сесії — виконуй ці кроки поточним
способом: кілька `Agent` в одному повідомленні (описано в кожному Step). Флаг
`pipeline.use_workflow` у `.planning/config.json`: за замовчуванням авто
(вживати Workflow, коли доступний); `false` — примусово Agent-per-item фолбек.

## Step 0 — Холодний старт (обов'язково при КОЖНОМУ запуску)

1. `validate-graph.cjs` — граф проти поточного стану планів; помилки → стоп,
   покажи їх (можливо, щось змерджено повз конвеєр — направ у /shipyard:decompose).

   **Кейс «декомпозиція не матеріалізована»** (немає `.planning/phases/` або
   жодного `*-PLAN.md`): це означає, що попередня декомпозиція закрила Gate 2
   неправомірно (наприклад, підмінила плани Jira-тікетами). Дії:
   a. чесно повідом користувачу: PLAN-файлів немає, delivery стартувати ні з чого;
      покажи, що знайдено натомість (Jira-тікети, ROLLOUT.md тощо);
   b. якщо тікети існують у зовнішньому трекері (Jira/GitHub issues) —
      запропонуй ІМПОРТ: агент читає кожен зовнішній тікет і матеріалізує
      його як `.planning/phases/<N>-*/<N>-<M>-PLAN.md` за шаблоном декомпозиції
      (frontmatter: phase/plan/title/depends_on/files_modified + delivery-блок;
      тіло: Goal/Context/Scope/Out of scope/Acceptance criteria/Test strategy/
      Verification commands). Чого немає в Jira (depends_on, files_modified) —
      виведи зі змісту або допитай користувача. Після імпорту — знову
      validate-graph (справжній Gate 2) і далі звичайний потік;
   c. якщо зовнішніх тікетів немає — направ у /shipyard:decompose.
   НІКОЛИ не конструюй tickets.json руками в обхід validate-graph.
2. `state-sync.cjs` — перебудувати delivery-state з фактичного GitHub
   (локальний файл — лише кеш).
3. Покажи ДОШКУ з stdout state-sync + tickets.json:

```text
ready:    T-01-01, T-01-04
blocked:  T-02-01 ← чекає T-01-02
pr-open:  T-01-02 (PR #142, checks: 1 failing, review: CHANGES_REQUESTED)
merged:   T-01-03
```

## Step 1 — Вибір scope

- Аргумент з тікетами → це scope; перевір проти дошки.
- Інакше AskUserQuestion (multiSelect) з ready-тікетів + опції "вся фаза N",
  "все ready". pr-open тікети автоматично в scope babysit-циклу — їх не обирають.
- Обраний blocked-тікет → уточни САМЕ ТОДІ:
  залежність має відкритий PR → "додати залежність у scope / стекнутись на її
  гілку (--on-top) / відкласти тікет"; залежність pending → "додати в scope /
  відкласти".
- Merged-залежності завжди задоволені — вибірка з середини графа легальна.

## Step 2 — Drift-gate обраних тікетів

Для кожного тікета зі scope, чий план старший за останній merge в main
(або якщо минуло >2 днів від генерації) — прожени drift-check ПАРАЛЕЛЬНО:

- **Workflow-шлях** (доступний і `use_workflow ≠ false`): `Workflow({scriptPath:
  <workflows/drift-gate.mjs>, args: {tickets: [{id, planPath, model: sonnet}],
  driftRefPath: <references/drift-check.md>}})`. Скрипт fail-safe: агент, що
  впав, трактується як `drifted`.
- **Фолбек**: кілька drift-check `Agent` в одному повідомленні (`model: sonnet`;
  промпт `${CLAUDE_PLUGIN_ROOT}/references/drift-check.md` + контракт тікета).

`drifted` → тікет виключається зі scope, позначається needs-replan,
користувачу — підсумок дрейфу і направлення в /shipyard:decompose. НЕ виконуй
дрейфнутий тікет наосліп.

## Step 3 — Виконавці (паралельно по готовності)

Для кожного тікета T зі scope, коли всі його depends_on merged (або —
--on-top — мають стабільну гілку):

1. `base` = origin/main, якщо залежності merged; інакше гілка найглибшої
   незмердженої залежності.
2. Preflight (GSD 1.7): якщо доступний gsd-tools —
   `node ~/.claude/gsd-core/bin/gsd-tools.cjs worktree base-check` —
   ловить розбіжність HEAD із fork-base до створення worktree
   (відсутність gsd-tools — не помилка, пропусти).
3. `ticket-worktree.sh create <T> <branch з tickets.json> <base>`.
   Ім'я гілки береться ТІЛЬКИ з tickets.json (канонічний формат
   `ticket/<ID>-<slug-з-назви-тікета>`, вже санітизований validate-graph'ом) —
   не конструюй його вручну.
4. Запусти executor-агента (Agent tool, `model: opus[1m]`) У WORKTREE з контрактом:
   повний текст плану тікета + Context reads + правило "працюй ТІЛЬКИ в
   межах files_modified; коміть атомарно з префіксом (T): ...; прожени
   Verification commands до зеленого локально".
4b. (TUNE, опційно) Pre-push рев'ю адаптерами GSD — дешевше зловити
    зауваження до PR-ботів: `/gsd-code-review <phase> --fix` або
    `/gsd-review --coderabbit --opencode`, якщо CLI-рев'ювери налаштовані.
    Недоступні — пропусти мовчки.
5. Після виконавця: push гілки,
   `gh pr create --base <base-branch|main> --head <branch> --draft
   --title "<T>: <title>" --body <PR body за шаблоном>`.
   PR body: Problem / Scope / Ticket / Dependency slice / Test evidence /
   Rollout-Rollback (для risky).
6. Одразу перший `reviewers.cjs reinit <pr>`.
7. Онови delivery-state (`state-sync.cjs`).

Кроки 1–3 (base, preflight, `ticket-worktree.sh create`) — ЗАВЖДИ в main-loop
і СЕРІЙНО: `git worktree add` пише у спільний `.git`, паралельне створення
racy. Кроки 4–6 (код → verify → push → draft-PR → reinit) — це fan-out по
готових тікетах:

- **Workflow-шлях** (доступний і `use_workflow ≠ false`): після серійного
  створення всіх worktrees — `Workflow({scriptPath: <workflows/executors.mjs>,
  args: {tickets: [{id, title, planPath, branch, worktreePath, prBase,
  model: opus[1m]}], reinitScript: <scripts/reviewers.cjs>, deliveryRulesHint,
  prBodyGuide}})`. Агент сам комітить, пушить, відкриває draft-PR і робить
  reinit у своєму worktree. `prBase` = `main` (залежності merged) або гілка
  найглибшої незмердженої залежності.
- **Фолбек**: кілька executor `Agent` в одному повідомленні (кроки 4–6 вручну,
  як вище). Незалежні тікети — ПАРАЛЕЛЬНО.

Крок 4b (pre-push рев'ю) і крок 7 (`state-sync.cjs` — один раз ПІСЛЯ повернення
Workflow/агентів) лишаються за main-loop. Конфлікти по файлах виключені Gate 2.

## Step 4 — Babysit loop (для КОЖНОГО відкритого PR зі scope)

Лічильник спроб на PR: attempts (старт 1, MAX 5).

```text
loop:
  a. state-sync.cjs → checks цього PR
     failing → ci-fix агент у worktree тікета (`model: opus[1m]`)
       (промпт ${CLAUDE_PLUGIN_ROOT}/references/ci-fix.md + контракт + лог
        падіння: gh run view --log-failed)
       'escalate' від агента → status blocked, до людини
       push відбувся → крок d
     pending → почекай завершення checks (gh pr checks <pr> --watch), потім знову a

  b. reviewers.cjs unresolved <pr>
     є треди → review-fix агент у worktree (`model: opus[1m]`)
       (промпт ${CLAUDE_PLUGIN_ROOT}/references/review-fix.md + JSON тредів)
       агент або править (push → крок d), або відповідає reply на невалідні
       (без push → познач треди опрацьованими, знову b)

  c. arch-review агент (`model: claude-opus-4-8[1m]`)
     (промпт ${CLAUDE_PLUGIN_ROOT}/references/arch-review.md + gh pr diff +
      .planning/architecture/)
     violation    → fix у worktree → push → крок d
     adr-outdated → status blocked, ескалація людині (рішення міняти — не твоє)
     conform      → перевір критерії зеленого:
       всі checks passed ∧ unresolved=0 ∧ arch conform
       → зафіксуй вердикти в PR body трейлером (переживає squash-merge):
         допиши останнім рядком body через gh pr edit <pr> --body:
         gate_status: arch-review=conform, drift-check=<fresh|skipped>, checks=green
       → gh pr ready <pr> (зняти draft)
       → human_checkpoint? повідом людину і чекай апруву : status green, ВИХІД

  d. після КОЖНОГО push:
     reviewers.cjs reinit <pr>
     attempts += 1
     attempts > MAX → status blocked, ескалація людині зі зведенням спроб
     → крок a
```

Кілька відкритих PR: **Workflow-шлях** (доступний і `use_workflow ≠ false`)
паралелить САМЕ fix-роботу одного раунду. Порядок раунду:

1. `state-sync.cjs` → для кожного відкритого PR визнач `needsCiFix` (checks
   failing) і `needsReviewFix` (`reviewers.cjs unresolved` > 0). Ті, що чекають
   на pending checks — пропусти цей раунд (їх добере наступний після watch).
2. Є PR, що потребують роботи → `Workflow({scriptPath: <workflows/fix-round.mjs>,
   args: {prs: [{id, pr, branch, worktreePath, planPath, needsCiFix,
   needsReviewFix, model: opus[1m]}], ciFixRefPath, reviewFixRefPath,
   reinitScript}})`. Один паралельний прохід; кожен агент пушить максимум раз і
   робить reinit сам. `escalate` → status blocked, до людини.
3. Для кожного `pushed:true` — `attempts += 1` (MAX 5), почекай CI
   (`gh pr checks --watch`).
4. Далі — крок **c** циклу (arch-review, Opus 4.8 1M) і conform-гейт для кожного PR
   у main-loop, як вище. Це судження і фіналізація — НЕ віддавай у Workflow.

**Фолбек** (нема Workflow): обслуговуй по черзі раундами (a→d для кожного PR).
Поки всі не green/blocked. green + merged залежності розблоковують наступні
тікети зі scope → повертайся у Step 3 для них.

## Step 5 — Завершення

1. Всі тікети scope green/merged → підсумок: тікет / PR / стан / що чекає
   людину (апруви high-risk, merge).
2. Якщо це були ОСТАННІ тікети фази (всі тікети фази merged) → запропонуй
   integrator-прогін: агент за `${CLAUDE_PLUGIN_ROOT}/references/integrator.md`
   (`model: claude-opus-4-8[1m]`)
   → `INTEGRATION.md`; `needs-fix` → fix-тікети як нові плани → /shipyard:decompose
   Step 4 → наступний /shipyard:deliver.
3. Приберися: `ticket-worktree.sh remove <T>` для merged тікетів.

## Правила

- Merge робить людина (або auto-merge політика репо) — ти доводиш до green.
- Ніколи не force-push. Ніколи не комітиш у main.
- Кожна зміна стану — через state-sync, не ручним редагуванням state-файлів.
- Бот-рев'ювери можуть помилятися: незгода з обґрунтуванням — легальний
  результат review-fix, сліпе виконання — ні.
