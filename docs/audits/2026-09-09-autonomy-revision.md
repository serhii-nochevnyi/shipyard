# Повторна ревізія автономності та моделей — 2026-09-09

## Результат і межі перевірки

У main вже інтегровані фази 25–27, реліз **0.49.0**. Шість додаткових знахідок попередньої ревізії R01–R06 залишаються актуальними. Виявлено одну нову прогалину R07 у підрахунку одночасних guard-агентів. Окремо підтверджено розбіжність між оновленим репозиторієм і встановленим Codex bundle; це стан інсталяції, а не восьмий дефект нового коду.

Виконано `git fetch origin` та `git pull --ff-only`: на момент виклику main вже був актуальним, `43cc359`. Під час ревізії інший процес пересунув main на **`31ed89659d8a84257499c86bd0f9886cde9a8447`**, який також відповідав origin/main при фінальній перевірці. Цей додатковий коміт змінює лише три backlog-документи. Дерева `plugins`, `scripts`, `tests` у двох ревізіях побітово однакові. Тести виконано в окремому detached worktree на `43cc359`, тому вони перевіряють той самий runtime-код, що й `31ed896`.

Перевірено resolver та сигнали складності, генератор Codex, installer/preflight, історію невдалих спроб, inline/background judgment, журнал dispatch, capacity, front/stop/CI wait, base refresh, worktree bases, перенесення gate trailer та перевірку досяжності після merge. Зіставлено ADR-005/006, звіти інтеграції та відомі follow-up. Це ревізія цих наскрізних механізмів, а не твердження про перевірку кожного рядка репозиторію. Реальні платні агенти, Docker/Kubernetes і якість відповідей моделей на вибірці задач не випробовувалися.

## Перевірки

| Перевірка | Результат |
|---|---|
| `make test-fast` | PASS, exit 0 |
| `make test-codex-shipyard` | PASS, exit 0; справжній gsd-core 1.13.0 у тимчасовому HOME smoke-тесту |
| Попередні adversarial probes на новому main | R01–R05 відтворюються |
| Контракт background arch-review | R06 підтверджено читанням обох шляхів; не live LLM експеримент |
| Два одночасні guard у різних хвилях | Новий R07 відтворено функцією `computeFront` |
| Вісім ролей, обидві runtime-гілки | Базові alias/effort відповідають поточній політиці |
| Встановлений Codex bundle | Чотири перевірені runtime-скрипти відрізняються від main; різниця семантична |

`test-fast` друкує відомий неблокуючий дефект smoke-фікстури: `sentinel-smoke.sh:1647: pending: command not found`. Загальний exit залишається 0; це вже пункт 11 розділу “Worth a ticket later” інтеграційного звіту фази 27, а не нова знахідка цього аудиту.

## Підтверджені незакриті знахідки

### R01 — P1: перехід одразу до repeat_exhausted без repeat

[failure-signature.cjs:375](/Volumes/KINGSTON/claude-shipyard/plugins/delivery-pipeline/scripts/failure-signature.cjs:375), [перехід:397](/Volumes/KINGSTON/claude-shipyard/plugins/delivery-pipeline/scripts/failure-signature.cjs:397).

На нових head послідовність сигнатур `A → B → A → A` дає `first → progress → progress → repeat_exhausted`. Лічильник `seen` збирає всі появи A після останнього green; перевірка суміжності стосується лише останньої пари. За двох різних сигнатур правило K=3 не втручається. Жодна попередня відповідь не вимагала `repeat/rethink`, але вже дозволена стеля моделі та подальше передавання людині.

Це ризик передчасного припинення автономного repair і витрачання найдорожчої спроби. Потрібне підтвердження, що rethink саме цієї помилки вже виконано. Послідовні повтори усувають наведений контрприклад; для сильнішого твердження «глибину вже витрачено» потрібний зв'язок зі спробою та фактично застосованою глибиною. `effort_applied: unknown` не є таким доказом.

### R02 — P2: remap обходить min_cli моделі Codex

[gen-codex-shipyard.cjs:295](/Volumes/KINGSTON/claude-shipyard/scripts/gen-codex-shipyard.cjs:295).

