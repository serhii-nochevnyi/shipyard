# Багаторівневий delivery-конвеєр на базі GSD

> Версія 3. Актуальний пін: `@opengsd/gsd-core@1.7.0` (команди і флаги
> звірені з пакетом і документацією next; статус адаптації — розділ 10.5).
> Цільовий сценарій:
> **глибокий investigation → декомпозиція на тікети із залежностями → реалізація
> кожного тікета в окремому git worktree → PR на тікет → автоматичне доведення PR
> до зеленого стану з переініціалізацією рев'юверів (CodeRabbit, Copilot).**

---

## 0. Вимоги до конвеєра

1. **Deep investigation** — окремий режим, у якому тема повністю вивчається і
   фіксуються прийняті положення (decisions/ADR). Код на цьому етапі не пишеться.
2. **Декомпозиція на тікети із залежностями** — explicit DAG, кожен тікет є
   execution contract, а не назвою задачі.
3. **Delivery-механізм** — окремий контур, який бере набір тікетів і:
   - виконує кожен тікет в **окремому git worktree** з дотриманням залежностей;
   - доводить кожен тікет до **окремого PR** (гілка на тікет, stacked PRs для
     незмерджених залежностей);
   - відслідковує стан PR через git/GitHub (`gh`);
   - доводить PR до **зеленого стану**: CI checks + цикл виправлень за
     коментарями рев'юверів;
   - після кожного push **переініціалізує рев'юверів**: CodeRabbit
     (`@coderabbitai full review`) і Copilot (re-request review через API).

---

## 1. Розподіл: що дає GSD 1.6, що будуємо самі

GSD не треба дублювати. Звірена межа:

| Потреба | GSD 1.6 з коробки | Будуємо самі |
|---|---|---|
| Ideation / раннє мислення | `/gsd-explore` (Socratic ideation) | — |
| Дослідження з експериментом | `/gsd-spike` → `.planning/spikes/SPIKE-NNN/` | Investigation package (шаблони INV) |
| Карта кодової бази | `/gsd-map-codebase` (architecture/conventions/concerns) | — |
| Knowledge graph | `/gsd-graphify` (opt-in у `.planning/config.json`) | — |
| Інжест ADR у планування | `/gsd-plan-phase --ingest <adr>` (парсить locked decisions + scope fences) | ADR-пакет як вихід investigation |
| Плани із залежностями | frontmatter планів: `phase, plan, type, wave, depends_on, files_modified` | Валідатор графа + генерація `tickets.yaml` як view |
| Ревʼю якості планів | `/gsd-plan-review-convergence <phase> --all --max-cycles N` | — |
| Паралельне виконання у worktrees | `/gsd-execute-phase` (waves, `Agent(isolation="worktree")`) — але **merge в одну гілку** | **Delivery-контур: PR на тікет** (розділ 5) |
| Чиста PR-гілка без `.planning/` | `/gsd-pr-branch` | Використовуємо як утиліту в delivery |
| UAT | `/gsd-verify-work` (conversational UAT) | Mechanical verification живе в CI + babysit loop |
| PR / ship | `/gsd-ship <phase>` — один PR на phase | **PR-per-ticket + babysit до зеленого** |
| Ведення рев'ю-циклу | — | **Reviewer re-init + fix loop (CodeRabbit/Copilot)** |

Висновок той самий, що і в v1, але з точнішою межею:

```text
GSD          = investigation support + planning + plan quality convergence
Надбудова    = ticket discipline + PR-per-ticket delivery + review babysitting
```

---

## 2. Принципи (без змін по суті)

1. **Чат не є джерелом правди.** Джерело правди — артефакти в `.planning/`.
   Сесія може померти; артефакти — стабільна памʼять процесу.
2. **Кожен етап залишає контракт для наступного.** Investigation → decisions.
   Decisions → ADR. ADR → тікети. Тікет → PR. PR → merge evidence.
3. **Різні cognitive modes — різні агенти.** Дослідник, архітектор, декомпозитор,
   виконавець, фіксер рев'ю-коментарів — окремі fresh-context агенти, звʼязані
   лише артефактами.
4. **Одне джерело правди для залежностей.** Залежності живуть у frontmatter
   тікетів. `graph/tickets.yaml` — **генерований view**, не рукописний
   майстер-файл (інакше вони неминуче розійдуться).

---

## 3. Структура `.planning/`

Не конфліктує з нативною розкладкою GSD (`STATE.md`, `ROADMAP.md`,
`phases/XX-name/XX-YY-PLAN.md`, `spikes/`), а додає до неї:

