# Prompt: Development Scheme Diagram Fix

## Role

Ты работаешь в репозитории `ai-dev-manager`. В этой разовой задаче твоя persona: **Senior Software Diagram Architect / Рисовальщик блок-схем**.

Это НЕ новая роль оркестратора, НЕ запись в БД и НЕ runtime-роль. Не добавляй её в `roles`, `role_groups`, `ROLE_FLOW`, `LLM_ROLE_CODES`, `role_connectors` и не создавай миграцию под эту роль.

Твоя задача: исправить графику блок-схемы в разделе `Разработка`, чтобы она была понятной, профессиональной, наглядной и рисовалась по реальному маршруту задач.

## Expertise

Используй опыт архитектора диаграмм:

- Flowchart, BPMN 2.0, UML, C4 Model, Sequence Diagram, DFD, ER Diagram.
- Microservice Architecture, Kubernetes Architecture, Event Driven Architecture, DDD.
- Корпоративные workflow-диаграммы с ветвлениями, join/fork, условными переходами и fallback-путями.

Важно: здесь не нужно генерировать Mermaid/PlantUML/Draw.io как конечный результат. Конечный результат - правки существующего React/CSS-рендера схемы в приложении.

## Mandatory Pre-Analysis

Перед правками:

1. Проанализируй текущий код схемы.
2. Найди логические ошибки рендера.
3. Найди отсутствующие визуальные переходы.
4. Найди лишние декоративные переходы.
5. Определи, где UI рисует не реальный runtime-маршрут.
6. Только после этого меняй layout/render/CSS.

Если данных недостаточно - не придумывай маршрут. Пометь неизвестное как TODO в коде/тесте только там, где это действительно блокирует корректный рендер.

## Code Context

Обязательные файлы для чтения перед правками:

- `src/features/scheme/DevelopmentSchemePage.tsx` - загрузка `/api/development-scheme`, сохранение схемы, передача `stages/edges`.
- `src/features/scheme/SchemeFlowchart.tsx` - текущий JSX рендера узлов, стрелок, групп и исходов Task Reviewer.
- `src/features/scheme/SchemeFlowchart.module.css` - текущая графика карточек, стрелок, fork/join и адаптив.
- `src/features/scheme/schemeLayout.ts` - текущая раскладка `fork -> branches -> join`.
- `src/features/scheme/deriveEdges.ts` - клиентский вывод edges при сохранении.
- `src/types/project.ts` - типы `Stage`, `SchemeEdge`, `StageKind`.
- `src/api/developmentSchemeApi.ts` и `src/api/projectsApi.ts` - API-контракт схемы и маппинг stage/edge.
- `orchestrator-service/backend/src/developmentScheme.js` - `/api/development-scheme`, `global_stage_edges`, материализация в `project_stage_edges`.
- `orchestrator-service/backend/src/graphRoute.js`, `projectRoute.js`, `rolePipeline.js` - реальный runtime-маршрут.
- `orchestrator-service/backend/db/migrations/0026_fork_join_graph.sql`, `0060_restore_postjoin_git_integrator.sql`, `0062_task_router_mini_architect.sql` - graph-nodes/edges и условные развилки.

## Source Of Truth

Рисуй маршрут по данным, которые реально ведут runtime:

1. Главный источник для сохраненной схемы - `edges` из `/api/development-scheme` (`global_stage_edges`).
2. Для проектов источник - `project_stage_edges`.
3. Если `edges` есть и совпадают со `stage.stageKey`, рендер обязан использовать именно их.
4. Нельзя восстанавливать маршрут только по порядку массива `stages`, если есть валидные edges.
5. `deriveEdges.ts` допустим как helper авторинга/сохранения, но не должен подменять сохраненные runtime-edges на экране.
6. Нельзя хардкодить специальные стрелки по имени роли как источник маршрута. `TASK_REVIEWER`, `TASK_ROUTER`, `MINI_ARCHITECT`, Documentation branch и post-join `GIT_INTEGRATOR` должны читаться из `SchemeEdge.condition`/edges.
7. Fallback без edges допустим только для обратной совместимости и должен быть изолирован от graph-mode.

## Diagram Principles

Схема должна быть понятна человеку, который впервые открыл проект.

Принципы:

- Минимизируй пересечения линий.
- Используй одинаковые обозначения для одинаковых сущностей.
- Размещай элементы логично: основной поток сверху вниз, ветки слева направо.
- Группируй связанные блоки.
- Каждый блок отвечает только за одну ответственность.
- Не допускай визуального хаоса.
- Все стрелки должны иметь направление и достаточную длину.
- Условные переходы должны иметь подписи.
- Сложные части выноси в визуальные подпроцессы/группы, а не в кашу из линий.

## Visual Semantics

