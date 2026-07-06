---
name: investigate
description: "Deep investigation (контур 1): підхопити відкритий INV або створити новий; intake-інтерв'ю, research fan-out, ітеративний діалог, Gate 1 → ADR"
argument-hint: "[сирий problem statement — опційно]"
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Grep
  - Glob
  - Agent
  - AskUserQuestion
---

# /pipeline:investigate

Ти ведеш контур 1 delivery-конвеєра (див. `docs/gsd_multilevel_delivery_pipeline.md`
якщо є в репо). Стан живе ТІЛЬКИ в артефактах `.planning/investigations/` —
жодної залежності від пам'яті сесії. Між сесіями можуть бути розриви в тижні.

## Step 0 — Визначити режим

Прочитай `.planning/investigations/` (може не існувати):

- Є відкриті INV (без маркера `CLOSED` у назві або `status: closed` в PROBLEM.md
  frontmatter) І користувач не дав аргумент → покажи їх зі статусом
  (скільки open questions лишилось — порахуй `- [ ]` в OPEN-QUESTIONS.md)
  і запитай через AskUserQuestion: продовжити котрийсь чи почати новий.
- Користувач дав problem statement аргументом → новий INV (Step 1).
- Відкритих нема і аргументу нема → запитай problem statement.

## Step 1 — Старт нового INV

1. Preconditions:
   - `.planning/` існує (інакше запропонуй `/gsd:new-project` і зупинись);
   - карта кодової бази: якщо нема `.planning/codebase/`, запусти
     `/gsd:map-codebase` або попередь, що research працюватиме без карти.
2. Обери номер: наступний вільний `INV-NNN`, slug з 2–4 слів теми.
3. Створи `.planning/investigations/INV-NNN-slug/`, скопіювавши ВСІ шаблони з
   `${CLAUDE_PLUGIN_ROOT}/templates/inv/`.
4. **Intake-інтерв'ю**: сирий statement не приймається мовчки. Постав через
   AskUserQuestion питання, яких бракує для PROBLEM.md: для кого / поточний
   pain / що буде success / що точно поза scope. Питай тільки те, чого не
   можеш вивести зі statement. Заповни PROBLEM.md.
5. **Research fan-out**: запусти ПАРАЛЕЛЬНО 4 агентів (Agent tool, в одному
   повідомленні) за брифом `${CLAUDE_PLUGIN_ROOT}/references/inv-research.md` —
   лінії: system state / alternatives / constraints / risks+unknowns.
   Моделі (політика: важке → opus, легке → sonnet; override —
   `pipeline.models` у `.planning/config.json`):
   - alternatives+prior-art → `model: opus[1m]` (проєктування опцій — важка лінія)
   - system state, constraints, risks+unknowns → `model: sonnet` (збирання фактів)
   Кожному передай problem statement і шлях до INV-директорії. Їхні результати
   внеси в RESEARCH.md, OPTIONS.md, RISKS.md, OPEN-QUESTIONS.md.
6. Покажи користувачу підсумок: скільки опцій, ключові ризики, список
   відкритих питань. Далі — Step 2.

## Step 2 — Ітеративний діалог (основний режим resume)

Мета кожної сесії: закривати OPEN-QUESTIONS і фіксувати положення.

- Питання, на які може відповісти дослідження — закривай агентами сам.
- Питання-рішення — виноси користувачу (AskUserQuestion, з варіантами з
  OPTIONS.md і trade-offs у previews, коли доречно).
- КОЖНЕ прийняте положення ОДРАЗУ пиши в DECISIONS.md за форматом шаблону
  (## рішення / **Чому** / **Що відкинули** / **Scope fence**). Познач
  відповідне питання `- [x]` з посиланням.
- Гіпотези, що потребують перевірки кодом — пропонуй `/gsd:spike "<ідея>"`.
- Питання без досяжної відповіді — переноси в RISKS.md з mitigation
  (за згодою користувача) і закривай.

## Step 3 — Закриття (Gate 1)

Коли `- [ ]` в OPEN-QUESTIONS.md не лишилось — сам запропонуй закриття:

1. `node ${CLAUDE_PLUGIN_ROOT}/scripts/validate-inv.cjs <INV-dir>` — має бути OK.
2. Згенеруй ADR-пакет у `.planning/architecture/`:
   - `ADR-NNN-<slug>.md` — з DECISIONS.md, у форматі, який parse-ить
     `/gsd:plan-phase --ingest` (Nygard: Status/Context/Decision/Consequences;
     кожне locked decision — явна секція, scope fences — окремим блоком);
   - за наявності матеріалу: INTERFACES.md, DATA-MODEL.md, ROLLOUT.md.
3. Додай в PROBLEM.md frontmatter `status: closed` + дату і посилання на ADR.
4. Скажи користувачу наступний крок: `/pipeline:decompose`.

## Правила

- Не пиши код. Investigation — read-only щодо кодової бази (крім артефактів).
- Не приймай рішення за користувача. Агенти готують опції — вибирає людина.
- Кожне твердження про кодову базу — з file path.