```text
.planning/
  STATE.md                      # GSD
  ROADMAP.md                    # GSD
  REQUIREMENTS.md               # GSD

  investigations/               # надбудова: контур 1
    INV-001-topic/
      PROBLEM.md
      RESEARCH.md
      OPTIONS.md
      RISKS.md
      OPEN-QUESTIONS.md
      DECISIONS.md              # прийняті положення → сировина для ADR

  architecture/                 # надбудова: вихід investigation
    ADR-001-selected-approach.md
    INTERFACES.md
    DATA-MODEL.md
    ROLLOUT.md

  phases/                       # GSD: тікети = GSD-плани з delivery-розширенням
    01-foundation/
      01-01-PLAN.md             # = тікет T-01-01
      01-02-PLAN.md
    02-behavior/
      02-01-PLAN.md

  graph/                        # надбудова: генеровані view + стан delivery
    tickets.yaml                # згенеровано з frontmatter планів
    delivery-state.yaml         # стан кожного тікета в delivery-контурі
```

---

## 4. Контур 1 — Deep Investigation

### 4.0. Ініціація

Investigation — самостійна точка входу. Інтерфейс — **скіл, а не CLI з
прапорцями**: жодних параметрів пам'ятати не треба.

```text
/investigate                      # без аргументів — скіл сам розбереться
/investigate <будь-який текст>    # сирий problem statement як аргумент
```

Скіл на старті читає `.planning/investigations/` і **сам з'ясовує контекст**:

```text
- є відкриті INV?  → питає: продовжити INV-001 (показує статус і відкриті
                     питання) чи почати новий?
- новий без тексту → питає problem statement
- INV дозрів       → сам пропонує: "всі питання закриті — закриваю Gate 1
                     і генерую ADR?"
```

**Вхід може бути будь-якої зрілості**: сира ідея, баг/інцидент, епік із Jira,
PRD. Для зовсім сирої ідеї скіл спершу запропонує `/gsd-explore` (Socratic
ideation) — його вихід стає problem statement.

**Що робить старт нового INV:**

```text
1. Preconditions: .planning/ ініціалізований (/gsd-new-project),
   карта кодової бази існує і свіжа (/gsd-map-codebase) — інакше виконує
2. Створює .planning/investigations/INV-NNN-slug/ зі скелетом усіх артефактів
3. Intake-інтервʼю: агент ставить питання, яких бракує для PROBLEM.md
   (для кого, поточний pain, success criteria, що поза scope) —
   сирий statement не приймається мовчки
4. Research fan-out: паралельні агенти по лініях
   (стан системи / альтернативи+prior art / обмеження / ризики)
   → чернетки RESEARCH.md, OPTIONS.md, RISKS.md + OPEN-QUESTIONS.md
5. Далі — ітеративний діалог (4.1): ви закриваєте питання і приймаєте
   положення; наступна сесія — знову просто /investigate, скіл сам
   підхопить відкритий INV зі стану артефактів
```

**Закриття** (скіл пропонує сам, коли питання вичерпані): структурний
валідатор Gate 1 (всі OPEN-QUESTIONS закриті або переведені в ризики,
DECISIONS повний) → генерація ADR-пакета в `architecture/` у форматі,
який parse-ить `plan-phase --ingest` → INV позначається closed і стає
read-only довідником.

Кілька investigation можуть жити паралельно (INV-001, INV-002) — вони
незалежні до моменту, коли їхні ADR зустрінуться в одній декомпозиції.

### 4.1. Процес

```text
Problem statement
  → дослідження кодової бази     (/gsd-map-codebase, якщо ще нема)
  → дослідження теми             (research-агенти, за потреби /gsd-spike для
                                  experiential-перевірки гіпотез кодом-чернеткою)
  → OPTIONS.md з trade-offs
  → DECISIONS.md                 (прийняті положення: що обрали, що відкинули, чому)
  → ADR-пакет в architecture/    (формат, який parse-ить plan-phase --ingest)
```

Investigation — це ітеративний діалог з людиною: агенти зносять findings і
options, людина приймає положення. Кожне прийняте положення фіксується в
`DECISIONS.md` одразу, а не в кінці.

### 4.2. Артефакти

```text
PROBLEM.md        — яку проблему вирішуємо, для кого, success criteria, що поза scope
RESEARCH.md       — поточний стан системи, альтернативи, обмеження, unknowns
OPTIONS.md        — Option A/B/C + trade-offs (порівняльна таблиця обовʼязкова)
RISKS.md          — ризики з severity та mitigation
OPEN-QUESTIONS.md — питання, що блокують рішення; кожне має owner
DECISIONS.md      — locked decisions; кожне: рішення / чому / що відкинули / scope fence
```

### 4.3. Gate 1 — Investigation complete

- всі OPEN-QUESTIONS або закриті, або явно перенесені в ризики з mitigation;
- кожна опція в OPTIONS.md має trade-offs;
- DECISIONS.md покриває всі рішення, потрібні для декомпозиції;
- ADR-файли створені в `architecture/` (це вхідний формат для контуру 2).