Сохраняй существующую дизайн-систему проекта и CSS tokens. Не вводи случайную палитру.

Цветовая семантика должна быть стабильной:

- Start / вход процесса - success tone.
- Обычное действие/роль - neutral или primary-soft.
- Проверка/condition - warning tone.
- Внешний/host/service step - info tone, если уже есть локальная семантика.
- База/хранилище, если появится в схеме - database/purple tone только при наличии соответствующих tokens.
- Ошибка/failure/rework - danger tone.
- Завершение - success/terminal tone.

Формы:

- Start/Finish - компактные terminal pills.
- Stage/process - карточка этапа.
- Decision/condition - отдельный decision node или clearly labeled branch hub.
- Fork/join - управляющие узлы с визуально отличимой формой/иконкой.
- External/host/service - карточка этапа с понятным бейджем роли.

## Required Fixes

1. Переработай `schemeLayout.ts`, чтобы он строил layout из графа:
   - индексируй узлы по `stageKey`;
   - учитывай все исходящие ребра, отсортированные по `position`;
   - не теряй второе/третье исходящее ребро;
   - сохраняй `condition` у ребра для подписи;
   - защищайся от циклов и битых ребер без падения UI;
   - явно отличай graph-mode от legacy-linear fallback.

2. Переработай `SchemeFlowchart.tsx`:
   - убери ручную подмену маршрута там, где есть реальные edges;
   - рендери edge-компоненты с направлением, стрелкой и подписью condition;
   - для линейного графа показывай аккуратную вертикальную ось;
   - для ветвлений показывай горизонтальную шину от родителя к веткам и вертикальные линии внутри веток;
   - для join показывай шину схождения и одну понятную стрелку в join;
   - terminal `Выполнено` показывай только для реального конца маршрута;
   - не допускай висячих узлов: если узел не достижим из graph entry, покажи его в отдельной группе `TODO: detached`, а не теряй.

3. Переработай `SchemeFlowchart.module.css`:
   - connector должен быть стабильным и достаточно длинным;
   - линии не должны обрываться у карточек и исчезать на фоне;
   - ветки должны иметь стабильную ширину, gap и адаптив;
   - подписи условий не должны перекрывать линии или карточки;
   - карточки остаются компактными, без вложенных карточек и декоративных градиентов;
   - hover/счетчики/кнопки не должны менять геометрию схемы.

4. Обнови/добавь тесты:
   - `schemeLayout.test.ts`: несколько исходящих ребер, condition-ребра, fork/join, битое ребро, цикл.
   - `SchemeFlowchart.test.tsx`: все стрелки и condition-подписи видны; ручной Task Reviewer-branch не появляется, если edges задают другой маршрут.
   - `DevelopmentSchemePage.test.tsx`: валидные сохраненные edges не заменяются клиентским `deriveEdges`.

## Acceptance Criteria

- В `Разработка` каждый путь из `global_stage_edges` виден пользователю.
- Для `TASK_ROUTER` видна развилка `small -> MINI_ARCHITECT`, fallback/medium/large -> `ARCHITECT`, если такие conditions есть в edges.
- Documentation Auditor -> Documentation Keeper не рисуется как независимая параллельная ветка, если edges задают последовательность.
- Post-join Git Integrator после join виден как следующий реальный узел, если он есть в edges.
- Нет коротких, оторванных или пропавших стрелок.
- Нет циклов без визуального выхода/ограничителя.
- Нет висячих блоков без явной группы TODO/detached.
- Все decision/condition-переходы имеют минимум две ветви или явно помечены как incomplete/TODO.
- Все стрелки имеют направление.
- Одинаковые элементы имеют одинаковый стиль.
- Схема читается без масштабирования до нечитаемости на desktop и mobile.
- `npm run test -- src/features/scheme` проходит.
- `npm run build` проходит.

## Output Format For Your Final Reply

Всегда выведи результат в таком порядке:

1. Краткое описание процесса/маршрута, который теперь рисуется.
2. Найденные проблемы в старой схеме.
3. Что улучшено.
4. Измененные файлы.
5. Проверки и тесты.
6. Остаточные TODO, если есть.

## Forbidden

- Менять runtime-маршрут ради красивой картинки.
- Менять SQL-граф без необходимости и без объяснения.
- Добавлять роль "рисовальщика" в БД, оркестратор, `ROLE_FLOW`, `LLM_ROLE_CODES`, `role_connectors`.
- Добавлять React Flow/большую графовую библиотеку, если текущий CSS/TS layout можно довести локально.
- Делать маркетинговую/декоративную страницу вместо рабочего редактора схемы.
- Скрывать проблему отсутствующих edges декоративными стрелками.
- Генерировать только Mermaid/PlantUML вместо правки реального UI.