CLI-фікстура `0.147.0` правильно вилучає Astra з палети, але `model_profile_overrides.codex.sonnet.model = gpt-6-astra` повертається прямо з GSD remapper. В одному запуску отримано попередження «не записуємо Astra», палету лише з Terra та фактичний результат `gpt-6-astra/high`.

Перевіряти сумісність потрібно після остаточного remap, використовуючи відомий `min_cli` початкової палети. Це не вимога заборонити довільні нові моделі чи скасувати пріоритет remap.

### R03 — P2: preflight не читає model із зареєстрованого agent-файлу

[gsd-tune.cjs:429](/Volumes/KINGSTON/claude-shipyard/plugins/delivery-pipeline/scripts/gsd-tune.cjs:429), [пошук model literal:443](/Volumes/KINGSTON/claude-shipyard/plugins/delivery-pipeline/scripts/gsd-tune.cjs:443).

Preflight шукає назву моделі тільки в `config.toml`. Стандартна реєстрація містить `config_file = "agents/shipyard-integrator.toml"`, а сама модель лежить у цьому окремому файлі. Фікстура зі встановленим Astra-агентом і CLI `0.147.0` після звичайного tune проходить: `exit=0, blockers=[], drift=0`.

Потрібно перевіряти фактичні зареєстровані agent-файли або достовірний install manifest. Це окремий сценарій від R02: тут йдеться про виявлення вже несумісної інсталяції.

### R04 — P2: повторна інсталяція залишає вилучені -deep файли

[install-shipyard-codex.sh:96](/Volumes/KINGSTON/claude-shipyard/scripts/install-shipyard-codex.sh:96).

Installer копіює нові TOML поверх старих і не прибирає власні файли, які більше не генеруються. Реальний генератор запущено двічі — із версіями `0.153.4`, потім `0.147.0`; після того самого copy-over, що в installer, лишаються чотири старі `-deep` файли, хоча другий результат генерації їх не містить. Зменшення палети має ту саму проблему.

Перевірка «файл існує» більше не засвідчує актуальну політику. Конкретний host може відкрити застарілий агент або відмовити в його dispatch; live-вибір цього файлу не випробовувався. Потрібне узгодження старого й нового manifest із видаленням лише файлів, якими володіє installer, та двоетапний install smoke.

### R05 — P2: актуальний Claude CLI маскує неправильний explicit Fable pin

[gsd-tune.cjs:405](/Volumes/KINGSTON/claude-shipyard/plugins/delivery-pipeline/scripts/gsd-tune.cjs:405).

У фікстурі `pipeline.fable=auto`, CLI `2.1.263` і `ANTHROPIC_DEFAULT_FABLE_MODEL=claude-fable-5` preflight повертає `exit=0, blockers=[]`. Він читає версію CLI, але не перевіряє explicit pin, який суперечить вимозі Fable 5.1 у прийнятому ADR-005. Це перевірка узгодженості з політикою репозиторію, не нова зовнішня перевірка поведінки провайдера.

Перевіряти потрібно також ефективне explicit налаштування моделі. Зміна лише CLI не виправляє environment override; автоматично переписувати середовище користувача не потрібно.

### R06 — P2: background judgment не записує факт, потрібний для власної ескалації

[pr-sentinel.md:149](/Volumes/KINGSTON/claude-shipyard/plugins/delivery-pipeline/references/pr-sentinel.md:149), порівняння з [deliver.md:1374](/Volumes/KINGSTON/claude-shipyard/plugins/delivery-pipeline/commands/deliver.md:1374).

Background-контракт читає попередній `arch_review … verdict=violation`, але не зобов'язує записати `arch_review` для поточного вердикту. Він також не містить виклику arch-review resolver з `--input-tokens` / `--contested`. Inline-шлях має і resolve, і writer. Нове передавання `base_tree` виправляє іншу частину протоколу й не закриває цю.

Отже, background-only виконання не має гарантованого producer факту для contested escalation. Агент може доповнити пропущені кроки сам, але автономний протокол на це не повинен покладатися. Потрібна спільна процедура measure → resolve → dispatch → record для обох шляхів та contract-тест обох входів.