**Перевірка автоматизується**: скрипт-валідатор перевіряє наявність і
непорожність секцій. Змістовну якість перевіряє людина — це human gate.

---

## 5. Контур 2 — Декомпозиція на тікети

### 5.1. Тікет = GSD-план + delivery-розширення

Інтерфейс — скіл `/decompose` (без параметрів). Він сам:

```text
1. знаходить закриті INV з ADR, які ще не декомпозовані → питає, який брати
   (або кілька ADR в одну фазу)
2. уточнює режим: --tdd? --mvp? (з рекомендацією за типом роботи)
3. запускає ланцюг GSD-командами під капотом:
   /gsd-plan-phase N --ingest <adr> [--tdd|--mvp]
   /gsd-plan-review-convergence N --all --max-cycles 3
   scripts/validate-graph          # Gate 2 + генерація tickets.yaml
4. показує підсумок: тікети, DAG, waves, high-risk → ви апрувите
   або кажете "T-03 розбий" — і ланцюг повторюється точково
```

Декомпозицію робить GSD — це його сильна сторона; скіл лише знімає з вас
потребу пам'ятати команди і флаги.

GSD-план уже має потрібний frontmatter (`phase`, `plan`, `type`, `wave`,
`depends_on`, `files_modified`). Delivery-контур додає свої поля:

```yaml
# frontmatter 01-02-PLAN.md (доповнення)
delivery:
  ticket: T-01-02
  branch: ticket/T-01-02-repository-layer
  pr: null            # заповнює оркестратор
  risk: medium
  human_checkpoint: false
```

### 5.2. Вимоги до тіла тікета (execution contract)

Кожен тікет мусить містити: **Goal, Context (список файлів для читання),
Scope, Out of scope, Acceptance criteria, Test strategy, Verification commands.**
Це вже майже збігається з форматом GSD-плану; `plan-review-convergence`
використовуємо як механізм доведення тікетів до цього стандарту.

### 5.3. Генерація графа і валідація

`graph/tickets.yaml` генерується скриптом із frontmatter усіх планів:

```yaml
# згенеровано — не редагувати руками
milestone: M-001
tickets:
  T-01-01: { title: "Add data model",       depends_on: [],                 files: [src/models/**],  risk: medium }
  T-01-02: { title: "Add repository layer", depends_on: [T-01-01],          files: [src/repo/**],    risk: medium }
  T-02-01: { title: "Add API endpoint",     depends_on: [T-01-01, T-01-02], files: [src/api/**],     risk: high }
```

### 5.35. Джерело правди і зовнішні трекери

Тікет конвеєра існує лише як файл `.planning/phases/<N>-*/<N>-<M>-PLAN.md`.
Jira/GitHub issues — опційна **експортна проєкція** (пункт 7 у списку
імплементації), не заміна: deliver читає тільки PLAN-файли, і Gate 2 —
це виключно exit 0 від validate-graph, а не наявність тікетів у трекері.
Якщо декомпозиція завершилась без матеріалізованих PLAN-файлів — це
неправомірно закритий Gate 2; холодний старт deliver детектує цей кейс і
пропонує імпорт зовнішніх тікетів у PLAN-файли з повторним Gate 2.

### 5.4. Gate 2 — Ticket graph valid (повністю автоматичний)

Валідатор (`scripts/validate-graph`) перевіряє:

- немає циклів (topological sort успішний);
- кожен `depends_on` посилається на існуючий тікет;
- тікети без спільних предків не перетинаються по `files_modified`
  (інакше вони не можуть іти в один wave — валідатор або піднімає конфлікт,
  або додає штучну залежність);
- кожен `risk: high` тікет має `human_checkpoint: true`.

---

## 6. Контур 3 — Delivery: worktree → PR → зелений стан

Це окремий механізм (оркестратор), який замінює `/gsd-execute-phase` +
`/gsd-ship` для режиму «PR на тікет». Нативний execute-phase лишається
доступним для внутрішніх/низькоризикових phase, де досить одного PR на phase.

**Delivery — самостійна точка входу.** Контури 1–3 не є одним безперервним
процесом: між investigation, декомпозицією і delivery може минути день або
місяць. Тому delivery стартує окремою командою, приймає **явний вибір
тікетів** і не тримає жодного стану в памʼяті сесії — тільки артефакти + GitHub.

### 6.0. Вибір тікетів і холодний старт

Інтерфейс — скіл `/deliver` (без параметрів). Замість прапорців — дошка і
вибір:

