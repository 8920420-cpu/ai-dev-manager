-- WORK-STACK-001 — очередь-«стек» элементов работы между Архитектором и Программистом.
--
-- Мотивация. Раньше Архитектор при расщеплении мультисервисной задачи МАТЕРИАЛИЗОВАЛ
-- детей прямо в tasks (task_kind='service', наследуя описание/messageFingerprint эпика).
-- Это порождало два хронических дефекта:
--   * bogus-дедуп: closeBlockedDuplicateTasks группировал ребёнка с родителем по общему
--     fingerprint и гасил ребёнка как «дубль своего же эпика»;
--   * рекурсию расщепления: ребёнок, вернувшийся к Архитектору, снова выглядел
--     «мультисервисным» и порождал новый эпик с детьми (эпик→эпик→эпик).
--
-- Теперь разбивка Архитектора кладётся сюда КАК ДАННЫЕ ОЧЕРЕДИ (не как задачи), а
-- дочерние CODING-задачи заводит ленивый промоутер (advanceWorkStack) по одному
-- элементу на свободный микросервис. Элемент стека — не задача: его нельзя ни
-- задедупить с родителем, ни отправить назад Архитектору. Промоутнутая задача
-- создаётся БЕЗ messageFingerprint → структурно недоступна для дедупа.
--
-- Замок микросервиса («программист берёт сервис и держит его, пока не закончит»)
-- обеспечивается двухслойно: (1) промоутер не выдаёт второй PENDING-элемент того же
-- сервиса, пока предыдущий PROMOTED не терминализовался; (2) существующий claim
-- программиста (PROGRAMMER-WORKTREE-PER-SERVICE) держит один активный CODING на сервис.

CREATE TABLE IF NOT EXISTS work_stack (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Эпик-родитель (задача А). CASCADE: снятие эпика убирает и его незакрытый стек.
  epic_task_id      uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  project_id        uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  service_id        uuid NOT NULL REFERENCES services(id),
  service_code      text NOT NULL,                 -- денорм: для промоутера/логов без JOIN
  seq               int  NOT NULL DEFAULT 0,        -- порядок внутри сервиса (ASC=FIFO, DESC=LIFO)
  title             text NOT NULL,
  description       text NOT NULL DEFAULT '',
  data_card         jsonb NOT NULL DEFAULT '{}'::jsonb,   -- отфильтрованная по сервису карточка (БЕЗ messageFingerprint)
  -- Куда промоутер выводит дочернюю задачу (наследуется из FORWARD-перехода Архитектора).
  target_status     text NOT NULL DEFAULT 'CODING',
  target_role_id    uuid REFERENCES roles(id),
  target_stage_key  text,                          -- для граф-режима (fork/join)
  status            text NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('PENDING','PROMOTED','DONE','FAILED','CANCELLED')),
  promoted_task_id  uuid REFERENCES tasks(id) ON DELETE SET NULL,   -- дочерняя задача, если элемент промоутнут
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Промоутер ищет PENDING-элементы по сервису; частичный индекс держит выборку узкой.
CREATE INDEX IF NOT EXISTS work_stack_pending_idx
  ON work_stack(project_id, service_id, seq)
  WHERE status = 'PENDING';

-- Замок сервиса и reconcile промоутнутых — быстрый поиск активных PROMOTED по сервису.
CREATE INDEX IF NOT EXISTS work_stack_promoted_idx
  ON work_stack(project_id, service_id)
  WHERE status = 'PROMOTED';

-- Роллап эпика и очистка — все строки одного эпика.
CREATE INDEX IF NOT EXISTS work_stack_epic_idx
  ON work_stack(epic_task_id);

COMMENT ON TABLE work_stack IS
  'WORK-STACK-001: очередь элементов работы (по одному на микросервис) между Архитектором и Программистом; промоутер заводит из PENDING-элементов дочерние CODING-задачи под замком сервиса.';