### R07 — P2, нове: кілька живих guard рахуються як один

[front.cjs:1155](/Volumes/KINGSTON/claude-shipyard/plugins/delivery-pipeline/scripts/front.cjs:1155), [дозволений запуск нового guard:1257](/Volumes/KINGSTON/claude-shipyard/plugins/delivery-pipeline/commands/deliver.md:1257).

Виправлення фази 27 коректно згортає N записів одного guard до одного агента. Але ключ згортання — лише роль `pr-sentinel`, без ідентифікатора агента чи хвилі. `activeDispatches` повертає тільки `{role, at}`. Step 4 одночасно дозволяє повернутися до наступної хвилі, поки guard працює, і передати нові PR новому guard.

Відтворено дозволений цим контрактом стан:

```text
guard хвилі 1: T-01-01, T-01-02
guard хвилі 2: T-01-03
executor:      T-01-04
executor:      T-01-05

фактично у фікстурі: 4 агенти, вільно 0
computeFront:        max=4, in_flight=3, free=1
```

Наступна хвиля отримує зайве місце. Більше одночасних guard збільшує похибку. Це не заперечення прийнятого правила «один guard над кількома PR коштує одного агента»; дефект полягає в злитті **різних** guard у той самий запис підрахунку.

Варіанти виправлення: зберігати й передавати фактичний `agent_id`/dispatch group та рахувати унікальні живі агенти; або механічно гарантувати єдиний guard на активний конвеєр і прибрати дозволений паралельний fresh-guard шлях. Перший варіант зберігає чинну гнучкість. Час запису не є надійною заміною id: нові PR можуть додаватися вже запущеному guard. Acceptance має розрізняти один guard із кількома PR і два різні guard.

## Встановлений конвеєр відстає від main

Це окреме операційне спостереження. Встановлений [shipyard-deliver skill](/Users/serhii/.agents/skills/shipyard-deliver/SKILL.md:271) посилається на `/Users/serhii/.codex/shipyard/scripts`. Перевірені `front.cjs`, `pipeline-config.cjs`, `dispatch-record.cjs`, `gsd-tune.cjs` у цьому bundle відрізняються від main. Генератор копіює script payload побітово, тому ця різниця не пояснюється перетворенням Claude-команд у Codex skills. Diff показує відсутність нової capacity/model-policy логіки у встановлених файлах.

Конкретний приклад: [встановлений integrator](/Users/serhii/.codex/agents/shipyard-integrator.toml:4) має `gpt-5.6-terra/xhigh`; [arch-review](/Users/serhii/.codex/agents/shipyard-arch-review.toml:4) також Terra/xhigh. Це попередня генерація, а не очікуваний результат нової палітри. Доступність Astra на host додатково залежить від перевірки CLI під час нової генерації.

Тому нова поведінка репозиторію ще не означає нову поведінку skill, який використовує встановлені шляхи. Після закриття installer/preflight сценаріїв потрібні регенерація/перевстановлення bundle та оновлення сесії, що вже завантажила старі інструкції. У цій ревізії змінювалися тільки audit-артефакти: глобальні агенти й конфігурація не перевстановлювалися.

## Що вже виправлено або не слід повторно оголошувати новим дефектом