```text
1. холодний старт (нижче) → скіл показує ДОШКУ з фактичного стану:
     ready:    T-01-01, T-01-04          (залежності merged, можна брати)
     blocked:  T-02-01 ← чекає T-01-02
     pr-open:  T-01-02 (PR #142, fixing, attempt 2)
     merged:   T-01-03
     drifted:  T-01-05 → needs-replan
2. питає, що брати в роботу: multiselect з ready (+опція "всю фазу" /
   "все ready")
3. якщо ви обрали blocked-тікет — уточнює саме тоді, а не прапорцем заздалегідь:
     "T-02-01 залежить від T-01-02 (PR відкритий). Додати T-01-02 у scope?
      Стекатись на його гілку? Чи відкласти T-02-01?"
4. підтверджений scope → запуск оркестратора; далі все без вас до
   human gates
```

Merged-залежності завжди вважаються задоволеними — вибірка з середини графа
легальна. Повторний виклик `/deliver` у будь-який момент показує ту саму
дошку (прогрес, блокери) і дозволяє докинути наступну порцію.

**Холодний старт (обовʼязковий пролог кожного запуску).** Оскільки між
запусками був розрив:

```text
1. Resync стану: gh pr list/checks/reviews → перебудувати delivery-state.yaml
   з фактичного стану GitHub (локальний файл — кеш, GitHub — правда)
2. Перевалідація графа: scripts/validate-graph проти поточного main
   (щось могло змерджитись повз конвеєр)
3. Drift-gate для кожного обраного тікета: швидкий агент перевіряє, що
   контракт ще відповідає кодовій базі (файли з Context існують, інтерфейси
   не змінилися, scope не перекритий чужими змінами). Дрейф → тікет
   позначається needs-replan і НЕ виконується наосліп; повертається в
   контур 2 (/gsd-plan-phase точково)
```

### 6.05. Модель інтеграції — epic-stacked (дефолт)

Фаза інтегрується через ОДНУ epic-гілку, а не десятками PR прямо в default-
гілку. `.planning/config.json` → `pipeline.integration_mode`:
`epic-stacked` (дефолт) | `direct-to-main` (легасі; залежні чекають merge).

- на фазу — epic-гілка `epic/<phase-dir>` від default-гілки (main|master),
  згенерована в `tickets.json.epics` разом із per-ticket `epic`/`pr_base`;
- корінний тікет (порожній `depends_on`) → PR у epic-гілку;
- залежний тікет → **каскадний** PR у гілку primary-батька (найглибша
  залежність тієї ж фази), БЕЗ очікування його merge — потік не спиняється;
- `state-sync` обчислює `base` кожного тікета (корінь → epic; залежний → гілка
  батька; merged-батько → epic — GitHub ретаргетить дітей мерджнутого батька);
- фаза заходить у default-гілку ОДНИМ PR epic → default; його, як і тікет-PR,
  мерджить людина після integrator `passed`;
- готовність каскадна: тікет ready щойно батьки ≥ `branched` (а не merged) —
  дитину можна вести паралельно з батьком.

Детермінований шар: `epic-branch.sh ensure|pr|retarget|status`.

### 6.1. Модель виконання

```text
для кожного тікета T з обраного scope у топологічному порядку:
  ready(T) = epic-stacked: усі depends_on(T) ≥ branched (мають гілку для каскаду)
             direct-to-main: усі depends_on(T) у стані merged

  1. base   = state[T].base (epic-stacked: epic для кореня / гілка primary-
              батька для залежного / epic коли батько merged;
              direct-to-main: main або гілка найглибшої незмердженої залежності)
  2. git worktree add ../wt/T-XX <branch> <base>
  3. виконавець: headless-агент у worktree з контрактом тікета
     (claude -p з тілом тікета + Context reads; TDD за контрактом)
  4. локальна перевірка: verification commands з тікета
  5. commit → push → gh pr create --base <base> --draft (перший рядок body:
     машинозчитуваний "Ticket: <T>")
  6. babysit loop (6.2) до зеленого стану
  7. green → merge у СВОЮ базу (epic/гілка батька) → діти-PR ретаргетяться на
     epic (epic-branch.sh retarget; GitHub часто робить це сам)
```

Паралельність безкоштовна: всі тікети, у яких `ready(T)`, запускаються
одночасно — кожен у своєму worktree, конфлікти по файлах виключені Gate 2.
Каскад робить незалежним і ланцюг: дитина стартує, щойно батько має гілку.

**Іменування гілок.** Гілка тікета — `ticket/<ID>-<slug>`, де slug — це
**назва тікета після санітизації**: нижній регістр, кирилиця
транслітерується, будь-який знак крім букв і цифр (пробіли, `: , ( ) / ' "`
тощо) замінюється одним дефісом, дефіси по краях зрізаються, довжина slug
≤ 40 символів. Приклад: `Add API endpoint (v2): auth` →
`ticket/T-02-01-add-api-endpoint-v2-auth`. Ім'я генерується детерміновано
`validate-graph`-ом із назви і потрапляє в `tickets.yaml`; явно вказаний
`delivery.branch` валідується проти цього ж правила (заборонені символи →
помилка Gate 2). Виконавці беруть ім'я тільки з `tickets.json`.

### 6.2. Babysit loop — доведення PR до зеленого

**Рух до фікспойнту.** Оркестратор веде весь досяжний scope до кінця за один
запуск, а не спиняється на першому блокері. Після кожного `state-sync` він
рахує actionable-фронт = {ready-тікети, ще не стартовані} ∪ {відкриті не-green
PR}; поки фронт не порожній — продовжує (виконує ready, babysit'ить PR,
підбирає каскадних дітей, щойно батько `branched`). Блокер (escalate,
attempts>MAX, adr-outdated, drift, human-gate) **паркує** тікет і не спиняє
прогін — рух триває рештою фронту. Зупинка легальна лише на фікспойнті: усе
доставлено або лишились самі блокери/очікування людини.

Стан кожного тікета трекається в `graph/delivery-state.yaml`:

```yaml
T-01-02:
  status: fixing        # pending|in-progress|pr-open|fixing|green|merged|blocked
  branch: ticket/T-01-02-repository-layer
  pr: 142
  attempts: 2           # ліміт циклів, після якого — ескалація на людину
  last_push: <sha>
```

Цикл (виконується оркестратором для кожного відкритого PR):

```text
loop:
  1. CI:      gh pr checks <pr> --json name,state
              є failing → fix-агент у worktree тікета:
                читає лог падіння (gh run view --log-failed),
                виправляє, проганяє verification commands локально,
                commit + push
              → крок 4

  2. Reviews: зібрати actionable-коментарі
                gh api repos/{o}/{r}/pulls/<pr>/comments   (inline)
                gh api repos/{o}/{r}/pulls/<pr>/reviews    (verdicts)
              є unresolved → fix-агент:
                ! дисципліна receiving-code-review: коментар спершу
                  верифікується проти коду; необґрунтований — отримує
                  аргументовану відповідь-reply, а не сліпу правку
                правки → commit + push
              → крок 4

  2b. Arch-review (CodeRabbit/Copilot НЕ знають наших ADR — це окремий агент):
              читає diff PR + architecture/ (ADR, INTERFACES, DATA-MODEL)
              + контракт тікета; вердикт:
                conform     → далі
                violation   → fix-агент править під ADR → крок 4
                adr-outdated→ ескалація на людину: або рішення змінюється
                              (оновити DECISIONS/ADR і перевалідувати графа),
                              або код приводиться до ADR
              запускається при відкритті PR і після кожного push, що міняє код

  3. Зелений стан досягнуто, якщо:
              - всі checks passed
              - немає unresolved actionable-коментарів
              - CodeRabbit: останній review без blocking issues
              - Copilot: review comments опрацьовані
              - arch-review: verdict conform
              - approvals за branch protection (людина — для human_checkpoint)
              → status: green, вихід із циклу

  4. Переініціалізація рев'юверів після КОЖНОГО push:
              # CodeRabbit — повний повторний огляд
              gh pr comment <pr> --body "@coderabbitai full review"
              # Copilot — повторний запит рев'ю (не ре-рев'юїть push автоматично)
              gh api -X POST repos/{o}/{r}/pulls/<pr>/requested_reviewers \
                 -f 'reviewers[]=copilot-pull-request-reviewer[bot]'
              attempts += 1
              attempts > MAX (default 5) → status: blocked, ескалація на людину
              → крок 1
```

Примітки до механіки рев'юверів:

- **CodeRabbit**: `@coderabbitai review` — інкрементальний огляд нових комітів,
  `@coderabbitai full review` — повний з нуля (це і є «переініціалізація»);
  `@coderabbitai resolve` — закрити опрацьовані треди після push із фіксами.
- **Copilot code review**: після push треба явно re-request через
  `requested_reviewers` API (або `gh pr edit --add-reviewer` там, де підтримано);
  сам по собі він повторно не рев'юїть.
- Обидва боти можуть помилятися: fix-агент зобовʼязаний **верифікувати кожен
  коментар проти коду** і має право відповісти обґрунтованою незгодою. Мета
  циклу — «немає unresolved тредів», а не «виконані всі забаганки ботів».

### 6.3. Gate 3 — Ticket delivered (автоматичний, на тікет)

- PR у стані green (критерії з кроку 3, включно з arch-review conform);
- всі зміни в PR належать scope тікета (перевірка diff проти `files_modified`);
- verification commands з тікета зелені локально і в CI;
- для `human_checkpoint: true` — explicit approval людини.

### 6.4. Gate 4 — Integration (на milestone/phase)

Після merge всіх тікетів phase — окремий integrator-агент читає всі PR,
diff milestone-гілки/main, ADR і перевіряє: когерентність, відсутність
дублювань між тікетами, відповідність ADR, фактичне покриття acceptance
criteria. Вердикт `passed | needs-fix | human-review-required` в
`INTEGRATION.md`; `needs-fix` породжує fix-тікети, які проходять той самий
delivery-контур (розділ 6.1) — це і є зворотний цикл.