| Попереднє зауваження | Поточний стан |
|---|---|
| Невалідний конфіг дозволяє default auto-merge | T-26-02 інтегровано. `loadConfig` повертає `valid:false`; mutation gates відмовляють. Саме існування default-полів у результаті loadConfig більше не доводить permissive merge. Smoke підтверджує відмову duty/merge. |
| Ліміту паралельності взагалі немає | Виправлено T-26-12 і фазою 27. Є capacity, узгоджені читачі front/stop/CI wait, cap=4. R07 — конкретний залишковий multi-guard сценарій. |
| Усі Codex-ролі примусово Terra; немає deep-варіантів | У source виправлено фазою 25. Є palette, CLI floor та чотири deep-варіанти; залишаються R02–R04. Старий встановлений bundle — окрема причина спостерігати стару поведінку. |
| `gsd-tune --apply` безумовно повертає дорогі Fable overrides | Старий висновок неактуальний. Тепер tuning враховує policy/runtime; R05 стосується перевірки explicit pin. |
| Причина dispatch — довільний текст; можна назвати agent іншої ролі; альтернативний writer dispatch | Фаза 27 додає resolver route grammar, перевірку pair, відповідності agent-file ролі й заборону іншого writer. Route ще не є доказом фактичного виконання або правильності усіх сигналів. |
| Drift Workflow без explicit effort повертає low | Default вирівняно з поточним resolver; тести перевіряють відповідність. |
| Base-tree carry є, але до нього не доходять дані | T-27-09 підключив `--base-tree` в обох документованих writers. Наявні перевірки head/base tree та скидання checks при carry. |
| Застарілі epic/base refs; child PR на вже merged parent | Є epic refresh, origin-first worktree base, перевірки limb та післяmerge reachability. Відоме окреме питання автоматичного retarget stranded child не закрите цими твердженнями. |

Відомий незавершений зв'язок **T-26-13** також залишається: `drift-needed.cjs` реалізований і тестується, але пошук по production commands/references не знаходить його виклику. Це вже задокументоване відкладене підключення, а не нова знахідка.

Не повторно рахувалися новими й follow-up інтеграції фази 27: journal ownership для `epic_unreachable`, refresh push у freshness warning, дробові stale-hour knobs, stranded-child fixpoint та неблокуюча помилка heredoc у smoke. Їх треба тримати в backlog із чинними статусами, а не плутати з виправленими landing edits.

## Що це означає для оптимізації підписок

Прийняту драбину змінювати через ці дефекти не потрібно. Підтверджена source-база Claude: executor/repair/research — Opus/high, arch-review/integrator — Opus/xhigh, drift/guard — Sonnet/high. Автоматичний маршрут не повертає Haiku. Codex використовує окрему палітру: Terra/high, drift Terra/low; за доступної стелі — integrator Astra/high і чотири deep-ролі Astra/high. Alias `sonnet` у Codex resolver не є остаточним ID моделі.

Адаптація до role/risk/checkpoint, failure signature та переданих input/contested сигналів є. Вона все ще залежить від повноти виклику, що демонструє R06. Прочитані routing/dispatch компоненти не реалізують контролер залишку підписок Codex/Claude, reset-time, резервування ліміту під суддів і перевибору runtime за залишком квоти. Capacity обмежує одночасну роботу, але не вимірює споживання підписки.

Рекомендований порядок: **R01 + R06 → installer/preflight R02–R05 → R07 → узгодження встановленого bundle → quota-aware admission окремою зміною**. Для останньої потрібні timestamp та надійність показників квоти, збереження роботи перед reset і відновлення після нього. Недоступний показник не можна трактувати як нуль або повний запас. Модель судді та мінімальна якість мають лишатися явними обмеженнями політики. Економія у відсотках без вимірювання реального споживання та якості тут не заявляється.

## Відтворення і артефакти

- [Повторні probes R01–R05](/Volumes/KINGSTON/claude-shipyard/docs/audits/2026-09-08-models-autonomy-probes.cjs) — запущено проти нового snapshot, використано фактичний встановлений GSD resolver та локальні CLI version stubs.
- [Нові probes](/Volumes/KINGSTON/claude-shipyard/docs/audits/2026-09-09-autonomy-probes.cjs) — multi-guard, background contract, baseline ролей, optional installed-script parity.
- [Зафіксовані результати](/Volumes/KINGSTON/claude-shipyard/docs/audits/2026-09-09-autonomy-evidence.json).

Приклад запуску нової діагностики:

```sh
node docs/audits/2026-09-09-autonomy-probes.cjs /path/to/checkout /path/to/.codex/shipyard
```

Це діагностичні скрипти: exit 0 означає завершення спостережень, а не відсутність дефектів. Нові артефакти залишені без коміту. Наявні зміни `.planning/graph`, попередні звіти та чужі worktree збережені.