### 6.5. Телеметрія конвеєра (вхід для вдосконалення)

Конвеєр накопичує append-only журнал `.planning/graph/delivery-log.jsonl`:

- `status_change` пише **сам `state-sync.cjs`** при кожному холодному старті
  (перехід pending→branched→pr-open→merged, з таймстемпом);
- session-only факти (`attempt` з role/model/outcome, `fix_round`
  fixed|no-op|escalate, `escalation`) журналить оркестратор через
  `log-event.cjs` — GitHub їх пізніше не відновить.

`pipeline-stats.cjs` зводить журнал + `gh pr list` у метрики: медіанний
час до merge, babysit-спроби, частку no-op fix-раундів, ескалації в розрізі
risk. Це вхід для тюнінгу драбини моделей (§7.5) і промптів fix-ролей.

Стан тікета в `delivery-state.json` додатково несе `since` (відколи тікет у
поточному статусі); дошка холодного старту підсвічує «хвости» —
approved+green PR без merge та задавнені драфти. Матчинг тікет↔PR —
branch-first із fallback по маркеру `<T>:` у назві PR (страховка на випадок
перейменування канонічної гілки ре-декомпозицією; `Ticket: <T>` — перший
рядок PR body).

---

## 7. Оркестратор

Запускається скілом `/deliver` на підтверджений вами scope і живе, поки
scope не доведений до зеленого або не заблокований:

```text
0. холодний старт (6.0): resync із GitHub → перевалідація графа → drift-gate
1. читає graph/tickets.yaml + graph/delivery-state.yaml (щойно пересинхронізований)
2. просуває стани в межах scope: запускає ready-тікети, ганяє babysit loop
   для відкритих PR
3. після кожної зміни стану — комітить delivery-state.yaml (аудит-трейл у git)
4. блокується лише на human gates (human_checkpoint, ескалації attempts,
   needs-replan після drift-gate)
5. коли весь scope green/merged — якщо це була остання порція phase,
   пропонує integrator-прогін (Gate 4)
```

Оркестратор ідемпотентний: увесь стан у `delivery-state.yaml` + GitHub,
тому його можна вбити і перезапустити в будь-який момент — він відновить
картину зі стану PR (`gh pr list --json`), а не з памʼяті сесії.
У цьому репозиторії природне місце запуску — контейнер claude-shipyard
(gh auth уже змонтовано, claude CLI запечений).

---

## 7.5. Політика моделей

Два яруси: **важке судження + важка робота → Opus 4.8 з 1M контекстом, легка
механіка → Sonnet.** Розкладка агентів конвеєра:

```text
Opus 4.8  integrator, arch-review,        — судження з найдорожчими помилками,
1M        executor, review-fix, ci-fix,     кодова робота, діагностика,
          research:alternatives             проєктування опцій
Sonnet 5  drift-check, research:system-    — механічна звірка і збирання фактів
          state/constraints/risks
```

Точні model ID (звірено з каталогом моделей): Opus-ярус — **Opus 4.8 з 1M
контекстом**: аліас `opus[1m]`, повна форма `claude-opus-4-8[1m]`; Sonnet 5 =
`claude-sonnet-5` (скіли використовують аліас `sonnet`). Раніше найважчі
судження (integrator, arch-review) йшли на Fable 5, але вона тепер платна —
усі судження зведені до Opus 4.8 1M.

Скіли передають `model` при кожному спавні агента. Override — блок
`pipeline.models` у `.planning/config.json` (tier-аліаси або повні model ID).

GSD-агенти декомпозиції регламентуються власним механізмом GSD
(`model_profile` / `models` / `model_overrides` у тому ж config.json);
рекомендація: `models.planning: opus` + `model_overrides.gsd-planner:
claude-opus-4-8[1m]` — планувальник є найважчою роллю декомпозиції.

## 8. Gates (підсумкова таблиця)

```text
Gate 1: Investigation complete      — human + структурний валідатор
Gate 2: Ticket graph valid          — повністю автоматичний (validate-graph)
Gate 3: Ticket delivered (× тікет)  — автоматичний; human лише для high-risk
Gate 4: Integration accepted        — integrator-агент + human при needs-fix
Gate 5: Release ready               — rollout/rollback описані, evidence в PR body
```

Порівняно з v1 gates 4–8 згорнуті: plan quality забезпечує
`plan-review-convergence`, mechanical verification живе в CI babysit-циклу,
а «PR body якісний» — вимога Gate 3 (шаблон PR body: Problem, Scope, Ticket,
Dependency slice, Test evidence, Rollout/Rollback).

---

## 9. Повний operational flow

```bash
# 0. Init (одноразово)
/gsd-new-project
/gsd-map-codebase

# 1. Deep investigation (контур 1) — окрема точка входу
/investigate "тема/проблема"
#    intake-інтервʼю → research fan-out → ітеративний діалог
#    гіпотези, що потребують перевірки кодом: /gsd-spike "<ідея>"
/investigate            # наступна сесія: скіл сам підхопить відкритий INV
#    коли питання вичерпані, скіл пропонує закриття:
#    результат: DECISIONS.md + architecture/ADR-001.md          [Gate 1: human]

# --- розрив можливий тут ---

# 2. Декомпозиція (контур 2)
/decompose
#    сам знаходить недекомпозовані ADR, уточнює режим, під капотом:
#    plan-phase --ingest + plan-review-convergence + validate-graph
#    → graph/tickets.yaml, ви апрувите набір тікетів              [Gate 2: auto]

# --- розрив можливий тут ---

# 3. Delivery (контур 3) — окрема точка входу, scope обираєте на дошці
/deliver
#    холодний старт: resync з GitHub + drift-gate → дошка тікетів
#    → ви обираєте, що брати в роботу (multiselect)
#    worktree на тікет → PR на тікет → babysit до зеленого
#    з переініціалізацією CodeRabbit/Copilot після кожного push [Gate 3: auto]
/deliver                 # наступна порція, коли зручно

# 4. Integration — /deliver сам пропонує, коли фаза закрита
#    integrator → INTEGRATION.md                                 [Gate 4]
#    needs-fix → fix-тікети → знову /deliver

# 5. Наступна phase → крок 2
```

---

## 10. Що треба імплементувати (дельта, в порядку пріоритету)

**Інтерфейсний шар — три скіли** (Claude Code plugin, той самий механізм,
що й GSD-команди). Скіли не приймають обовʼязкових параметрів: читають стан
з артефактів, показують його і **допитують лише те, чого не можуть вивести**:

```text
1. /investigate   — контур 1: підхопити відкритий INV або створити новий,
                    intake-інтервʼю, research fan-out, Gate 1 → ADR
2. /decompose     — контур 2: знайти недекомпозовані ADR, уточнити режим,
                    GSD-ланцюг під капотом, Gate 2 → тікети на апрув
3. /deliver       — контур 3: холодний старт → дошка → вибір scope →
                    оркестратор; наприкінці фази пропонує integrator
```

**Детермінований шар — скрипти, які скіли викликають** (git-операції,
валідацію і GitHub-стан агент не імпровізує):

```text
4. delivery-оркестратор     — розділи 6–7; worktree/branch/PR lifecycle + babysit loop
5. scripts/validate-graph   — Gate 2: цикли, посилання, file-конфлікти,
                              генерація graph/tickets.yaml з frontmatter
6. scripts/reviewers        — re-init: coderabbit comment + copilot re-request;
                              збір unresolved-тредів
7. scripts/state            — resync delivery-state.yaml із фактичного стану GitHub
```

**Агентні промпти** (використовує оркестратор):

```text
8. ci-fix, review-fix, arch-review, drift-check, integrator, intake/research (INV)
```

Мінімальний робочий цикл «тікети → зелені PRи»: `/deliver` + пункти 4–7 +
ci-fix/review-fix. `(опційно)` Jira/GitHub exporter: tickets.yaml → issues.

---

## 10.5. Реорієнтація на GSD 1.7 (пін: 1.7.0)

Конвеєр переорієнтовано з 1.6.x на 1.7. Ключовий факт з ревізії документації
next: GSD свідомо зупиняється на створенні PR (non-goals: no tracker
integration, no auto-PR-loop, no auto-merge) — babysit-цикл, resync стану з
GitHub, ADR-конформанс і integrator лишаються унікальною цінністю надбудови.

**Вже враховано в конвеєрі:**

- `requirements[]` — обов'язкове поле frontmatter (порожнє = BLOCKER
  plan-checker'а): шаблон у /shipyard:decompose доповнено, validate-graph
  попереджає;
- `wave` у шаблоні самостійного авторства планів;
- preflight `gsd-tools worktree base-check` перед створенням ticket-worktree;
- `context_window: 1000000` у рекомендованому конфізі (adaptive-context для
  1M-моделей, узгоджено з opus[1m]);
- конфіг-булеани типу `workflow.code_review` стали capability-owned — скіли
  не читають їх напряму.

- **capability `delivery-pipeline`** (`capabilities/delivery-pipeline/`,
  ставиться в образ на global scope): fail-closed gate `command-exit-zero` →
  `validate-graph.cjs` на `plan:post`, blocking. Gate 2 тепер — механічна
  частина GSD-циклу: планування фізично не завершиться без матеріалізованих
  валідних PLAN-файлів (перевірено: без планів gate повертає block:true,
  з валідними — block:false). Вимикач — федеративний конфіг-ключ
  `delivery_pipeline.graph_gate`. Нюанс rc.4: `runtimeCompat.supported`
  приймає лише `["*"]` (конкретний id `claude` не проходить крос-валідацію).

- **ship:pre gate** (capability v0.3.0): blocking `command-exit-zero` →
  `uat-gate.cjs ${PHASE_NUMBER}` обгортає fail-closed предикат
  `phase uat-passed` — /gsd-ship не пройде без verification evidence
  (вимикач: `delivery_pipeline.uat_gate`). Без фази в контексті — skip.
- **`ship.pr_body_sections`** засіяно в рекомендований конфіг decompose
  (Acceptance Criteria + Risks & Dependencies з PLAN.md).
- **Pre-push рев'ю** — опційний крок 4b у deliver
  (`/gsd-code-review --fix` / `/gsd-review --coderabbit --opencode`).
- validate-graph свідомо НЕ схуднутий до дельти над plan-checker:
  імпорт-потік (Jira → PLAN.md у deliver) не проходить через plan-checker,
  тож самостійна повна перевірка DAG лишається потрібною.

- **arch-conform agentVerdict** (capability v0.4.0): advisory-gate на
  ship:pre — LLM-оцінка відповідності змін фази locked-рішенням ADR
  (blocking заборонено контрактом для недетермінованих перевірок; вимикач
  `delivery_pipeline.arch_verdict`).
- **`agent_skills` injection**: скіл `pipeline:delivery-rules`
  (правила frontmatter/delivery-блоку/branch naming/scope-дисципліни)
  інжектиться в gsd-planner і gsd-executor через
  `agent_skills: {"gsd-planner": ["global:shipyard:delivery-rules"], ...}`
  у рекомендованому конфізі.
- **Трейлер `gate_status:`** — deliver фіксує вердикти в PR body останнім
  рядком (`gate_status: arch-review=…, drift-check=…, checks=green`);
  переживає squash-merge, читається пост-фактум.

Roadmap 1.7 закрито повністю.

## 10.6. Codex runtime (той самий конвеєр на OpenAI Codex CLI)

Конвеєр працює і на Codex — установка на хості, окремо від Docker-образу.
Джерело правди лишається Claude-плагіном (`plugins/delivery-pipeline/commands/*.md`);
генератор `scripts/gen-codex-shipyard.cjs` емітить Codex-native артефакти,
тож два рантайми не розходяться (нуль дрейфу).

- **Конверсія без реплікації.** Генератор `require()` власний конвертер gsd-core
  (`runtime-artifact-conversion.cjs`) — команди стають Codex-скілами
  `~/.agents/skills/shipyard-<cmd>/SKILL.md` з `<codex_skill_adapter>`-хедером
  (мапінг `AskUserQuestion → request_user_input`, `Agent/Task → spawn_agent`).
  Плагін-специфічні rewrite-и (`${CLAUDE_PLUGIN_ROOT}`, `/shipyard:<cmd>` →
  `$shipyard-<cmd>`) робить сам генератор.
- **Сабаґенти.** Ролі з `references/*.md` (arch-review, ci-fix, drift-check,
  review-fix, integrator, inv-research) → `$CODEX_HOME/agents/shipyard-<role>.toml`,
  зареєстровані в `config.toml [agents.*]` **non-destructively** (gsd-агенти
  не чіпаються; merge ідемпотентний).
- **Гейти.** Capability вже runtime-agnostic (`runtimeCompat: ["*"]`,
  `command-exit-zero` + `agentVerdict`) — той самий Gate 2 і UAT-гейт
  ставляться через `gsd-tools capability install`.
- **`deliver` — гібрид.** У Codex немає Workflow tool, тож `deliver` іде своїм
  вбудованим Agent-шляхом: детермінантика — Node-скрипти під
  `$CODEX_HOME/shipyard/scripts/`, агентна робота — через `spawn_agent`.

Установка: `make install-shipyard-codex` (потрібен gsd-core для Codex:
`npx --yes @opengsd/gsd-core@1.7.0 --codex --global`). `SHIPYARD_CODEX_PHASE=1` —
лише investigate+decompose. Смоук: `make test-codex-shipyard`.

## 11. Короткий висновок

```text
GSD        = investigation support + декомпозиція + plan quality convergence
Надбудова  = deep-investigation дисципліна + ticket graph +
             PR-per-ticket delivery у worktrees + review babysitting
```

Найбільшу цінність дають: locked decisions як контракт investigation;
тікет = GSD-план із delivery-frontmatter (одне джерело правди для залежностей);
worktree + stacked-PR модель, що дає справжню паралельність без file-конфліктів;
babysit loop, який автоматично доводить кожен PR до зеленого стану і тримає
CodeRabbit/Copilot у циклі після кожного push.
